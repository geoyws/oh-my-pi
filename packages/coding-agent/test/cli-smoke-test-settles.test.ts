import { expect, it } from "bun:test";
import * as path from "node:path";

// Regression (kb omp t-5b4175f7): `omp --smoke-test` exited 1 with "command ended before
// completing" right after the STT worker's pong. Each worker probe ends in `terminate()`, which
// SIGKILLs the `unref`'d worker subprocess and awaits its reap behind a confirm timer that was
// `unref`'d as well, so nothing held the event loop and it drained with `terminate()` pending.
// The probe runs the real CLI entry in a child process: worker unref and the unsettled-entry
// diagnostic both apply only outside the test runner, which the child must not inherit.

const repoRoot = path.resolve(import.meta.dir, "../../..");
const cliEntry = path.join(repoRoot, "packages/coding-agent/src/cli.ts");

it("finishes `--smoke-test` with every worker probe settled", async () => {
	const proc = Bun.spawn([process.execPath, cliEntry, "--smoke-test"], {
		cwd: repoRoot,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, PI_TEST_RUNTIME: "0", BUN_ENV: undefined, NODE_ENV: undefined },
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(stderr).not.toContain("ended before completing");
	expect(stdout).toBe("smoke-test: ok\n");
	expect(exitCode).toBe(0);
}, 120_000);
