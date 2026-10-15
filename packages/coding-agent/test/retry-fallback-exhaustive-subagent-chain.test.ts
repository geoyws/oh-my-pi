import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { cfgExhaustiveRetryFallbackRoles } from "@oh-my-pi/pi-coding-agent/session/settings";
import {
	findRetryFallbackCandidates,
	getExhaustiveRetryFallbackRoles,
	getRetryFallbackChains,
	getRetryFallbackRole,
	installRetryFallbackRole,
	type RetryFallbackResolutionContext,
	resolveRetryFallbackChainKey,
} from "@oh-my-pi/pi-coding-agent/session/retry-fallback-chains";
import { TurnRecovery, type TurnRecoveryHost } from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { createSessionDefaults } from "./helpers/session-defaults";

/** Minimal child session: immediately yields so the spawn completes. */
function createYieldingSession(): AgentSession {
	const listeners: Array<(event: { type: string; [key: string]: unknown }) => void> = [];
	return {
		...createSessionDefaults(),
		subscribe: (listener: (event: { type: string; [key: string]: unknown }) => void) => {
			listeners.push(listener);
			return () => {};
		},
		prompt: async () => {
			for (const listener of listeners) {
				listener({
					type: "tool_execution_end",
					toolCallId: "tool-yield",
					toolName: "yield",
					result: { content: [{ type: "text", text: "Result submitted." }], details: { status: "success" } },
					isError: false,
				});
			}
		},
	} as unknown as AgentSession;
}

const FIRST = "scout-a/first";
const SECOND = "scout-b/second";
const THIRD = "scout-c/third";
const OUTSIDE = "outside/other";
const SCOUT_ROLE = "subagent:scout";

function model(provider: string, id: string): Model<Api> {
	return buildModel({
		provider,
		id,
		name: id,
		api: "openai-completions",
		baseUrl: `https://${provider}.example.test`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	});
}

function lookupFor(models: Model<Api>[]) {
	return {
		find: (provider: string, id: string) => models.find(entry => entry.provider === provider && entry.id === id),
		hasProvider: (provider: string) => models.some(entry => entry.provider === provider),
	};
}

function scoutSettings(): Settings {
	return Settings.isolated({
		"retry.fallbackChains": {
			default: [OUTSIDE],
			"scout-a/first": [OUTSIDE],
			"scout-b/second": [OUTSIDE],
		},
	});
}

function installScoutChain(settings: Settings, exhaustive: boolean): void {
	installRetryFallbackRole(settings, SCOUT_ROLE, {
		primary: FIRST,
		chain: [SECOND, THIRD],
		...(exhaustive ? { exhaustive: true as const } : {}),
	});
}

function contextFor(
	settings: Settings,
	models: Model<Api>[],
	exhaustive: readonly string[] = [],
): RetryFallbackResolutionContext {
	return {
		chains: getRetryFallbackChains(settings),
		getModelRole: (role: string) => settings.getModelRole(role),
		modelLookup: lookupFor(models),
		exhaustiveRoles: new Set(exhaustive),
	};
}

function recoveryFor(settings: Settings, models: Model<Api>[]): TurnRecovery {
	return new TurnRecovery(
		{
			settings,
			modelRegistry: lookupFor(models),
			model: () => undefined,
			sessionManager: {},
		} as unknown as TurnRecoveryHost,
		{ deferFallbackChainValidation: true },
	);
}

describe("exhaustive subagent fallback chains", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("resolves the exhaustive subagent chain ahead of a model-keyed chain", () => {
		const settings = scoutSettings();
		installScoutChain(settings, true);
		const models = [model("scout-a", "first"), model("scout-b", "second"), model("scout-c", "third")];
		const context = contextFor(settings, models, [SCOUT_ROLE]);
		expect(resolveRetryFallbackChainKey(context, FIRST, undefined, SCOUT_ROLE)).toBe(SCOUT_ROLE);
		expect(resolveRetryFallbackChainKey(context, FIRST)).toBe(SCOUT_ROLE);
		expect(resolveRetryFallbackChainKey(context, SECOND)).toBe(SCOUT_ROLE);
	});

	it("recovery consults only the exhaustive chain key", () => {
		const settings = scoutSettings();
		installScoutChain(settings, true);
		const models = [model("scout-a", "first"), model("scout-b", "second"), model("scout-c", "third")];
		const recovery = recoveryFor(settings, models);
		expect(recovery.retryFallbackChainKeys(FIRST, undefined)).toEqual([SCOUT_ROLE]);
		expect(recovery.retryFallbackChainKeys(SECOND, undefined, { pinnedRole: SCOUT_ROLE })).toEqual([SCOUT_ROLE]);
	});

	it("a scout whose listed models all fail never leaves its list", () => {
		const settings = scoutSettings();
		installScoutChain(settings, true);
		const models = [model("scout-a", "first"), model("scout-b", "second"), model("scout-c", "third")];
		const recovery = recoveryFor(settings, models);
		const attempted: string[] = [];
		let pinned: string | undefined;
		let current: string | undefined = FIRST;
		for (let step = 0; step < 10; step += 1) {
			if (current === undefined) break;
			const selector: string = current;
			attempted.push(selector);
			const keys = recovery.retryFallbackChainKeys(selector, undefined, pinned ? { pinnedRole: pinned } : undefined);
			const next = keys
				.flatMap(key =>
					recovery.findRetryFallbackCandidates(key, selector, undefined).map(candidate => candidate.raw),
				)
				.at(0);
			if (next === undefined) {
				current = undefined;
				break;
			}
			pinned = keys[0];
			current = next;
		}
		expect(attempted).toEqual([FIRST, SECOND, THIRD]);
		expect(recovery.findRetryFallbackCandidates(SCOUT_ROLE, THIRD, undefined)).toEqual([]);
	});

	it("a single-entry override keeps model-key precedence", () => {
		const settings = scoutSettings();
		installScoutChain(settings, false);
		const models = [model("scout-a", "first"), model("scout-b", "second"), model("scout-c", "third")];
		const context = contextFor(settings, models, []);
		expect(resolveRetryFallbackChainKey(context, FIRST)).toBe("scout-a/first");
		const recovery = recoveryFor(settings, models);
		expect(recovery.retryFallbackChainKeys(FIRST, undefined, { pinnedRole: SCOUT_ROLE })).toEqual([
			SCOUT_ROLE,
			"scout-a/first",
		]);
	});

	it("a default session with a model-keyed chain is unchanged", () => {
		const settings = scoutSettings();
		const models = [model("scout-a", "first")];
		const context = contextFor(settings, models, []);
		expect(resolveRetryFallbackChainKey(context, FIRST)).toBe("scout-a/first");
		expect(findRetryFallbackCandidates(context, "scout-a/first", FIRST).map(candidate => candidate.raw)).toEqual([
			OUTSIDE,
		]);
	});

	it("marks a spawn's explicit multi-entry list exhaustive", async () => {
		const first = model("scout-a", "first");
		const second = model("scout-b", "second");
		const third = model("scout-c", "third");
		let childSettings: Settings | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			childSettings = options?.settings;
			return { session: createYieldingSession(), extensionsResult: {}, setToolUIContext: () => {} } as never;
		});
		const agent: AgentDefinition = { name: "scout", description: "test", systemPrompt: "test", source: "bundled" };
		await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "exhaustive-spawn",
			modelOverride: [FIRST, SECOND, THIRD],
			settings: Settings.isolated({
				"retry.fallbackChains": { default: [OUTSIDE], "scout-a/first": [OUTSIDE] },
			}),
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [first, second, third],
				getApiKey: async () => "test-key",
			} as never,
			enableLsp: false,
		});
		if (!childSettings) throw new Error("Expected child settings");
		const role = getRetryFallbackRole(childSettings, "subagent:exhaustive-spawn");
		expect(role?.chain).toEqual([SECOND, THIRD]);
		expect(role?.exhaustive).toBe(true);
	});

	it("leaves a spawn's single-entry override non-exhaustive", async () => {
		const first = model("scout-a", "first");
		const second = model("scout-b", "second");
		let childSettings: Settings | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			childSettings = options?.settings;
			return { session: createYieldingSession(), extensionsResult: {}, setToolUIContext: () => {} } as never;
		});
		const agent: AgentDefinition = { name: "scout", description: "test", systemPrompt: "test", source: "bundled" };
		await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "single-spawn",
			modelOverride: FIRST,
			settings: Settings.isolated({
				"retry.fallbackChains": { default: [SECOND] },
			}),
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [first, second],
				getApiKey: async () => "test-key",
			} as never,
			enableLsp: false,
		});
		if (!childSettings) throw new Error("Expected child settings");
		const role = getRetryFallbackRole(childSettings, "subagent:single-spawn");
		expect(role?.chain).toEqual([SECOND]);
		expect(role?.exhaustive).toBeUndefined();
	});

	it("survives a warm-revival overlay round trip", () => {
		const parent = scoutSettings();
		const child = parent.overlay();
		installScoutChain(child, true);
		// Warm revival parks the live session, captures its overlay layers, and
		// rebuilds settings from them on the same parent — the rebuilt object
		// must keep the exhaustive flag, not just the selectors.
		const restored = parent.restoreOverlay(child.overlayLayers());
		expect(getRetryFallbackRole(restored, SCOUT_ROLE)?.exhaustive).toBe(true);
		const models = [model("scout-a", "first"), model("scout-b", "second"), model("scout-c", "third")];
		const context: RetryFallbackResolutionContext = {
			chains: getRetryFallbackChains(restored),
			getModelRole: (role: string) => restored.getModelRole(role),
			modelLookup: lookupFor(models),
			exhaustiveRoles: getExhaustiveRetryFallbackRoles(restored),
		};
		expect(resolveRetryFallbackChainKey(context, FIRST)).toBe(SCOUT_ROLE);
		expect(resolveRetryFallbackChainKey(context, SECOND)).toBe(SCOUT_ROLE);
		const recovery = recoveryFor(restored, models);
		const attempted: string[] = [];
		let pinned: string | undefined;
		let current: string | undefined = FIRST;
		for (let step = 0; step < 10; step += 1) {
			if (current === undefined) break;
			const selector: string = current;
			attempted.push(selector);
			const keys = recovery.retryFallbackChainKeys(selector, undefined, pinned ? { pinnedRole: pinned } : undefined);
			const next = keys
				.flatMap(key =>
					recovery.findRetryFallbackCandidates(key, selector, undefined).map(candidate => candidate.raw),
				)
				.at(0);
			if (next === undefined) {
				current = undefined;
				break;
			}
			pinned = keys[0];
			current = next;
		}
		expect(attempted).toEqual([FIRST, SECOND, THIRD]);
		expect(recovery.findRetryFallbackCandidates(SCOUT_ROLE, THIRD, undefined)).toEqual([]);
	});

	it("passes exhaustive intent when a multi-entry list defers to the SDK installer", async () => {
		// None of the requested models is visible yet (discovery pending), so the
		// executor defers resolution to the SDK installer inside createAgentSession.
		const unrelated = model("elsewhere", "other");
		let fallbackRole: unknown;
		let fallbackExhaustive: unknown;
		let fallbackDefaultChain: unknown;
		let fallbackPattern: unknown;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			fallbackRole = options?.modelPatternFallbackRole;
			if (options && typeof options === "object" && "modelPatternFallbackExhaustive" in options) {
				fallbackExhaustive = options.modelPatternFallbackExhaustive;
			}
			fallbackDefaultChain = options?.modelPatternDefaultFallbackChain;
			fallbackPattern = options?.modelPattern;
			return { session: createYieldingSession(), extensionsResult: {}, setToolUIContext: () => {} } as never;
		});
		const agent: AgentDefinition = { name: "scout", description: "test", systemPrompt: "test", source: "bundled" };
		await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "deferred-exhaustive",
			modelOverride: [FIRST, "scout-b/second", "scout-c/third"],
			settings: Settings.isolated({
				"retry.fallbackChains": { default: [OUTSIDE] },
			}),
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [unrelated],
				getApiKey: async () => "test-key",
			} as never,
			enableLsp: false,
		});
		expect(fallbackPattern).toEqual([FIRST, "scout-b/second", "scout-c/third"]);
		expect(fallbackRole).toBe("subagent:deferred-exhaustive");
		expect(fallbackDefaultChain).toBeUndefined();
		expect(fallbackExhaustive).toBe(true);
	});

	it("ignores exhaustive roles supplied through user config", () => {
		const settings = scoutSettings();
		// `omp config set` / config file: global layer, never the runtime override.
		// No subagent install ever runs on a main session, so nothing shadows it.
		cfgExhaustiveRetryFallbackRoles.set(settings, [SCOUT_ROLE]);
		expect(getExhaustiveRetryFallbackRoles(settings).size).toBe(0);
		// A user flag alone installs no chain.
		expect(getRetryFallbackRole(settings, SCOUT_ROLE)).toBeUndefined();
		const models = [model("scout-a", "first"), model("scout-b", "second"), model("scout-c", "third")];
		const context = contextFor(settings, models, [...getExhaustiveRetryFallbackRoles(settings)]);
		// A main-session lookup still follows the model-keyed chain, never the named role alone.
		expect(resolveRetryFallbackChainKey(context, FIRST)).toBe("scout-a/first");
		const recovery = recoveryFor(settings, models);
		expect(recovery.retryFallbackChainKeys(FIRST, undefined)).toEqual(["scout-a/first"]);
		expect(
			recovery.findRetryFallbackCandidates("scout-a/first", FIRST, undefined).map(candidate => candidate.raw),
		).toEqual([OUTSIDE]);
	});
});
