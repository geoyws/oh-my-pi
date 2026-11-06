/**
 * Four-dimension coverage runner: lines, functions, branches and statements
 * for an explicit set of tracked source files.
 *
 * Bun's `--coverage` lcov has line (DA) and function totals only; it never emits
 * branch (BRDA) records, so branch and statement coverage are unmeasured by it.
 * For every suite in the scope manifest this runner executes the same test
 * files twice under `bun test`:
 *
 * 1. `--coverage --coverage-reporter=lcov`: Bun's native line/function numbers,
 *    kept for comparison with earlier Bun-only measurements.
 * 2. `--preload istanbul-preload.ts`: the tracked files are instrumented with
 *    istanbul at load time, which yields all four dimensions.
 *
 * Istanbul counters from every suite are merged per file; a tracked file that no
 * test loaded is still reported, at zero. Per file the report also lists which
 * lines only one of the two tools treats as executable or uncovered, so any
 * line-count disagreement between them is enumerated rather than guessed.
 *
 * Usage:
 *   bun scripts/four-dimension-coverage/cli.ts --scope scripts/four-dimension-coverage/renderer-scope.json --out <dir> [--root <checkout>] [--require-full]
 *
 * Exit codes: 0 measured; 1 `--require-full` and a dimension is below 100%;
 * 2 a suite run failed (the report is still written); 64 usage error.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";
import { createInstrumenter } from "istanbul-lib-instrument";
import * as libCoverage from "istanbul-lib-coverage";
import * as libReport from "istanbul-lib-report";
import * as reports from "istanbul-reports";
import { createInstrumentOptions, IGNORE_HINT } from "./instrument-options";

export interface SuiteSpec {
	/** Stable label; also the artifact sub-directory name. */
	name: string;
	/** Directory `bun test` runs in, relative to the scope root. */
	cwd: string;
	/** Test file globs relative to `cwd`; matches are sorted and deduplicated. */
	tests: string[];
}

export interface ScopeManifest {
	/** Source files to measure, relative to the scope root. */
	tracked: string[];
	suites: SuiteSpec[];
}

interface Metric {
	covered: number;
	total: number;
	pct: number;
}

interface BunFileCoverage {
	/** Executable line -> hit count, from DA records. */
	lines: Map<number, number>;
	functionsFound: number;
	functionsHit: number;
}

export interface SuiteResult {
	name: string;
	cwd: string;
	patterns: string[];
	files: string[];
	bun: { exitCode: number; pass: number | null; fail: number | null; seconds: number };
	istanbul: { exitCode: number; pass: number | null; fail: number | null; seconds: number };
}

export interface FileReport {
	file: string;
	lines: Metric;
	functions: Metric;
	branches: Metric;
	statements: Metric;
	bun: {
		perSuite: Record<string, { lines: Metric; functions: Metric } | null>;
		unionLines: Metric | null;
	};
	lineDiff: {
		executableOnlyInBun: number[];
		executableOnlyInIstanbul: number[];
		uncoveredOnlyInBun: number[];
		uncoveredOnlyInIstanbul: number[];
	};
}

export interface MeasureResult {
	root: string;
	head: string | null;
	bunVersion: string;
	startedAt: string;
	finishedAt: string;
	suites: SuiteResult[];
	files: FileReport[];
	suitesGreen: boolean;
	full: boolean;
}

const PRELOAD = path.join(import.meta.dir, "istanbul-preload.ts");

function metric(covered: number, total: number): Metric {
	return { covered, total, pct: total === 0 ? 100 : Math.floor((covered / total) * 10_000) / 100 };
}

function countFrom(output: string, word: "pass" | "fail"): number | null {
	const match = output.match(new RegExp(`^\\s*(\\d+) ${word}$`, "m"));
	return match ? Number(match[1]) : null;
}

async function resolveTests(cwd: string, patterns: string[]): Promise<string[]> {
	const found = new Set<string>();
	for (const pattern of patterns) {
		for await (const file of new Bun.Glob(pattern).scan({ cwd, onlyFiles: true })) found.add(file);
	}
	return [...found].sort();
}

async function runBunTest(
	cwd: string,
	args: string[],
	env: Record<string, string>,
	log: string,
): Promise<{ exitCode: number; pass: number | null; fail: number | null; seconds: number }> {
	const started = performance.now();
	const child = Bun.spawn([process.execPath, "test", "--parallel=1", ...args], {
		cwd,
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	const output = `${stdout}${stderr}`;
	await Bun.write(log, output);
	return {
		exitCode,
		pass: countFrom(output, "pass"),
		fail: countFrom(output, "fail"),
		seconds: Math.round((performance.now() - started) / 100) / 10,
	};
}

/** Parse Bun's lcov into tracked absolute paths; SF paths are relative to the suite cwd. */
export function parseBunLcov(text: string, cwd: string, tracked: Set<string>): Map<string, BunFileCoverage> {
	const files = new Map<string, BunFileCoverage>();
	let current: BunFileCoverage | null = null;
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line.startsWith("SF:")) {
			const file = path.resolve(cwd, line.slice(3));
			current = tracked.has(file) ? { lines: new Map(), functionsFound: 0, functionsHit: 0 } : null;
			if (current) files.set(file, current);
			continue;
		}
		if (!current) continue;
		if (line.startsWith("DA:")) {
			const [lineNo, hits] = line.slice(3).split(",").map(Number);
			current.lines.set(lineNo, (current.lines.get(lineNo) ?? 0) + hits);
		} else if (line.startsWith("FNF:")) {
			current.functionsFound = Number(line.slice(4));
		} else if (line.startsWith("FNH:")) {
			current.functionsHit = Number(line.slice(4));
		} else if (line === "end_of_record") {
			current = null;
		}
	}
	return files;
}

async function readJsonDumps(dir: string): Promise<libCoverage.CoverageMapData[]> {
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch {
		return [];
	}
	const dumps: libCoverage.CoverageMapData[] = [];
	for (const name of names.filter(name => name.startsWith("istanbul-") && name.endsWith(".json")).sort()) {
		dumps.push(await Bun.file(path.join(dir, name)).json());
	}
	return dumps;
}

function sortedNumbers(values: number[]): number[] {
	// A typed array sorts numerically; line numbers are positive 32-bit integers.
	return Array.from(Uint32Array.from(values).sort());
}

/** Run every suite twice (Bun native, istanbul) and write the four-dimension report under `outDir`. */
export async function measure(manifest: ScopeManifest, root: string, outDir: string): Promise<MeasureResult> {
	const startedAt = new Date().toISOString();
	const absRoot = await fs.realpath(root);
	await fs.mkdir(outDir, { recursive: true });
	const absOut = await fs.realpath(outDir);
	const tracked: string[] = [];
	for (const file of manifest.tracked) tracked.push(await fs.realpath(path.join(absRoot, file)));
	const trackedSet = new Set(tracked);

	// Seed every tracked file at zero so an unloaded file still reports its totals.
	const coverageMap = libCoverage.createCoverageMap({});
	const instrumenter = createInstrumenter(createInstrumentOptions());
	for (const file of tracked) {
		const source = await Bun.file(file).text();
		if (IGNORE_HINT.test(source)) throw new Error(`coverage ignore hint in ${file}; hints are not allowed`);
		instrumenter.instrumentSync(source, file);
		coverageMap.addFileCoverage(instrumenter.lastFileCoverage());
	}

	const suites: SuiteResult[] = [];
	const bunBySuite = new Map<string, Map<string, BunFileCoverage>>();
	for (const suite of manifest.suites) {
		const cwd = path.join(absRoot, suite.cwd);
		const files = await resolveTests(cwd, suite.tests);
		const suiteOut = path.join(absOut, "suites", suite.name);
		// A previous run's dumps or lcov in the same --out would be merged into this one.
		await fs.rm(suiteOut, { recursive: true, force: true });
		await fs.mkdir(suiteOut, { recursive: true });
		await Bun.write(path.join(suiteOut, "files.txt"), `${files.join("\n")}\n`);
		const empty = { exitCode: 0, pass: 0, fail: 0, seconds: 0 };
		if (files.length === 0) {
			suites.push({ name: suite.name, cwd: suite.cwd, patterns: suite.tests, files, bun: empty, istanbul: empty });
			bunBySuite.set(suite.name, new Map());
			continue;
		}
		const bunDir = path.join(suiteOut, "bun");
		const bun = await runBunTest(
			cwd,
			["--coverage", "--coverage-reporter=lcov", `--coverage-dir=${bunDir}`, ...files],
			{},
			path.join(suiteOut, "bun.log"),
		);
		let lcov = "";
		try {
			lcov = await Bun.file(path.join(bunDir, "lcov.info")).text();
		} catch {
			lcov = "";
		}
		bunBySuite.set(suite.name, parseBunLcov(lcov, cwd, trackedSet));

		const istanbulDir = path.join(suiteOut, "istanbul-raw");
		const istanbul = await runBunTest(
			cwd,
			["--preload", PRELOAD, ...files],
			{ OMP_FOUR_DIM_OUT: istanbulDir, OMP_FOUR_DIM_TRACK: JSON.stringify(tracked) },
			path.join(suiteOut, "istanbul.log"),
		);
		for (const dump of await readJsonDumps(istanbulDir)) coverageMap.merge(dump);
		suites.push({ name: suite.name, cwd: suite.cwd, patterns: suite.tests, files, bun, istanbul });
	}

	const files: FileReport[] = tracked.map(file => {
		const fileCoverage = coverageMap.fileCoverageFor(file);
		const summary = fileCoverage.toSummary();
		const istanbulLines = fileCoverage.getLineCoverage();
		const perSuite: FileReport["bun"]["perSuite"] = {};
		const unionBun = new Map<number, number>();
		let bunSeen = false;
		for (const suite of manifest.suites) {
			const entry = bunBySuite.get(suite.name)?.get(file);
			if (!entry) {
				perSuite[suite.name] = null;
				continue;
			}
			bunSeen = true;
			let hit = 0;
			for (const [line, hits] of entry.lines) {
				if (hits > 0) hit++;
				unionBun.set(line, (unionBun.get(line) ?? 0) + hits);
			}
			perSuite[suite.name] = {
				lines: metric(hit, entry.lines.size),
				functions: metric(entry.functionsHit, entry.functionsFound),
			};
		}
		const istanbulExecutable = new Set(Object.keys(istanbulLines).map(Number));
		const istanbulUncovered = new Set([...istanbulExecutable].filter(line => istanbulLines[line] === 0));
		const bunUncovered = new Set([...unionBun].filter(([, hits]) => hits === 0).map(([line]) => line));
		return {
			file: path.relative(absRoot, file),
			lines: metric(summary.lines.covered, summary.lines.total),
			functions: metric(summary.functions.covered, summary.functions.total),
			branches: metric(summary.branches.covered, summary.branches.total),
			statements: metric(summary.statements.covered, summary.statements.total),
			bun: {
				perSuite,
				unionLines: bunSeen ? metric(unionBun.size - bunUncovered.size, unionBun.size) : null,
			},
			lineDiff: bunSeen
				? {
						executableOnlyInBun: sortedNumbers(
							[...unionBun.keys()].filter(line => !istanbulExecutable.has(line)),
						),
						executableOnlyInIstanbul: sortedNumbers([...istanbulExecutable].filter(line => !unionBun.has(line))),
						uncoveredOnlyInBun: sortedNumbers([...bunUncovered].filter(line => !istanbulUncovered.has(line))),
						uncoveredOnlyInIstanbul: sortedNumbers(
							[...istanbulUncovered].filter(line => !bunUncovered.has(line)),
						),
					}
				: {
						executableOnlyInBun: [],
						executableOnlyInIstanbul: [],
						uncoveredOnlyInBun: [],
						uncoveredOnlyInIstanbul: [],
					},
		};
	});

	const istanbulOut = path.join(absOut, "istanbul");
	await Bun.write(path.join(istanbulOut, "coverage-final.json"), JSON.stringify(coverageMap.toJSON()));
	const context = libReport.createContext({ dir: istanbulOut, coverageMap, defaultSummarizer: "flat" });
	for (const name of ["lcovonly", "json-summary", "text"] as const) {
		reports.create(name, name === "text" ? { file: "report.txt" } : {}).execute(context);
	}

	const suitesGreen = suites.every(suite => suite.bun.exitCode === 0 && suite.istanbul.exitCode === 0);
	const full = files.every(file =>
		[file.lines, file.functions, file.branches, file.statements].every(entry => entry.covered === entry.total),
	);
	const headResult = await $`git rev-parse HEAD`.cwd(absRoot).quiet().nothrow();
	const result: MeasureResult = {
		root: absRoot,
		head: headResult.exitCode === 0 ? headResult.text().trim() : null,
		bunVersion: Bun.version,
		startedAt,
		finishedAt: new Date().toISOString(),
		suites,
		files,
		suitesGreen,
		full,
	};
	await Bun.write(path.join(absOut, "summary.json"), `${JSON.stringify(result, null, "\t")}\n`);
	await Bun.write(path.join(absOut, "summary.md"), renderMarkdown(result));
	return result;
}

function cell(entry: Metric): string {
	return `${entry.covered}/${entry.total} (${entry.pct}%)`;
}

export function renderMarkdown(result: MeasureResult): string {
	const rows = [
		`# Four-dimension coverage at ${result.head ?? "unknown HEAD"}`,
		"",
		`Bun ${result.bunVersion}; suites green: ${result.suitesGreen}; all dimensions 100%: ${result.full}.`,
		"",
		"| file | lines | functions | branches | statements | bun lines (union) |",
		"| --- | --- | --- | --- | --- | --- |",
		...result.files.map(
			file =>
				`| ${file.file} | ${cell(file.lines)} | ${cell(file.functions)} | ${cell(file.branches)} | ${cell(file.statements)} | ${file.bun.unionLines ? cell(file.bun.unionLines) : "not loaded"} |`,
		),
		"",
		"| suite | files | bun exit | bun pass/fail | istanbul exit | istanbul pass/fail |",
		"| --- | --- | --- | --- | --- | --- |",
		...result.suites.map(
			suite =>
				`| ${suite.name} | ${suite.files.length} | ${suite.bun.exitCode} | ${suite.bun.pass}/${suite.bun.fail} | ${suite.istanbul.exitCode} | ${suite.istanbul.pass}/${suite.istanbul.fail} |`,
		),
		"",
	];
	return rows.join("\n");
}

/** CLI behind `cli.ts`; returns the process exit code. */
export async function main(argv: string[]): Promise<number> {
	const option = (flag: string) => {
		const index = argv.indexOf(flag);
		return index >= 0 ? argv[index + 1] : undefined;
	};
	const scope = option("--scope");
	const out = option("--out");
	if (!scope || !out) {
		process.stderr.write("usage: cli.ts --scope <manifest.json> --out <dir> [--root <checkout>] [--require-full]\n");
		return 64;
	}
	// --root measures another checkout (e.g. an older commit without this script) with this checkout's tooling.
	const root = path.resolve(option("--root") ?? path.join(import.meta.dir, "..", ".."));
	const manifest: ScopeManifest = await Bun.file(path.resolve(scope)).json();
	const result = await measure(manifest, root, path.resolve(out));
	process.stdout.write(renderMarkdown(result));
	if (!result.suitesGreen) return 2;
	if (argv.includes("--require-full") && !result.full) return 1;
	return 0;
}
