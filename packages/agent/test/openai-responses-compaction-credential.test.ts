import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import {
	type CompactionPreparation,
	compact,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
} from "@oh-my-pi/pi-agent-core/compaction";
import {
	OPENAI_REMOTE_COMPACTION_PRESERVE_KEY,
	getCompactionV2PreserveData,
} from "@oh-my-pi/pi-agent-core/compaction/openai";
import type { ApiKey } from "@oh-my-pi/pi-ai";
import type {
	AssistantMessage,
	Context,
	FetchImpl,
	Model,
	SimpleStreamOptions,
	ToolResultMessage,
	UserMessage,
} from "@oh-my-pi/pi-ai/types";
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

function makeOpenAiModel(overrides: Partial<ModelSpec<"openai-responses">> = {}): Model<"openai-responses"> {
	return buildModel({
		id: "gpt-5",
		name: "GPT-5",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
		...overrides,
	});
}

function makeAzureModel(overrides: Partial<ModelSpec<"azure-openai-responses">> = {}): Model<"azure-openai-responses"> {
	return buildModel({
		id: "gpt-5",
		name: "GPT-5 Azure",
		api: "azure-openai-responses",
		provider: "azure-openai",
		baseUrl: "https://example-resource.openai.azure.com/openai/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
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

function responsesTurn(
	api: "openai-responses" | "azure-openai-responses",
	provider: string,
	credentialId: number | undefined,
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text" as const, text: "working on it" }],
		api,
		provider,
		model: "gpt-5",
		usage: ZERO_USAGE,
		stopReason: "stop",
		...(credentialId !== undefined ? { credentialId } : {}),
		providerPayload: {
			type: "openaiResponsesHistory",
			provider,
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

function v1SuccessResponse(): Response {
	return Response.json({ output: [{ type: "compaction", encrypted_content: "enc-new" }] });
}

// Real t-af8e8aa4 incident text: Meta returns 400 `reasoning
// encrypted_content was not issued to this caller (invalid_request_error)`.
const FOREIGN_CALLER_MESSAGE = "reasoning encrypted_content was not issued to this caller";

function foreignCallerResponse(): Response {
	return new Response(JSON.stringify({ error: { message: FOREIGN_CALLER_MESSAGE, type: "invalid_request_error" } }), {
		status: 400,
		headers: { "content-type": "application/json" },
	});
}

function isV1Body(body: Record<string, unknown>): boolean {
	// V1 /responses/compact takes {model, input, instructions}; V2 streaming
	// bodies carry instructions too, plus stream/store trigger flags.
	return typeof body.instructions === "string" && typeof body.stream !== "boolean";
}

// Preserve slots written literally (not via the store helpers) so these
// tests compile against the pre-fix code too and fail on behavior, proving
// the bug instead of a changed API.
function v2PreserveWithCredential(provider: string, credentialId: number): Record<string, unknown> {
	return {
		[OPENAI_REMOTE_COMPACTION_PRESERVE_KEY]: {
			version: "v2",
			provider,
			credentialId,
			replacementHistory: prefixHistory(),
			usedTokens: 1,
		},
	};
}

function v1PreserveWithCredential(provider: string, credentialId: number): Record<string, unknown> {
	return {
		[OPENAI_REMOTE_COMPACTION_PRESERVE_KEY]: {
			provider,
			replacementHistory: prefixHistory(),
			compactionItem: { type: "compaction", encrypted_content: "enc-prev" },
			credentialId,
		},
	};
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

interface CompactionRun {
	v2Bodies: Array<Record<string, unknown>>;
	v1Bodies: Array<Record<string, unknown>>;
	preserveData: Record<string, unknown> | undefined;
}

async function runRemoteCompaction(options: {
	model: Model;
	turn: AssistantMessage;
	previousPreserveData: Record<string, unknown> | undefined;
	servingApiKey: ApiKey;
	v2Enabled: boolean;
	fetch: FetchImpl;
	completeImpl?: (model: Model, ctx: Context, options: SimpleStreamOptions) => Promise<AssistantMessage>;
}): Promise<CompactionRun> {
	const v2Bodies: Array<Record<string, unknown>> = [];
	const v1Bodies: Array<Record<string, unknown>> = [];
	const fetchMock: FetchImpl = async (input, init) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		// V1 /responses/compact takes {model, input, instructions}; V2
		// streaming takes instructions too, plus stream/store trigger flags.
		(isV1Body(body) ? v1Bodies : v2Bodies).push(body);
		return options.fetch(input, init);
	};
	const preparation: CompactionPreparation = {
		firstKeptEntryId: "kept-1",
		messagesToSummarize: [userMessage("do the thing"), options.turn, toolResultMessage()],
		turnPrefixMessages: [],
		recentMessages: [userMessage("tail")],
		isSplitTurn: false,
		tokensBefore: 100_000,
		previousPreserveData: options.previousPreserveData,
		fileOps: createFileOps(),
		settings: {
			...DEFAULT_COMPACTION_SETTINGS,
			remoteStreamingV2Enabled: options.v2Enabled,
		},
	};
	const result = await compact(preparation, options.model, options.servingApiKey, undefined, undefined, {
		fetch: fetchMock,
		thinkingLevel: ThinkingLevel.Off,
		...(options.completeImpl ? { completeImpl: options.completeImpl } : {}),
	});
	return { v2Bodies, v1Bodies, preserveData: result.preserveData };
}

describe("openai-responses V2 compaction credential binding", () => {
	test("drops foreign encrypted reasoning from messages and prefix on the first request", async () => {
		const model = makeOpenAiModel({ remoteCompaction: { enabled: true, v2StreamingEnabled: true } });
		const run = await runRemoteCompaction({
			model,
			turn: responsesTurn("openai-responses", "openai", 11),
			previousPreserveData: v2PreserveWithCredential("openai", 11),
			servingApiKey: async () => ({ apiKey: "test-key", credentialId: 7 }),
			v2Enabled: true,
			fetch: async () => sseResponse(compactionV2SuccessEvents()),
		});

		expect(run.v2Bodies).toHaveLength(1);
		expect(run.v1Bodies).toHaveLength(0);
		const input = run.v2Bodies[0]?.input;
		expect(inputHasEncryptedContent(input, "enc_turn_A")).toBe(false);
		expect(inputHasEncryptedContent(input, "enc_prefix_A")).toBe(false);
		expect(inputHasFunctionCall(input, "call_a")).toBe(true);
		expect(JSON.stringify(input)).toContain("working on it");
		expect(getCompactionV2PreserveData(run.preserveData)?.credentialId).toBe(7);
	});

	test("retries a foreign-caller 400 once with encrypted reasoning stripped", async () => {
		const model = makeOpenAiModel({ remoteCompaction: { enabled: true, v2StreamingEnabled: true } });
		let v2Attempts = 0;
		const run = await runRemoteCompaction({
			model,
			// Legacy turn: no recorded credential, so the build keeps the blob
			// and the send retry must strip it after the 400.
			turn: responsesTurn("openai-responses", "openai", undefined),
			previousPreserveData: undefined,
			servingApiKey: "test-key",
			v2Enabled: true,
			fetch: async () => {
				v2Attempts += 1;
				return v2Attempts === 1 ? foreignCallerResponse() : sseResponse(compactionV2SuccessEvents());
			},
		});

		expect(run.v2Bodies).toHaveLength(2);
		expect(run.v1Bodies).toHaveLength(0);
		expect(inputHasEncryptedContent(run.v2Bodies[0]?.input, "enc_turn_A")).toBe(true);
		expect(inputHasEncryptedContent(run.v2Bodies[1]?.input, "enc_turn_A")).toBe(false);
		expect(inputHasFunctionCall(run.v2Bodies[1]?.input, "call_a")).toBe(true);
	});

	test("rebuilds the request for the sibling credential after a 401 rotation", async () => {
		const model = makeOpenAiModel({ remoteCompaction: { enabled: true, v2StreamingEnabled: true } });
		let fetches = 0;
		const run = await runRemoteCompaction({
			model,
			turn: responsesTurn("openai-responses", "openai", 1),
			previousPreserveData: v2PreserveWithCredential("openai", 1),
			// key-a serves until it 401s; the rotation context carries the
			// error, which switches the resolver to sibling key-b.
			servingApiKey: async ctx =>
				ctx.error !== undefined ? { apiKey: "key-b", credentialId: 2 } : { apiKey: "key-a", credentialId: 1 },
			v2Enabled: true,
			fetch: async () => {
				fetches += 1;
				return fetches === 1
					? new Response("unauthorized", { status: 401 })
					: sseResponse(compactionV2SuccessEvents());
			},
		});

		expect(run.v2Bodies).toHaveLength(2);
		// First attempt serves credential 1, so its own blobs stay.
		expect(inputHasEncryptedContent(run.v2Bodies[0]?.input, "enc_turn_A")).toBe(true);
		expect(inputHasEncryptedContent(run.v2Bodies[0]?.input, "enc_prefix_A")).toBe(true);
		// The rotated sibling must not receive credential 1's blobs.
		expect(inputHasEncryptedContent(run.v2Bodies[1]?.input, "enc_turn_A")).toBe(false);
		expect(inputHasEncryptedContent(run.v2Bodies[1]?.input, "enc_prefix_A")).toBe(false);
		expect(inputHasFunctionCall(run.v2Bodies[1]?.input, "call_a")).toBe(true);
		expect(getCompactionV2PreserveData(run.preserveData)?.credentialId).toBe(2);
	});
});

describe("openai-responses V1 compaction credential binding", () => {
	test("drops foreign encrypted reasoning from messages and prefix on the first request", async () => {
		const model = makeOpenAiModel({ remoteCompaction: { enabled: true } });
		const run = await runRemoteCompaction({
			model,
			turn: responsesTurn("openai-responses", "openai", 11),
			previousPreserveData: v1PreserveWithCredential("openai", 11),
			servingApiKey: async () => ({ apiKey: "test-key", credentialId: 7 }),
			v2Enabled: false,
			fetch: async () => v1SuccessResponse(),
		});

		expect(run.v1Bodies).toHaveLength(1);
		expect(run.v2Bodies).toHaveLength(0);
		const input = run.v1Bodies[0]?.input;
		expect(inputHasEncryptedContent(input, "enc_turn_A")).toBe(false);
		expect(inputHasEncryptedContent(input, "enc_prefix_A")).toBe(false);
		expect(inputHasFunctionCall(input, "call_a")).toBe(true);
	});

	test("retries a foreign-caller 400 once with encrypted reasoning stripped", async () => {
		const model = makeOpenAiModel({ remoteCompaction: { enabled: true } });
		let v1Attempts = 0;
		const run = await runRemoteCompaction({
			model,
			turn: responsesTurn("openai-responses", "openai", undefined),
			previousPreserveData: undefined,
			servingApiKey: "test-key",
			v2Enabled: false,
			fetch: async () => {
				v1Attempts += 1;
				return v1Attempts === 1 ? foreignCallerResponse() : v1SuccessResponse();
			},
			completeImpl: localSummaryTurn,
		});

		expect(run.v1Bodies).toHaveLength(2);
		expect(inputHasEncryptedContent(run.v1Bodies[0]?.input, "enc_turn_A")).toBe(true);
		expect(inputHasEncryptedContent(run.v1Bodies[1]?.input, "enc_turn_A")).toBe(false);
		expect(inputHasFunctionCall(run.v1Bodies[1]?.input, "call_a")).toBe(true);
	});

	test("rebuilds the request for the sibling credential after a 401 rotation", async () => {
		const model = makeOpenAiModel({ remoteCompaction: { enabled: true } });
		let fetches = 0;
		const run = await runRemoteCompaction({
			model,
			turn: responsesTurn("openai-responses", "openai", 1),
			previousPreserveData: v1PreserveWithCredential("openai", 1),
			// key-a serves until it 401s; the rotation context carries the
			// error, which switches the resolver to sibling key-b.
			servingApiKey: async ctx =>
				ctx.error !== undefined ? { apiKey: "key-b", credentialId: 2 } : { apiKey: "key-a", credentialId: 1 },
			v2Enabled: false,
			fetch: async () => {
				fetches += 1;
				return fetches === 1 ? new Response("unauthorized", { status: 401 }) : v1SuccessResponse();
			},
		});

		expect(run.v1Bodies).toHaveLength(2);
		expect(inputHasEncryptedContent(run.v1Bodies[0]?.input, "enc_turn_A")).toBe(true);
		expect(inputHasEncryptedContent(run.v1Bodies[1]?.input, "enc_turn_A")).toBe(false);
		expect(inputHasEncryptedContent(run.v1Bodies[1]?.input, "enc_prefix_A")).toBe(false);
		expect(inputHasFunctionCall(run.v1Bodies[1]?.input, "call_a")).toBe(true);
	});
});

describe("azure-openai-responses compaction credential binding", () => {
	test("V2 drops foreign encrypted reasoning from messages and prefix", async () => {
		const model = makeAzureModel({ remoteCompaction: { enabled: true, v2StreamingEnabled: true } });
		const run = await runRemoteCompaction({
			model,
			turn: responsesTurn("azure-openai-responses", "azure-openai", 11),
			previousPreserveData: v2PreserveWithCredential("azure-openai", 11),
			servingApiKey: async () => ({ apiKey: "test-key", credentialId: 7 }),
			v2Enabled: true,
			fetch: async () => sseResponse(compactionV2SuccessEvents()),
		});

		expect(run.v2Bodies).toHaveLength(1);
		const input = run.v2Bodies[0]?.input;
		expect(inputHasEncryptedContent(input, "enc_turn_A")).toBe(false);
		expect(inputHasEncryptedContent(input, "enc_prefix_A")).toBe(false);
		expect(inputHasFunctionCall(input, "call_a")).toBe(true);
		expect(getCompactionV2PreserveData(run.preserveData)?.credentialId).toBe(7);
	});

	test("V2 retries a foreign-caller 400 once with encrypted reasoning stripped", async () => {
		const model = makeAzureModel({ remoteCompaction: { enabled: true, v2StreamingEnabled: true } });
		let v2Attempts = 0;
		const run = await runRemoteCompaction({
			model,
			turn: responsesTurn("azure-openai-responses", "azure-openai", undefined),
			previousPreserveData: undefined,
			servingApiKey: "test-key",
			v2Enabled: true,
			fetch: async () => {
				v2Attempts += 1;
				return v2Attempts === 1 ? foreignCallerResponse() : sseResponse(compactionV2SuccessEvents());
			},
		});

		expect(run.v2Bodies).toHaveLength(2);
		expect(inputHasEncryptedContent(run.v2Bodies[0]?.input, "enc_turn_A")).toBe(true);
		expect(inputHasEncryptedContent(run.v2Bodies[1]?.input, "enc_turn_A")).toBe(false);
	});

	test("V1 drops foreign encrypted reasoning from messages and prefix", async () => {
		const model = makeAzureModel({ remoteCompaction: { enabled: true } });
		const run = await runRemoteCompaction({
			model,
			turn: responsesTurn("azure-openai-responses", "azure-openai", 11),
			previousPreserveData: v1PreserveWithCredential("azure-openai", 11),
			servingApiKey: async () => ({ apiKey: "test-key", credentialId: 7 }),
			v2Enabled: false,
			fetch: async () => v1SuccessResponse(),
		});

		expect(run.v1Bodies).toHaveLength(1);
		const input = run.v1Bodies[0]?.input;
		expect(inputHasEncryptedContent(input, "enc_turn_A")).toBe(false);
		expect(inputHasEncryptedContent(input, "enc_prefix_A")).toBe(false);
		expect(inputHasFunctionCall(input, "call_a")).toBe(true);
	});

	test("V1 retries a foreign-caller 400 once with encrypted reasoning stripped", async () => {
		const model = makeAzureModel({ remoteCompaction: { enabled: true } });
		let v1Attempts = 0;
		const run = await runRemoteCompaction({
			model,
			turn: responsesTurn("azure-openai-responses", "azure-openai", undefined),
			previousPreserveData: undefined,
			servingApiKey: "test-key",
			v2Enabled: false,
			fetch: async () => {
				v1Attempts += 1;
				return v1Attempts === 1 ? foreignCallerResponse() : v1SuccessResponse();
			},
			completeImpl: localSummaryTurn,
		});

		expect(run.v1Bodies).toHaveLength(2);
		expect(inputHasEncryptedContent(run.v1Bodies[0]?.input, "enc_turn_A")).toBe(true);
		expect(inputHasEncryptedContent(run.v1Bodies[1]?.input, "enc_turn_A")).toBe(false);
	});
});

function localSummaryTurn(): Promise<AssistantMessage> {
	return Promise.resolve({
		role: "assistant",
		content: [{ type: "text" as const, text: "local summary" }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: Date.now(),
	} as unknown as AssistantMessage);
}
