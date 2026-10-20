import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import {
	defaultSupportedEffort,
	mapEffortToAnthropicAdaptiveEffort,
	minimumSupportedEffort,
} from "@oh-my-pi/pi-catalog/model-thinking";
import type { Api, Model, Provider } from "@oh-my-pi/pi-catalog/types";

const M31_IDS = ["MiniMax-M3.1-Flash", "MiniMax-M3.1-Flash-Preview"] as const;
const MINIMAX_HOSTS = ["minimax", "minimax-cn", "minimax-code", "minimax-code-cn"] as const satisfies readonly Provider[];
const ALL_TIERS = [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max];

function buildM31<TApi extends Api>(id: string, provider: Provider, api: TApi): Model<TApi> {
	return buildModel({
		id,
		name: id,
		api,
		provider,
		baseUrl: api === "anthropic-messages" ? "https://api.minimax.io/anthropic" : "https://api.minimax.io/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 204_800,
		maxTokens: 131_072,
	});
}

/** OpenAI-compatible wire value, mirroring pi-ai's `mapOpenAIReasoningEffort`. */
function openAIWireEffort(model: Model<"openai-completions">, effort: Effort): string {
	return model.compat.reasoningEffortMap?.[effort] ?? model.thinking?.effortMap?.[effort] ?? effort;
}

describe("MiniMax M3.1 effort pin (classes/minimax.kdl)", () => {
	for (const id of M31_IDS) {
		for (const provider of MINIMAX_HOSTS) {
			it(`sends medium for every tier and the default on ${provider}/${id} over Anthropic Messages`, () => {
				const model = buildM31(id, provider, "anthropic-messages");
				expect(model.thinking?.requiresEffort).toBe(true);
				expect(model.thinking?.efforts).toEqual(ALL_TIERS);
				expect(model.thinking?.defaultLevel).toBe(Effort.Medium);
				for (const effort of ALL_TIERS) {
					expect(mapEffortToAnthropicAdaptiveEffort(model, effort)).toBe("medium");
				}
				// Effort-less and forced-off requests clamp to an effort first.
				const clampTargets = [defaultSupportedEffort(model), minimumSupportedEffort(model)];
				for (const clamped of clampTargets) {
					expect(clamped).toBeDefined();
					expect(mapEffortToAnthropicAdaptiveEffort(model, clamped!)).toBe("medium");
				}
			});

			it(`sends reasoning_effort medium for every tier and the default on ${provider}/${id} over Chat Completions`, () => {
				const model = buildM31(id, provider, "openai-completions");
				expect(model.thinking?.requiresEffort).toBe(true);
				expect(model.thinking?.defaultLevel).toBe(Effort.Medium);
				// Exact-model rank beats the class-wide minimax-code `supports-reasoning-effort #false`.
				expect(model.compat.supportsReasoningEffort).toBe(true);
				expect(model.compat.omitReasoningEffort).toBe(false);
				for (const effort of ALL_TIERS) {
					expect(openAIWireEffort(model, effort)).toBe("medium");
				}
				const clampTargets = [defaultSupportedEffort(model), minimumSupportedEffort(model)];
				for (const clamped of clampTargets) {
					expect(clamped).toBeDefined();
					expect(openAIWireEffort(model, clamped!)).toBe("medium");
				}
			});
		}
	}
});
