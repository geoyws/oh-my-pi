import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import {
	type CompactionPreparation,
	compact,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
} from "@oh-my-pi/pi-agent-core/compaction";
import { storeCompactionV2PreserveData } from "@oh-my-pi/pi-agent-core/compaction/openai";
import type { ApiKey } from "@oh-my-pi/pi-ai";
import type { AssistantMessage, FetchImpl, Model, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import * as piUtils from "@oh-my-pi/pi-utils";

const TEST_INSTALLATION_ID = "00000000-0000-4000-8000-000000000001";

beforeEach(() => {
	vi.spyOn(piUtils, "getInstallId").mockReturnValue(TEST_INSTALLATION_ID);
});

afterEach(() => {
	vi.restoreAllMocks();
});
const { isRecord } = piUtils;

function makeCodexCompactionModel(
	overrides: Partial<ModelSpec<"openai-codex-responses">> = {},
): Model<"openai-codex-responses"> {
	return buildModel({
		id: "gpt-5.6-terra",
		name: "GPT-5.6 Terra",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.example/backend-api",
		reasoning: true,
		preferWebsockets: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 372000,
		maxTokens: 128000,
		useResponsesLite: true,
		remoteCompaction: { enabled: true, api: "openai-codex-responses", v2StreamingEnabled: true },
		...overrides,
	});
}

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function credentialTurn(credentialId: number | undefined): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text" as const, text: "working on it" }],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-5.6-terra",
		usage: ZERO_USAGE,
		stopReason: "stop",
		...(credentialId !== undefined ? { credentialId } : {}),
		providerPayload: {
			type: "openaiResponsesHistory",
			provider: "openai-codex",
			dt: true,
			items: [
				{
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "working on it" }],
				},
				{ type: "reasoning", id: "rs_turn", summary: [], encrypted_content: "enc_turn_A" },
				{ type: "function_call", call_id: "call_a", name: "read", arguments: "{}" },
			],
		},
		timestamp: Date.now(),
	} as unknown as AssistantMessage;
}

function userMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function toolResultMessage(): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call_a|fc_call_a",
		toolName: "read",
		content: [{ type: "text", text: "result" }],
		isError: false,
		timestamp: Date.now(),
	};
}

function prefixHistory(): Array<Record<string, unknown>> {
	return [
		{ type: "message", role: "user", content: [{ type: "input_text", text: "prior user" }] },
		{ type: "reasoning", id: "rs_prefix", summary: [], encrypted_content: "enc_prefix_A" },
	];
}

function compactionV2SuccessEvents(): Array<Record<string, unknown>> {
	return [
		{
			type: "response.output_item.done",
			output_index: 0,
			item: { type: "compaction", encrypted_content: "enc-new" },
		},
		{
			type: "response.done",
			response: {
				id: "response-new",
				status: "completed",
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
			},
		},
	];
}

function sseResponse(events: Array<Record<string, unknown>>): Response {
	return new Response(
		`${events.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("")}`,
		{ headers: { "content-type": "text/event-stream" } },
	);
}

function inputHasEncryptedContent(input: unknown, blob: string): boolean {
	return (
		Array.isArray(input) &&
		input.some(
			item =>
				isRecord(item) &&
				"encrypted_content" in item &&
				(item as { encrypted_content?: unknown }).encrypted_content === blob,
		)
	);
}

function inputHasFunctionCall(input: unknown, callId: string): boolean {
	return (
		Array.isArray(input) &&
		input.some(item => isRecord(item) && item.type === "function_call" && item.call_id === callId)
	);
}

async function runCodexV2Compaction(options: {
	storedCredentialId: number | undefined;
	servingApiKey: ApiKey;
}): Promise<{ bodies: Array<Record<string, unknown>> }> {
	const model = makeCodexCompactionModel();
	const bodies: Array<Record<string, unknown>> = [];
	const fetchMock: FetchImpl = async (_input, init) => {
		bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		return sseResponse(compactionV2SuccessEvents());
	};

	const previousPreserveData = storeCompactionV2PreserveData(
		{
			compactionItem: { type: "compaction", encrypted_content: "enc-prev" },
			replacementHistory: prefixHistory(),
			usedTokens: 1,
			retainedImageCount: 0,
		},
		model,
		options.storedCredentialId,
	);

	const preparation: CompactionPreparation = {
		firstKeptEntryId: "kept-1",
		messagesToSummarize: [userMessage("do the thing"), credentialTurn(11), toolResultMessage()],
		turnPrefixMessages: [],
		recentMessages: [userMessage("tail")],
		isSplitTurn: false,
		tokensBefore: 100_000,
		previousPreserveData,
		fileOps: createFileOps(),
		settings: {
			...DEFAULT_COMPACTION_SETTINGS,
			remoteStreamingV2Enabled: true,
		},
	};

	await compact(preparation, model, options.servingApiKey, undefined, undefined, {
		fetch: fetchMock,
		thinkingLevel: ThinkingLevel.Off,
	});
	return { bodies };
}

describe("codex V2 compaction credential binding", () => {
	test("drops foreign encrypted reasoning from messages and prefix on the first request", async () => {
		const { bodies } = await runCodexV2Compaction({
			storedCredentialId: 11,
			servingApiKey: async () => ({ apiKey: "test-key", credentialId: 7 }),
		});

		expect(bodies).toHaveLength(1);
		const input = bodies[0]?.input;
		expect(inputHasEncryptedContent(input, "enc_turn_A")).toBe(false);
		expect(inputHasEncryptedContent(input, "enc_prefix_A")).toBe(false);
		expect(inputHasFunctionCall(input, "call_a")).toBe(true);
		expect(JSON.stringify(input)).toContain("working on it");
	});

	test("keeps encrypted reasoning when the serving credential matches", async () => {
		const { bodies } = await runCodexV2Compaction({
			storedCredentialId: 11,
			servingApiKey: async () => ({ apiKey: "test-key", credentialId: 11 }),
		});

		expect(bodies).toHaveLength(1);
		const input = bodies[0]?.input;
		expect(inputHasEncryptedContent(input, "enc_turn_A")).toBe(true);
		expect(inputHasEncryptedContent(input, "enc_prefix_A")).toBe(true);
	});

	test("strips encrypted reasoning when the serving credential is unknown", async () => {
		const { bodies } = await runCodexV2Compaction({
			storedCredentialId: 11,
			servingApiKey: "test-key",
		});

		expect(bodies).toHaveLength(1);
		const input = bodies[0]?.input;
		expect(inputHasEncryptedContent(input, "enc_turn_A")).toBe(false);
		expect(inputHasEncryptedContent(input, "enc_prefix_A")).toBe(false);
		expect(inputHasFunctionCall(input, "call_a")).toBe(true);
	});
});
