import * as fs from "node:fs";
import * as path from "node:path";
import { createInstrumenter } from "istanbul-lib-instrument";
import { createInstrumentOptions, IGNORE_HINT } from "./instrument-options";

/**
 * Instrument exactly the tracked files with istanbul as Bun loads them, and
 * hand `registerDump` a callback that writes this process's counters.
 *
 * Environment:
 * - OMP_FOUR_DIM_TRACK: JSON array of absolute source paths to instrument.
 * - OMP_FOUR_DIM_OUT: directory that receives one `istanbul-<pid>-<uuid>.json` per process.
 *
 * Counters are cumulative and every call of the dump callback overwrites the same
 * per-process file, so the last write holds the process's totals and nothing is
 * counted twice.
 */
export function installFourDimensionCoverage(
	env: Record<string, string | undefined>,
	registerDump: (dump: () => Promise<void>) => void,
): void {
	const outDir = env.OMP_FOUR_DIM_OUT;
	const trackJson = env.OMP_FOUR_DIM_TRACK;
	if (!outDir || !trackJson) {
		throw new Error("four-dimension coverage: OMP_FOUR_DIM_OUT and OMP_FOUR_DIM_TRACK are required");
	}
	const parsed: unknown = JSON.parse(trackJson);
	if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(file => typeof file === "string")) {
		throw new Error("four-dimension coverage: OMP_FOUR_DIM_TRACK must be a non-empty JSON array of paths");
	}
	const tracked = parsed.map(file => fs.realpathSync(file));

	const filter = new RegExp(`^(?:${tracked.map(file => file.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|")})$`);
	const instrumenter = createInstrumenter(createInstrumentOptions());
	Bun.plugin({
		name: "omp-four-dimension-coverage",
		setup(build) {
			build.onLoad({ filter }, async args => {
				const source = await Bun.file(args.path).text();
				if (IGNORE_HINT.test(source)) {
					throw new Error(`four-dimension coverage: coverage ignore hint in ${args.path}; hints are not allowed`);
				}
				const contents = instrumenter.instrumentSync(source, args.path);
				return { contents, loader: args.path.endsWith(".tsx") ? "tsx" : "ts" };
			});
		},
	});

	const dumpFile = path.join(outDir, `istanbul-${process.pid}-${crypto.randomUUID()}.json`);
	registerDump(async () => {
		await Bun.write(dumpFile, JSON.stringify(Reflect.get(globalThis, "__coverage__") ?? {}));
	});
}
