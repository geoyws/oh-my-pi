import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { main, measure, type ScopeManifest } from "./four-dimension";

setDefaultTimeout(120_000);

const SUBJECT = `export function classify(n: number): string {
	if (n > 0) {
		return "positive";
	}
	return "non-positive";
}

export const pick = (flag: boolean): string => (flag ? "a" : "b");
`;

const UNLOADED = `export function never(): number {
	return 1;
}
`;

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture(tests: Record<string, string>, files: Record<string, string> = {}): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "four-dim-"));
	roots.push(root);
	await Bun.write(path.join(root, "src/subject.ts"), SUBJECT);
	await Bun.write(path.join(root, "src/unloaded.ts"), UNLOADED);
	for (const [name, body] of Object.entries({ ...files, ...tests })) await Bun.write(path.join(root, name), body);
	return root;
}

const manifest: ScopeManifest = {
	tracked: ["src/subject.ts", "src/unloaded.ts"],
	suites: [{ name: "unit", cwd: ".", tests: ["test/*.test.ts"] }],
};

const testFile = (calls: string) => `import { expect, test } from "bun:test";
import { classify, pick } from "../src/subject";
test("subject", () => {
${calls}
});
`;

describe("four-dimension coverage negative control", () => {
	test("an untaken branch reports below 100% and taking it reports 100% on every dimension", async () => {
		const partialRoot = await fixture({
			"test/partial.test.ts": testFile(`	expect(classify(1)).toBe("positive");\n	expect(pick(true)).toBe("a");`),
		});
		const partial = await measure(manifest, partialRoot, path.join(partialRoot, "out"));
		expect(partial.suitesGreen).toBe(true);
		const partialSubject = partial.files.find(file => file.file === "src/subject.ts")!;
		expect(partialSubject.branches).toMatchObject({ covered: 2, total: 4 });
		expect(partialSubject.statements.covered).toBeLessThan(partialSubject.statements.total);
		expect(partialSubject.lines.covered).toBeLessThan(partialSubject.lines.total);
		expect(partialSubject.functions).toMatchObject({ covered: 2, total: 2 });

		const fullRoot = await fixture({
			"test/full.test.ts": testFile(
				`	expect(classify(1)).toBe("positive");\n	expect(classify(0)).toBe("non-positive");\n	expect(pick(true)).toBe("a");\n	expect(pick(false)).toBe("b");`,
			),
		});
		const full = await measure(manifest, fullRoot, path.join(fullRoot, "out"));
		const fullSubject = full.files.find(file => file.file === "src/subject.ts")!;
		for (const dimension of [
			fullSubject.lines,
			fullSubject.functions,
			fullSubject.branches,
			fullSubject.statements,
		]) {
			expect(dimension.covered).toBe(dimension.total);
			expect(dimension.total).toBeGreaterThan(0);
		}
		expect(fullSubject.bun.unionLines).not.toBeNull();
		expect(fullSubject.bun.unionLines?.covered).toBe(fullSubject.bun.unionLines?.total);
	});

	test("a tracked file no test loads is reported at zero, never omitted", async () => {
		const root = await fixture({ "test/partial.test.ts": testFile(`	expect(classify(1)).toBe("positive");`) });
		const result = await measure(manifest, root, path.join(root, "out"));
		const unloaded = result.files.find(file => file.file === "src/unloaded.ts")!;
		expect(unloaded.functions).toEqual({ covered: 0, total: 1, pct: 0 });
		expect(unloaded.statements).toEqual({ covered: 0, total: 1, pct: 0 });
		expect(unloaded.bun.unionLines).toBeNull();
		expect(result.full).toBe(false);
	});

	test("a re-run into the same --out reports only the new run's hits", async () => {
		const root = await fixture({
			"test/a.test.ts": testFile(
				`	expect(classify(1)).toBe("positive");\n	expect(classify(0)).toBe("non-positive");\n	expect(pick(true)).toBe("a");\n	expect(pick(false)).toBe("b");`,
			),
		});
		const out = path.join(root, "out");
		const first = await measure(manifest, root, out);
		expect(first.files.find(file => file.file === "src/subject.ts")!.branches).toMatchObject({
			covered: 4,
			total: 4,
		});

		await Bun.write(
			path.join(root, "test/a.test.ts"),
			testFile(`	expect(classify(1)).toBe("positive");\n	expect(pick(true)).toBe("a");`),
		);
		const second = await measure(manifest, root, out);
		const subject = second.files.find(file => file.file === "src/subject.ts")!;
		expect(subject.branches).toMatchObject({ covered: 2, total: 4 });
		expect(subject.bun.unionLines!.covered).toBeLessThan(subject.bun.unionLines!.total);
	});

	test("a coverage ignore hint in a tracked file is refused", async () => {
		const root = await fixture(
			{ "test/partial.test.ts": testFile(`	expect(classify(1)).toBe("positive");`) },
			{ "src/unloaded.ts": `/* istanbul ignore next */\n${UNLOADED}` },
		);
		await expect(measure(manifest, root, path.join(root, "out"))).rejects.toThrow("coverage ignore hint");
	});
});

describe("four-dimension coverage CLI", () => {
	async function writeScope(root: string, scope: ScopeManifest): Promise<string> {
		const file = path.join(root, "scope.json");
		await Bun.write(file, JSON.stringify(scope));
		return file;
	}

	test("missing --scope or --out is a usage error", async () => {
		expect(await main([])).toBe(64);
		expect(await main(["--scope", "scope.json"])).toBe(64);
	});

	test("--require-full exits 1 below 100% and 0 once two suites together cover every dimension", async () => {
		const root = await fixture({
			"a/positive.test.ts": testFile(`	expect(classify(1)).toBe("positive");\n	expect(pick(true)).toBe("a");`),
			"b/negative.test.ts": testFile(
				`	expect(classify(0)).toBe("non-positive");\n	expect(pick(false)).toBe("b");`,
			),
			"src/limit.ts": "export const LIMIT = 3;\n",
			"src/helper.ts": "export const double = (n: number): number => n * 2;\n",
			// The untracked helper puts a non-tracked file in Bun's lcov, which the parser must skip.
			"a/limit.test.ts": `import { expect, test } from "bun:test";\nimport { double } from "../src/helper";\nimport { LIMIT } from "../src/limit";\ntest("limit", () => expect(double(LIMIT)).toBe(6));\n`,
		});
		await $`git init -q && git add -A && git -c user.email=t@example.invalid -c user.name=t commit -qm fixture`
			.cwd(root)
			.quiet();
		const head = (await $`git rev-parse HEAD`.cwd(root).text()).trim();
		const out = path.join(root, "out");
		const tracked = ["src/subject.ts", "src/limit.ts"];
		const onlyA = await writeScope(root, { tracked, suites: [{ name: "a", cwd: "a", tests: ["*.test.ts"] }] });
		expect(await main(["--scope", onlyA, "--out", out, "--root", root, "--require-full"])).toBe(1);
		expect(await main(["--scope", onlyA, "--out", out, "--root", root])).toBe(0);

		const both = await writeScope(root, {
			tracked,
			suites: [
				{ name: "a", cwd: "a", tests: ["*.test.ts"] },
				{ name: "b", cwd: "b", tests: ["*.test.ts"] },
			],
		});
		expect(await main(["--scope", both, "--out", out, "--root", root, "--require-full"])).toBe(0);
		const summary = await Bun.file(path.join(out, "summary.json")).json();
		expect(summary.head).toBe(head);
		const subject = summary.files.find((file: { file: string }) => file.file === "src/subject.ts");
		expect(subject.branches).toEqual({ covered: 4, total: 4, pct: 100 });
		expect(subject.bun.perSuite.a.lines.covered).toBeLessThan(subject.bun.perSuite.a.lines.total);
		expect(subject.bun.unionLines.covered).toBe(subject.bun.unionLines.total);
		const limit = summary.files.find((file: { file: string }) => file.file === "src/limit.ts");
		expect(limit.functions).toEqual({ covered: 0, total: 0, pct: 100 });
		expect(await Bun.file(path.join(out, "summary.md")).text()).toContain(`at ${head}`);
	});

	test("a suite whose process dies early exits 2 and still reports the tracked files", async () => {
		const root = await fixture({ "test/dies.test.ts": `process.exit(3);\n` });
		const scope = await writeScope(root, manifest);
		const out = path.join(root, "out");
		expect(await main(["--scope", scope, "--out", out, "--root", root])).toBe(2);
		const summary = await Bun.file(path.join(out, "summary.json")).json();
		expect(summary.suites[0].istanbul).toMatchObject({ exitCode: 3, pass: null, fail: null });
		expect(summary.files.map((file: { statements: { covered: number } }) => file.statements.covered)).toEqual([0, 0]);
		expect(await Bun.file(path.join(out, "summary.md")).text()).toContain("unknown HEAD");
	});

	test("without --root it measures the checkout that holds the script; a suite with no files runs nothing", async () => {
		const repoRoot = path.join(import.meta.dir, "..", "..");
		const root = await fixture({});
		const scope = await writeScope(root, {
			tracked: [path.relative(repoRoot, path.join(import.meta.dir, "instrument-options.ts"))],
			suites: [{ name: "none", cwd: ".", tests: ["no-such-dir/*.test.ts"] }],
		});
		const out = path.join(root, "out");
		expect(await main(["--scope", scope, "--out", out])).toBe(0);
		const summary = await Bun.file(path.join(out, "summary.json")).json();
		expect(summary.root).toBe(await fs.realpath(repoRoot));
		expect(summary.suites[0]).toMatchObject({ files: [], istanbul: { exitCode: 0, pass: 0 } });
		expect(summary.files[0].functions).toMatchObject({ covered: 0, total: 1 });
	});
});
