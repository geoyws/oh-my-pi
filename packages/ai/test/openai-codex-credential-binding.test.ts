import { afterEach, describe, expect, it } from "bun:test";
import {
	buildTransformedCodexRequestBody,
	convertCodexResponsesMessages,
	openCodexCompactionEventStream,
	streamOpenAICodexResponses,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { AssistantMessage, Context, FetchImpl, Model, ProviderSessionState } from "@oh-my-pi/pi-ai/types";
import { createOpenAIResponsesHistoryPayload } from "@oh-my-pi/pi-ai/utils";
import * as piUtils from "@oh-my-pi/pi-utils";
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

describe("openai-codex foreign encrypted reasoning transport retry", () => {
	const { getAgentDir, setAgentDir, TempDir } = piUtils;
	const originalAgentDir = getAgentDir();
	const originalWebSocket = global.WebSocket;

	afterEach(() => {
		global.WebSocket = originalWebSocket;
		setAgentDir(originalAgentDir);
	});

	const FOREIGN_CALLER_MESSAGE = "reasoning 'encrypted_content' was not issued to this caller";

	function sseModel(): Model<"openai-codex-responses"> {
		// Unofficial base URL: the official endpoint zstd-compresses SSE
		// bodies and resends uncompressed after a 400, which would double
		// the fetch counts these tests assert.
		return createCodexModel("gpt-5.5", {
			baseUrl: "http://127.0.0.1:2455/backend-api/codex",
			preferWebsockets: false,
		});
	}

	function wsModel(): Model<"openai-codex-responses"> {
		return createCodexModel("gpt-5.5", {
			baseUrl: "https://chatgpt.com/backend-api",
			preferWebsockets: true,
		});
	}

	function legacyContext(): Context {
		return codexContext(undefined);
	}

	function foreignCallerResponse(): Response {
		return new Response(
			JSON.stringify({ error: { message: FOREIGN_CALLER_MESSAGE, type: "invalid_request_error" } }),
			{ status: 400, headers: { "content-type": "application/json" } },
		);
	}

	function unrelatedBadRequestResponse(): Response {
		return new Response(
			JSON.stringify({ error: { message: "Input 'input[0]' is invalid", type: "invalid_request_error" } }),
			{ status: 400, headers: { "content-type": "application/json" } },
		);
	}

	function completedSseResponse(text: string): Response {
		const events = [
			{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
			{ type: "response.output_text.delta", delta: text },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_retry",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text }],
				},
			},
			{
				type: "response.completed",
				response: {
					id: "resp_retry",
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 3,
						total_tokens: 8,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		];
		return new Response(`${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}

	function createCodexTestToken(accountId = "acc_test"): string {
		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
			"utf8",
		).toBase64();
		return `aaa.${payload}.bbb`;
	}

	function useTempAgentDir(): void {
		setAgentDir(TempDir.createSync("@pi-codex-credential-retry-").path());
	}

	it("retries an SSE foreign-caller 400 once with encrypted reasoning stripped", async () => {
		useTempAgentDir();
		const seenInputs: unknown[][] = [];
		let attempts = 0;
		const fetchMock: FetchImpl = Object.assign(
			async (): Promise<Response> => {
				attempts += 1;
				return attempts === 1 ? foreignCallerResponse() : completedSseResponse("Recovered");
			},
			{ preconnect: fetch.preconnect },
		);

		const result = await streamOpenAICodexResponses(sseModel(), legacyContext(), {
			apiKey: createCodexTestToken(),
			fetch: fetchMock,
			onPayload: payload => {
				seenInputs.push([...((payload as { input?: unknown[] }).input ?? [])]);
				return undefined;
			},
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(attempts).toBe(2);
		expect(seenInputs).toHaveLength(2);
		expect(containsEncryptedReasoning(seenInputs[0])).toBe(true);
		expect(containsEncryptedReasoning(seenInputs[1])).toBe(false);
		expect(containsFunctionCall(seenInputs[1], "call_codex")).toBe(true);
		expect(containsAssistantOutputText(seenInputs[1], "working on it")).toBe(true);
	});

	it("surfaces a second SSE foreign-caller 400 instead of looping", async () => {
		useTempAgentDir();
		let attempts = 0;
		const fetchMock: FetchImpl = Object.assign(
			async (): Promise<Response> => {
				attempts += 1;
				return foreignCallerResponse();
			},
			{ preconnect: fetch.preconnect },
		);

		const result = await streamOpenAICodexResponses(sseModel(), legacyContext(), {
			apiKey: createCodexTestToken(),
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(attempts).toBe(2);
	});

	it("does not retry an unrelated SSE 400", async () => {
		useTempAgentDir();
		let attempts = 0;
		const fetchMock: FetchImpl = Object.assign(
			async (): Promise<Response> => {
				attempts += 1;
				return unrelatedBadRequestResponse();
			},
			{ preconnect: fetch.preconnect },
		);

		const result = await streamOpenAICodexResponses(sseModel(), legacyContext(), {
			apiKey: createCodexTestToken(),
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(attempts).toBe(1);
	});

	class ForeignReasoningWebSocket {
		static readonly CONNECTING = 0;
		static readonly OPEN = 1;
		static readonly CLOSING = 2;
		static readonly CLOSED = 3;
		static sends: string[] = [];

		readyState: number = ForeignReasoningWebSocket.CONNECTING;
		binaryType: "blob" | "arraybuffer" | "nodebuffer" = "blob";
		onopen: ((event: Event) => void) | null = null;
		onmessage: ((event: MessageEvent) => void) | null = null;
		onerror: ((event: Event) => void) | null = null;
		onclose: ((event: Event) => void) | null = null;

		constructor(
			public readonly url: string,
			public readonly options?: { headers?: Record<string, string> },
		) {}

		send(data: string): void {
			ForeignReasoningWebSocket.sends.push(data);
			if (ForeignReasoningWebSocket.sends.length === 1) {
				this.sendJson({
					type: "response.failed",
					response: {
						status: "400",
						error: { message: FOREIGN_CALLER_MESSAGE, code: "invalid_request_error" },
					},
				});
				return;
			}
			this.emitCodexResponse({ messageId: "msg_ws_retry", responseId: "resp_ws_retry", text: "Recovered" });
		}

		close(): void {
			this.readyState = ForeignReasoningWebSocket.CLOSED;
		}

		sendJson(payload: Record<string, unknown>): void {
			this.emit("message", { data: JSON.stringify(payload) } as unknown as MessageEvent);
		}

		emit(type: "open" | "message" | "error" | "close", event: Event): void {
			const handler = (this as unknown as Record<string, unknown>)[`on${type}`];
			if (typeof handler === "function") (handler as (e: Event) => void).call(this, event);
		}

		scheduleOpen(): void {
			setTimeout(() => {
				this.readyState = ForeignReasoningWebSocket.OPEN;
				this.emit("open", new Event("open"));
			}, 0);
		}

		emitCodexResponse(opts: { messageId: string; responseId: string; text: string }): void {
			const { messageId, responseId, text } = opts;
			this.sendJson({
				type: "response.output_item.done",
				item: {
					type: "message",
					id: messageId,
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text }],
				},
			});
			this.sendJson({
				type: "response.completed",
				response: {
					id: responseId,
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 3,
						total_tokens: 8,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			});
		}
	}

	function sentInput(sends: string[], index: number): unknown[] {
		return (JSON.parse(sends[index]!) as { input?: unknown[] }).input ?? [];
	}

	function useForeignReasoningSocket(): typeof ForeignReasoningWebSocket {
		ForeignReasoningWebSocket.sends = [];
		const socket = class extends ForeignReasoningWebSocket {
			constructor(url: string, options?: { headers?: Record<string, string> }) {
				super(url, options);
				this.scheduleOpen();
			}
		};
		global.WebSocket = socket as unknown as typeof WebSocket;
		return ForeignReasoningWebSocket;
	}

	it("retries a websocket foreign-caller failure once with encrypted reasoning stripped", async () => {
		useTempAgentDir();
		const socket = useForeignReasoningSocket();

		const result = await streamOpenAICodexResponses(wsModel(), legacyContext(), {
			apiKey: createCodexTestToken(),
			sessionId: "ws-foreign-reasoning-session",
			providerSessionState: new Map<string, ProviderSessionState>(),
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(socket.sends).toHaveLength(2);
		expect(containsEncryptedReasoning(sentInput(socket.sends, 0))).toBe(true);
		const retryInput = sentInput(socket.sends, 1);
		expect(containsEncryptedReasoning(retryInput)).toBe(false);
		expect(containsFunctionCall(retryInput, "call_codex")).toBe(true);
		expect(containsAssistantOutputText(retryInput, "working on it")).toBe(true);
	});

	it("surfaces a second websocket foreign-caller failure instead of looping", async () => {
		useTempAgentDir();
		const sends: string[] = [];
		class AlwaysFailWebSocket extends ForeignReasoningWebSocket {
			constructor(url: string, options?: { headers?: Record<string, string> }) {
				super(url, options);
				this.scheduleOpen();
			}

			override send(data: string): void {
				sends.push(data);
				this.sendJson({
					type: "response.failed",
					response: {
						status: "400",
						error: { message: FOREIGN_CALLER_MESSAGE, code: "invalid_request_error" },
					},
				});
			}
		}
		global.WebSocket = AlwaysFailWebSocket as unknown as typeof WebSocket;

		const result = await streamOpenAICodexResponses(wsModel(), legacyContext(), {
			apiKey: createCodexTestToken(),
			sessionId: "ws-foreign-reasoning-loop-session",
			providerSessionState: new Map<string, ProviderSessionState>(),
		}).result();

		expect(result.stopReason).toBe("error");
		expect(sends).toHaveLength(2);
	});

	it("does not retry an unrelated websocket failure", async () => {
		useTempAgentDir();
		const sends: string[] = [];
		class UnrelatedFailureWebSocket extends ForeignReasoningWebSocket {
			constructor(url: string, options?: { headers?: Record<string, string> }) {
				super(url, options);
				this.scheduleOpen();
			}

			override send(data: string): void {
				sends.push(data);
				this.sendJson({
					type: "response.failed",
					response: {
						status: "400",
						error: { message: "Input 'input[0]' is invalid", code: "invalid_request_error" },
					},
				});
			}
		}
		global.WebSocket = UnrelatedFailureWebSocket as unknown as typeof WebSocket;

		const result = await streamOpenAICodexResponses(wsModel(), legacyContext(), {
			apiKey: createCodexTestToken(),
			sessionId: "ws-unrelated-failure-session",
			providerSessionState: new Map<string, ProviderSessionState>(),
		}).result();

		expect(result.stopReason).toBe("error");
		expect(sends).toHaveLength(1);
	});

	it("retries a compaction foreign-caller 400 once with the staged body stripped", async () => {
		useTempAgentDir();
		const bodies: Array<Record<string, unknown>> = [];
		let attempts = 0;
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				const raw = init?.body;
				const text =
					typeof raw === "string" ? raw : new TextDecoder().decode(Bun.zstdDecompressSync(raw as Uint8Array));
				bodies.push(JSON.parse(text) as Record<string, unknown>);
				attempts += 1;
				return attempts === 1 ? foreignCallerResponse() : completedSseResponse("Compacted");
			},
			{ preconnect: fetch.preconnect },
		);

		const body = await buildTransformedCodexRequestBody(createCodexModel("gpt-5.5"), legacyContext(), undefined);
		const events: unknown[] = [];
		for await (const event of await openCodexCompactionEventStream(
			createCodexModel("gpt-5.5"),
			{ model: "gpt-5.5", input: body.input },
			{ apiKey: createCodexTestToken(), fetch: fetchMock },
		)) {
			events.push(event);
		}

		expect(attempts).toBe(2);
		expect(bodies).toHaveLength(2);
		expect(containsEncryptedReasoning(bodies[0]!.input as unknown[])).toBe(true);
		expect(containsEncryptedReasoning(bodies[1]!.input as unknown[])).toBe(false);
		expect(events.some(event => (event as { type?: unknown }).type === "response.completed")).toBe(true);
	});
});
