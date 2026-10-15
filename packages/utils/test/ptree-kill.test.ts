import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { AbortError, spawn } from "@oh-my-pi/pi-utils/ptree";

// Ignores SIGTERM, so only an escalation to SIGKILL ends it.
const STUBBORN_CHILD = 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);';

describe("ptree kill without a usable native process handle", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.skipIf(process.platform === "win32").each([
		[
			"the handle lookup throws",
			() => {
				throw new Error("Value is not an instance of class `Process`");
			},
		],
		[
			"native termination rejects",
			() => ({ terminate: () => Promise.reject(new Error("terminate failed")) }) as unknown as Process,
		],
	])("still ends a SIGTERM-ignoring child when %s", async (_name, fromPid) => {
		const child = spawn([process.execPath, "-e", STUBBORN_CHILD]);
		const reader = child.stdout.getReader();
		await reader.read(); // "ready": the SIGTERM handler is installed
		reader.releaseLock();
		spyOn(Process, "fromPid").mockImplementation(fromPid);

		child.kill(undefined, 50);

		// A kill that never signals the child leaves `exited` pending until the test times out.
		await child.exited;
		expect(child.proc.signalCode).toBe("SIGKILL");
	});

	// The detached group's leader dies on SIGTERM while a TERM-ignoring
	// descendant keeps the inherited stdout/stderr pipes open. Termination
	// must still escalate to the group after the grace period, or wait() never
	// sees EOF. Rows with a `fromPid` replacement exercise the JS fallback; the
	// unstubbed row drives the real native handle against a live leader whose
	// holder was adopted outside its tree, so only the native group wave can
	// reach it.
	it.skipIf(process.platform === "win32").each([
		[
			"the handle lookup throws",
			() => {
				throw new Error("Value is not an instance of class `Process`");
			},
			false,
		],
		["the handle lookup finds no process", () => null, false],
		["the leader has already exited by signal", () => null, true],
		["the native handle terminates a live leader whose holder left its tree", undefined, false],
	])("kills a pipe-holding group after its leader dies to SIGTERM when %s", async (_name, fromPid, leaderExited) => {
		// Real process lifecycle against the platform clock: fake timers cannot
		// drive child exit or pipe EOF, so the deadlines below only bound failure.
		const GRACE_MS = 100;
		const READY_MS = 2_000;
		const SETTLE_MS = GRACE_MS + 1_000;
		const REAP_MS = 500;
		const marker = `ptree-dead-leader-${process.pid}-${Date.now()}`;
		const holderReparented = fromPid === undefined;
		// Inner shell (and its sleeps, which inherit SIG_IGN) ignore TERM; the
		// outer group leader does not. The readiness line is printed only after
		// the trap is installed.
		const holderScript = `sh -c "trap '' TERM; printf '%s %s\\n' ${marker} \\$\\$; while sleep 1; do :; done"`;
		// Reparented: the subshell exits at once, so the holder is adopted outside
		// the leader's tree yet stays in its process group holding the pipes; the
		// leader then waits as a TERM-killable sleep.
		const script = holderReparented ? `(${holderScript} &); exec sleep 60` : `${holderScript} & wait`;
		const child = spawn(["/bin/sh", "-c", script], { detached: true });
		let holder: Process | null = null;
		let restoreFromPid: (() => void) | undefined;
		try {
			const reader = child.stdout.getReader();
			const decoder = new TextDecoder();
			let text = "";
			const readyDeadline = Bun.sleep(READY_MS).then(() => undefined);
			try {
				while (!text.includes("\n")) {
					const chunk = await Promise.race([reader.read(), readyDeadline]);
					if (!chunk) throw new Error(`descendant did not report readiness within ${READY_MS}ms`);
					if (chunk.done) throw new Error(`stdout closed before readiness: ${JSON.stringify(text)}`);
					text += decoder.decode(chunk.value, { stream: true });
				}
			} finally {
				reader.releaseLock();
			}
			const [readyMarker, pidText] = text.slice(0, text.indexOf("\n")).split(" ");
			expect(readyMarker).toBe(marker);
			const holderPid = Number(pidText);
			expect(Number.isSafeInteger(holderPid) && holderPid > 0, `invalid descendant pid ${pidText}`).toBe(true);
			holder = Process.fromPid(holderPid);
			if (!holder) throw new Error(`descendant ${holderPid} is not observable`);

			if (holderReparented) {
				// A descendant walk from the live leader must find nothing, so the
				// holder is reachable only through the leader's process group. No
				// event reports the subshell's exit, so poll for it within READY_MS.
				const leader = Process.fromPid(child.pid);
				if (!leader) throw new Error(`leader ${child.pid} is not observable`);
				const detachDeadline = Date.now() + READY_MS;
				while (leader.children().length > 0 && Date.now() < detachDeadline) await Bun.sleep(10);
				expect(leader.children(), `holder ${holderPid} is still inside the leader's tree`).toEqual([]);
				expect(leader.status()).toBe(ProcessStatus.Running);
				expect(holder.groupId()).toBe(child.pid);
			}
			if (fromPid) {
				const fromPidSpy = spyOn(Process, "fromPid").mockImplementation(fromPid);
				restoreFromPid = () => fromPidSpy.mockRestore();
			}
			const waiting = child.wait({ allowAbort: true });
			waiting.catch(() => {});
			const reason = new AbortError(new Error("cancelled"), "");
			// kill(reason) makes `exited` reject with `reason` as soon as the leader
			// dies, while wait() only awaits it after pipe EOF. Without a signal or
			// timeout attached nothing else observes it, so capture the rejection
			// here (it is asserted below) instead of leaving it unhandled.
			const leaderExit = child.exited.then(
				code => ({ code }),
				(error: unknown) => ({ error }),
			);
			if (leaderExited) {
				process.kill(-child.pid, "SIGTERM");
				await child.proc.exited;
			}
			child.kill(reason, GRACE_MS);

			const outcome = await Promise.race([
				waiting.then(result => ({ result })),
				Bun.sleep(SETTLE_MS).then(() => undefined),
			]);
			expect(outcome, `wait() did not settle within ${SETTLE_MS}ms of a ${GRACE_MS}ms grace kill`).toBeDefined();
			expect(outcome?.result.exitError).toBe(reason);
			// wait() awaited `exited`, so it has settled with the kill reason.
			const settledExit = await leaderExit;
			expect("error" in settledExit && settledExit.error).toBe(reason);

			const reapDeadline = Date.now() + REAP_MS;
			while (holder.status() === ProcessStatus.Running && Date.now() < reapDeadline) await Bun.sleep(10);
			expect(holder.status(), `TERM-ignoring descendant ${holderPid} survived the kill`).toBe(ProcessStatus.Exited);
		} finally {
			restoreFromPid?.();
			// While Bun has not reaped the leader its PID, and so the PGID, cannot be reused.
			if (child.proc.exitCode === null && child.proc.signalCode === null) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {}
			}
			holder?.killTree(9);
		}
	});
});
