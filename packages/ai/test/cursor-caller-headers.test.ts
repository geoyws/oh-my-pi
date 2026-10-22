import { afterEach, describe, expect, it } from "bun:test";
import * as http2 from "node:http2";
import { streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { ProviderRequestTelemetry } from "@oh-my-pi/pi-ai/utils/request-telemetry";
import { transportFetch } from "@oh-my-pi/pi-ai/utils/transport-fetch";
import { logger } from "@oh-my-pi/pi-utils";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	AgentServerMessageSchema,
	InteractionUpdateSchema,
	TextDeltaUpdateSchema,
	TurnEndedUpdateSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";

// Cursor forwards caller headers (including `before_provider_headers` extension
// edits), and it speaks HTTP/2. These assert the TRANSPORT contract against a
// real local HTTP/2 server rather than the sanitizer in isolation: if
// `streamCursor` stopped merging caller headers, or merged the wrong ones, a
// helper-level test would still pass while the wire lost them.
//
// Two classes must never reach `http2.request()`, because node THROWS on them
// rather than ignoring them, turning a harmless header into a dead request:
// pseudo-headers and HTTP/1 connection-specific headers. A third class —
// headers the request sets for itself — must not arrive duplicated, since names
// are matched case-insensitively on the wire.

let server: http2.Http2Server | undefined;
const sessions = new Set<http2.Http2Session>();
let received: http2.IncomingHttpHeaders = {};

function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
	const frame = Buffer.alloc(5 + data.length);
	frame[0] = flags;
	frame.writeUInt32BE(data.length, 1);
	frame.set(data, 5);
	return frame;
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

/** Records the headers the client actually sent, then replies with a clean turn. */
async function startServer(reply?: (stream: http2.ServerHttp2Stream) => void): Promise<string> {
	server = http2.createServer();
	server.on("session", session => {
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
	});
	server.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
		stream.on("data", () => {});
		received = headers;
		if (reply) {
			reply(stream);
			return;
		}
		stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
		stream.write(textDeltaFrame("ok"));
		stream.write(turnEndedFrame());
		stream.end();
	});

	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("expected the fixture server to bind a tcp port");
	return `http://127.0.0.1:${address.port}`;
}

async function stopServer(): Promise<void> {
	for (const session of sessions) session.destroy();
	sessions.clear();
	if (!server) return;
	const closing = server;
	server = undefined;
	const closed = Promise.withResolvers<void>();
	closing.close(error => (error ? closed.reject(error) : closed.resolve()));
	await closed.promise;
}

function makeModel(baseUrl: string): Model<"cursor-agent"> {
	return buildModel({
		id: "cursor-caller-headers-fixture",
		name: "Cursor caller headers fixture",
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

const context: Context = { messages: [{ role: "user", content: "headers", timestamp: 1 }] };

/** Drive one request to completion and hand back the headers the server saw. */
async function send(headers: Record<string, string>): Promise<http2.IncomingHttpHeaders> {
	const baseUrl = await startServer();
	const stream = streamCursor(makeModel(baseUrl), context, { apiKey: "test-token", headers });
	for await (const _event of stream) {
		// drain
	}
	await stream.result();
	return received;
}

afterEach(async () => {
	received = {};
	await stopServer();
});

describe("Cursor caller headers reach the wire", () => {
	it("delivers an ordinary caller header to the server", async () => {
		const sent = await send({ "x-trace": "abc", "x-waygate-activity": "mode=plan" });
		expect(sent["x-trace"]).toBe("abc");
		expect(sent["x-waygate-activity"]).toBe("mode=plan");
	});

	it("normalizes a caller header name to lower case", async () => {
		const sent = await send({ "X-Trace": "abc" });
		expect(sent["x-trace"]).toBe("abc");
	});

	// The request still has to go out. Node throws on these rather than dropping
	// them, so a leak here is a dead request, not a missing header.
	it("survives HTTP/1 connection-specific headers and pseudo-headers", async () => {
		const sent = await send({
			connection: "keep-alive",
			"keep-alive": "timeout=5",
			"transfer-encoding": "chunked",
			upgrade: "h2c",
			":path": "/evil",
			"x-trace": "kept",
		});
		// The request completed, and the benign header still landed.
		expect(sent["x-trace"]).toBe("kept");
		expect(sent[":path"]).toBe("/agent.v1.AgentService/Run");
		expect(sent.connection).toBeUndefined();
		expect(sent["transfer-encoding"]).toBeUndefined();
	});

	it("does not let a caller override the headers the request sets itself", async () => {
		const sent = await send({
			Authorization: "Bearer stolen",
			"Content-Type": "text/plain",
			TE: "gzip",
			"X-Request-Id": "forged",
			// The Connect body is streamed after the headers, so no caller length can
			// describe it; an HTTP/2 peer resets the stream once the body diverges.
			"Content-Length": "999",
			"x-trace": "kept",
		});
		expect(sent.authorization).toBe("Bearer test-token");
		expect(sent["content-type"]).toBe("application/connect+proto");
		expect(sent.te).toBe("trailers");
		expect(sent["x-request-id"]).not.toBe("forged");
		expect(sent["content-length"]).toBeUndefined();
		expect(sent["x-trace"]).toBe("kept");
	});

	// A plain `host` header suppresses the `:authority` node derives from the URL,
	// so a caller value would silently retarget the request at another vhost.
	it("does not let a caller header retarget the request authority", async () => {
		const sent = await send({ Host: "evil.example.com", "x-trace": "kept" });
		expect(sent[":authority"]).not.toBe("evil.example.com");
		expect(sent[":authority"]).toContain("127.0.0.1");
		expect(sent.host).toBeUndefined();
		expect(sent["x-trace"]).toBe("kept");
	});
});

describe("Cursor native HTTP/2 request telemetry", () => {
	for (const retry of [false, true]) {
		it(
			retry
				? "counts native retry attempts and bytes from both responses"
				: "counts native response bytes without calling wrapped fetch",
			async () => {
				const lines: Array<{ message: string; fields: Record<string, unknown> }> = [];
				const dispose = logger.registerLogSink(event => {
					if (event.message.startsWith("provider request")) {
						lines.push({ message: event.message, fields: event.context ?? {} });
					}
				});
				const success = Buffer.concat([textDeltaFrame("雪🌊"), turnEndedFrame()]);
				// A clean Connect end before turnEnded is a replay-safe incomplete stream.
				const failure = frameConnectMessage(Buffer.from("{}"), 2);
				let requests = 0;
				let fetchCalls = 0;
				try {
					const baseUrl = await startServer(stream => {
						requests++;
						stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
						stream.end(retry && requests === 1 ? failure : success);
					});
					const model = makeModel(baseUrl);
					const telemetry = new ProviderRequestTelemetry(model, "native-h2");
					const fetch = transportFetch(
						model,
						async () => {
							fetchCalls++;
							throw new Error("native HTTP/2 must not invoke fetch");
						},
						telemetry,
					);
					const response = streamCursor(model, context, {
						apiKey: "test-token",
						transport: "http2",
						fetch,
						maxRetryDelayMs: 1,
					});
					telemetry.observe(response);
					for await (const _event of response) {
						/* drain */
					}
					expect((await response.result()).stopReason).toBe("stop");
					await Promise.resolve();
					expect(fetchCalls).toBe(0);
					expect(requests).toBe(retry ? 2 : 1);
					const end = lines.find(line => line.message === "provider request end")!;
					expect(end.fields).toMatchObject({
						attempts: requests,
						bytesIn: success.byteLength + (retry ? failure.byteLength : 0),
						status: 200,
						outcome: "ok",
					});
					expect(typeof end.fields.ttfbMs).toBe("number");
					const attempts = lines.filter(line => line.message === "provider request attempt");
					expect(attempts).toHaveLength(retry ? 1 : 0);
					if (retry) {
						expect(attempts[0].fields).toMatchObject({
							attempt: 2,
							previousStatus: 200,
							requestId: end.fields.requestId,
						});
						expect(attempts[0].fields.previousError).toBeDefined();
					}
				} finally {
					dispose();
				}
			},
			5_000,
		);
	}
});

it("retains native HTTP/2 bytes and headers on a terminal inference failure", async () => {
	const lines: Array<{ message: string; fields: Record<string, unknown> }> = [];
	const dispose = logger.registerLogSink(event => {
		if (event.message.startsWith("provider request"))
			lines.push({ message: event.message, fields: event.context ?? {} });
	});
	const body = frameConnectMessage(Buffer.from(JSON.stringify({ error: { code: "permission_denied" } })), 2);
	try {
		const baseUrl = await startServer(stream => {
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			stream.end(body);
		});
		const model = makeModel(baseUrl);
		const telemetry = new ProviderRequestTelemetry(model, "native-failure");
		const response = streamCursor(model, context, {
			apiKey: "test-token",
			transport: "http2",
			fetch: transportFetch(model, undefined, telemetry),
		});
		telemetry.observe(response);
		for await (const _event of response) {
			/* drain */
		}
		expect((await response.result()).stopReason).toBe("error");
		await Promise.resolve();
		expect(lines.find(line => line.message === "provider request end")!.fields).toMatchObject({
			attempts: 1,
			bytesIn: body.byteLength,
			status: 200,
			outcome: "error",
		});
		expect(lines.filter(line => line.message === "provider request attempt")).toHaveLength(0);
	} finally {
		dispose();
	}
});
