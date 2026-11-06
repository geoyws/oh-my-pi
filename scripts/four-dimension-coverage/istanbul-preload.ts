/**
 * `bun test --preload` entry used by `four-dimension.ts`; the behaviour lives in
 * `coverage-plugin.ts`. Bun's test runner does not emit `process.on("exit")`, so
 * the counters are written from a global `afterAll`.
 */
import { afterAll } from "bun:test";
import { installFourDimensionCoverage } from "./coverage-plugin";

installFourDimensionCoverage(process.env, afterAll);
