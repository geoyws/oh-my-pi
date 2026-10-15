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

/** Auth, routing and append calls retain proxy/CA/debug policy without becoming inference attempts. */
export function auxiliaryFetch(fetchImpl: FetchImpl = globalThis.fetch): FetchImpl {
	return (fetchImpl as TransportFetch)[AUXILIARY_FETCH] ?? fetchImpl;
}

/** Native inference transports share the logical record without invoking wrapped fetch. */
export function getProviderRequestTelemetry(fetchImpl: FetchImpl | undefined): ProviderRequestTelemetry | undefined {
	return (fetchImpl as TransportFetch | undefined)?.[REQUEST_TELEMETRY];
}

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
