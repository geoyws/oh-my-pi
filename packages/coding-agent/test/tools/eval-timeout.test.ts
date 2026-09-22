import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EVAL_TIMEOUT_PAUSE_OP } from "@oh-my-pi/pi-coding-agent/eval/bridge-timeout";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import * as toolTimeouts from "@oh-my-pi/pi-coding-agent/tools/tool-timeouts";
import { TempDir } from "@oh-my-pi/pi-utils";

/** Mutable shape of the fake session so a tool can be wired in after construction. */
interface FakeToolSession {
	getToolByName?: (name: string) => AgentTool | undefined;
	asyncJobManager?: AsyncJobManager;
}

function makeSession(
	evalSessionId?: string,
	extras: { agentId?: string; asyncJobManager?: AsyncJobManager; tools?: AgentTool[]; settings?: Settings } = {},
): ToolSession {
	const tools = extras.tools ?? [];
	return {
		cwd: process.cwd(),
		hasUI: false,
		taskDepth: 0,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getSessionId: () => evalSessionId ?? "eval-timeout-session",
		getEvalSessionId: evalSessionId ? () => evalSessionId : undefined,
		getAgentId: extras.agentId ? () => extras.agentId : undefined,
		getToolByName: (name: string) => tools.find(tool => tool.name === name),
		asyncJobManager: extras.asyncJobManager,
		settings: extras.settings ?? Settings.isolated(),
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

/**
 * Process teardown is asynchronous in the kernel, not in this process, so there
 * is no promise or event to await: poll the real condition (the pid is gone)
 * under a bounded deadline instead of guessing a single sleep length.
 */
async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (isRunning(pid) && Date.now() < deadline) await Bun.sleep(25);
	return !isRunning(pid);
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
 * Defends the contract that a cell which does not delegate to an `agent()`/
 * `completion()` bridge call is bounded by a *plain wall-clock* timeout — not the
 * activity watchdog, which now only extends the budget while a bridge call is in
 * flight. Regression guard for the watchdog killing ordinary compute cells and
 * surfacing a misleading "of inactivity" message.
 */
describe("EvalTool timeout semantics", () => {
	afterAll(async () => {
		await disposeAllVmContexts();
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("disables the cell timeout when timeout is zero", async () => {
		// Keep the integration path real while making a mistakenly armed timeout
		// fail quickly. Fake timers cannot drive the isolated worker's clock, and
		// a zero timeout must bypass the production clamp entirely.
		vi.spyOn(toolTimeouts, "clampTimeout").mockReturnValue(0.05);
		const tool = new EvalTool(makeSession());
		const result = await tool.execute("call-unlimited-timeout", {
			language: "js",
			code: "await Bun.sleep(100); print('completed');",
			timeout: 0,
		});

		expect(result.content.some(block => block.type === "text" && block.text.includes("completed"))).toBe(true);
		expect(result.details?.cells?.[0]?.status).toBe("complete");
	});

	it("bounds a compute cell (no agent/completion) by a plain wall-clock timeout", async () => {
		// Exercise the real worker cancellation path without spending a full
		// second waiting for the requested public timeout.
		vi.spyOn(toolTimeouts, "clampTimeout").mockReturnValue(0.05);
		const tool = new EvalTool(makeSession());
		const result = await tool.execute("call-compute-timeout", {
			language: "js",
			code: "await Bun.sleep(2000); return 'never';",
			timeout: 1,
		});

		const text = result.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map(block => block.text)
			.join("\n");
		expect(text).toContain("timed out after 1 seconds");
		// The new wording is a plain wall-clock timeout, not an inactivity stall.
		expect(text).not.toContain("inactivity");
		expect(text).not.toContain("never");

		const cell = result.details?.cells?.[0];
		expect(cell?.exitCode).toBeUndefined();
	});

	it("reports a dead JS worker instead of waiting for the cell timeout", async () => {
		const tool = new EvalTool(makeSession());
		const result = await tool.execute("call-worker-exit", {
			language: "js",
			code: "process.exit(0);",
			timeout: 1,
		});

		const text = result.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map(block => block.text)
			.join("\n");
		expect(text).toContain("JS eval worker exited");
		expect(text).not.toContain("timed out");

		const cell = result.details?.cells?.[0];
		expect(cell?.status).toBe("error");
		expect(cell?.exitCode).toBe(1);
	});

	/**
	 * Pause authority over the cell deadline is host-owned. Evaluated code can
	 * reach the status data channel (`__omp_emit_status__`), and forwarding a
	 * `timeout-pause` from there disarmed the watchdog for as long as the cell
	 * cared to run — a synchronous runaway then never timed out at all. The
	 * runtime→host boundary now drops those ops, so the deadline stays armed.
	 */
	it("still times out a runaway cell that forges a bridge timeout pause", async () => {
		const tool = new EvalTool(makeSession("eval-timeout-forged-pause"));
		// Cold-start the worker outside the measured window: a one-second budget
		// bounds the cell's own work, not the runtime's module graph load.
		await tool.execute("seed", { language: "js", code: "globalThis.seeded = true;" });

		// `timeout: 1` is the public parameter and the production clamp already
		// resolves it to one second, so no clamp mock is needed here.
		const startedAt = Date.now();
		const result = await tool.execute("call-forged-pause", {
			language: "js",
			code: `globalThis.__omp_emit_status__(${JSON.stringify(EVAL_TIMEOUT_PAUSE_OP)});
const end = Date.now() + 30_000;
while (Date.now() < end) {}`,
			timeout: 1,
		});
		const elapsedMs = Date.now() - startedAt;

		expect(textOf(result)).toContain("timed out after 1 seconds");
		// The cell asked for 30s of synchronous work; honouring its forged pause
		// is the only way this takes anywhere near that long.
		expect(elapsedMs).toBeLessThan(15_000);
		expect(result.details?.cells?.[0]?.exitCode).toBeUndefined();
	}, 60_000);

	/**
	 * A hard timeout must contain the *whole* runtime it kills. The JS worker is
	 * spawned detached, so it leads its own process group: SIGKILLing the leader
	 * pid alone left everything the cell had spawned running for the rest of the
	 * omp process lifetime (the #7714 failure mode already fixed for managed
	 * kernels). The sweep is also strictly scoped — it must never reach a
	 * detached process the host owns outside that group.
	 */
	it("reaps the timed-out JS worker and its children without touching unowned processes", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-eval-timeout-"));
		const pidFile = path.join(dir, "pids.json");
		// Host-owned detached work: in its own session/group, so a correctly
		// scoped sweep of the worker's group cannot signal it.
		const bystander = Bun.spawn(["sleep", "120"], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			detached: true,
		});
		let cellPids: { worker: number; child: number } | undefined;
		try {
			const tool = new EvalTool(makeSession("eval-timeout-containment"));
			await tool.execute("seed", { language: "js", code: "globalThis.seeded = true;" });

			const startedAt = Date.now();
			const result = await tool.execute("call-runaway", {
				language: "js",
				// Spawn a child, then wedge the runtime synchronously: the only way
				// out is destructive worker termination.
				code: `const child = Bun.spawn(["sleep", "120"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
await Bun.write(${JSON.stringify(pidFile)}, JSON.stringify({ worker: process.pid, child: child.pid }));
const end = Date.now() + 120_000;
while (Date.now() < end) {}`,
				timeout: 1,
			});
			const elapsedMs = Date.now() - startedAt;
			// Recover the pids before any assertion so a failure still cleans up.
			cellPids = JSON.parse(fs.readFileSync(pidFile, "utf8")) as { worker: number; child: number };

			const text = textOf(result);
			expect(text).toContain("timed out after 1 seconds");
			// State loss is explicit; the cell is never silently replayed.
			expect(text).toContain("VM state was reset");
			expect(result.details?.cells?.[0]?.exitCode).toBeUndefined();
			// Bounded by the cell timeout plus teardown, not by the cell's own 120s.
			expect(elapsedMs).toBeLessThan(30_000);

			// Process isolation is the precondition for the group sweep; an
			// in-thread fallback worker could not be killed at all.
			expect(cellPids.worker).not.toBe(process.pid);
			expect(await waitForExit(cellPids.worker, 15_000)).toBe(true);
			expect(await waitForExit(cellPids.child, 15_000)).toBe(true);
			expect(isRunning(bystander.pid)).toBe(true);
		} finally {
			// A failed assertion must not leak the cell's processes either.
			killPid(cellPids?.child);
			killPid(cellPids?.worker);
			bystander.kill("SIGKILL");
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);

	/**
	 * Recovery contract: the killed runtime is replaced, not resurrected — the
	 * next cell runs on a clean worker with the lost state visibly gone, and a
	 * different eval session keeps its own retained state throughout.
	 */
	it("gives the next cell a clean worker and leaves other sessions untouched", async () => {
		const victim = new EvalTool(makeSession("eval-timeout-victim"));
		const bystander = new EvalTool(makeSession("eval-timeout-bystander"));
		await victim.execute("seed-victim", { language: "js", code: "globalThis.retained = 41;" });
		await bystander.execute("seed-bystander", { language: "js", code: "globalThis.retained = 7;" });

		// No clamp mock: `timeout: 1` already resolves to one second.
		const timedOut = await victim.execute("call-runaway", {
			language: "js",
			code: "const end = Date.now() + 120_000; while (Date.now() < end) {}",
			timeout: 1,
		});
		expect(textOf(timedOut)).toContain("timed out after 1 seconds");

		const recovered = await victim.execute("after-timeout", {
			language: "js",
			code: "print('retained=' + typeof globalThis.retained + ' sum=' + (20 + 22));",
		});
		expect(textOf(recovered)).toContain("retained=undefined sum=42");
		expect(recovered.details?.cells?.[0]?.status).toBe("complete");

		const survivor = await bystander.execute("other-session", {
			language: "js",
			code: "print('retained=' + globalThis.retained);",
		});
		expect(textOf(survivor)).toContain("retained=7");
	}, 60_000);

	/**
	 * Truthfulness has to survive the session file, not just the in-memory
	 * result: a timed-out cell that reopens as `exitCode: 0`/`complete` would
	 * tell a resumed model the cell succeeded and that its variables are still
	 * there. Round-trips the real tool result through the session store.
	 */
	it("keeps a timed-out cell truthful across a session save and reopen", async () => {
		using tempDir = TempDir.createSync("@omp-eval-timeout-session-");
		const sessionDir = path.join(tempDir.path(), "sessions");
		const sessionManager = SessionManager.create(tempDir.path(), sessionDir);
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("expected a persisted session file");
		// A fresh session stays in memory until something forces it out; the
		// round trip under test is the on-disk one.
		await sessionManager.ensureOnDisk();

		const tool = new EvalTool(makeSession("eval-timeout-persisted"));
		await tool.execute("seed", { language: "js", code: "globalThis.retained = 41;" });
		const timedOut = await tool.execute("call-runaway", {
			language: "js",
			code: "const end = Date.now() + 120_000; while (Date.now() < end) {}",
			timeout: 1,
		});

		// Exactly what the agent loop persists for a completed tool call.
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "call-runaway",
			toolName: "eval",
			content: timedOut.content,
			details: timedOut.details,
			isError: timedOut.isError === true,
			timestamp: Date.now(),
		});
		await sessionManager.flush();
		await sessionManager.close();

		const reopened = await SessionManager.open(sessionFile, sessionDir);
		try {
			const entry = reopened.getBranch().find(item => item.type === "message" && item.message.role === "toolResult");
			if (entry?.type !== "message" || entry.message.role !== "toolResult") {
				throw new Error("expected a persisted eval toolResult entry");
			}
			const persisted = entry.message.details as { cells?: Array<Record<string, unknown>> } | undefined;
			const cell = persisted?.cells?.[0];
			expect(cell?.status).toBe("error");
			// A JSON round trip drops `undefined`; what must never come back is a
			// number, which would read as a real process exit status.
			expect(cell?.exitCode).toBeUndefined();
			const persistedText = entry.message.content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map(block => block.text)
				.join("\n");
			expect(persistedText).toContain("timed out after 1 seconds");
			expect(persistedText).toContain("VM state was reset");
			expect(entry.message.isError).toBe(true);
		} finally {
			await reopened.close();
		}

		// The claim the persisted text makes about state loss is true of the
		// runtime a resumed session would actually get.
		const afterReopen = await tool.execute("after-reopen", {
			language: "js",
			code: "print('retained=' + typeof globalThis.retained);",
		});
		expect(textOf(afterReopen)).toContain("retained=undefined");
	}, 60_000);

	/**
	 * A cell hard-timeout tears down a runtime, not the session's background
	 * work. Managed jobs the eval session started live in the host process and
	 * are owned by the agent, so an unrelated runtime kill must leave them
	 * registered, owned, and still bounded by their own deadline.
	 */
	it("leaves a managed job started by eval registered when a later cell hard-times out", async () => {
		const manager = new AsyncJobManager({});
		const session = makeSession("eval-timeout-managed-job", {
			agentId: "Main",
			asyncJobManager: manager,
			settings: Settings.isolated({ "async.enabled": true, "eval.autoBackground.enabled": false }),
		});
		// BashTool's schema-bound `execute` signature does not unify with the
		// erased `AgentTool` the session registry hands the bridge; the runtime
		// object is exactly what production registers.
		const bash = new BashTool(session) as unknown as AgentTool;
		(session as unknown as FakeToolSession).getToolByName = name => (name === "bash" ? bash : undefined);
		const tool = new EvalTool(session);
		try {
			// Managed background work owned by the session, started from a cell.
			const started = await tool.execute("start-managed", {
				language: "js",
				code: `const started = await tool.bash({ i: "Sleeping in the background", command: "sleep 30", timeout: 15, async: true });
print(JSON.stringify(started.details.async));`,
			});
			const jobId = (JSON.parse(textOf(started).trim()) as { jobId: string }).jobId;
			expect(manager.getJob(jobId)?.status).toBe("running");

			const timedOut = await tool.execute("call-runaway", {
				language: "js",
				code: "const end = Date.now() + 120_000; while (Date.now() < end) {}",
				timeout: 1,
			});
			expect(textOf(timedOut)).toContain("timed out after 1 seconds");

			// The live registry, not a snapshot the cell handed back.
			const job = manager.getJob(jobId);
			expect(job?.status).toBe("running");
			expect(job?.ownerId).toBe("Main");
			expect(manager.getRunningJobs({ ownerId: "Main" }).map(entry => entry.id)).toContain(jobId);

			// Its own 15s deadline still governs it: a job killed with the runtime
			// would have settled at the cell's 1s timeout instead.
			await job?.promise.catch(() => {});
			const settled = manager.getJob(jobId);
			expect(settled?.status).toBe("failed");
			expect(Date.now() - (settled?.startTime ?? 0)).toBeGreaterThan(10_000);
		} finally {
			manager.cancelAll();
			await manager.dispose({ timeoutMs: 5_000 });
		}
	}, 60_000);

	/**
	 * Timeout authority is the channel, not the op string. An ordinary session
	 * tool may simply be *named* `timeout-pause`, and its status event travels
	 * the generic host sink; reading that as a deadline suspension disarmed the
	 * watchdog with no matching resume.
	 */
	it("does not let a tool named timeout-pause disarm the cell deadline", async () => {
		const collidingTool: AgentTool = {
			name: EVAL_TIMEOUT_PAUSE_OP,
			label: "Timeout Pause",
			description: "Ordinary tool whose name collides with the reserved control op",
			parameters: type({}),
			execute: async () => ({ content: [{ type: "text", text: "called" }] }),
		};
		const tool = new EvalTool(makeSession("eval-timeout-name-collision", { tools: [collidingTool] }));
		await tool.execute("seed", { language: "js", code: "globalThis.seeded = true;" });

		const startedAt = Date.now();
		const result = await tool.execute("call-colliding-tool", {
			language: "js",
			code: `await tool[${JSON.stringify(EVAL_TIMEOUT_PAUSE_OP)}]({});
const end = Date.now() + 30_000;
while (Date.now() < end) {}`,
			timeout: 1,
		});
		const elapsedMs = Date.now() - startedAt;

		expect(textOf(result)).toContain("timed out after 1 seconds");
		expect(elapsedMs).toBeLessThan(15_000);
	}, 60_000);
});
