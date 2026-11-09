#!/usr/bin/env bun
/**
 * `bun run test` for packages/tui: `bun test --parallel` over test/*.test.ts
 * with a bounded worker count.
 *
 * Bare `--parallel` starts one worker per core. Each tui worker loads the
 * native addon and runs 50-90 threads, so on a 32-core host the suite peaks at
 * ~2600 pids. Inside the omp-gate container (--pids-limit 2048) a thread spawn
 * then fails, Bun aborts with SIGABRT and takes every sibling worker down with
 * it. OMP_TEST_CONCURRENCY, the width the gate already exports for
 * scripts/ci-test-ts.ts, caps the worker count; unset, every core runs one.
 */
import * as os from "node:os";
import * as path from "node:path";

/** Worker count for `bun test --parallel=N`: OMP_TEST_CONCURRENCY clamped to `cores`. */
export function testWorkers(spec: string | undefined, cores: number): number {
	const cap = Math.max(1, cores);
	const raw = spec?.trim().toLowerCase();
	if (!raw || raw === "all" || raw === "max") return cap;
	const override = Number(raw);
	if (Number.isFinite(override) && override >= 1) return Math.min(Math.floor(override), cap);
	throw new Error(`Invalid OMP_TEST_CONCURRENCY=${JSON.stringify(spec)}; expected a positive integer, all, or max`);
}

if (import.meta.main) {
	const root = path.join(import.meta.dir, "..");
	const files = [...new Bun.Glob("test/*.test.ts").scanSync({ cwd: root })].sort();
	const workers = testWorkers(Bun.env.OMP_TEST_CONCURRENCY, os.availableParallelism());
	const proc = Bun.spawn([process.execPath, "test", `--parallel=${workers}`, ...files, ...process.argv.slice(2)], {
		cwd: root,
		stdio: ["inherit", "inherit", "inherit"],
	});
	process.exit(await proc.exited);
}
