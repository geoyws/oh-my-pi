import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ModelUsageAccountHealth, ModelUsageHealth } from "@oh-my-pi/pi-ai";
import * as envApiKey from "@oh-my-pi/pi-ai/env-api-key";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { RecoveryCompactionResult, TurnRecoveryHost } from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import { TurnRecovery } from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import { TempDir } from "@oh-my-pi/pi-utils";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";

const SESSION_ID = "quota-plan-session";
const HOUR_MS = 3_600_000;
const QUOTA_ERROR = "429 quota exceeded for this account";

function bundled(provider: string, id: string): Model {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Expected bundled model ${provider}/${id}`);
	return model;
}

function quotaFailure(model: Model): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: QUOTA_ERROR,
		timestamp: Date.now(),
	};
}

function depleted(credentialId: number, resetsAt: number | undefined, authoritative: boolean): ModelUsageAccountHealth {
	return {
		credentialId,
		credentialType: "oauth",
		state: "depleted",
		...(resetsAt === undefined ? {} : { resetsAt }),
		...(authoritative ? { resetIsAuthoritative: true as const } : {}),
	};
}

function healthy(credentialId: number): ModelUsageAccountHealth {
	return { credentialId, credentialType: "oauth", state: "healthy", remainingFraction: 0.8 };
}

function pool(accounts: ModelUsageAccountHealth[]): ModelUsageHealth {
	const state = accounts.some(account => account.state === "healthy")
		? "healthy"
		: accounts.some(account => account.state === "unknown")
			? "unknown"
			: "depleted";
	return { state, accounts };
}

describe("TurnRecovery quota recovery planning", () => {
	const primary = bundled("anthropic", "claude-sonnet-4-5");
	const miniFallback = bundled("openai", "gpt-4o-mini");
	const fullFallback = bundled("openai", "gpt-4o");

	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let calls: string[];
	let events: AgentSessionEvent[];
	let continues: number;
	let redeemCalls: number;
	let activeModel: Model;
	let generation: number;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-turn-recovery-quota-plan-");
		authStorage = await AuthStorage.create(tempDir.join("testauth.db"));
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"), { settings: Settings.isolated() });
	});

	beforeEach(() => {
		vi.spyOn(envApiKey, "getEnvApiKey").mockReturnValue(undefined);
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");
		authStorage.keys.setRuntime("openai", "openai-test-key");
		modelRegistry.clearSuppressedSelectors();
		calls = [];
		events = [];
		continues = 0;
		redeemCalls = 0;
		activeModel = primary;
		generation = 0;
		vi.spyOn(authStorage.limits, "markReached").mockResolvedValue({ switched: false });
		vi.spyOn(authStorage.usage, "invalidate").mockImplementation(async provider => {
			calls.push(`invalidate:${provider}`);
		});
		vi.spyOn(authStorage.sessions, "pin").mockImplementation((provider, sessionId, credentialId) => {
			calls.push(`pin:${provider}:${sessionId}:${credentialId}`);
			return true;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	/** Health by `provider/model`; phase N applies after the Nth wake refreshed usage (the primary is always compared). */
	function stubHealth(phases: Array<Record<string, ModelUsageHealth>>): void {
		vi.spyOn(authStorage.health, "model").mockImplementation(async (provider, options) => {
			const key = `${provider}/${options.modelId}`;
			calls.push(`health:${key}`);
			const wakes = calls.filter(call => call === `invalidate:${primary.provider}`).length;
			const phase = phases[Math.min(phases.length - 1, wakes)] ?? {};
			return phase[key] ?? { state: "unknown", accounts: [] };
		});
	}

	function createRecovery(settings: Record<string, unknown>): { recovery: TurnRecovery; failure: AssistantMessage } {
		const failure = quotaFailure(primary);
		const state: { messages: AgentMessage[] } = { messages: [failure] };
		const host: TurnRecoveryHost = {
			agent: {
				state,
				replaceMessages(messages: AgentMessage[]) {
					state.messages = messages;
				},
			} as never,
			sessionManager: {
				getBranchView: () => [],
				getSessionId: () => SESSION_ID,
				appendModelChange: () => {},
			} as never,
			settings: Settings.isolated({ "retry.baseDelayMs": 1, ...settings }),
			modelRegistry,
			configWarnings: [],
			model: () => activeModel,
			contextFitsModel: () => true,
			textOutputCommitted: () => true,
			thinkingLevel: () => undefined,
			configuredThinkingLevel: () => undefined,
			setThinkingLevel: () => {},
			thinkingLevelCeiling: () => undefined,
			isDisposed: () => false,
			isStreaming: () => false,
			isCompacting: () => false,
			abortInProgress: () => false,
			streamingEditAbortTriggered: () => false,
			promptGeneration: () => generation,
			promptSequence: () => 0,
			sessionId: () => SESSION_ID,
			emitSessionEvent: async event => {
				events.push(event);
			},
			scheduleAgentContinue: () => {
				continues++;
			},
			waitForSessionMessagePersistence: async () => {},
			appendSessionMessage: () => {},
			persistedAssistantEntryId: () => undefined,
			sessionMessageAlreadyPersisted: () => false,
			setModelWithProviderSessionReset: async model => {
				calls.push(`model:${model.provider}/${model.id}`);
				activeModel = model;
			},
			resolveActiveEditMode: () => "hashline",
			syncAfterModelChange: async () => {},
			resetCurrentResponsesProviderSession: () => {},
			maybeAutoRedeemReset: async () => {
				redeemCalls++;
				return { restored: false };
			},
			runAutoCompaction: async () => ({ continuationScheduled: false }) as RecoveryCompactionResult,
			shakeForRequestBodyReadTimeout: async () => false,
			withBashBranchTransition: <T>(operation: () => T): T => operation(),
		};
		return { recovery: new TurnRecovery(host), failure };
	}

	const chain = {
		[`${primary.provider}/${primary.id}`]: [
			`${miniFallback.provider}/${miniFallback.id}`,
			`${fullFallback.provider}/${fullFallback.id}`,
		],
	};

	function notices(): string[] {
		return events.flatMap(event =>
			event.type === "notice" && event.source === "quota-recovery" ? [event.message] : [],
		);
	}

	it("switches at once to a later fallback with available quota, skipping an exhausted rung with no stated reset", async () => {
		const now = Date.now();
		stubHealth([
			{
				"anthropic/claude-sonnet-4-5": pool([depleted(1, now + 2 * HOUR_MS, true)]),
				"openai/gpt-4o-mini": pool([depleted(21, undefined, false)]),
				"openai/gpt-4o": pool([healthy(31)]),
			},
		]);
		const waitSpy = mockSchedulerWaitWithClock();
		const { recovery, failure } = createRecovery({ "retry.fallbackChains": chain });

		await recovery.recordUsageLimitOutcome(failure);
		expect(await recovery.handleRetryableError(failure)).toBe(true);

		expect(calls.filter(call => call.startsWith("model:"))).toEqual(["model:openai/gpt-4o"]);
		expect(calls).toContain(`pin:openai:${SESSION_ID}:31`);
		const start = events.find(event => event.type === "auto_retry_start");
		expect(start).toMatchObject({ delayMs: 0 });
		expect(waitSpy.mock.calls.every(call => (call[0] as number) < 1_000)).toBe(true);
		expect(notices().some(message => message.includes("openai/gpt-4o account #31"))).toBe(true);
		expect(continues).toBe(1);
	});

	it("waits for the earliest authoritative reset across models, then refreshes usage before resuming on it", async () => {
		const now = Date.now();
		const fallbackResetAt = now + HOUR_MS;
		stubHealth([
			{
				"anthropic/claude-sonnet-4-5": pool([depleted(1, now + 2 * HOUR_MS, true)]),
				// Sooner, but a heuristic block: no provider-stated time.
				"openai/gpt-4o-mini": pool([depleted(21, now + HOUR_MS / 2, false)]),
				"openai/gpt-4o": pool([depleted(31, fallbackResetAt, true)]),
			},
			{
				"anthropic/claude-sonnet-4-5": pool([depleted(1, now + 2 * HOUR_MS, true)]),
				"openai/gpt-4o-mini": pool([depleted(21, now + HOUR_MS / 2, false)]),
				"openai/gpt-4o": pool([healthy(31)]),
			},
		]);
		const waitSpy = mockSchedulerWaitWithClock();
		const { recovery, failure } = createRecovery({
			"retry.fallbackChains": chain,
			"retry.waitForUsageReset": true,
		});

		await recovery.recordUsageLimitOutcome(failure);
		expect(await recovery.handleRetryableError(failure)).toBe(true);

		const start = events.find(event => event.type === "auto_retry_start");
		if (start?.type !== "auto_retry_start") throw new Error("Expected auto_retry_start");
		expect(start.delayMs).toBeGreaterThan(HOUR_MS - 60_000);
		expect(start.delayMs).toBeLessThanOrEqual(HOUR_MS);
		expect(waitSpy.mock.calls.some(call => (call[0] as number) > HOUR_MS - 60_000)).toBe(true);
		const waiting = notices().find(message => message.startsWith("waiting for"));
		expect(waiting).toContain("openai/gpt-4o account #31");
		expect(waiting).toContain(new Date(fallbackResetAt).toISOString());

		// Every compared provider is refreshed before the wake reads health again.
		const firstInvalidate = calls.indexOf("invalidate:anthropic");
		expect(firstInvalidate).toBeGreaterThan(-1);
		expect(calls.indexOf("invalidate:openai")).toBeGreaterThan(-1);
		const healthAfterWake = calls.findIndex((call, index) => index > firstInvalidate && call.startsWith("health:"));
		expect(healthAfterWake).toBeGreaterThan(calls.indexOf("invalidate:openai"));
		expect(calls.filter(call => call.startsWith("model:"))).toEqual(["model:openai/gpt-4o"]);
		expect(calls).toContain(`pin:openai:${SESSION_ID}:31`);
		expect(continues).toBe(1);
		// Saved resets stay with their consent-gated pre-planning path only.
		expect(redeemCalls).toBe(1);
	});

	it("re-arms the same wait when refreshed usage moves the reset, without spending retry attempts", async () => {
		const now = Date.now();
		stubHealth([
			{ "anthropic/claude-sonnet-4-5": pool([depleted(1, now + HOUR_MS, true), depleted(2, now + 2 * HOUR_MS, true)]) },
			{ "anthropic/claude-sonnet-4-5": pool([depleted(1, now + 3 * HOUR_MS, true), depleted(2, now + 2 * HOUR_MS, true)]) },
			{ "anthropic/claude-sonnet-4-5": pool([depleted(1, now + 3 * HOUR_MS, true), healthy(2)]) },
		]);
		const waitSpy = mockSchedulerWaitWithClock();
		const { recovery, failure } = createRecovery({ "retry.modelFallback": false, "retry.waitForUsageReset": true });

		await recovery.recordUsageLimitOutcome(failure);
		expect(await recovery.handleRetryableError(failure)).toBe(true);

		const longWaits = waitSpy.mock.calls.map(call => call[0] as number).filter(delay => delay > 60_000);
		expect(longWaits).toHaveLength(2);
		expect(longWaits[0]).toBeLessThanOrEqual(HOUR_MS);
		expect(longWaits[1]).toBeGreaterThan(2 * HOUR_MS - 60_000);
		expect(longWaits[1]).toBeLessThanOrEqual(2 * HOUR_MS);
		expect(notices().some(message => message.includes("moved the earliest reset"))).toBe(true);
		expect(events.filter(event => event.type === "auto_retry_start")).toHaveLength(1);
		expect(recovery.attempt).toBe(1);
		expect(calls).toContain(`pin:anthropic:${SESSION_ID}:2`);
		expect(calls.some(call => call.startsWith("model:"))).toBe(false);
		expect(continues).toBe(1);
	});

	it("never routes onto exhausted quota whose reset is unknown", async () => {
		stubHealth([
			{
				"anthropic/claude-sonnet-4-5": pool([depleted(1, undefined, false)]),
				"openai/gpt-4o-mini": pool([depleted(21, undefined, false)]),
				"openai/gpt-4o": pool([{ credentialId: 31, credentialType: "oauth", state: "unknown" }]),
			},
		]);
		mockSchedulerWaitWithClock();
		const { recovery, failure } = createRecovery({ "retry.fallbackChains": chain, "retry.maxDelayMs": 100 });

		await recovery.recordUsageLimitOutcome(failure);
		expect(await recovery.handleRetryableError(failure)).toBe(false);

		expect(calls.some(call => call.startsWith("model:") || call.startsWith("pin:"))).toBe(false);
		expect(events.find(event => event.type === "auto_retry_end")).toMatchObject({ success: false });
		expect(continues).toBe(0);
	});

	it("cancels an armed wake through abortRetry without refreshing or resuming", async () => {
		const now = Date.now();
		stubHealth([{ "anthropic/claude-sonnet-4-5": pool([depleted(1, now + HOUR_MS, true)]) }]);
		const waitStarted = Promise.withResolvers<void>();
		vi.spyOn(scheduler, "wait").mockImplementation(async (_delayMs, options) => {
			const { promise, reject } = Promise.withResolvers<void>();
			const signal = options?.signal;
			signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
			waitStarted.resolve();
			return promise;
		});
		const { recovery, failure } = createRecovery({ "retry.modelFallback": false, "retry.waitForUsageReset": true });

		await recovery.recordUsageLimitOutcome(failure);
		const retrying = recovery.handleRetryableError(failure);
		await waitStarted.promise;
		recovery.abortRetry();

		expect(await retrying).toBe(false);
		expect(events.find(event => event.type === "auto_retry_end")).toMatchObject({
			success: false,
			finalError: "Retry cancelled",
		});
		expect(calls.some(call => call.startsWith("invalidate:"))).toBe(false);
		expect(continues).toBe(0);
		expect(recovery.isRetrying).toBe(false);
	});
});
