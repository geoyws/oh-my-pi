import { expect, it } from "bun:test";
import type { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { ProviderRequestTelemetry } from "@oh-my-pi/pi-ai/utils/request-telemetry";
import { transportFetch } from "@oh-my-pi/pi-ai/utils/transport-fetch";
import { logger } from "@oh-my-pi/pi-utils";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	BidiAppendRequestSchema,
	BidiRequestIdSchema,
	InteractionUpdateSchema,
	TextDeltaUpdateSchema,
	TurnEndedUpdateSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";

const CONNECT_END_STREAM_FLAG = 0x02;

function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
	const frame = Buffer.alloc(5 + data.length);
	frame[0] = flags;
	frame.writeUInt32BE(data.length, 1);
	frame.set(data, 5);
	return frame;
}

function readConnectMessage(frame: Uint8Array): Uint8Array {
	if (frame.length < 5) throw new Error("truncated Connect frame");
	const length = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(1, false);
	if (frame.length !== length + 5) throw new Error("invalid Connect frame length");
	return frame.subarray(5);
}

function textDeltaFrame(text: string): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, {
				message: { case: "textDelta", value: create(TextDeltaUpdateSchema, { text }) },
			}),
		},
	});
	return frameConnectMessage(toBinary(AgentServerMessageSchema, message));
}

function turnEndedFrame(): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, {
				message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
			}),
		},
	});
	return frameConnectMessage(toBinary(AgentServerMessageSchema, message));
}

function connectEndErrorFrame(code: string): Buffer {
	return frameConnectMessage(Buffer.from(JSON.stringify({ error: { code } }), "utf8"), CONNECT_END_STREAM_FLAG);
}

function makeModel(baseUrl: string): Model<"cursor-agent"> {
	return buildModel({
		id: "cursor-http1-fixture",
		name: "Cursor HTTP1 fixture",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1,
		maxTokens: 1,
	});
}

const context: Context = { messages: [{ role: "user", content: "transport", timestamp: 1 }] };

/**
 * Serves RunSSE and hands its response controller to `onRunRequest` once the
 * client's first BidiAppend (the run request) arrives.
 */
function startRunSseServer(onRunRequest: (controller: ReadableStreamDefaultController<Uint8Array>) => void) {
	const streamReady = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
	let runRequestSeen = false;
	return Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			await request.arrayBuffer();
			if (url.pathname === "/agent.v1.AgentService/RunSSE") {
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							streamReady.resolve(controller);
						},
					}),
					{ headers: { "content-type": "application/connect+proto" } },
				);
			}
			if (url.pathname === "/aiserver.v1.BidiService/BidiAppend") {
				if (!runRequestSeen) {
					runRequestSeen = true;
					onRunRequest(await streamReady.promise);
				}
				return new Response(null, { headers: { "content-type": "application/proto" } });
			}
			return new Response(null, { status: 404 });
		},
	});
}

/** A turn that never settles fails the test at this bound instead of hanging the suite. */
const SETTLE_TIMEOUT_MS = 2_000;

/** Drains the stream, recording every terminal event it emits. */
async function drain(response: AssistantMessageEventStream, onEvent?: (type: string) => void) {
	const terminalEvents: string[] = [];
	for await (const event of response) {
		onEvent?.(event.type);
		if (event.type === "done" || event.type === "error") terminalEvents.push(event.type);
	}
	return { result: await response.result(), terminalEvents };
}

it("streams through RunSSE and sends AgentClientMessage frames through BidiAppend", async () => {
	const streamReady = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
	const runRequestIds: string[] = [];
	const appendRequestIds: string[] = [];
	const appendSeqnos: bigint[] = [];
	const appendedCases: string[] = [];
	const streamingHeaders: string[] = [];

	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			streamingHeaders.push(request.headers.get("x-cursor-streaming") ?? "");
			const body = new Uint8Array(await request.arrayBuffer());
			if (url.pathname === "/agent.v1.AgentService/RunSSE") {
				const requestId = fromBinary(BidiRequestIdSchema, readConnectMessage(body));
				runRequestIds.push(requestId.requestId);
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							streamReady.resolve(controller);
						},
					}),
					{ headers: { "content-type": "application/connect+proto" } },
				);
			}
			if (url.pathname === "/aiserver.v1.BidiService/BidiAppend") {
				// BidiAppend is a unary RPC: the live service answers 415 to a
				// streaming-framed `application/connect+proto` body and accepts only
				// an unframed `application/proto` message.
				if (request.headers.get("content-type") !== "application/proto") {
					return new Response(null, { status: 415 });
				}
				const append = fromBinary(BidiAppendRequestSchema, body);
				appendRequestIds.push(append.requestId?.requestId ?? "");
				appendSeqnos.push(append.appendSeqno);
				appendedCases.push(fromBinary(AgentClientMessageSchema, append.dataBinary).message.case ?? "");
				const controller = await streamReady.promise;
				controller.enqueue(textDeltaFrame("http1 ok"));
				controller.enqueue(turnEndedFrame());
				controller.close();
				return new Response(null, { headers: { "content-type": "application/proto" } });
			}
			return new Response(null, { status: 404 });
		},
	});

	try {
		const response = streamCursor(makeModel(server.url.toString()), context, {
			apiKey: "test-token",
			transport: "http1",
		});
		const { result, terminalEvents } = await drain(response);

		expect(terminalEvents).toEqual(["done"]);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "http1 ok" })]);
		expect(runRequestIds).toHaveLength(1);
		expect(appendRequestIds).toEqual(runRequestIds);
		expect(appendSeqnos).toEqual([0n]);
		expect(appendedCases).toEqual(["runRequest"]);
		expect(streamingHeaders).toEqual(["true", "true"]);
	} finally {
		server.stop(true);
	}
});

it(
	"settles a turn with the error an end-stream frame carries",
	async () => {
		const server = startRunSseServer(controller => {
			controller.enqueue(textDeltaFrame("partial"));
			controller.enqueue(connectEndErrorFrame("resource_exhausted"));
			controller.close();
		});

		try {
			const response = streamCursor(makeModel(server.url.toString()), context, {
				apiKey: "test-token",
				transport: "http1",
			});
			const { result, terminalEvents } = await drain(response);

			expect(terminalEvents).toEqual(["error"]);
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("resource_exhausted");
		} finally {
			server.stop(true);
		}
	},
	SETTLE_TIMEOUT_MS,
);

it(
	"settles a caller abort on a live RunSSE stream as aborted",
	async () => {
		const server = startRunSseServer(controller => {
			// `turnEnded` arrives but the transport never ends, so the turn is still
			// waiting on a clean end when the caller aborts. Closing the transport
			// must not turn that abort into a successful completion.
			controller.enqueue(Buffer.concat([textDeltaFrame("partial"), turnEndedFrame()]));
		});
		const abort = new AbortController();

		try {
			const response = streamCursor(makeModel(server.url.toString()), context, {
				apiKey: "test-token",
				transport: "http1",
				signal: abort.signal,
			});
			const { result, terminalEvents } = await drain(response, type => {
				if (type === "text_delta") abort.abort();
			});

			expect(terminalEvents).toEqual(["error"]);
			expect(result.stopReason).toBe("aborted");
		} finally {
			server.stop(true);
		}
	},
	SETTLE_TIMEOUT_MS,
);

it("counts only native RunSSE attempts and exact bytes across a retry, excluding BidiAppend", async () => {
	const lines: Array<{ message: string; fields: Record<string, unknown> }> = [];
	const dispose = logger.registerLogSink(event => {
		if (event.message.startsWith("provider request")) {
			lines.push({ message: event.message, fields: event.context ?? {} });
		}
	});
	const success = Buffer.concat([textDeltaFrame("雪🌊"), turnEndedFrame()]);
	// A clean Connect end before turnEnded forces the existing incomplete-stream retry.
	const failure = frameConnectMessage(Buffer.from("{}"), CONNECT_END_STREAM_FLAG);
	let requests = 0;
	let appends = 0;
	let fetchCalls = 0;
	let streamReady = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			await request.arrayBuffer();
			if (new URL(request.url).pathname.endsWith("/RunSSE")) {
				requests++;
				return new Response(new ReadableStream<Uint8Array>({
					start(controller) { streamReady.resolve(controller); },
				}), { headers: { "content-type": "application/connect+proto" } });
			}
			appends++;
			const controller = await streamReady.promise;
			streamReady = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
			controller.enqueue(requests === 1 ? failure : success);
			controller.close();
			return new Response("auxiliary body must not count".repeat(100), { headers: { "content-type": "application/proto" } });
		},
	});
	try {
		const model = makeModel(server.url.toString());
		const telemetry = new ProviderRequestTelemetry(model, "native-http1");
		const fetch = transportFetch(model, async () => {
			fetchCalls++;
			throw new Error("native HTTP/1 must retain its existing fetch path");
		}, telemetry);
		const response = streamCursor(model, context, { apiKey: "test-token", transport: "http1", fetch, maxRetryDelayMs: 1 });
		telemetry.observe(response);
		const { result } = await drain(response);
		await Promise.resolve();
		expect(result.stopReason).toBe("stop");
		expect(requests).toBe(2);
		expect(appends).toBeGreaterThanOrEqual(1);
		expect(fetchCalls).toBe(0);
		const end = lines.find(line => line.message === "provider request end")!;
		expect(end.fields).toMatchObject({ attempts: 2, bytesIn: failure.byteLength + success.byteLength, status: 200, outcome: "ok" });
		expect(typeof end.fields.ttfbMs).toBe("number");
		const attempts = lines.filter(line => line.message === "provider request attempt");
		expect(attempts).toHaveLength(1);
		expect(attempts[0].fields).toMatchObject({ attempt: 2, previousStatus: 200, requestId: end.fields.requestId });
		expect(attempts[0].fields.previousError).toBeDefined();
	} finally {
		dispose();
		server.stop(true);
	}
}, 5_000);

it("records native RunSSE HTTP failure headers without inventing received bytes", async () => {
	const lines: Array<{ message: string; fields: Record<string, unknown> }> = [];
	const dispose = logger.registerLogSink(event => {
		if (event.message.startsWith("provider request")) lines.push({ message: event.message, fields: event.context ?? {} });
	});
	const server = Bun.serve({
		port: 0,
		fetch: request => new Response(null, { status: new URL(request.url).pathname.endsWith("/RunSSE") ? 401 : 200 }),
	});
	try {
		const model = makeModel(server.url.toString());
		const telemetry = new ProviderRequestTelemetry(model, "native-http-failure");
		const response = streamCursor(model, context, {
			apiKey: "test-token", transport: "http1", fetch: transportFetch(model, undefined, telemetry),
		});
		telemetry.observe(response);
		const { result } = await drain(response);
		await Promise.resolve();
		expect(result.stopReason).toBe("error");
		const end = lines.find(line => line.message === "provider request end")!;
		expect(end.fields).toMatchObject({ attempts: 1, bytesIn: 0, status: 401, outcome: "error" });
		expect(typeof end.fields.ttfbMs).toBe("number");
	} finally {
		dispose();
		server.stop(true);
	}
});
