import { describe, expect, it, vi } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { ModelSwitchQueue, type ModelSwitchQueueHost } from "@oh-my-pi/pi-coding-agent/modes/model-switch-queue";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

/**
 * The single end-of-turn model switch slot: user switches queue only while the
 * main session streams, the latest switch of any origin wins, and the flush
 * applies the queued switch exactly once.
 */
const model = (provider: string, id: string): Model => ({ provider, id }) as unknown as Model;

function createHost(initial: Model = model("anthropic", "sonnet")) {
	const session = {
		model: initial,
		isStreaming: true,
		setModelTemporary: vi.fn(async () => {}),
	};
	const host = {
		session: session as unknown as AgentSession,
		showStatus: vi.fn(),
		showWarning: vi.fn(),
	} satisfies ModelSwitchQueueHost;
	return { host, session, queue: new ModelSwitchQueue(host) };
}

describe("ModelSwitchQueue", () => {
	it("declines a user switch while idle so the caller applies it now", () => {
		const { host, session, queue } = createHost();
		session.isStreaming = false;
		const apply = vi.fn(async () => {});

		expect(queue.queueUser({ target: host.session, model: model("anthropic", "opus"), apply })).toBe(false);
		expect(queue.pending).toBeUndefined();
		expect(host.showStatus).not.toHaveBeenCalled();
		expect(apply).not.toHaveBeenCalled();
	});

	it("declines a switch aimed at a session other than the main one", () => {
		const { queue } = createHost();
		const other = { model: undefined, isStreaming: true } as unknown as AgentSession;

		expect(queue.queueUser({ target: other, model: model("anthropic", "opus"), apply: async () => {} })).toBe(false);
		expect(queue.pending).toBeUndefined();
	});

	it("queues a user switch while streaming and reports it", () => {
		const { host, queue } = createHost();
		const opus = model("anthropic", "opus");

		const queued = queue.queueUser({
			target: host.session,
			model: opus,
			thinkingLevel: ThinkingLevel.High,
			role: "slow",
			apply: async () => {},
		});

		expect(queued).toBe(true);
		expect(queue.pending).toEqual({ model: opus, thinkingLevel: ThinkingLevel.High, source: "user", role: "slow" });
		expect(host.showStatus).toHaveBeenCalledWith(
			"Model switch queued for after this turn: anthropic/sonnet -> anthropic/opus",
		);
	});

	it("keeps only the latest queued switch and applies it once at the flush", async () => {
		const { host, session, queue } = createHost();
		const first = vi.fn(async () => {});
		const second = vi.fn(async () => {});
		queue.queueUser({ target: host.session, model: model("anthropic", "opus"), apply: first });
		queue.queueUser({ target: host.session, model: model("anthropic", "haiku"), apply: second });
		expect(queue.pending?.model).toEqual(model("anthropic", "haiku"));

		session.isStreaming = false;
		await queue.flush();
		await queue.flush();

		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledTimes(1);
		expect(session.setModelTemporary).not.toHaveBeenCalled();
		expect(queue.pending).toBeUndefined();
		const switched = host.showStatus.mock.calls.filter(([message]) => String(message).startsWith("Model switched"));
		expect(switched).toEqual([["Model switched to anthropic/haiku"]]);
	});

	it("applies a plan transition silently through setModelTemporary", async () => {
		const { host, session, queue } = createHost();
		const plan = model("anthropic", "opus");
		queue.queuePlan("plan", plan, ThinkingLevel.Low);

		await queue.flush();

		expect(session.setModelTemporary).toHaveBeenCalledTimes(1);
		expect(session.setModelTemporary).toHaveBeenCalledWith(plan, ThinkingLevel.Low);
		expect(host.showStatus).not.toHaveBeenCalled();
	});

	it("clears only entries from the named origins", () => {
		const { host, queue } = createHost();
		queue.queueUser({ target: host.session, model: model("anthropic", "opus"), apply: async () => {} });

		queue.clear("plan", "plan-restore");
		expect(queue.pending?.source).toBe("user");

		queue.queuePlan("plan", model("anthropic", "haiku"), undefined);
		queue.clear("plan-restore");
		expect(queue.pending?.source).toBe("plan");
		queue.clear("plan");
		expect(queue.pending).toBeUndefined();
	});

	it("lets the last write win across user and plan origins", async () => {
		const { host, session, queue } = createHost();
		const apply = vi.fn(async () => {});
		queue.queuePlan("plan", model("anthropic", "haiku"), undefined);
		queue.queueUser({ target: host.session, model: model("anthropic", "opus"), apply });
		expect(queue.pending?.source).toBe("user");

		queue.queuePlan("plan-restore", model("anthropic", "sonnet"), undefined);
		expect(queue.pending?.source).toBe("plan-restore");
		await queue.flush();

		expect(apply).not.toHaveBeenCalled();
		expect(session.setModelTemporary).toHaveBeenCalledTimes(1);
		expect(session.setModelTemporary).toHaveBeenCalledWith(model("anthropic", "sonnet"), undefined);
	});

	it("warns instead of throwing when the queued switch fails", async () => {
		const { host, queue } = createHost();
		queue.queueUser({
			target: host.session,
			model: model("anthropic", "opus"),
			apply: async () => {
				throw new Error("No API key for anthropic/opus");
			},
		});

		await queue.flush();

		expect(host.showWarning).toHaveBeenCalledWith("Failed to switch model after streaming: No API key for anthropic/opus");
		expect(queue.pending).toBeUndefined();
	});

	it("notifies subscribers on every change until they unsubscribe", async () => {
		const { host, queue } = createHost();
		const listener = vi.fn();
		const unsubscribe = queue.subscribe(listener);

		queue.queueUser({ target: host.session, model: model("anthropic", "opus"), apply: async () => {} });
		queue.clear("plan");
		await queue.flush();
		expect(listener).toHaveBeenCalledTimes(2);

		unsubscribe();
		queue.queuePlan("plan", model("anthropic", "haiku"), undefined);
		expect(listener).toHaveBeenCalledTimes(2);
	});
});
