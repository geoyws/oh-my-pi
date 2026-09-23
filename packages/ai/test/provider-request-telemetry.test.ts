import { afterEach, describe, expect, it } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { AssistantMessageEvent, Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { logger } from "@oh-my-pi/pi-utils";

// Every logical provider request must be reconstructable from the log file alone:
// how long it took, how many attempts it burned, how many bytes and tokens it
// moved, and how it ended. A `start` with no `end` is the hung-request signature.

type Fields = Record<string, unknown>;

const model: Model<"google-generative-ai"> = buildModel({
	id: "gemini-3-flash",
	name: "Gemini 3 Flash",
	api: "google-generative-ai",
	provider: "google",
	baseUrl: "",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

const SSE_BODY = `data: ${JSON.stringify({
	candidates: [{ content: { parts: [{ text: "hello" }] }, finishReason: "STOP" }],
	usageMetadata: {
		promptTokenCount: 10,
		candidatesTokenCount: 5,
		cachedContentTokenCount: 3,
		totalTokenCount: 15,
	},
})}\n\n`;

function sseResponse(): Response {
	return new Response(SSE_BODY, { status: 200, headers: { "content-type": "text/event-stream" } });
}

let dispose: (() => void) | undefined;

function captureTelemetry(): { lines: Array<{ message: string; fields: Fields }> } {
	const lines: Array<{ message: string; fields: Fields }> = [];
	dispose = logger.registerLogSink(event => {
		if (!event.message.startsWith("provider request")) return;
		lines.push({ message: event.message, fields: (event.context ?? {}) as Fields });
	});
	return { lines };
}

async function drain(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	try {
		for await (const event of stream) events.push(event);
	} catch {
		// Terminal failures are asserted through the telemetry lines, not here.
	}
	return events;
}

/** Telemetry closes on the result promise, which settles on the same tick as the last event. */
async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

afterEach(() => {
	dispose?.();
	dispose = undefined;
});

describe("provider request telemetry", () => {
	it("emits one start/end pair per request with duration, bytes, and token counts", async () => {
		const { lines } = captureTelemetry();
		const fetchImpl = (async () => sseResponse()) as unknown as FetchImpl;

		await drain(streamSimple(model, context, { apiKey: "k", fetch: fetchImpl }));
		await settle();

		expect(lines.map(l => l.message)).toEqual(["provider request start", "provider request end"]);
		const [start, end] = lines;
		expect(start.fields).toMatchObject({
			provider: "google",
			model: "gemini-3-flash",
			api: "google-generative-ai",
			transport: "http",
			attempt: 1,
		});
		expect(typeof start.fields.requestId).toBe("string");
		expect(typeof start.fields.sessionId).toBe("string");
		expect(end.fields.requestId).toBe(start.fields.requestId);
		expect(end.fields).toMatchObject({
			outcome: "ok",
			stopReason: "stop",
			attempts: 1,
			bytesIn: Buffer.byteLength(SSE_BODY),
			inputTokens: 7,
			outputTokens: 5,
			cacheReadTokens: 3,
			totalTokens: 15,
			status: 200,
		});
		expect(typeof end.fields.durationMs).toBe("number");
		expect(end.fields.durationMs as number).toBeGreaterThanOrEqual(0);
		expect(typeof end.fields.ttfbMs).toBe("number");
	});

	it("logs an attempt-boundary line per retried attempt under a single request id", async () => {
		const { lines } = captureTelemetry();
		let calls = 0;
		const fetchImpl = (async () => {
			calls += 1;
			if (calls === 1) {
				return new Response(JSON.stringify({ error: { message: "invalid key", code: 401 } }), {
					status: 401,
					headers: { "content-type": "application/json" },
				});
			}
			return sseResponse();
		}) as unknown as FetchImpl;

		await drain(
			streamSimple(model, context, {
				apiKey: ({ lastChance }) => (lastChance ? "k2" : "k1"),
				fetch: fetchImpl,
			}),
		);
		await settle();

		expect(calls).toBe(2);
		const attempts = lines.filter(l => l.message === "provider request attempt");
		expect(attempts.map(l => l.fields.attempt)).toEqual([2]);
		expect(attempts[0].fields.previousStatus).toBe(401);
		expect(typeof attempts[0].fields.sinceStartMs).toBe("number");
		const requestIds = new Set(lines.map(l => l.fields.requestId));
		expect(requestIds.size).toBe(1);
		const end = lines.at(-1)!;
		expect(end.message).toBe("provider request end");
		expect(end.fields).toMatchObject({ outcome: "ok", attempts: 2 });
	});

	it("does not attribute an earlier HTTP status to a later transport failure", async () => {
		const { lines } = captureTelemetry();
		let calls = 0;
		const fetchImpl = (async () => {
			calls += 1;
			if (calls === 1) {
				return new Response(JSON.stringify({ error: { message: "invalid key", code: 401 } }), {
					status: 401,
					headers: { "content-type": "application/json" },
				});
			}
			throw new TypeError("fetch failed after auth retry");
		}) as unknown as FetchImpl;

		await drain(
			streamSimple(model, context, {
				apiKey: ({ lastChance }) => (lastChance ? "k2" : "k1"),
				fetch: fetchImpl,
			}),
		);
		await settle();

		const end = lines.find(l => l.message === "provider request end")!;
		expect(end.fields).toMatchObject({ outcome: "error", attempts: 2 });
		expect(end.fields.status).toBeUndefined();
		expect(String(end.fields.error)).toContain("fetch failed after auth retry");
	});

	it("reports a transport failure as outcome error with its class and text", async () => {
		const { lines } = captureTelemetry();
		const fetchImpl = (async () => {
			throw new TypeError("fetch failed");
		}) as unknown as FetchImpl;

		await drain(streamSimple(model, context, { apiKey: "k", fetch: fetchImpl }));
		await settle();

		const end = lines.find(l => l.message === "provider request end")!;
		expect(end.fields.outcome).toBe("error");
		expect(String(end.fields.error)).toContain("fetch failed");
		expect(typeof end.fields.errorFlags).toBe("string");
	});

	it("separates a timeout from a generic error", async () => {
		const { lines } = captureTelemetry();
		const fetchImpl = (async () => {
			throw new Error("Request timed out after 60000ms");
		}) as unknown as FetchImpl;

		await drain(streamSimple(model, context, { apiKey: "k", fetch: fetchImpl }));
		await settle();

		expect(lines.find(l => l.message === "provider request end")!.fields.outcome).toBe("timeout");
	});

	it("reports an aborted request as outcome aborted", async () => {
		const { lines } = captureTelemetry();
		const controller = new AbortController();
		const fetchImpl = (async () => {
			controller.abort();
			throw new DOMException("The operation was aborted.", "AbortError");
		}) as unknown as FetchImpl;

		await drain(streamSimple(model, context, { apiKey: "k", fetch: fetchImpl, signal: controller.signal }));
		await settle();

		expect(lines.find(l => l.message === "provider request end")!.fields.outcome).toBe("aborted");
	});
});
