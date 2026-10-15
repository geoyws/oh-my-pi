import { describe, expect, it } from "bun:test";
import {
	buildTransformedCodexRequestBody,
	convertCodexResponsesMessages,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai/types";
import { createOpenAIResponsesHistoryPayload } from "@oh-my-pi/pi-ai/utils";
import { createCodexModel } from "./helpers";

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function codexTurn(credentialId: number | undefined, modelId = "gpt-5.5"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "working on it" }],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: modelId,
		usage: ZERO_USAGE,
		stopReason: "stop",
		...(credentialId !== undefined ? { credentialId } : {}),
		providerPayload: createOpenAIResponsesHistoryPayload("openai-codex", [
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "working on it" }],
			},
			{ type: "reasoning", id: "rs_codex", summary: [], encrypted_content: "enc_codex_11" },
			{ type: "function_call", call_id: "call_codex", name: "read", arguments: "{}" },
		]),
		timestamp: Date.now(),
	};
}

function codexContext(credentialId: number | undefined, modelId = "gpt-5.5"): Context {
	return {
		messages: [codexTurn(credentialId, modelId), { role: "user", content: "continue", timestamp: Date.now() }],
	};
}

function containsEncryptedReasoning(input: unknown[] | undefined): boolean {
	return (input ?? []).some(item => {
		if (!item || typeof item !== "object") return false;
		return "encrypted_content" in item && typeof item.encrypted_content === "string";
	});
}

function containsAssistantOutputText(input: unknown[] | undefined, text: string): boolean {
	return (input ?? []).some(item => {
		if (!item || typeof item !== "object") return false;
		if (!("type" in item) || item.type !== "message") return false;
		if (!("content" in item) || !Array.isArray(item.content)) return false;
		return item.content.some(
			part =>
				part !== null &&
				typeof part === "object" &&
				"type" in part &&
				part.type === "output_text" &&
				"text" in part &&
				part.text === text,
		);
	});
}

function containsFunctionCall(input: unknown[] | undefined, callId: string): boolean {
	return (input ?? []).some(
		item =>
			item !== null &&
			typeof item === "object" &&
			"type" in item &&
			item.type === "function_call" &&
			"call_id" in item &&
			item.call_id === callId,
	);
}

describe("openai-codex-responses encrypted reasoning credential binding", () => {
	const model = createCodexModel("gpt-5.5");

	it("keeps encrypted reasoning for the issuing credential", () => {
		const input = convertCodexResponsesMessages(model, codexContext(11), { currentCredentialId: 11 });
		expect(containsEncryptedReasoning(input)).toBe(true);
		expect(containsFunctionCall(input, "call_codex")).toBe(true);
	});

	it("drops encrypted reasoning issued under another credential but keeps other items", () => {
		const input = convertCodexResponsesMessages(model, codexContext(11), { currentCredentialId: 7 });
		expect(containsEncryptedReasoning(input)).toBe(false);
		expect(containsFunctionCall(input, "call_codex")).toBe(true);
		expect(containsAssistantOutputText(input, "working on it")).toBe(true);
	});

	it("preserves legacy replay when either credential is unknown", () => {
		expect(containsEncryptedReasoning(convertCodexResponsesMessages(model, codexContext(11)))).toBe(true);
		expect(
			containsEncryptedReasoning(
				convertCodexResponsesMessages(model, codexContext(undefined), { currentCredentialId: 7 }),
			),
		).toBe(true);
	});

	it("drops encrypted reasoning on a model change with the same credential", () => {
		const input = convertCodexResponsesMessages(model, codexContext(11, "other-model"), {
			currentCredentialId: 11,
		});
		expect(containsEncryptedReasoning(input)).toBe(false);
	});

	it("forwards the request credential through the shared turn/compaction body builder", async () => {
		const switched = await buildTransformedCodexRequestBody(model, codexContext(11), { credentialId: 7 });
		const switchedInput = switched.input as unknown[];
		expect(containsEncryptedReasoning(switchedInput)).toBe(false);
		expect(containsFunctionCall(switchedInput, "call_codex")).toBe(true);

		const same = await buildTransformedCodexRequestBody(model, codexContext(11), { credentialId: 11 });
		expect(containsEncryptedReasoning(same.input as unknown[])).toBe(true);
	});
});
