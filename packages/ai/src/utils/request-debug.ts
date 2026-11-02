import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getRequestDebugDir } from "@oh-my-pi/pi-utils";
import { redactHeaders } from "./http-inspector";
import { decodeRequestBodyBytes } from "./request-body";

const REQUEST_DEBUG_ENV = "PI_REQ_DEBUG";
/** Absolute directory override for the dumps; it must already be private (no group/other access). */
const REQUEST_DEBUG_DIR_ENV = "PI_REQ_DEBUG_DIR";
const textEncoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/** JSON body fields that always carry credentials; redacted in every dump. */
const CREDENTIAL_FIELD_RE =
	/^(?:refresh_token|access_token|id_token|client_secret|client_assertion|code_verifier|device_code|subject_token|actor_token|password|private_key|api_?key)$/i;
/**
 * Fields that carry credentials in form bodies and OAuth/token exchanges, where generic names such as
 * `code`, `assertion` and `token` are credentials too (in a model request they are ordinary tool arguments).
 */
const EXCHANGE_CREDENTIAL_FIELD_RE =
	/^(?:refresh_token|access_token|id_token|client_secret|client_assertion|code_verifier|device_code|subject_token|actor_token|password|private_key|api_?key|assertion|code|token)$/i;
const REDACTED = "[redacted]";
/**
 * Paths of credential exchanges whose responses hold fresh credentials: OAuth/token endpoints and
 * Google IAM credential mints (`serviceAccounts/<sa>:generateAccessToken`, used by impersonated ADC).
 */
const TOKEN_ENDPOINT_PATH_RE =
	/(?:\/(?:oauth2?\/)?(?:v\d+\/)?token|:(?:generateAccessToken|generateIdToken|signJwt|signBlob))$/i;

let nextSessionId = 1;

type RequestBodyInit = NonNullable<RequestInit["body"]>;

type RequestDebugBody = { body: unknown } | { bodyText: string } | { bodyBase64: string } | { bodyUnavailable: string };

export type RequestDebugHeaders = Headers | Record<string, string | string[] | number | undefined | null> | undefined;

export interface RequestDebugPayload {
	method: string;
	url: string;
	headers?: RequestDebugHeaders;
	body?: unknown;
	bodyText?: string;
	bodyBase64?: string;
	bodyUnavailable?: string;
	protocol?: string;
}

interface ReservedRequestDebugFile {
	id: number;
	requestPath: string;
	responsePath: string;
	handle: fs.FileHandle;
	overwrite: boolean;
}

export interface RequestDebugResponseLog {
	write(chunk: Uint8Array | string): void;
	close(): Promise<void>;
}

export interface RequestDebugSession {
	readonly id: number;
	readonly requestPath: string;
	readonly responsePath: string;
	openResponseLog(statusLine: string, headers?: RequestDebugHeaders): Promise<RequestDebugResponseLog>;
	wrapResponse(response: Response): Promise<Response>;
}

function isRequestDebugEnvEnabled(): boolean {
	return Bun.env[REQUEST_DEBUG_ENV] === "1";
}

export function isRequestDebugEnabled(): boolean {
	return isRequestDebugEnvEnabled();
}

export async function createRequestDebugSession(payload: RequestDebugPayload): Promise<RequestDebugSession> {
	const { id, requestPath, responsePath, handle, overwrite } = await reserveRequestDebugFile();
	const requestDump: Record<string, unknown> = {
		id,
		protocol: payload.protocol ?? "http",
		method: payload.method,
		url: payload.url,
	};
	const headers = redactHeaders(headersToRecord(payload.headers));
	if (headers) requestDump.headers = headers;
	const exchange = isCredentialExchange(payload);
	const fields = exchange ? EXCHANGE_CREDENTIAL_FIELD_RE : CREDENTIAL_FIELD_RE;
	if (payload.body !== undefined) requestDump.body = redactCredentialFields(payload.body, fields);
	if (payload.bodyText !== undefined) requestDump.bodyText = redactFormCredentials(payload.bodyText);
	if (payload.bodyBase64 !== undefined) requestDump.bodyBase64 = payload.bodyBase64;
	if (payload.bodyUnavailable !== undefined) requestDump.bodyUnavailable = payload.bodyUnavailable;

	try {
		await handle.writeFile(`${JSON.stringify(requestDump, null, 2)}\n`, "utf8");
	} finally {
		await handle.close();
	}

	return new FileRequestDebugSession(id, requestPath, responsePath, overwrite, exchange);
}

/**
 * Dump a fetch-shaped request to `rr-session-N.json`; the returned session's
 * `wrapResponse` streams the raw response into `rr-session-N.res.log`. Called
 * per request by `transportFetch` while `PI_REQ_DEBUG=1`.
 */
export async function createFetchRequestDebugSession(
	input: string | URL | Request,
	init: RequestInit | undefined,
): Promise<RequestDebugSession> {
	const headers = resolveRequestHeaders(input, init);
	const body = await snapshotRequestBody(input, init, headers.get("content-type"), headers.get("content-encoding"));
	return createRequestDebugSession({
		method: resolveRequestMethod(input, init),
		url: resolveRequestUrl(input),
		headers,
		...body,
	});
}

class FileRequestDebugSession implements RequestDebugSession {
	readonly id: number;
	readonly requestPath: string;
	readonly responsePath: string;
	readonly #overwriteResponseLog: boolean;
	/** A token exchange's response body is fresh credentials: log its status and headers only. */
	readonly #omitResponseBody: boolean;

	constructor(
		id: number,
		requestPath: string,
		responsePath: string,
		overwriteResponseLog: boolean,
		omitResponseBody: boolean,
	) {
		this.id = id;
		this.requestPath = requestPath;
		this.responsePath = responsePath;
		this.#overwriteResponseLog = overwriteResponseLog;
		this.#omitResponseBody = omitResponseBody;
	}

	async openResponseLog(statusLine: string, headers?: RequestDebugHeaders): Promise<RequestDebugResponseLog> {
		const handle = await fs.open(this.responsePath, this.#overwriteResponseLog ? "w" : "wx", 0o600);
		const headerBlock = formatResponseHeaderBlock(statusLine, headers);
		await handle.write(textEncoder.encode(headerBlock));
		if (this.#omitResponseBody) {
			await handle.write(textEncoder.encode("[response body omitted: credential exchange]\n"));
			await handle.close();
			return { write() {}, close: async () => {} };
		}
		return new FileRequestDebugResponseLog(handle);
	}

	async wrapResponse(response: Response): Promise<Response> {
		const log = await this.openResponseLog(`HTTP ${response.status} ${response.statusText}`.trim(), response.headers);
		if (!response.body) {
			await log.close();
			return response;
		}

		const reader = response.body.getReader();
		const teed = new ReadableStream<Uint8Array>({
			async pull(controller) {
				try {
					const { done, value } = await reader.read();
					if (done) {
						await log.close();
						controller.close();
						return;
					}
					log.write(value);
					controller.enqueue(value);
				} catch (error) {
					await log.close().catch(() => undefined);
					controller.error(error);
				}
			},
			async cancel(reason) {
				try {
					await reader.cancel(reason);
				} finally {
					await log.close();
				}
			},
		});

		const wrapped = new Response(teed, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
		copyResponseMetadata(wrapped, response);
		return wrapped;
	}
}

class FileRequestDebugResponseLog implements RequestDebugResponseLog {
	#handle: fs.FileHandle | undefined;
	#pending: Promise<void> = Promise.resolve();
	#closed: Promise<void> | undefined;

	constructor(handle: fs.FileHandle) {
		this.#handle = handle;
	}

	write(chunk: Uint8Array | string): void {
		const handle = this.#handle;
		if (!handle) return;
		const bytes = typeof chunk === "string" ? textEncoder.encode(chunk) : chunk.slice();
		this.#pending = this.#pending.then(async () => {
			await handle.write(bytes);
		});
	}

	close(): Promise<void> {
		if (this.#closed) return this.#closed;
		const handle = this.#handle;
		if (!handle) return Promise.resolve();
		this.#handle = undefined;
		this.#closed = (async () => {
			try {
				await this.#pending;
			} finally {
				await handle.close();
			}
		})();
		return this.#closed;
	}
}

/** Preserve `Response.url` across a body-wrapping copy; lost by the `new Response(...)` constructor. */
export function copyResponseMetadata(target: Response, source: Response): void {
	const sourceUrl = source.url;
	if (!sourceUrl) return;
	try {
		Object.defineProperty(target, "url", { value: sourceUrl, configurable: true });
	} catch {
		// Some runtimes may expose Response.url as non-configurable. The body
		// capture remains correct; callers that need url already tolerate the
		// platform default on other response wrappers in this package.
	}
}

/**
 * The dump directory, created 0700. The default lives under omp's state root;
 * a `PI_REQ_DEBUG_DIR` override must already deny group and other access,
 * since dumps hold prompts, responses and request bodies.
 */
async function requestDebugDir(): Promise<string> {
	const override = Bun.env[REQUEST_DEBUG_DIR_ENV]?.trim();
	if (override) {
		if (!path.isAbsolute(override)) throw new Error(`${REQUEST_DEBUG_DIR_ENV} must be an absolute path`);
		await fs.mkdir(override, { recursive: true, mode: 0o700 });
		const stat = await fs.stat(override);
		if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
			throw new Error(`${REQUEST_DEBUG_DIR_ENV} ${override} is readable by other users; chmod 700 it`);
		}
		return override;
	}
	const dir = getRequestDebugDir();
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	if (process.platform !== "win32") await fs.chmod(dir, 0o700);
	return dir;
}

async function reserveRequestDebugFile(): Promise<ReservedRequestDebugFile> {
	const dir = await requestDebugDir();
	for (;;) {
		const id = nextSessionId++;
		const requestPath = path.join(dir, `rr-session-${process.pid}-${id}.json`);
		try {
			const handle = await fs.open(requestPath, "wx", 0o600);
			return {
				id,
				requestPath,
				responsePath: path.join(dir, `rr-session-${process.pid}-${id}.res.log`),
				handle,
				overwrite: false,
			};
		} catch (error) {
			if (isFileExistsError(error)) continue;
			throw error;
		}
	}
}

/** Replace the value of every field named by `fields`, at any depth, with a marker. */
function redactCredentialFields(value: unknown, fields: RegExp): unknown {
	if (Array.isArray(value)) return value.map(item => redactCredentialFields(item, fields));
	if (typeof value !== "object" || value === null) return value;
	const out: Record<string, unknown> = {};
	for (const [key, field] of Object.entries(value)) {
		out[key] = fields.test(key) ? REDACTED : redactCredentialFields(field, fields);
	}
	return out;
}

/**
 * Redact credential fields of an `application/x-www-form-urlencoded` body
 * (the shape OAuth token endpoints take). Text that is not a plain form body
 * is returned unchanged.
 */
function redactFormCredentials(text: string): string {
	if (!/^[^\s=&]+=[^\s]*$/.test(text)) return text;
	const params = new URLSearchParams(text);
	let redacted = false;
	for (const key of new Set(params.keys())) {
		if (!EXCHANGE_CREDENTIAL_FIELD_RE.test(key)) continue;
		params.set(key, REDACTED);
		redacted = true;
	}
	return redacted ? params.toString() : text;
}

/** True for an OAuth/token exchange: a `grant_type` in the body, or a request to a token endpoint. */
function isCredentialExchange(payload: RequestDebugPayload): boolean {
	try {
		if (TOKEN_ENDPOINT_PATH_RE.test(new URL(payload.url).pathname)) return true;
	} catch {}
	if (typeof payload.body === "object" && payload.body !== null && "grant_type" in payload.body) return true;
	return payload.bodyText !== undefined && /(?:^|&)grant_type=/.test(payload.bodyText);
}

function resolveRequestMethod(input: string | URL | Request, init: RequestInit | undefined): string {
	return (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
}

function resolveRequestUrl(input: string | URL | Request): string {
	return input instanceof Request ? input.url : input.toString();
}

function resolveRequestHeaders(input: string | URL | Request, init: RequestInit | undefined): Headers {
	if (init?.headers) return new Headers(init.headers);
	return input instanceof Request ? new Headers(input.headers) : new Headers();
}

async function snapshotRequestBody(
	input: string | URL | Request,
	init: RequestInit | undefined,
	contentType: string | null,
	contentEncoding: string | null,
): Promise<RequestDebugBody | undefined> {
	if (init?.body !== undefined && init.body !== null) return snapshotBodyInit(init.body, contentType, contentEncoding);
	if (input instanceof Request && input.body) {
		return snapshotBytes(new Uint8Array(await input.clone().arrayBuffer()), contentType, contentEncoding);
	}
	return undefined;
}

async function snapshotBodyInit(
	body: RequestBodyInit,
	contentType: string | null,
	contentEncoding: string | null,
): Promise<RequestDebugBody> {
	if (typeof body === "string") return snapshotText(body, contentType);
	if (body instanceof URLSearchParams) return { bodyText: body.toString() };
	if (body instanceof FormData) return { bodyUnavailable: "FormData" };
	if (body instanceof Blob) {
		return snapshotBytes(new Uint8Array(await body.arrayBuffer()), body.type || contentType, contentEncoding);
	}
	if (body instanceof ArrayBuffer) return snapshotBytes(new Uint8Array(body), contentType, contentEncoding);
	if (ArrayBuffer.isView(body)) {
		return snapshotBytes(new Uint8Array(body.buffer, body.byteOffset, body.byteLength), contentType, contentEncoding);
	}
	if (body instanceof ReadableStream) return { bodyUnavailable: "ReadableStream" };
	return { bodyText: String(body) };
}

function snapshotBytes(
	bytes: Uint8Array,
	contentType: string | null,
	contentEncoding: string | null,
): RequestDebugBody {
	try {
		// Dump what the server decodes, not the compressed wire bytes; the
		// recorded `content-encoding` header still shows how it was sent.
		return snapshotText(utf8Decoder.decode(decodeRequestBodyBytes(bytes, contentEncoding)), contentType);
	} catch {
		return { bodyBase64: Buffer.from(bytes).toString("base64") };
	}
}

function snapshotText(text: string, contentType: string | null): RequestDebugBody {
	if (isJsonContentType(contentType) || looksLikeJson(text)) {
		try {
			return { body: JSON.parse(text) };
		} catch {
			// Fall through to bodyText: malformed JSON is still useful as raw text.
		}
	}
	return { bodyText: text };
}

function isJsonContentType(contentType: string | null): boolean {
	if (!contentType) return false;
	const lower = contentType.toLowerCase();
	return lower.includes("application/json") || lower.includes("+json");
}

function looksLikeJson(text: string): boolean {
	const trimmed = text.trimStart();
	return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function formatResponseHeaderBlock(statusLine: string, headers?: RequestDebugHeaders): string {
	const lines = [statusLine];
	const record = redactHeaders(headersToRecord(headers));
	if (record) {
		for (const name in record) {
			const value = record[name];
			if (Array.isArray(value)) {
				for (const item of value) lines.push(`${name}: ${item}`);
			} else {
				lines.push(`${name}: ${value}`);
			}
		}
	}
	return `${lines.join("\r\n")}\r\n\r\n`;
}

function headersToRecord(headers: RequestDebugHeaders): Record<string, string | string[]> | undefined {
	if (!headers) return undefined;
	const record: Record<string, string | string[]> = {};
	let hasHeaders = false;
	if (headers instanceof Headers) {
		headers.forEach((value, key) => {
			hasHeaders = true;
			record[key] = value;
		});
	} else {
		for (const key in headers) {
			const value = headers[key];
			if (value === undefined || value === null) continue;
			hasHeaders = true;
			record[key] = Array.isArray(value) ? value.map(String) : String(value);
		}
	}
	return hasHeaders ? record : undefined;
}

function isFileExistsError(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EEXIST";
}
