import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import { streamAppleFoundationModels } from "@oh-my-pi/pi-ai/providers/apple-foundation-models";
import { stream } from "@oh-my-pi/pi-ai/stream";
import { ProviderRequestTelemetry } from "@oh-my-pi/pi-ai/utils/request-telemetry";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as natives from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";
import { BEDROCK_TEST_CONTEXT, bedrockEvent, bedrockTestModel } from "./helpers/bedrock-stream";

const raw = '{"path":"repaired.txt","content":"hello';
const tool = { name: "write", description: "Write a file", parameters: { type: "object" } };

describe("final JSON tool-call boundaries", () => {
	afterEach(() => vi.restoreAllMocks());

	it.each(["contentBlockStop", "messageStop", "eof"])("refuses truncated Bedrock input at %s", async finalizer => {
		const frames = [
			bedrockEvent("messageStart", JSON.stringify({ role: "assistant" })),
			bedrockEvent(
				"contentBlockStart",
				JSON.stringify({ contentBlockIndex: 0, start: { toolUse: { toolUseId: "call_1", name: "write" } } }),
			),
			bedrockEvent(
				"contentBlockDelta",
				JSON.stringify({ contentBlockIndex: 0, delta: { toolUse: { input: raw } } }),
			),
			...(finalizer === "contentBlockStop"
				? [bedrockEvent("contentBlockStop", JSON.stringify({ contentBlockIndex: 0 }))]
				: []),
			...(finalizer !== "eof" ? [bedrockEvent("messageStop", JSON.stringify({ stopReason: "tool_use" }))] : []),
		];
		const result = await streamBedrock(bedrockTestModel(), BEDROCK_TEST_CONTEXT, {
			bearerToken: "test-token",
			fetch: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							for (const frame of frames) controller.enqueue(frame);
							controller.close();
						},
					}),
					{ headers: { "content-type": "application/vnd.amazon.eventstream" } },
				),
		}).result();
		if (finalizer !== "eof") expect(result.stopReason).toBe("toolUse");
		const call = result.content.find(block => block.type === "toolCall");
		if (!call) throw new Error("Expected tool call");
		expect(call.arguments).toEqual({ __parseError: expect.any(String), __rawJson: raw });
		expect(() => validateToolArguments(tool, call)).toThrow("Tool call arguments are not valid JSON");
	});

	it("refuses truncated Apple Foundation Models arguments when the bridge finishes", async () => {
		vi.spyOn(natives, "appleFmGenerate").mockImplementation((_request, callback) => {
			callback(null, JSON.stringify({ type: "toolCall", callId: "call_1", name: "write", arguments: raw }));
			callback(null, JSON.stringify({ type: "done" }));
			return 1;
		});
		const model = buildModel({
			id: "on-device",
			name: "On-device",
			api: "apple-foundation-models",
			provider: "apple",
			baseUrl: "",
			reasoning: false,
			input: ["text"],
			contextWindow: 8192,
			maxTokens: 1024,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		const result = await streamAppleFoundationModels(model, BEDROCK_TEST_CONTEXT, {}).result();
		expect(result.stopReason).toBe("toolUse");
		const call = result.content.find(block => block.type === "toolCall");
		if (!call) throw new Error("Expected tool call");
		expect(call.arguments).toEqual({ __parseError: expect.any(String), __rawJson: raw });
		expect(() => validateToolArguments(tool, call)).toThrow("Tool call arguments are not valid JSON");
	});
});

describe("Apple local inference telemetry", () => {
	const model = buildModel({
		id: "on-device",
		name: "On-device",
		api: "apple-foundation-models",
		provider: "apple",
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		contextWindow: 8192,
		maxTokens: 1024,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
	let dispose: (() => void) | undefined;
	const lines: Array<{ message: string; fields: Record<string, unknown> }> = [];

	function capture() {
		lines.length = 0;
		dispose = logger.registerLogSink(event => {
			if (event.message.startsWith("provider request")) {
				lines.push({ message: event.message, fields: (event.context ?? {}) as Record<string, unknown> });
			}
		});
	}

	afterEach(() => {
		dispose?.();
		dispose = undefined;
		vi.restoreAllMocks();
	});

	it("counts one local generation while retaining streamed content and usage without network bytes", async () => {
		capture();
		const bridge = vi.spyOn(natives, "appleFmGenerate").mockImplementation((_request, callback) => {
			queueMicrotask(() => {
				callback(null, JSON.stringify({ type: "text", text: "Hello " }));
				callback(null, JSON.stringify({ type: "text", text: "世界" }));
				callback(null, JSON.stringify({ type: "usage", input: 12, cachedInput: 4, output: 3, reasoning: 0 }));
				callback(null, JSON.stringify({ type: "done" }));
			});
			return 1;
		});
		const fetch = vi.fn(async () => {
			throw new Error("Local inference must not fetch");
		});
		const request = stream(model, BEDROCK_TEST_CONTEXT, { apiKey: "local", fetch });
		const events = [];
		for await (const event of request) events.push(event);
		const result = await request.result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "Hello 世界" }]);
		expect(events.filter(event => event.type === "text_delta").map(event => event.delta)).toEqual(["Hello ", "世界"]);
		expect(bridge).toHaveBeenCalledTimes(1);
		expect(fetch).not.toHaveBeenCalled();
		expect(lines.map(line => line.message)).toEqual(["provider request start", "provider request end"]);
		const end = lines[1].fields;
		expect(end).toMatchObject({
			requestId: lines[0].fields.requestId,
			attempts: 1,
			bytesIn: 0,
			outcome: "ok",
			inputTokens: 8,
			cacheReadTokens: 4,
			outputTokens: 3,
			totalTokens: 15,
		});
		expect(end.status).toBeUndefined();
		expect(end.ttfbMs).toBeUndefined();
	});

	it.each(["throw", "callback", "event"] as const)("records a real bridge %s failure once and returns the failure to the consumer", async mode => {
		capture();
		const failure = new Error("Local generation failed");
		const noteError = vi.spyOn(ProviderRequestTelemetry.prototype, "noteCallError");
		const bridge = vi.spyOn(natives, "appleFmGenerate").mockImplementation((_request, callback) => {
			if (mode === "throw") throw failure;
			queueMicrotask(() => {
				if (mode === "callback") callback(failure, "");
				else callback(null, JSON.stringify({ type: "error", code: "runtime", message: failure.message }));
			});
			return 1;
		});
		const result = await stream(model, BEDROCK_TEST_CONTEXT, { apiKey: "local" }).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(failure.message);
		expect(bridge).toHaveBeenCalledTimes(1);
		expect(noteError).toHaveBeenCalledTimes(1);
		if (mode !== "event") expect(noteError).toHaveBeenCalledWith(failure);
		expect(lines.map(line => line.message)).toEqual(["provider request start", "provider request end"]);
		expect(lines[1].fields).toMatchObject({ attempts: 1, bytesIn: 0, outcome: "error" });
		expect(lines[1].fields.status).toBeUndefined();
	});

	it("does not count a local attempt when payload preparation rejects before bridge invocation", async () => {
		capture();
		const bridge = vi.spyOn(natives, "appleFmGenerate");
		const result = await stream(model, BEDROCK_TEST_CONTEXT, {
			apiKey: "local",
			onPayload() {
				throw new Error("Payload rejected");
			},
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Payload rejected");
		expect(bridge).not.toHaveBeenCalled();
		expect(lines[1].fields).toMatchObject({ attempts: 0, bytesIn: 0, outcome: "error" });
	});
});
