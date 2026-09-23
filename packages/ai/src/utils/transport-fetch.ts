import { resolveExtraCa, withExtraCaInit } from "@oh-my-pi/pi-utils";
import { coworkFetch } from "../providers/cowork-fetch";
import { withInferenceUserAgent } from "../providers/inference-headers";
import type { Api, FetchImpl, Model } from "../types";
import { getProxyForProvider, withProxyInit } from "./proxy";
import { createFetchRequestDebugSession, isRequestDebugEnabled } from "./request-debug";
import type { ProviderRequestTelemetry } from "./request-telemetry";

/** Stamped on a fetch already built by {@link transportFetch}. */
const TRANSPORT_FETCH = Symbol("omp.transportFetch");

type TransportFetch = FetchImpl & { [TRANSPORT_FETCH]?: true };

/**
 * The one fetch every inference request goes through. Per call it applies, in
 * order: the inference User-Agent default, `NODE_EXTRA_CA_CERTS`, the
 * per-provider proxy, and `PI_REQ_DEBUG` request/response recording — then
 * calls `fetchImpl` (or the model's default fetch) exactly once. Providers
 * never layer transport concerns themselves.
 *
 * `telemetry`, when supplied by the pi-ai entry point that opened the logical
 * request, counts each call as one attempt and measures the response.
 *
 * Idempotent: the built fetch is stamped and returned as-is on later passes.
 * `streamSimple` re-enters `stream`, and `streamSimpleRequest` re-enters itself
 * on auth retries, so without the stamp each entry point would add another
 * layer (three PI_REQ_DEBUG dumps for one request).
 */
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

	const fetch: TransportFetch = async (input, init) => {
		init = withInferenceUserAgent(input, init);
		const extraCa = resolveExtraCa();
		if (extraCa) init = withExtraCaInit(init, extraCa);
		if (proxyUrl) init = withProxyInit(input, init, proxyUrl);
		telemetry?.noteAttempt();
		const session = isRequestDebugEnabled() ? await createFetchRequestDebugSession(input, init) : undefined;
		let response: Response;
		try {
			response = await base(input, init);
		} catch (error) {
			telemetry?.noteAttemptError(error);
			throw error;
		}
		if (session) response = await session.wrapResponse(response);
		return telemetry ? telemetry.observeResponse(response) : response;
	};
	if (base.preconnect) fetch.preconnect = base.preconnect;
	fetch[TRANSPORT_FETCH] = true;
	return fetch;
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

/** Whether `fetchImpl` is already a built {@link transportFetch}, i.e. an outer entry point owns this request. */
export function isTransportFetchBuilt(fetchImpl: FetchImpl | undefined): boolean {
	return (fetchImpl as TransportFetch | undefined)?.[TRANSPORT_FETCH] === true;
}
