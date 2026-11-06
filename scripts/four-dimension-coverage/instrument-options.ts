import type { InstrumenterOptions } from "istanbul-lib-instrument";

/**
 * Coverage-suppression comments. Their presence would let a file report 100%
 * while skipping code, so both the preload and the runner refuse such files.
 */
export const IGNORE_HINT = /\b(?:istanbul|c8|v8|node:coverage)\s+ignore\b/;

/**
 * One option set for runtime instrumentation (preload) and for seeding files no
 * test loaded (runner). Identical options yield identical coverage maps, so the
 * seeded zero map and the runtime counters merge index by index.
 */
export function createInstrumentOptions(): Partial<InstrumenterOptions> {
	return {
		coverageVariable: "__coverage__",
		coverageGlobalScope: "globalThis",
		coverageGlobalScopeFunc: false,
		esModules: true,
		compact: false,
		preserveComments: true,
		produceSourceMap: false,
		parserPlugins: [
			"typescript",
			"importAttributes",
			"explicitResourceManagement",
			"decorators-legacy",
			"classProperties",
			"classPrivateProperties",
			"classPrivateMethods",
			"dynamicImport",
			"importMeta",
			"numericSeparator",
			"objectRestSpread",
			"optionalCatchBinding",
			"topLevelAwait",
		],
	};
}
