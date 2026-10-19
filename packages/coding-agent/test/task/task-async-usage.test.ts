/**
 * Contracts: background `task` jobs publish their child's model usage.
 *
 * An rpc/eval consumer sees async subagents only through `wait`/`cancel`
 * results and `async-result` deliveries, so those surfaces must carry the
 * child's full usage (input/output/cacheRead/cacheWrite/totalTokens and billed
 * cost) — and count each job exactly once.
 *
 * 1. `wait` reports each job's own usage (never a batch sibling's) and sums
 *    the jobs it consumes into `details.usage`; a repeated wait keeps the
 *    per-job status usage but adds nothing to the aggregate.
 * 2. A mixed blocking+async call bills the inline child on the task result and
 *    the async child on the wait — the batch's inline aggregate riding in the
 *    job's details is never attributed to the job.
 * 3. A running job exposes its live usage; a cancelled or failed job reports
 *    its partial usage once its run settles — from the child's result, or the
 *    last live usage when the child threw without one.
 * 4. An auto-delivered result carries the usage, and a later wait does not
 *    bill it again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { Usage } from "@oh-my-pi/pi-ai";
import { buildJobResult, undeliveredJobs } from "@oh-my-pi/pi-coding-agent/async/job-control";
import { type AsyncJobDeliverySink, AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import {
	type AsyncResultDetails,
	buildAsyncResultBatchMessage,
} from "@oh-my-pi/pi-coding-agent/session/async-job-delivery";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { AgentProgress, SingleResult, TaskParams } from "@oh-my-pi/pi-tui/tools/task";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

const scoutAgent: AgentDefinition = {
	name: "scout",
	description: "Read-only scout",
	systemPrompt: "You are a scout.",
	source: "bundled",
	blocking: true,
};

function createSession(manager: AsyncJobManager): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": true, "task.batch": true }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getAgentId: () => null,
		asyncJobManager: manager,
	} as unknown as ToolSession;
}

/** Distinct, non-round values per bucket so a swapped or dropped field shows. */
function usage(seed: number): Usage {
	const input = 1000 * seed + 1;
	const output = 100 * seed + 2;
	const cacheRead = 10_000 * seed + 3;
	const cacheWrite = 500 * seed + 4;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: {
			input: 0.001 * seed,
			output: 0.0025 * seed,
			cacheRead: 0.0001 * seed,
			cacheWrite: 0.0005 * seed,
			total: 0.0041 * seed,
		},
	};
}

/** Expected aggregate, summed in the same job order the wait reports. */
function sum(...usages: Usage[]): Usage {
	const total: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	for (const u of usages) {
		total.input += u.input;
		total.output += u.output;
		total.cacheRead += u.cacheRead;
		total.cacheWrite += u.cacheWrite;
		total.totalTokens += u.totalTokens;
		total.cost.input += u.cost.input;
		total.cost.output += u.cost.output;
		total.cost.cacheRead += u.cost.cacheRead;
		total.cost.cacheWrite += u.cost.cacheWrite;
		total.cost.total += u.cost.total;
	}
	return total;
}

function makeResult(id: string, agent: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id,
		agent,
		agentSource: "bundled",
		task: "task prompt",
		assignment: "Do the thing.",
		exitCode: 0,
		output: `${id} output.`,
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
		...overrides,
	};
}

function liveProgress(id: string, liveUsage: Usage): AgentProgress {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "task prompt",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 1,
		tokens: liveUsage.input + liveUsage.output + liveUsage.cacheWrite,
		cost: liveUsage.cost.total,
		durationMs: 1,
		usage: liveUsage,
	};
}

describe("async task child usage", () => {
	const managers: AsyncJobManager[] = [];
	const gates = new Map<string, PromiseWithResolvers<void>>();

	function createManager(onJobComplete: AsyncJobDeliverySink = () => {}): AsyncJobManager {
		const manager = new AsyncJobManager({ onJobComplete });
		managers.push(manager);
		return manager;
	}

	function gate(id: string): PromiseWithResolvers<void> {
		let entry = gates.get(id);
		if (!entry) {
			entry = Promise.withResolvers<void>();
			gates.set(id, entry);
		}
		return entry;
	}

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent, scoutAgent],
			projectAgentsDir: null,
		});
	});

	afterEach(async () => {
		for (const entry of gates.values()) entry.resolve();
		gates.clear();
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 1000 });
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("wait reports each job's own usage and bills consumed jobs exactly once", async () => {
		const usageById: Record<string, Usage> = { WorkerA: usage(1), WorkerB: usage(2) };
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			await gate(id).promise;
			return makeResult(id, options.agent.name, { usage: usageById[id] });
		});
		const manager = createManager();
		const session = createSession(manager);
		const tool = await TaskTool.create(session);

		await tool.execute("tc-usage", {
			context: "ctx",
			tasks: [
				{ name: "WorkerA", agent: "task", task: "A." },
				{ name: "WorkerB", agent: "task", task: "B." },
			],
		} as TaskParams);
		// A live `wait` watches its jobs, which keeps auto-delivery from
		// consuming them first.
		manager.watchJobs(["WorkerA", "WorkerB"]);
		gate("WorkerA").resolve();
		gate("WorkerB").resolve();
		await manager.getJob("WorkerA")!.promise;
		await manager.getJob("WorkerB")!.promise;

		const jobs = () => [manager.getJob("WorkerA")!, manager.getJob("WorkerB")!];
		const first = buildJobResult(session, manager, "wait", jobs(), []);
		const firstById = new Map(first.details?.jobs?.map(job => [job.id, job]));
		expect(firstById.get("WorkerA")?.usage).toEqual(usage(1));
		expect(firstById.get("WorkerB")?.usage).toEqual(usage(2));
		expect(first.details?.usage).toEqual(sum(usage(1), usage(2)));

		const repeat = buildJobResult(session, manager, "wait", jobs(), []);
		const repeatById = new Map(repeat.details?.jobs?.map(job => [job.id, job]));
		expect(repeatById.get("WorkerA")?.usage).toEqual(usage(1));
		expect(repeatById.get("WorkerB")?.usage).toEqual(usage(2));
		expect(repeat.details?.usage).toBeUndefined();
	});

	it("bills a mixed call's inline child on the task result and its async child on the wait", async () => {
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			if (id === "ScoutOne") return makeResult(id, options.agent.name, { usage: usage(3) });
			await gate(id).promise;
			return makeResult(id, options.agent.name, { usage: usage(4) });
		});
		const manager = createManager();
		const session = createSession(manager);
		const tool = await TaskTool.create(session);

		const result = await tool.execute("tc-mixed-usage", {
			context: "ctx",
			tasks: [
				{ name: "ScoutOne", agent: "scout", task: "Research." },
				{ name: "WorkerOne", agent: "task", task: "Build." },
			],
		} as TaskParams);
		expect(result.details?.usage).toEqual(usage(3));

		manager.watchJobs(["WorkerOne"]);
		gate("WorkerOne").resolve();
		await manager.getJob("WorkerOne")!.promise;
		// The job's retained details also carry the batch's inline aggregate.
		expect(manager.getJob("WorkerOne")!.latestDetails?.usage).toEqual(usage(3));

		const waited = buildJobResult(session, manager, "wait", [manager.getJob("WorkerOne")!], []);
		expect(waited.details?.jobs?.[0]?.usage).toEqual(usage(4));
		expect(waited.details?.usage).toEqual(usage(4));
	});

	it("exposes live usage while running and partial usage after cancellation", async () => {
		const live = usage(5);
		const partial = usage(6);
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			const aborted = Promise.withResolvers<void>();
			options.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
			options.onProgress?.(liveProgress(id, live));
			await aborted.promise;
			return makeResult(id, options.agent.name, {
				aborted: true,
				exitCode: 1,
				error: "Aborted",
				usage: partial,
			});
		});
		const manager = createManager();
		const session = createSession(manager);
		const tool = await TaskTool.create(session);

		// The job forwards the child's streamed progress as a tool update; that
		// update is the signal the live usage reached the job row.
		const liveForwarded = Promise.withResolvers<void>();
		await tool.execute(
			"tc-cancel-usage",
			{
				context: "ctx",
				tasks: [{ name: "WorkerC", agent: "task", task: "Long work." }],
			} as TaskParams,
			undefined,
			update => {
				if (update.details?.progress?.some(p => p.id === "WorkerC" && p.usage)) liveForwarded.resolve();
			},
		);
		const job = manager.getJob("WorkerC")!;
		await liveForwarded.promise;

		const running = buildJobResult(session, manager, "jobs", [job], []);
		expect(running.details?.jobs?.[0]?.status).toBe("running");
		expect(running.details?.jobs?.[0]?.usage).toEqual(live);
		expect(running.details?.usage).toBeUndefined();

		expect(manager.cancel("WorkerC")).toBe(true);
	await job.promise;
	// A cancelled settlement waits for its owner: a live `wait` must recover
	// it (billing partial usage on first consume) instead of throwing
	// "nothing to wait for".
	expect(undeliveredJobs(manager, undefined).map(j => j.id)).toContain("WorkerC");

		const cancelled = buildJobResult(session, manager, "wait", [job], []);
		expect(cancelled.details?.jobs?.[0]?.status).toBe("cancelled");
		expect(cancelled.details?.jobs?.[0]?.usage).toEqual(partial);
		expect(cancelled.details?.usage).toEqual(partial);

		const repeat = buildJobResult(session, manager, "wait", [job], []);
		expect(repeat.details?.usage).toBeUndefined();
		expect(undeliveredJobs(manager, undefined).map(j => j.id)).not.toContain("WorkerC");
	});

	it("bills a failed child's partial usage from its result", async () => {
		const partial = usage(8);
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			await gate(id).promise;
			return makeResult(id, options.agent.name, { exitCode: 1, error: "provider exploded", usage: partial });
		});
		const manager = createManager();
		const session = createSession(manager);
		const tool = await TaskTool.create(session);

		await tool.execute("tc-failed-usage", {
			context: "ctx",
			tasks: [{ name: "WorkerE", agent: "task", task: "Doomed." }],
		} as TaskParams);
		manager.watchJobs(["WorkerE"]);
		gate("WorkerE").resolve();
		const job = manager.getJob("WorkerE")!;
		await job.promise;

		const waited = buildJobResult(session, manager, "wait", [job], []);
		expect(waited.details?.jobs?.[0]?.status).toBe("failed");
		expect(waited.details?.jobs?.[0]?.usage).toEqual(partial);
		expect(waited.details?.usage).toEqual(partial);

		const repeat = buildJobResult(session, manager, "wait", [job], []);
		expect(repeat.details?.usage).toBeUndefined();
	});

	it("keeps the last live usage when the child throws without a result", async () => {
		const live = usage(9);
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			options.onProgress?.(liveProgress(id, live));
			await gate(id).promise;
			throw new Error("session crashed mid-run");
		});
		const manager = createManager();
		const session = createSession(manager);
		const tool = await TaskTool.create(session);

		const liveForwarded = Promise.withResolvers<void>();
		await tool.execute(
			"tc-throw-usage",
			{
				context: "ctx",
				tasks: [{ name: "WorkerF", agent: "task", task: "Crashes." }],
			} as TaskParams,
			undefined,
			update => {
				if (update.details?.progress?.some(p => p.id === "WorkerF" && p.usage)) liveForwarded.resolve();
			},
		);
		manager.watchJobs(["WorkerF"]);
		await liveForwarded.promise;
		gate("WorkerF").resolve();
		const job = manager.getJob("WorkerF")!;
		await job.promise;

		const waited = buildJobResult(session, manager, "wait", [job], []);
		expect(waited.details?.jobs?.[0]?.status).toBe("failed");
		expect(waited.details?.jobs?.[0]?.usage).toEqual(live);
		expect(waited.details?.usage).toEqual(live);
	});

	it("carries usage on auto-delivery and does not bill the delivered job again on wait", async () => {
		const delivered: AsyncResultDetails[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options =>
			makeResult(options.id ?? "?", options.agent.name, { usage: usage(7) }),
		);
		const manager = createManager((jobId, text, job) => {
			const message = buildAsyncResultBatchMessage([{ jobId, result: text, job, durationMs: 0, epoch: 0 }]);
			if (message?.details) delivered.push(message.details);
		});
		const session = createSession(manager);
		const tool = await TaskTool.create(session);

		await tool.execute("tc-delivery-usage", {
			context: "ctx",
			tasks: [{ name: "WorkerD", agent: "task", task: "Quick." }],
		} as TaskParams);
		await manager.getJob("WorkerD")!.promise;
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.jobs[0]?.usage).toEqual(usage(7));
		expect(delivered[0]?.usage).toEqual(usage(7));
		expect(manager.isJobResultConsumed("WorkerD")).toBe(true);

		const waited = buildJobResult(session, manager, "wait", [manager.getJob("WorkerD")!], []);
		expect(waited.details?.jobs?.[0]?.usage).toEqual(usage(7));
		expect(waited.details?.usage).toBeUndefined();
	});
});
