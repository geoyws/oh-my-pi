import { resolveExtraCa, withExtraCaInit } from "@oh-my-pi/pi-utils";
import { coworkFetch } from "../providers/cowork-fetch";
import { withInferenceUserAgent } from "../providers/inference-headers";
import type { Api, FetchImpl, Model } from "../types";
import { getProxyForProvider, withProxyInit } from "./proxy";
import { createFetchRequestDebugSession, isRequestDebugEnabled } from "./request-debug";
import type { ProviderRequestTelemetry } from "./request-telemetry";

const TRANSPORT_FETCH = Symbol("omp.transportFetch");
const AUXILIARY_FETCH = Symbol("omp.auxiliaryFetch");
const REQUEST_TELEMETRY = Symbol("omp.requestTelemetry");
type TransportFetch = FetchImpl & {
	[TRANSPORT_FETCH]?: true;
	[AUXILIARY_FETCH]?: FetchImpl;
	[REQUEST_TELEMETRY]?: ProviderRequestTelemetry;
};

/** Transport policy stays identical for inference and auxiliary calls; only inference emits request telemetry. */
export function transportFetch(
	model: Model<Api>,
	fetchImpl: FetchImpl | undefined,
	telemetry?: ProviderRequestTelemetry,
): FetchImpl {
	const given = fetchImpl as TransportFetch | undefined;
	if (given?.[TRANSPORT_FETCH]) return given;
	const base =
		given ?? (model.provider === "anthropic" && model.api === "anthropic-messages" ? coworkFetch : globalThis.fetch);
	const proxyUrl = getProxyForProvider(model.provider);
	const buildFetch = (record?: ProviderRequestTelemetry): TransportFetch => {
		const wrapped: TransportFetch = async (input, init) => {
			if ((init?.method ?? (input instanceof Request ? input.method : "GET")) === "POST") {
				recordDispatchOrigin(model, input);
			}
			init = withInferenceUserAgent(input, init);
			const extraCa = resolveExtraCa();
			if (extraCa) init = withExtraCaInit(init, extraCa);
			if (proxyUrl) init = withProxyInit(input, init, proxyUrl);
			record?.noteCall();
			const session = isRequestDebugEnabled() ? await createFetchRequestDebugSession(input, init) : undefined;
			let response: Response;
			try {
				response = await base(input, init);
			} catch (error) {
				record?.noteCallError(error);
				throw error;
			}
			if (session) response = await session.wrapResponse(response);
			return record ? record.observeResponse(response) : response;
		};
		if (base.preconnect) wrapped.preconnect = base.preconnect;
		wrapped[TRANSPORT_FETCH] = true;
		if (record) wrapped[REQUEST_TELEMETRY] = record;
		return wrapped;
	};
	const inference = buildFetch(telemetry);
	if (telemetry) inference[AUXILIARY_FETCH] = buildFetch();
	return inference;
}

const dispatchOrigins = new Map<string, string>();
const DISPATCH_ORIGIN_CACHE_MAX = 1024;

function dispatchKey(model: Model<Api>): string {
	return `${model.provider}\u0000${model.baseUrl}`;
}

function recordDispatchOrigin(model: Model<Api>, input: string | URL | Request): void {
	let origin: string;
	try {
		origin = new URL(input instanceof Request ? input.url : input).origin;
	} catch {
		return;
	}
	const key = dispatchKey(model);
	if (dispatchOrigins.get(key) === origin) return;
	if (dispatchOrigins.size >= DISPATCH_ORIGIN_CACHE_MAX) dispatchOrigins.clear();
	dispatchOrigins.set(key, origin);
}

/**
 * Origin of the last inference request {@link model} actually sent, after
 * every dispatch-time rewrite (credential endpoints, env overrides, regional
 * hosts); `undefined` before its first request.
 */
export function lastDispatchOrigin(model: Model<Api>): string | undefined {
	return dispatchOrigins.get(dispatchKey(model));
}

/** Test hook: forgets every recorded dispatch origin. */
export function resetDispatchOriginsForTesting(): void {
	dispatchOrigins.clear();
}

/** Auth, routing and append calls retain proxy/CA/debug policy without becoming inference attempts. */
export function auxiliaryFetch(fetchImpl: FetchImpl = globalThis.fetch): FetchImpl {
	return (fetchImpl as TransportFetch)[AUXILIARY_FETCH] ?? fetchImpl;
}

/** Native inference transports share the logical record without invoking wrapped fetch. */
export function getProviderRequestTelemetry(fetchImpl: FetchImpl | undefined): ProviderRequestTelemetry | undefined {
	return (fetchImpl as TransportFetch | undefined)?.[REQUEST_TELEMETRY];
}

/** Options-bag form of {@link transportFetch}; returns `options` untouched when its fetch is already built. */
export function withTransportFetch<T extends { fetch?: FetchImpl }>(
	model: Model<Api>,
	options: T,
	telemetry?: ProviderRequestTelemetry,
): T {
	const fetch = transportFetch(model, options.fetch, telemetry);
	return fetch === options.fetch ? options : { ...options, fetch };
}

export function isTransportFetchBuilt(fetchImpl: FetchImpl | undefined): boolean {
	return (fetchImpl as TransportFetch | undefined)?.[TRANSPORT_FETCH] === true;
}
