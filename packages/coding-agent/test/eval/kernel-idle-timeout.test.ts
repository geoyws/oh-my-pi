import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { $which, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { disposeAllVmContexts } from "../../src/eval/js/context-manager";
import type { EvalPreludeDefinition } from "../../src/eval/preludes";
import { resolvePythonKernelIdentity } from "../../src/eval/py";
import { callPythonTool, disposeAllKernelSessions, executePython, type PythonResult } from "../../src/eval/py/executor";
import { PythonKernel } from "../../src/eval/py/kernel";
import * as pyToolBridge from "../../src/eval/py/tool-bridge";
import { disposePyToolBridge } from "../../src/eval/py/tool-bridge";
import type { ToolSession } from "../../src/tools";
import { EvalTool } from "../../src/tools/eval";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

let tempDir: TempDir;
let settingsState: SettingsTestState;

beforeEach(() => {
	settingsState = beginSettingsTest();
	tempDir = TempDir.createSync("@eval-kernel-idle-timeout-");
	setAgentDir(path.join(tempDir.path(), "agent"));
});

afterEach(async () => {
	await disposeAllVmContexts();
	await disposeAllKernelSessions();
	await disposePyToolBridge();
	restoreSettingsTestState(settingsState);
	tempDir.removeSync();
});

function makeSession(idleTimeoutSeconds: number): ToolSession {
	const sessionId = `kernel-idle-timeout-${crypto.randomUUID()}`;
	return {
		cwd: tempDir.path(),
		hasUI: false,
		settings: Settings.isolated({
			"async.enabled": false,
			"eval.autoProvision": false,
			"eval.kernelIdleTimeoutSeconds": idleTimeoutSeconds,
			"python.kernelMode": "session",
			"python.interpreter": Bun.env.PYTHON ?? $which("python3") ?? $which("python") ?? "",
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		getSessionId: () => sessionId,
		getEvalSessionId: () => sessionId,
		getToolByName: () => undefined,
	};
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isProcessAlive(pid)) return true;
		await Bun.sleep(50);
	}
	return !isProcessAlive(pid);
}

async function runCell(
	evalTool: EvalTool,
	language: "js" | "py",
	code: string,
	timeout = 30,
): Promise<{ status: string | undefined; output: string }> {
	const result = await evalTool.execute(`cell-${crypto.randomUUID()}`, { language, code, timeout });
	const cell = result.details?.cells?.[0];
	return { status: cell?.status, output: cell?.output ?? "" };
}

function pidFrom(output: string): number {
	const match = /pid=(\d+)/.exec(output);
	if (!match) throw new Error(`no pid in cell output: ${output}`);
	return Number(match[1]);
}

// Real Python kernels only under PI_PYTHON_INTEGRATION=1, like the other real-kernel suites.
const PYTHON_INTEGRATION = Bun.env.PI_PYTHON_INTEGRATION === "1";

const CELLS = {
	js: {
		label: "JavaScript",
		setState: "globalThis.idleProbe = 41; print('pid=' + process.pid)",
		readState: "print('pid=' + process.pid + ' probe=' + typeof globalThis.idleProbe)",
		missingState: "probe=undefined",
		longCell: "await Bun.sleep(2_500); print('pid=' + process.pid)",
	},
	py: {
		label: "Python",
		setState: "import os\nidle_probe = 41\nprint(f'pid={os.getpid()}')",
		readState: "import os\nprint(f\"pid={os.getpid()} probe={'idle_probe' in globals()}\")",
		missingState: "probe=False",
		longCell: "import asyncio, os\nawait asyncio.sleep(2.5)\nprint(f'pid={os.getpid()}')",
	},
} as const;

// Real timers and real runtime processes throughout: the JS eval subprocess
// (`__omp_worker_js_eval_process`) and the Python runner subprocess. The idle
// timer races real subprocess I/O and OS process exit, which a fake clock cannot
// advance; waits poll the real condition where one exists.
describe("eval.kernelIdleTimeoutSeconds", () => {
	for (const language of ["js", "py"] as const) {
		const cells = CELLS[language];

		it.skipIf(language === "py" && !PYTHON_INTEGRATION)(
			`${language}: reaps an idle kernel process and reports the reset on the next eval`,
			async () => {
				const evalTool = new EvalTool(makeSession(1));
				const first = await runCell(evalTool, language, cells.setState);
				expect(first.status).toBe("complete");
				const firstPid = pidFrom(first.output);
				// The runtime must be a real subprocess, not this test process or a Worker thread.
				expect(firstPid).not.toBe(process.pid);
				expect(isProcessAlive(firstPid)).toBe(true);

				expect(await waitForExit(firstPid, 10_000)).toBe(true);

				const next = await runCell(evalTool, language, cells.readState);
				expect(next.status).toBe("complete");
				expect(next.output).toContain(
					`[kernel] The previous ${cells.label} kernel was shut down after 1s with no cell running`,
				);
				expect(next.output).toContain(cells.missingState);
				const nextPid = pidFrom(next.output);
				expect(nextPid).not.toBe(firstPid);
				expect(isProcessAlive(nextPid)).toBe(true);

				// The note is delivered once: the following cell reuses the fresh kernel silently.
				const after = await runCell(evalTool, language, cells.readState);
				expect(after.output).not.toContain("[kernel] The previous");
				expect(pidFrom(after.output)).toBe(nextPid);
			},
			30_000,
		);

		it.skipIf(language === "py" && !PYTHON_INTEGRATION)(
			`${language}: never reaps a kernel while a cell outlives the idle window`,
			async () => {
				const evalTool = new EvalTool(makeSession(1));
				const warm = await runCell(evalTool, language, cells.setState);
				const pid = pidFrom(warm.output);

				const long = await runCell(evalTool, language, cells.longCell);
				expect(long.status).toBe("complete");
				expect(long.output).not.toContain("[kernel] The previous");
				expect(pidFrom(long.output)).toBe(pid);
				expect(isProcessAlive(pid)).toBe(true);

				// The window restarts when the cell ends, so the state is still there right after.
				const next = await runCell(evalTool, language, cells.readState);
				expect(next.output).not.toContain("[kernel] The previous");
				expect(pidFrom(next.output)).toBe(pid);
				expect(next.output).not.toContain(cells.missingState);
			},
			30_000,
		);

		it.skipIf(language === "py" && !PYTHON_INTEGRATION)(
			`${language}: keeps the kernel when the idle timeout is 0`,
			async () => {
				const evalTool = new EvalTool(makeSession(0));
				const pid = pidFrom((await runCell(evalTool, language, cells.setState)).output);
				await Bun.sleep(1_500);
				expect(isProcessAlive(pid)).toBe(true);
				const next = await runCell(evalTool, language, cells.readState);
				expect(pidFrom(next.output)).toBe(pid);
				expect(next.output).not.toContain(cells.missingState);
			},
			30_000,
		);
	}

	// A realistic session installs non-empty preludes (e.g. the default browser prelude) on every fresh
	// kernel; their sync is an awaited step bounded by the cell's remaining budget. This one takes 500 ms,
	// so it deterministically overruns a budget that has already run out.
	const idleProbePrelude: EvalPreludeDefinition = {
		name: "idle-probe",
		documentation: "Test prelude.",
		javascript: "",
		python: "__import__('time').sleep(0.5)\nomp_idle_probe = 1",
		exports: ["omp_idle_probe"],
		invoke: async () => ({ content: [] }),
	};
	for (const [variant, toolSession] of [
		["without a tool session", () => undefined],
		[
			"with a tool session that installs a prelude",
			(): ToolSession => ({ ...makeSession(0), getEvalPreludes: () => [idleProbePrelude] }),
		],
	] as const) {
		it.skipIf(!PYTHON_INTEGRATION)(
			`py: delivers the restart note when the cell after a reap is out of time before it runs (${variant})`,
			async () => {
				const options = {
					cwd: tempDir.path(),
					sessionId: `kernel-idle-deadline-${crypto.randomUUID()}`,
					interpreter: Bun.env.PYTHON ?? $which("python3") ?? $which("python") ?? undefined,
					kernelIdleTimeoutMs: 300,
					toolSession: toolSession(),
				};
				const first = await executePython("import os\nprint(f'pid={os.getpid()}')", options);
				expect(await waitForExit(pidFrom(first.output), 10_000)).toBe(true);

				// Deterministic hook: the fresh kernel is real, but becomes ready only after this cell's
				// deadline, so every remaining step (prelude sync, execution) is out of time.
				const originalStart = PythonKernel.start;
				PythonKernel.start = async startOptions => {
					const kernel = await originalStart.call(PythonKernel, {
						...startOptions,
						signal: undefined,
						deadlineMs: undefined,
					});
					const deadlineMs = startOptions.deadlineMs ?? Date.now();
					while (Date.now() <= deadlineMs) await Bun.sleep(10);
					return kernel;
				};
				let expired: PythonResult;
				try {
					expired = await executePython("print('never runs')", { ...options, timeoutMs: 1_000 });
				} finally {
					PythonKernel.start = originalStart;
				}
				expect(expired.cancelled).toBe(true);
				expect(expired.output).toContain(
					"[kernel] The previous Python kernel was shut down after 1s with no cell running",
				);
				expect(expired.output).toContain("timed out");
				expect(expired.output).not.toContain("never runs");

				// Delivered once: the next cell does not repeat it.
				const after = await executePython("print('fresh')", options);
				expect(after.output).toContain("fresh");
				expect(after.output).not.toContain("[kernel] The previous");
			},
			30_000,
		);
	}

	it.skipIf(!PYTHON_INTEGRATION)(
		"py: never reaps a kernel while an eval-defined tool call waits on a slow bridge start",
		async () => {
			const session = makeSession(0.5);
			const evalTool = new EvalTool(session);
			const defined = await runCell(
				evalTool,
				"py",
				"import os\n@tool\ndef ping() -> dict:\n    '''Report the kernel pid.'''\n    return {'pid': os.getpid()}\nprint(f'pid={os.getpid()}')",
			);
			expect(defined.status).toBe("complete");
			const pid = pidFrom(defined.output);

			// Deterministic hook: hold the process-wide bridge start open across the idle window.
			const ensureBridge = pyToolBridge.ensurePyToolBridge;
			const bridgeEntered = Promise.withResolvers<void>();
			const releaseBridge = Promise.withResolvers<void>();
			const bridgeSpy = spyOn(pyToolBridge, "ensurePyToolBridge").mockImplementation(async () => {
				bridgeEntered.resolve();
				await releaseBridge.promise;
				return await ensureBridge();
			});
			try {
				const call = callPythonTool("ping", {}, { ...resolvePythonKernelIdentity(session), toolSession: session });
				await bridgeEntered.promise;
				// The idle timer is a real host timer racing a real kernel; wait out two windows.
				await Bun.sleep(1_000);
				releaseBridge.resolve();
				expect(await call).toMatchObject({ ok: true, value: { pid } });
			} finally {
				releaseBridge.resolve();
				bridgeSpy.mockRestore();
			}
			expect(isProcessAlive(pid)).toBe(true);
		},
		30_000,
	);
});
