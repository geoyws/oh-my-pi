/**
 * Contract (reins ADR-024 "Steering never pauses goal mode", mirrored in this harness): a new
 * user instruction never pauses an active goal. Interrupting a turn holds goal auto-continuation
 * without changing the goal's status; the next user-authored message re-arms it so the goal
 * continues after that turn.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockHandler } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { GoalRuntime } from "@oh-my-pi/pi-coding-agent/goals/runtime";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

interface ParkedGoalHarness {
	session: AgentSession;
	/** Resolves when the first turn's model stream begins; the turn then parks until aborted. */
	streamStarted: Promise<void>;
	modelCalls: () => number;
}

function userMessageText(messages: readonly AgentMessage[]): string[] {
	const texts: string[] = [];
	for (const message of messages) {
		if (message.role !== "user") continue;
		if (typeof message.content === "string") {
			texts.push(message.content);
			continue;
		}
		for (const block of message.content) {
			if (block.type === "text") texts.push(block.text);
		}
	}
	return texts;
}

describe("AgentSession goal interrupts keep the goal active", () => {
	let tempDir: TempDir;
	let session: AgentSession | undefined;
	const authStorages: AuthStorage[] = [];

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-goal-interrupt-");
	});

	afterEach(async () => {
		try {
			vi.restoreAllMocks();
			await session?.dispose();
		} finally {
			session = undefined;
			for (const authStorage of authStorages.splice(0)) authStorage.close();
		}
	});

	afterAll(async () => {
		await tempDir?.remove();
	});

	async function createParkedGoalSession(tailResponses: MockHandler[]): Promise<ParkedGoalHarness> {
		const started = Promise.withResolvers<void>();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled claude-sonnet-4-5");
		const mock = createMockModel({
			responses: [
				() => {
					started.resolve();
					return { content: ["working on the goal"], delayMs: 60_000 };
				},
				...tailResponses,
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.keys.setRuntime("anthropic", "test-key");
		const created = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "goal.enabled": true }),
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
		});
		session = created;
		await created.goalRuntime.createGoal({ objective: "Ship the release" });
		return { session: created, streamStarted: started.promise, modelCalls: () => mock.calls.length };
	}

	function expectGoalActive(target: AgentSession): void {
		const state = target.getGoalModeState();
		expect(state?.enabled).toBe(true);
		expect(state?.goal.status).toBe("active");
	}

	it("flushing a queued steer with an empty Enter keeps the goal active and continuation resumes after it", async () => {
		const { session, streamStarted, modelCalls } = await createParkedGoalSession([
			{ content: ["handled the steer"] },
		]);
		const running = session.prompt("work on the goal");
		await streamStarted;

		await session.prompt("also rename the helper", { streamingBehavior: "steer" });
		// input-controller's empty-Enter flush: abort with the user-interrupt label, then let the
		// post-abort drain deliver the queued steer as the next turn.
		await session.abort({ reason: USER_INTERRUPT_LABEL });
		await session.waitForIdle();
		await running.catch(() => {});

		expect(userMessageText(session.agent.state.messages)).toContain("also rename the helper");
		expect(modelCalls()).toBe(2);
		expectGoalActive(session);
		expect(session.goalRuntime.continuationSuppressed).toBe(false);
		expect(session.goalRuntime.buildContinuationPrompt()).toBeDefined();
	});

	it("Esc then a new message keeps the goal active; continuation is held until the message, then re-arms", async () => {
		const { session, streamStarted } = await createParkedGoalSession([{ content: ["redirected"] }]);
		const running = session.prompt("work on the goal");
		await streamStarted;

		await session.abort({ reason: USER_INTERRUPT_LABEL });
		await running.catch(() => {});

		// Bare Esc: status stays active, but no auto-continuation is offered.
		expectGoalActive(session);
		expect(session.goalRuntime.buildContinuationPrompt()).toBeUndefined();

		await session.prompt("focus on the docs first");
		await session.waitForIdle();

		expectGoalActive(session);
		expect(session.goalRuntime.buildContinuationPrompt()).toBeDefined();
	});

	it("RPC abort_and_prompt keeps the goal active and continuation resumes after the new prompt", async () => {
		const { session, streamStarted } = await createParkedGoalSession([{ content: ["took the new prompt"] }]);
		const running = session.prompt("work on the goal");
		await streamStarted;

		// rpc-mode `abort_and_prompt`: abort with the user-interrupt label, then prompt.
		await session.abort({ reason: USER_INTERRUPT_LABEL });
		await session.prompt("switch to the hotfix");
		await session.waitForIdle();
		await running.catch(() => {});

		expect(userMessageText(session.agent.state.messages)).toContain("switch to the hotfix");
		expectGoalActive(session);
		expect(session.goalRuntime.buildContinuationPrompt()).toBeDefined();
	});

	it("a message that starts while an Esc abort is still unwinding keeps continuation armed and its accounting", async () => {
		const steeredStarted = Promise.withResolvers<void>();
		const { session, streamStarted } = await createParkedGoalSession([
			() => {
				steeredStarted.resolve();
				return { content: ["redirected"], usage: { input: 5, output: 7 }, delayMs: 20 };
			},
		]);
		const running = session.prompt("work on the goal");
		await streamStarted;

		// Park abort() at its goal hook (agent already idle) until the next user turn is streaming.
		const hookReached = Promise.withResolvers<void>();
		const releaseHook = Promise.withResolvers<void>();
		const runtime = session.goalRuntime;
		vi.spyOn(runtime, "onTaskAborted").mockImplementation(async options => {
			hookReached.resolve();
			await releaseHook.promise;
			return GoalRuntime.prototype.onTaskAborted.call(runtime, options);
		});

		const aborting = session.abort({ reason: USER_INTERRUPT_LABEL });
		await hookReached.promise;
		await running.catch(() => {});
		const next = session.prompt("focus on the docs first");
		await steeredStarted.promise;
		releaseHook.resolve();
		await aborting;
		await next;
		await session.waitForIdle();

		expect(userMessageText(session.agent.state.messages)).toContain("focus on the docs first");
		expectGoalActive(session);
		expect(session.goalRuntime.continuationSuppressed).toBe(false);
		expect(session.goalRuntime.buildContinuationPrompt()).toBeDefined();
		expect(session.getGoalModeState()?.goal.tokensUsed).toBe(12);
	});
});
