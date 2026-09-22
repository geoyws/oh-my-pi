import { afterAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { disposeAllKernelSessions } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import { checkPythonKernelAvailability } from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";

// `bun test` short-circuits the availability check, so probe for real: these
// tests spawn an actual interpreter and measure its pids.
const PYTHON_AVAILABLE = (await checkPythonKernelAvailability(process.cwd(), undefined, { forceProbe: true })).ok;

function makeSession(evalSessionId: string): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getEvalSessionId: () => evalSessionId,
		settings: Settings.isolated(),
	} as unknown as ToolSession;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Best-effort cleanup so a failed assertion never leaks a test's own children. */
function killPid(pid: number | undefined): void {
	if (pid === undefined) return;
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// Already gone, which is the state we wanted.
	}
}

/**
 * Teardown is asynchronous in the kernel, not in this process, so there is no
 * promise or event to await: poll the real condition (the pid is gone) under a
 * bounded deadline instead of guessing a single sleep length.
 */
async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (isRunning(pid) && Date.now() < deadline) await Bun.sleep(25);
	return !isRunning(pid);
}

/**
 * Python source for a cell that cannot be interrupted politely: it ignores
 * SIGINT, records a one-shot side effect, spawns a child, then sleeps far past
 * any deadline. Escalation to a hard kill is the only way out.
 */
function uninterruptibleCell(markerPath: string, pidPath: string): string {
	return [
		"import json, os, signal, subprocess, time",
		"signal.signal(signal.SIGINT, signal.SIG_IGN)",
		`open(${JSON.stringify(markerPath)}, "a").write("ran\\n")`,
		'child = subprocess.Popen(["sleep", "120"])',
		`open(${JSON.stringify(pidPath)}, "w").write(json.dumps({"kernel": os.getpid(), "child": child.pid}))`,
		"time.sleep(120)",
	].join("\n");
}

/**
 * Hard-timeout containment for the retained Python kernel: a cell that ignores
 * SIGINT must still be bounded, and killing the kernel must take its children
 * with it, leave a clean kernel for the next cell, never replay the dead cell,
 * and never disturb another language's retained runtime.
 */
describe.skipIf(!PYTHON_AVAILABLE)("EvalTool python timeout containment", () => {
	afterAll(async () => {
		await disposeAllKernelSessions();
		await disposeAllVmContexts();
	});

	it("hard-kills an uninterruptible kernel with its children and keeps other runtimes alive", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-py-timeout-"));
		const markerFile = path.join(dir, "marker.txt");
		const pidFile = path.join(dir, "pids.json");
		let pids: { kernel: number; child: number } | undefined;
		try {
			const python = new EvalTool(makeSession("py-timeout-victim"));
			const javascript = new EvalTool(makeSession("py-timeout-js-bystander"));
			// Cold-start both runtimes outside the measured window.
			await python.execute("seed-py", { language: "py", code: "retained = 41" });
			await javascript.execute("seed-js", { language: "js", code: "globalThis.retained = 7;" });

			// `timeout: 1` is the public parameter; the production clamp already
			// resolves it to one second, so no clamp mock is needed.
			const startedAt = Date.now();
			const result = await python.execute("call-runaway", {
				language: "py",
				code: uninterruptibleCell(markerFile, pidFile),
				timeout: 1,
			});
			const elapsedMs = Date.now() - startedAt;
			// Recover the pids before any assertion so a failure still cleans up.
			pids = JSON.parse(fs.readFileSync(pidFile, "utf8")) as { kernel: number; child: number };

			const text = textOf(result);
			expect(text).toContain("timed out");
			// Truthful about which recovery happened: interrupt failed, so the
			// kernel (and its state) is gone rather than merely interrupted.
			expect(text).toContain("the kernel has been killed");
			expect(result.details?.cells?.[0]?.exitCode).toBeUndefined();
			// Bounded by the cell budget plus the interrupt-escalation window,
			// not by the cell's own 120s sleep.
			expect(elapsedMs).toBeLessThan(30_000);

			expect(pids.kernel).not.toBe(process.pid);
			expect(await waitForExit(pids.kernel, 15_000)).toBe(true);
			// The kernel leads its own group; a hard kill that skipped the group
			// would leave this `sleep` running for the rest of the omp process.
			expect(await waitForExit(pids.child, 15_000)).toBe(true);

			const recovered = await python.execute("after-timeout", {
				language: "py",
				code: "print('retained=' + repr(globals().get('retained')))",
			});
			// A fresh kernel: the timed-out cell's state is gone, and the next
			// cell runs normally on top of it.
			expect(textOf(recovered)).toContain("retained=None");
			expect(recovered.details?.cells?.[0]?.exitCode).toBe(0);
			// The killed cell is never re-run: its one-shot side effect stayed one.
			expect(fs.readFileSync(markerFile, "utf8")).toBe("ran\n");

			const survivor = await javascript.execute("js-after-py-kill", {
				language: "js",
				code: "print('retained=' + globalThis.retained);",
			});
			expect(textOf(survivor)).toContain("retained=7");
		} finally {
			killPid(pids?.child);
			killPid(pids?.kernel);
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}, 120_000);

	it("still times out an uninterruptible cell that forges a bridge timeout pause", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-py-forged-"));
		const markerFile = path.join(dir, "marker.txt");
		const pidFile = path.join(dir, "pids.json");
		let pids: { kernel: number; child: number } | undefined;
		try {
			const python = new EvalTool(makeSession("py-timeout-forged-pause"));
			await python.execute("seed", { language: "py", code: "retained = 41" });

			const startedAt = Date.now();
			const result = await python.execute("call-forged-pause", {
				language: "py",
				// A display bundle is the runtime's own status channel, so the cell
				// can mint what looks exactly like a host bridge pause.
				code: [
					'__omp_display({"application/x-omp-status": {"op": "timeout-pause"}}, raw=True)',
					uninterruptibleCell(markerFile, pidFile),
				].join("\n"),
				timeout: 1,
			});
			const elapsedMs = Date.now() - startedAt;
			// Recover the pids before any assertion so a failure still cleans up.
			pids = JSON.parse(fs.readFileSync(pidFile, "utf8")) as { kernel: number; child: number };

			expect(textOf(result)).toContain("timed out");
			// Honouring the forged pause would let the cell's 120s sleep run out.
			expect(elapsedMs).toBeLessThan(30_000);

			expect(await waitForExit(pids.kernel, 15_000)).toBe(true);
			expect(await waitForExit(pids.child, 15_000)).toBe(true);
		} finally {
			killPid(pids?.child);
			killPid(pids?.kernel);
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}, 120_000);

	/**
	 * Boundary between the two recovery paths. A cell the runner *can* interrupt
	 * keeps its kernel, so the cell's children are not orphaned: the runtime
	 * still holds their handles and the next cell can manage them. Reaping them
	 * from the host would destroy retained state that the user deliberately
	 * started, and signalling the kernel's group would kill the kernel we just
	 * chose to keep. Child reaping is therefore tied to the hard kill above.
	 */
	it("keeps the kernel and its cell-spawned children after a soft interrupt", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-py-soft-"));
		const pidFile = path.join(dir, "pids.json");
		let pids: { kernel: number; child: number } | undefined;
		try {
			const python = new EvalTool(makeSession("py-timeout-soft"));
			await python.execute("seed", { language: "py", code: "retained = 41" });

			// `timeout: 1` already resolves to one second through the real clamp.
			const result = await python.execute("call-sleeper", {
				language: "py",
				code: [
					"import json, os, subprocess, time",
					'child = subprocess.Popen(["sleep", "120"])',
					`open(${JSON.stringify(pidFile)}, "w").write(json.dumps({"kernel": os.getpid(), "child": child.pid}))`,
					"time.sleep(120)",
				].join("\n"),
				timeout: 1,
			});
			// Recover the pids before any assertion so a failure still cleans up.
			pids = JSON.parse(fs.readFileSync(pidFile, "utf8")) as { kernel: number; child: number };

			const text = textOf(result);
			expect(text).toContain("timed out");
			expect(text).toContain("kernel interrupted but remains running");

			expect(isRunning(pids.kernel)).toBe(true);
			expect(isRunning(pids.child)).toBe(true);

			// The retained kernel still owns both its state and the child, so the
			// next cell can observe and clean it up.
			const next = await python.execute("after-interrupt", {
				language: "py",
				code: "child.kill(); child.wait(); print('retained=' + repr(retained))",
			});
			expect(textOf(next)).toContain("retained=41");
			expect(await waitForExit(pids.child, 10_000)).toBe(true);
		} finally {
			killPid(pids?.child);
			killPid(pids?.kernel);
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}, 120_000);

	it("leaves a retained python kernel untouched when a JS cell times out", async () => {
		const python = new EvalTool(makeSession("js-timeout-py-bystander"));
		const javascript = new EvalTool(makeSession("js-timeout-victim"));
		await python.execute("seed-py", { language: "py", code: "retained = 41" });
		await javascript.execute("seed-js", { language: "js", code: "globalThis.retained = 7;" });

		// `timeout: 1` already resolves to one second through the real clamp.
		const timedOut = await javascript.execute("call-runaway", {
			language: "js",
			code: "const end = Date.now() + 120_000; while (Date.now() < end) {}",
			timeout: 1,
		});
		expect(textOf(timedOut)).toContain("timed out after 1 seconds");

		const survivor = await python.execute("py-after-js-kill", {
			language: "py",
			code: "print('retained=' + repr(retained))",
		});
		expect(textOf(survivor)).toContain("retained=41");
	}, 120_000);
});
