import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "bun:test";
import { execCommand } from "../src/exec/exec";

const HANG = ["-e", "setTimeout(() => {}, 30_000)"];

describe("execCommand", () => {
	it("reports a non-zero code when the timeout kills the process", async () => {
		const result = await execCommand(process.execPath, HANG, process.cwd(), { timeout: 50 });
		expect(result.killed).toBe(true);
		expect(result.code).toBe(-1);
	});

	it("reports a non-zero code when the signal aborts the process", async () => {
		const controller = new AbortController();
		const pending = execCommand(process.execPath, HANG, process.cwd(), { signal: controller.signal });
		controller.abort();
		const result = await pending;
		expect(result.killed).toBe(true);
		expect(result.code).toBe(-1);
	});

	it("reports cancellation when the child traps SIGTERM and exits zero", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "exec-graceful-"));
		const marker = path.join(dir, "ready");
		const watcher = fs.watch(dir);
		const ready = Promise.withResolvers<void>();
		watcher.once("change", () => ready.resolve());

		try {
			const controller = new AbortController();
			// The child signals readiness after installing its handler; its timer never fires.
			const script = `process.on("SIGTERM", () => process.exit(0)); await Bun.write(${JSON.stringify(marker)}, "ready"); setTimeout(() => {}, 30_000);`;
			const pending = execCommand(process.execPath, ["-e", script], process.cwd(), { signal: controller.signal });
			// Wait for the child's readiness signal. The watcher event is the
			// fast path; the existence poll is the fallback — fs.watch
			// delivery is unreliable in some environments (FSEvents), and the
			// test must wait on the child, not hang on the watcher.
			const fallBack = (async () => {
				const start = Date.now();
				while (!fs.existsSync(marker) && Date.now() - start < 4000) await Bun.sleep(20);
			})();
			await Promise.race([ready.promise, fallBack]);
			expect(fs.existsSync(marker)).toBe(true);
			controller.abort();
			const result = await pending;
			expect(result.killed).toBe(true);
			expect(result.code).toBe(-1);
		} finally {
			watcher.close();
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	it("abort kills the TERM-ignoring grandchild's whole group", async () => {
		if (process.platform === "win32") return;
		// NOTE: real-clock `Bun.sleep` polls await a kernel condition (process
		// liveness via `pgrep`) with no event handle; signals only run on the
		// real clock. Bounded; exits as soon as the condition holds.
		const marker = `EXECCMD_ABORT_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
		const pattern = `[${marker[0]}]${marker.slice(1)}`;
		const live = (): number[] =>
			Bun.spawnSync(["pgrep", "-f", pattern])
				.stdout.toString()
				.trim()
				.split("\n")
				.filter(Boolean)
				.map(Number)
				.filter(pid => Number.isInteger(pid) && pid > 0);
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "exec-pgkill-"));
		const script = path.join(dir, "spawn.sh");
		// The direct child installs no trap; only the grandchild ignores TERM,
		// so a direct-child-only kill leaves the grandchild running while a
		// whole-group TERM→KILL escalation reaps it.
		await fs.promises.writeFile(
			script,
			`#!/bin/sh\nsh -c 'trap "" TERM; while :; do sleep 0.2; done' ${marker} & wait\n`,
		);
		try {
			const controller = new AbortController();
			const pending = execCommand("/bin/sh", [script], dir, { signal: controller.signal });
			const start = Date.now();
			while (live().length === 0 && Date.now() - start < 10_000) await Bun.sleep(20);
			expect(live().length).toBeGreaterThan(0);
			controller.abort();
			const result = await pending;
			expect(result.killed).toBe(true);
			const deadline = Date.now() + 10_000;
			let survivors = live();
			while (survivors.length > 0 && Date.now() < deadline) {
				await Bun.sleep(50);
				survivors = live();
			}
			expect(survivors).toEqual([]);
			for (const pid of survivors) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
			}
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	}, 60_000);
});
