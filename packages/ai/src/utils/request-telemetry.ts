/**
 * Per-request provider telemetry on the centralized logger.
 *
 * One logical provider request — everything pi-ai does between a caller's
 * `stream`/`streamSimple` entry and the assistant message that resolves it,
 * including auth-retry replays, provider-internal backoff retries and
 * thinking-loop re-samples — emits:
 *
 * - `provider request start` once, when the request is opened;
 * - `provider request attempt` once per outbound attempt after the first,
 *   carrying why the previous attempt failed;
 * - `provider request end` once, when the request settles.
 *
 * All three carry the same `requestId`, so a log file alone answers how long a
 * request took, how many attempts it burned, how many bytes and tokens it
 * moved, and how it ended. A `start` with no matching `end` is a hung request:
 * exactly the signature that needed a special build to diagnose before.
 */
import { logger } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import type { Api, AssistantMessage, Model } from "../types";
import { copyResponseMetadata } from "./request-debug";

/** Terminal disposition of one logical provider request. */
export type ProviderRequestOutcome = "ok" | "error" | "aborted" | "timeout";

/** Error text is a diagnostic prefix, never the whole provider body. */
const MAX_ERROR_TEXT = 200;

let sequence = 0;

/**
 * Correlation id for one logical request. Process-scoped counter rather than a
 * UUID: the logger stamps every line with the pid, the id is cheap to mint and
 * short enough to grep, and the pid prefix keeps it unique when several omp
 * processes are merged into one sink.
 */
function nextRequestId(): string {
	sequence = (sequence + 1) >>> 0;
	return `${process.pid.toString(36)}-${sequence.toString(36)}`;
}

function elapsedMs(since: number): number {
	return Math.round(performance.now() - since);
}

function errorText(error: unknown): string | undefined {
	const text = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
	if (!text) return undefined;
	return text.length > MAX_ERROR_TEXT ? `${text.slice(0, MAX_ERROR_TEXT)}…` : text;
}

function errorClass(error: unknown): string | undefined {
	if (error instanceof Error) return error.name || error.constructor.name;
	return error === undefined ? undefined : typeof error;
}

function outcomeFromFlags(flags: number): ProviderRequestOutcome {
	if (AIError.is(flags, AIError.Flag.Abort) || AIError.is(flags, AIError.Flag.UserInterrupt)) return "aborted";
	if (AIError.is(flags, AIError.Flag.Timeout)) return "timeout";
	return "error";
}

/** Record for one logical provider request; opened by the pi-ai entry point that owns it. */
export class ProviderRequestTelemetry {
	readonly requestId = nextRequestId();
	readonly #provider: string;
	readonly #model: string;
	readonly #api: Api;
	readonly #transport: string;
	readonly #startedAt = performance.now();
	#attempts = 0;
	#bytesIn = 0;
	#ttfbMs: number | undefined;
	#lastAttemptError: unknown;
	#status: number | undefined;
	#ended = false;

	constructor(model: Model<Api>, sessionId: string | undefined) {
		this.#provider = model.provider;
		this.#model = model.id;
		this.#api = model.api;
		this.#transport = model.transport ?? "http";
		logger.info("provider request start", {
			requestId: this.requestId,
			provider: this.#provider,
			model: this.#model,
			api: this.#api,
			transport: this.#transport,
			attempt: 1,
			sessionId,
		});
	}

	/** Opens an outbound attempt. Attempts after the first log an attempt-boundary line. */
	noteAttempt(): void {
		this.#attempts += 1;
		if (this.#attempts === 1) return;
		logger.info("provider request attempt", {
			requestId: this.requestId,
			provider: this.#provider,
			model: this.#model,
			api: this.#api,
			attempt: this.#attempts,
			sinceStartMs: elapsedMs(this.#startedAt),
			previousStatus: this.#status,
			previousErrorClass: errorClass(this.#lastAttemptError),
			previousError: errorText(this.#lastAttemptError),
		});
	}

	/** Records a transport-level failure so the next attempt boundary can name it. */
	noteAttemptError(error: unknown): void {
		this.#lastAttemptError = error;
	}

	/**
	 * Counts the response body and records when the first response headers of
	 * the request arrived. The body is wrapped in a pull-through reader — no
	 * buffering and no copy, one accumulator per chunk.
	 */
	observeResponse(response: Response): Response {
		this.#status = response.status;
		this.#ttfbMs ??= elapsedMs(this.#startedAt);
		const body = response.body;
		if (!body) return response;
		const reader = body.getReader();
		const counted = new ReadableStream<Uint8Array>({
			pull: async controller => {
				try {
					const { done, value } = await reader.read();
					if (done) {
						controller.close();
						return;
					}
					this.#bytesIn += value.byteLength;
					controller.enqueue(value);
				} catch (error) {
					controller.error(error);
				}
			},
			cancel: reason => reader.cancel(reason),
		});
		const wrapped = new Response(counted, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
		copyResponseMetadata(wrapped, response);
		return wrapped;
	}

	/**
	 * Close the record when `stream` settles. Non-consuming: the final result
	 * promise is already shared, and its usage/stop reason are the request's own.
	 */
	observe(stream: { result(): Promise<AssistantMessage> }): void {
		stream.result().then(
			message => this.completed(message),
			error => this.failed(error),
		);
	}

	/** Close the record from a resolved assistant message. */
	completed(message: AssistantMessage): void {
		const errorId = message.stopReason === "error" ? (message.errorId ?? AIError.classifyMessage(message)) : 0;
		const outcome: ProviderRequestOutcome =
			message.stopReason === "aborted" ? "aborted" : errorId === 0 ? "ok" : outcomeFromFlags(errorId);
		const usage = message.usage;
		this.#end({
			outcome,
			stopReason: message.stopReason,
			ttftMs: message.ttft === undefined ? undefined : Math.round(message.ttft),
			inputTokens: usage?.input,
			outputTokens: usage?.output,
			cacheReadTokens: usage?.cacheRead,
			cacheWriteTokens: usage?.cacheWrite,
			totalTokens: usage?.totalTokens,
			status: message.errorStatus ?? this.#status,
			errorFlags: errorId === 0 ? undefined : AIError.stringify(errorId),
			error: message.errorMessage === undefined ? undefined : errorText(message.errorMessage),
		});
	}

	/** Close the record from a thrown/rejected request. */
	failed(error: unknown): void {
		const flags = AIError.classify(error, this.#api);
		this.#end({
			outcome: outcomeFromFlags(flags),
			status: AIError.status(error) ?? this.#status,
			errorClass: errorClass(error),
			errorFlags: AIError.stringify(flags),
			error: errorText(error),
		});
	}

	#end(fields: {
		outcome: ProviderRequestOutcome;
		stopReason?: string;
		ttftMs?: number;
		inputTokens?: number;
		outputTokens?: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
		totalTokens?: number;
		status?: number;
		errorClass?: string;
		errorFlags?: string;
		error?: string;
	}): void {
		if (this.#ended) return;
		this.#ended = true;
		logger.info("provider request end", {
			requestId: this.requestId,
			provider: this.#provider,
			model: this.#model,
			api: this.#api,
			transport: this.#transport,
			attempts: this.#attempts,
			durationMs: elapsedMs(this.#startedAt),
			ttfbMs: this.#ttfbMs,
			bytesIn: this.#bytesIn,
			...fields,
		});
	}
}
