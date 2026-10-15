import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	executeBash,
	releaseShellSessions,
	setInFlightLeakBoundForTest,
} from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

/**
 * Kill-group regression tests: children started by a bash-tool call must not
 * outlive the call (normal end, abort, timeout) or the session.
 *
 * Every test uses a unique marker embedded as the backgrounded `sh`'s `$0`,
 * so `pgrep -f` finds exactly that test's grandchild. The grandchild ignores
 * SIGTERM (`trap "" TERM`): a direct-child-only kill leaves it running, while
 * the required whole-group TERM→KILL escalation reaps it.
 *
 * NOTE: the `Bun.sleep` polls below are genuine integration waits, not
 * guess-timers: they await a real kernel condition (child-process liveness
 * observed through `pgrep`) that has no event handle to await and cannot run
 * on fake timers — signals and process exit only happen on the real clock.
 * Every poll is bounded and exits as soon as the condition holds.
 */

function uniqueMarker(tag: string): string {
	return `PGKILL_${tag}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
}

function livePids(marker: string): number[] {
	// Bracket the first character so `pgrep -f` never matches its own command line.
	const proc = Bun.spawnSync(["pgrep", "-f", `[${marker[0]}]${marker.slice(1)}`]);
	return proc.stdout
		.toString()
		.trim()
		.split("\n")
		.filter(Boolean)
		.map(Number)
		.filter(pid => Number.isInteger(pid) && pid > 0);
}

async function pollWhileLive(marker: string, timeoutMs: number): Promise<number[]> {
	const start = Date.now();
	let pids = livePids(marker);
	while (pids.length > 0 && Date.now() - start < timeoutMs) {
		await Bun.sleep(50);
		pids = livePids(marker);
	}
	return pids;
}

async function pollUntilLive(marker: string, timeoutMs: number): Promise<number[]> {
	const start = Date.now();
	let pids: number[] = [];
	while (Date.now() - start < timeoutMs) {
		pids = livePids(marker);
		if (pids.length > 0) return pids;
		await Bun.sleep(20);
	}
	return pids;
}

/** Best-effort SIGKILL of exact pids so a failing test never leaks processes. */
function killPids(pids: readonly number[]): void {
	for (const pid of pids) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone — the outcome the tests assert.
		}
	}
}
/** `ps` state for a pid: `""` when gone, e.g. `"Z+"` for a zombie. */
function pidState(pid: number): string {
	try {
		const proc = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]);
		if (proc.exitCode !== 0) return "";
		return proc.stdout.toString().trim();
	} catch {
		return "";
	}
}

function termIgnoringGrandchild(marker: string): string {
	return `sh -c 'trap "" TERM; while :; do sleep 0.2; done' ${marker} & wait`;
}

describe("bash process-group kill", () => {
	let tempDir: string;
	const strayMarkers: string[] = [];

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-pgkill-"));
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: tempDir });
	});

	afterEach(() => {
		resetSettingsForTest();
		for (const marker of strayMarkers.splice(0)) killPids(livePids(marker));
		if (fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	it("abort kills the TERM-ignoring grandchild", async () => {
		if (process.platform === "win32") return;
		const marker = uniqueMarker("ABORT");
		strayMarkers.push(marker);
		const controller = new AbortController();
		const promise = executeBash(termIgnoringGrandchild(marker), {
			cwd: tempDir,
			timeout: 0,
			signal: controller.signal,
			sessionKey: `pgkill-abort-${marker}`,
		});
		expect(await pollUntilLive(marker, 10_000)).not.toEqual([]);
		controller.abort();
		const result = await promise;
		expect(result.cancelled).toBe(true);
		expect(await pollWhileLive(marker, 10_000)).toEqual([]);
	}, 60_000);

	it("timeout kills the TERM-ignoring grandchild", async () => {
		if (process.platform === "win32") return;
		const marker = uniqueMarker("TIMEOUT");
		strayMarkers.push(marker);
		const result = await executeBash(termIgnoringGrandchild(marker), {
			cwd: tempDir,
			timeout: 800,
			sessionKey: `pgkill-timeout-${marker}`,
		});
		expect(result.cancelled).toBe(true);
		expect(result.timedOut).toBe(true);
		expect(await pollWhileLive(marker, 10_000)).toEqual([]);
	}, 60_000);

	it("normal completion leaves no stray backgrounded grandchild", async () => {
		if (process.platform === "win32") return;
		const marker = uniqueMarker("NORMAL");
		strayMarkers.push(marker);
		let probe: () => readonly number[] = () => [];
		const promise = executeBash(`sh -c 'sleep 30' ${marker} &`, {
			cwd: tempDir,
			timeout: 5000,
			sessionKey: `pgkill-normal-${marker}`,
			onStart: p => {
				probe = p;
			},
		});
		let bgPid = 0;
		const start = Date.now();
		while (bgPid === 0 && Date.now() - start < 10_000) {
			const pids = probe();
			if (pids.length > 0) bgPid = pids[0]!;
			else await Bun.sleep(10);
		}
		expect(bgPid).toBeGreaterThan(0);
		const result = await promise;
		expect(result.cancelled).toBe(false);
		// Deterministic: executeBash awaits the background-job termination
		// (including exit-status reaping) before returning. The pid may still
		// flicker through a zombie state while the kernel releases it; what
		// must never survive is a RUNNING process (a spinning core).
		const deadline = Date.now() + 10_000;
		let state = pidState(bgPid);
		while (state !== "" && !state.startsWith("Z") && Date.now() < deadline) {
			await Bun.sleep(50);
			state = pidState(bgPid);
		}
		expect(state === "" || state.startsWith("Z")).toBe(true);
		// No SIGKILL of bgPid here: once reaped, the kernel may recycle the
		// pid for an unrelated process. The marker-keyed afterEach sweep is
		// the only cleanup and can only match this test's own grandchild.
	}, 60_000);

	it("session dispose kills running calls' groups", async () => {
		if (process.platform === "win32") return;
		const marker = uniqueMarker("DISPOSE");
		strayMarkers.push(marker);
		const sessionId = `pgkill-dispose-${marker}`;
		const controller = new AbortController();
		const promise = executeBash(termIgnoringGrandchild(marker), {
			cwd: tempDir,
			timeout: 0,
			signal: controller.signal,
			sessionKey: sessionId,
		});
		expect(await pollUntilLive(marker, 10_000)).not.toEqual([]);
		await releaseShellSessions(sessionId);
		const result = await promise;
		expect(result.cancelled).toBe(true);
		expect(await pollWhileLive(marker, 10_000)).toEqual([]);
	}, 60_000);

	it("session dispose waits for the in-flight run's group to die", async () => {
		if (process.platform === "win32") return;
		const marker = uniqueMarker("DISPOSEWAIT");
		strayMarkers.push(marker);
		const sessionId = `pgkill-disposewait-${marker}`;
		// No user abort: dispose itself must cancel the in-flight run and
		// wait (bounded) for the TERM→KILL escalation and reap. The
		// grandchild ignores TERM, so returning after only the TERM wave
		// would leave it running. No polling after dispose returns — the
		// group must already be gone. (p)grep liveness has no event handle
		// and cannot run on fake timers; the waits below are bounded kernel
		// waits, and the final assertion polls nothing.
		const promise = executeBash(termIgnoringGrandchild(marker), {
			cwd: tempDir,
			timeout: 0,
			sessionKey: sessionId,
		});
		expect(await pollUntilLive(marker, 10_000)).not.toEqual([]);
		await releaseShellSessions(sessionId);
		expect(livePids(marker)).toEqual([]);
		const result = await promise;
		expect(result.cancelled).toBe(true);
	}, 60_000);

	it("session dispose waits for a run older than the leak bound", async () => {
		if (process.platform === "win32") return;
		const marker = uniqueMarker("OLDRUN");
		strayMarkers.push(marker);
		const sessionId = `pgkill-oldrun-${marker}`;
		// Shrink the post-abort leak bound so the run can age past it in
		// milliseconds instead of ~30s. The bound must only ever drop an
		// entry after an abort: this run is never aborted before dispose,
		// so it must stay tracked no matter how old it gets, and dispose
		// must still wait for its TERM→KILL escalation. No polling after
		// dispose returns. (Real-clock sleep: process age has no event
		// handle and cannot run on fake timers.)
		setInFlightLeakBoundForTest(100);
		try {
			const promise = executeBash(termIgnoringGrandchild(marker), {
				cwd: tempDir,
				timeout: 0,
				sessionKey: sessionId,
			});
			expect(await pollUntilLive(marker, 10_000)).not.toEqual([]);
			await Bun.sleep(500);
			expect(livePids(marker)).not.toEqual([]);
			await releaseShellSessions(sessionId);
			expect(livePids(marker)).toEqual([]);
			const result = await promise;
			expect(result.cancelled).toBe(true);
		} finally {
			setInFlightLeakBoundForTest(undefined);
		}
	}, 60_000);

	it("session dispose waits for an in-flight async run's group to die", async () => {
		if (process.platform === "win32") return;
		const marker = uniqueMarker("ASYNCFLIGHT");
		strayMarkers.push(marker);
		const sessionId = `pgkill-asyncflight-${marker}`;
		// An `:async:` job's key (`${sid}:async:<jobId>`) never matched the
		// plain `${sid}\n` dispose prefix, so an in-flight async run was
		// neither aborted nor awaited. No user abort here: dispose itself
		// must cancel it and wait (bounded) for the TERM→KILL escalation.
		// No polling after dispose returns.
		const promise = executeBash(termIgnoringGrandchild(marker), {
			cwd: tempDir,
			timeout: 0,
			sessionKey: `${sessionId}:async:job1`,
		});
		expect(await pollUntilLive(marker, 10_000)).not.toEqual([]);
		await releaseShellSessions(sessionId);
		expect(livePids(marker)).toEqual([]);
		const result = await promise;
		expect(result.cancelled).toBe(true);
	}, 60_000);

	it("session dispose kills retained async shells' groups", async () => {
		if (process.platform === "win32") return;
		const marker = uniqueMarker("RETAINED");
		strayMarkers.push(marker);
		const sessionId = `pgkill-retained-${marker}`;
		// An `:async:` run's background job outlives the call by design
		// (documented detach); it must still die at session dispose. The trap
		// keeps `sh` from exec-ing `sleep` directly, so the marker stays
		// visible in the process table while the job lives.
		const result = await executeBash(`sh -c 'trap "" TERM; sleep 30' ${marker} &`, {
			cwd: tempDir,
			timeout: 5000,
			sessionKey: `${sessionId}:async:job1`,
		});
		expect(result.cancelled).toBe(false);
		expect(await pollUntilLive(marker, 10_000)).not.toEqual([]);
		await releaseShellSessions(sessionId);
		expect(await pollWhileLive(marker, 10_000)).toEqual([]);
	}, 60_000);
});
