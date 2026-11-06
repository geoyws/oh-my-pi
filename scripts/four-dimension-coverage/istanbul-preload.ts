/**
 * `bun test --preload` hook used by `four-dimension.ts`.
 *
 * Bun's own `--coverage` reports lines and functions only (its lcov carries no
 * BRDA records), so branch and statement coverage cannot come from it. This
 * preload instruments exactly the tracked source files with istanbul at load
 * time and dumps the collected counters when the test process exits. Untracked
 * modules load untouched.
 *
 * Environment (set by four-dimension.ts):
 * - OMP_FOUR_DIM_TRACK: JSON array of absolute source paths to instrument.
 * - OMP_FOUR_DIM_OUT: directory that receives one `istanbul-<pid>-<uuid>.json` per process.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createInstrumenter } from "istanbul-lib-instrument";
import { createInstrumentOptions, IGNORE_HINT } from "./instrument-options";

const outDir = process.env.OMP_FOUR_DIM_OUT;
const trackJson = process.env.OMP_FOUR_DIM_TRACK;
if (!outDir || !trackJson) {
	throw new Error("istanbul-preload: OMP_FOUR_DIM_OUT and OMP_FOUR_DIM_TRACK are required");
}
const tracked = (JSON.parse(trackJson) as string[]).map(file => fs.realpathSync(file));
if (tracked.length === 0) throw new Error("istanbul-preload: OMP_FOUR_DIM_TRACK is empty");

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const filter = new RegExp(`^(?:${tracked.map(escape).join("|")})$`);
const instrumenter = createInstrumenter(createInstrumentOptions());

Bun.plugin({
	name: "omp-four-dimension-coverage",
	setup(build) {
		build.onLoad({ filter }, async args => {
			const source = await Bun.file(args.path).text();
			if (IGNORE_HINT.test(source)) {
				throw new Error(`istanbul-preload: coverage ignore hint in ${args.path}; hints are not allowed`);
			}
			const contents = instrumenter.instrumentSync(source, args.path);
			return { contents, loader: args.path.endsWith(".tsx") ? "tsx" : "ts" };
		});
	},
});

process.on("exit", () => {
	// Synchronous by necessity: "exit" listeners cannot await.
	const coverage: unknown = Reflect.get(globalThis, "__coverage__") ?? {};
	fs.mkdirSync(outDir, { recursive: true });
	fs.writeFileSync(path.join(outDir, `istanbul-${process.pid}-${crypto.randomUUID()}.json`), JSON.stringify(coverage));
});
