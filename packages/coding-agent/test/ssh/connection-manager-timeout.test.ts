/**
 * Regression for #4232: `runSshSync` / `runSshCaptureSync` sit on the
 * `ensureHostInfo` → `probeHostInfo` / `ensureConnection` path that runs before
 * `SshTool.execute` applies the user's command timeout. Previously they invoked
 * `ssh` through `$`ssh ${args}`.quiet().nothrow()` with no timeout and no
 * abort signal, so an unreachable host or wedged control-master hung forever.
 *
 * The contract now is: each helper is bounded by `timeoutMs`, aborts a stalled
 * child, and returns a failure result (`exitCode !== 0`, non-empty
 * `stderr`) instead of throwing or blocking.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { _sshHelpersForTests } from "../../src/ssh/connection-manager";

const { runSshSync, runSshCaptureSync } = _sshHelpersForTests;

let binDir: string;
let sentinel: string;
let originalPath: string | undefined;

beforeAll(async () => {
	binDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ssh-timeout-"));
	sentinel = path.join(binDir, "ssh-hits.log");
	// Fake `ssh` that logs its invocation, then traps SIGTERM and sleeps far
	// past any test bound. Simulates a wedged control-master / unreachable
	// host. The sentinel log proves the helpers really executed this fake: a
	// missing binary throws ENOENT, and a real ssh reached through a stale
	// PATH snapshot would leave no entry. `#!/bin/sh` (not `env bash`) keeps
	// cold-start far under the timeout: an `env` PATH search can outlast it.
	const fake = path.join(binDir, "ssh");
	await fs.writeFile(fake, `#!/bin/sh\necho "hit $@" >> ${JSON.stringify(sentinel)}\ntrap '' TERM\nsleep 300\n`, {
		mode: 0o755,
	originalPath = process.env.PATH;
	process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
	// Warm the fake once: the first exec of a new file can outlast the test
	// timeout (cold dentry / trust evaluation), which would kill the wedge
	// before it logs and flake the sentinel assertion below. This costs only
	// the actual startup latency: it returns as soon as the log appears.
	const warm = Bun.spawn([fake], {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
		env: { ...process.env },
	});
	try {
		let started = false;
		const deadline = Date.now() + 10_000;
		while (!started && Date.now() <= deadline) {
			try {
				await fs.stat(sentinel);
				started = true;
			} catch {
				await Bun.sleep(25);
			}
		}
		if (!started) throw new Error(`fake ssh never logged to ${sentinel}`);
	} finally {
		try {
			warm.kill("SIGKILL");
		} catch {
			// Already reaped between the stat poll and the kill.
		}
	}
	await warm.exited;
});

afterAll(async () => {
	if (originalPath === undefined) delete process.env.PATH;
	else process.env.PATH = originalPath;
	await fs.rm(binDir, { recursive: true, force: true });
});

describe("SSH pre-command helpers bound their own runtime (#4232)", () => {
	it("runSshSync returns a failure result within the timeout on a wedged host", async () => {
		const timeoutMs = 200;
		const started = Date.now();
		const result = await runSshSync(["-o", "BatchMode=yes", "unreachable", "true"], timeoutMs);
		const elapsed = Date.now() - started;

		expect(elapsed).toBeLessThan(5_000);
		// Lower bound plus sentinel: only the wedged fake survives until the
		// deadline, and its log entry proves it was the binary that ran.
		expect(elapsed).toBeGreaterThanOrEqual(timeoutMs - 50);
		expect(await fs.readFile(sentinel, "utf8")).toContain("hit -o BatchMode=yes unreachable true");
		// timeout → aborted child, so exit code is null (aborted) or non-zero.
		expect(result.exitCode).not.toBe(0);
	}, 10_000);

	it("runSshCaptureSync returns a failure result within the timeout on a wedged host", async () => {
		const timeoutMs = 200;
		const started = Date.now();
		const result = await runSshCaptureSync(["-o", "BatchMode=yes", "unreachable", "true"], timeoutMs);
		const elapsed = Date.now() - started;

		expect(elapsed).toBeLessThan(5_000);
		// Same proof as above: deadline survival plus the fake's log entry.
		expect(elapsed).toBeGreaterThanOrEqual(timeoutMs - 50);
		expect(await fs.readFile(sentinel, "utf8")).toContain("hit -o BatchMode=yes unreachable true");
		expect(result.exitCode).not.toBe(0);
		expect(result.stdout).toBe("");
	}, 10_000);
});
