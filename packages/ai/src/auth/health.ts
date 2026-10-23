import type { Provider } from "../types";
import { isWithinUsageReserve, resolveUsedFraction } from "../usage";
import type {
	CredentialRankingContext,
	CredentialRankingStrategy,
	UsageCredential,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageReport,
} from "../usage";
import type { RankingStrategyResolver } from "../usage/registry";
import { raceSignal } from "./abort";
import type { SessionAffinity } from "./affinity";
import { credentialBlockScopesForRequest, providerTypeKey } from "./blocks";
import type { CredentialBlocks } from "./blocks";
import type { KeyCascade, KeyOverrides } from "./cascade";
import type { AccountPolicies } from "./policy";
import type { CredentialPool, StoredCredential } from "./pool";
import type { OAuthRefresher } from "./refresh";
import type { AuthCredentialStore } from "./store";
import type {
	CheckCredentialsOptions,
	CompletionProbeCredential,
	CredentialHealthResult,
	HealthApi,
	ModelUsageAccountHealth,
	ModelUsageHealth,
	ModelUsageHealthOptions,
} from "./types";
import { buildRefreshableOauthCredential, mergeRefreshedUsageCredential } from "./usage";
import type { UsageService } from "./usage";
import { REMOTE_REFRESH_SENTINEL } from "./types";
import { oauthUsageRequest, usageCacheIdentity, usageRequest } from "./usage-cache";
import type { UsageRequestDescriptor } from "./usage-cache";
import {
	isUsageLimitExhausted,
	reserveUsageLimits,
	scopedUsageLimits,
	usageReportMetadataValue,
	windowResetAt,
} from "./usage-report";

/** What one usage report proves about the quota windows limiting a model. */
type QuotaEvidence =
	| { kind: "unknown" }
	| {
			kind: "exhausted";
			/** Latest finite future reset among the exhausted windows; a lower bound unless `complete`. */
			resetsAt: number | undefined;
			/** Every limiting window is current and every exhausted one has a finite future reset. */
			complete: boolean;
	  }
	| {
			kind: "available";
			/** Headroom of the most consumed current reserve-scope window, when any reports a fraction. */
			remainingFraction: number | undefined;
			/** Every limiting window is current (none outlived its reset before the report was fetched). */
			complete: boolean;
	  };

/**
 * Evaluate every quota window limiting the requested model: the hard-block
 * scope ({@link CredentialRankingStrategy.scopeLimits}) together with the
 * reserve scope ({@link CredentialRankingStrategy.scopeLimitsForReserve}).
 *
 * An exhausted window in either scope blocks the account, and the account is
 * usable again only once every exhausted window has reset, so the wake time is
 * the latest exhausted reset, never the earliest. An exhausted window without a
 * finite future reset leaves the wake unknown. A window whose reset passed
 * before the report was fetched says nothing about its current state, so it
 * makes the evidence incomplete instead of counting as fresh headroom.
 * Headroom stays measured on the reserve scope alone.
 */
function evaluateQuotaWindows(
	strategy: CredentialRankingStrategy | undefined,
	report: UsageReport,
	rankingContext: CredentialRankingContext,
	nowMs: number,
): QuotaEvidence {
	const reserveLimits = new Set(reserveUsageLimits(strategy, report, rankingContext));
	const limiting = new Set<UsageLimit>(strategy ? scopedUsageLimits(strategy, report, rankingContext) : []);
	for (const limit of reserveLimits) limiting.add(limit);
	if (limiting.size === 0) return { kind: "unknown" };

	const current = [...limiting].filter(limit => {
		const resetsAt = windowResetAt(limit.window);
		return resetsAt === undefined || resetsAt > nowMs || report.fetchedAt >= resetsAt;
	});
	if (current.length === 0) return { kind: "unknown" };
	const allCurrent = current.length === limiting.size;

	const exhausted = current.filter(limit => isUsageLimitExhausted(limit));
	if (exhausted.length > 0) {
		let resetsAt: number | undefined;
		let everyResetKnown = true;
		for (const limit of exhausted) {
			const reset = windowResetAt(limit.window);
			if (reset === undefined || reset <= nowMs) {
				everyResetKnown = false;
				continue;
			}
			if (resetsAt === undefined || reset > resetsAt) resetsAt = reset;
		}
		return { kind: "exhausted", resetsAt, complete: everyResetKnown && allCurrent };
	}

	const usedFractions = current
		.filter(limit => reserveLimits.has(limit))
		.map(resolveUsedFraction)
		.filter((fraction): fraction is number => fraction !== undefined);
	return {
		kind: "available",
		remainingFraction: usedFractions.length === 0 ? undefined : Math.max(0, 1 - Math.max(...usedFractions)),
		complete: allCurrent,
	};
}

/** Dependencies for model pool health and stored credential probes. */
export interface CredentialHealthDeps {
	store: AuthCredentialStore;
	pool: CredentialPool;
	keys: KeyCascade;
	policies: AccountPolicies;
	blocks: CredentialBlocks;
	affinity: SessionAffinity;
	usage: UsageService;
	refresher: OAuthRefresher;
	overrides: KeyOverrides;
	strategies: RankingStrategyResolver;
}

/** Model-level pool health and per-credential auth probes. */
export class CredentialHealth implements HealthApi {
	#deps: CredentialHealthDeps;

	constructor(deps: CredentialHealthDeps) {
		this.#deps = deps;
	}

	/**
	 * Translate a refreshed {@link UsageCredential} into the public
	 * {@link CompletionProbeCredential} shape. Returns `null` when the
	 * credential lacks any usable bearer bytes (e.g. an API-key row with an
	 * empty key, or an OAuth row that never had an `access` token written).
	 */
	#buildCompletionProbeCredential(credential: UsageCredential): CompletionProbeCredential | null {
		if (credential.type === "api_key") {
			return credential.apiKey ? { type: "api_key", apiKey: credential.apiKey } : null;
		}
		if (!credential.accessToken) return null;
		return {
			type: "oauth",
			accessToken: credential.accessToken,
			refreshToken: credential.refreshToken,
			expiresAt: credential.expiresAt,
			accountId: credential.accountId,
			projectId: credential.projectId,
			email: credential.email,
			enterpriseUrl: credential.enterpriseUrl,
			apiEndpoint: credential.apiEndpoint,
			orgId: credential.orgId,
			region: credential.region,
			inferenceRegion: credential.inferenceRegion,
		};
	}

	/**
	 * Inspect the credential pool that {@link getApiKey} would use for one model
	 * without advancing round-robin state or changing session stickiness.
	 *
	 * Only credentials the session may use ({@link SessionAffinity.allows}) are
	 * evaluated, so a restricted session never sees another account's quota.
	 *
	 * Pool aggregation is deliberately conservative: one healthy sibling makes
	 * the model healthy, while any unknown sibling prevents a depleted/reserve
	 * conclusion. Static runtime/config/env credentials return unknown because
	 * they bypass the managed account pool.
	 */
	async model(provider: Provider, options: ModelUsageHealthOptions): Promise<ModelUsageHealth> {
		options.signal?.throwIfAborted();
		const origin = this.#deps.keys.source(provider);
		const strategy = this.#deps.strategies(provider);
		const usageProvider = this.#deps.usage.providerFor(provider);
		const canFetchOAuthUsage = usageProvider !== undefined || this.#deps.store.getUsageReport !== undefined;
		if (
			!origin ||
			(origin.kind !== "oauth" && origin.kind !== "api_key") ||
			(strategy === undefined && (origin.kind !== "oauth" || !canFetchOAuthUsage))
		) {
			return { state: "unknown", accounts: [] };
		}

		const stored = this.#deps.pool.entries(provider).map((entry, index) => ({
			entry,
			index,
		}));
		const oauthPool = stored.filter(({ entry }) => entry.credential.type === "oauth");
		const apiKeyPool = stored.filter(({ entry }) => entry.credential.type === "api_key");
		const loginApiKeyPool = apiKeyPool.filter(
			({ entry }) => entry.credential.type === "api_key" && entry.credential.source === "login",
		);
		const pool = (origin.kind === "oauth" ? oauthPool : loginApiKeyPool).filter(({ entry }) =>
			this.#deps.affinity.allows(provider, options.sessionId, entry.credential),
		);
		if (pool.length === 0) return { state: "unknown", accounts: [] };
		const sessionCredential = this.#deps.affinity.get(provider, options.sessionId);
		const selectedCredentialId =
			sessionCredential?.type === origin.kind
				? this.#deps.pool.entries(provider)[sessionCredential.index]?.id
				: undefined;

		const rankingContext: CredentialRankingContext = {
			modelId: options.modelId,
		};
		const planGate = strategy?.planGate?.(rankingContext);
		const planEligibilityByCredential = new Map<number, boolean | undefined>();
		const blockScope = strategy?.blockScope?.(rankingContext);
		const blockScopes = credentialBlockScopesForRequest(provider, strategy, rankingContext, blockScope);
		const reserveFraction = Number.isFinite(options.reserveFraction)
			? Math.max(0, Math.min(1, options.reserveFraction))
			: this.#deps.policies.defaultReservePct / 100;

		const resolveReserveFraction = (entry: StoredCredential): number => {
			const policy = this.#deps.policies.forCredential(provider, entry.credential);
			const configured = policy?.reservePct;
			return configured === undefined || !Number.isFinite(configured)
				? reserveFraction
				: Math.max(0, Math.min(1, configured / 100));
		};
		const nowMs = Date.now();
		let accounts = await Promise.all(
			pool.map(async ({ entry, index }): Promise<ModelUsageAccountHealth> => {
				const credentialType = entry.credential.type;
				const providerKey = providerTypeKey(provider, credentialType);
				const isTimed = (deadline: number): boolean =>
					this.#deps.blocks.isTimed(providerKey, blockScopes, entry.id, deadline);
				let blockedUntil = this.#deps.blocks.blockedUntil(provider, providerKey, index, blockScopes);
				// A block under a scope the strategy can vouch for must still fetch
				// a probe report, or it outlives the recovery that report would
				// prove: no report means no reconciliation, so the credential idles
				// until the clock runs out even after quota is restored. A
				// provider-timed block also fetches one, because only a timed block
				// plus complete quota evidence yields an authoritative wake time.
				if (
					blockedUntil !== undefined &&
					!this.#deps.blocks.canHeal(provider, providerKey, index, blockScopes) &&
					!isTimed(blockedUntil)
				) {
					return {
						credentialId: entry.id,
						credentialType,
						state: "depleted",
						resetsAt: blockedUntil,
					};
				}

				let report: UsageReport | null;
				try {
					report = await raceSignal(
						this.#deps.usage.report(provider, entry.credential, {
							baseUrl: options.baseUrl,
							timeoutMs: this.#deps.usage.requestTimeoutMs,
							signal: options.signal,
						}),
						options.signal,
						"usage fetch aborted",
					);
				} catch (error) {
					if (options.signal?.aborted) throw error;
					report = null;
				}
				if (planGate) {
					planEligibilityByCredential.set(entry.id, planGate(report));
				}

				if (this.#deps.blocks.supportsHealing(provider)) {
					blockedUntil = this.#deps.blocks.blockedUntil(provider, providerKey, index, blockScopes);
				}
				const evidence = report ? evaluateQuotaWindows(strategy, report, rankingContext, nowMs) : undefined;
				if (blockedUntil !== undefined) {
					// The block and every exhausted window must all have lifted.
					const quotaResetsAt = evidence?.kind === "exhausted" ? evidence.resetsAt : undefined;
					const authoritative =
						isTimed(blockedUntil) && evidence !== undefined && evidence.kind !== "unknown" && evidence.complete;
					return {
						credentialId: entry.id,
						credentialType,
						state: "depleted",
						resetsAt: quotaResetsAt === undefined ? blockedUntil : Math.max(blockedUntil, quotaResetsAt),
						...(authoritative ? { resetIsAuthoritative: true as const } : {}),
					};
				}
				if (!evidence || evidence.kind === "unknown") {
					return { credentialId: entry.id, credentialType, state: "unknown" };
				}
				if (evidence.kind === "exhausted") {
					return {
						credentialId: entry.id,
						credentialType,
						state: "depleted",
						resetsAt: evidence.resetsAt,
						...(evidence.complete ? { resetIsAuthoritative: true as const } : {}),
					};
				}

				const { remainingFraction } = evidence;
				if (remainingFraction === undefined) {
					return { credentialId: entry.id, credentialType, state: "unknown" };
				}
				// Current windows already inside the reserve bound the account at
				// reserve or worse; claiming healthy needs every window current.
				const state = isWithinUsageReserve(remainingFraction, resolveReserveFraction(entry))
					? "reserve"
					: evidence.complete
						? "healthy"
						: "unknown";
				return state === "unknown"
					? { credentialId: entry.id, credentialType, state }
					: { credentialId: entry.id, credentialType, state, remainingFraction };
			}),
		);
		if (planGate) {
			accounts = accounts.filter(account => planEligibilityByCredential.get(account.credentialId) !== false);
		}
		if (selectedCredentialId !== undefined) {
			const selectedAccount = accounts.find(account => account.credentialId === selectedCredentialId);
			if (selectedAccount) selectedAccount.selected = true;
		}

		if (accounts.some(account => account.state === "healthy")) return { state: "healthy", accounts };
		if (accounts.some(account => account.state === "unknown")) return { state: "unknown", accounts };
		if (accounts.some(account => account.state === "reserve")) return { state: "reserve", accounts };
		return { state: "depleted", accounts };
	}
	/**
	 * Probe each stored credential against its provider's auth-verifying usage
	 * endpoint and report per-credential auth health.
	 *
	 * Surfaces the identity of failing credentials so callers running a
	 * multi-account pool (e.g. a broker-backed auth-gateway) can tell which
	 * row is producing 401s. The probe mirrors the per-credential fan-out
	 * inside {@link UsageService.reports} (OAuth refresh-on-expiry,
	 * then `UsageProvider.fetchUsage`) but does NOT swallow errors — every
	 * credential gets either `ok: true`, `ok: false` with `reason`, or
	 * `ok: null` when no probe is configured for the provider.
	 *
	 * Iterates sequentially to avoid synchronized N-account fan-out that
	 * upstream `/usage` rate limiters (per source IP) treat as a burst.
	 *
	 * Only inspects active rows from {@link AuthCredentialStore.listAuthCredentials};
	 * soft-disabled rows are already known-bad and don't need a network probe.
	 * Environment-variable API keys are not enumerated — the caller's intent
	 * here is "which of my stored credentials is broken".
	 *
	 * Pass {@link CheckCredentialsOptions.completionProbe} to additionally
	 * exercise each credential against the provider's chat-completion endpoint
	 * (strict mode). The result lands on
	 * {@link CredentialHealthResult.completion}; the usage `ok` field is
	 * unchanged so callers can tell the two signals apart.
	 */
	async check(options?: CheckCredentialsOptions): Promise<CredentialHealthResult[]> {
		options?.signal?.throwIfAborted();
		const stored = this.#deps.store.listAuthCredentials();

		const timeoutMs = options?.timeoutMs ?? this.#deps.usage.requestTimeoutMs;
		const completionProbe = options?.completionProbe;
		const completionTimeoutMs = options?.completionTimeoutMs ?? timeoutMs;
		const ctx: UsageFetchContext = {
			fetch: this.#deps.usage.fetch,
			logger: this.#deps.usage.logger,
		};

		const results: CredentialHealthResult[] = [];
		for (const row of stored) {
			options?.signal?.throwIfAborted();
			if (options?.excludeProviders?.has(row.provider)) continue;
			const base: CredentialHealthResult = {
				id: row.id,
				provider: row.provider,
				type: row.credential.type,
				ok: null,
			};
			if (row.credential.type === "oauth") {
				if (row.credential.email) base.email = row.credential.email;
				if (row.credential.accountId) base.accountId = row.credential.accountId;
				if (row.credential.orgId) base.orgId = row.credential.orgId;
				if (row.credential.orgName) base.orgName = row.credential.orgName;
				if (row.credential.refresh === REMOTE_REFRESH_SENTINEL) base.remoteRefresh = true;
			}

			const baseUrl = options?.baseUrlResolver?.(row.provider as Provider);
			const cred = row.credential;
			let initialRequest: UsageRequestDescriptor;
			if (cred.type === "api_key") {
				// Stored keys may be references (env var name, "!command") — probe
				// with the resolved secret, not the reference string, so both the
				// usage probe and the completion probe exercise the real bytes.
				const apiKey = await this.#deps.overrides.resolve(cred.key);
				if (!apiKey) {
					base.reason = "api key reference could not be resolved";
					results.push(base);
					continue;
				}
				initialRequest = usageRequest(row.provider as Provider, { type: "api_key", apiKey }, baseUrl);
			} else {
				initialRequest = oauthUsageRequest(row.provider as Provider, cred, baseUrl);
			}

			const timeoutSignal = AbortSignal.timeout(timeoutMs);
			const probeSignal = options?.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
			let params: UsageFetchParams & { signal: AbortSignal } = {
				...initialRequest,
				accountKey: usageCacheIdentity(initialRequest.credential),
				signal: probeSignal,
			};
			let refreshError: string | undefined;

			// Refresh expired OAuth before probing — without this an expired access
			// token reports as `false` when the credential is actually healthy
			// (broker would happily refresh it on the next real request). The
			// refreshed bytes feed BOTH the usage probe and the optional
			// completion probe; we do it up-front so it runs even when no
			// `UsageProvider` is registered for this provider.
			if (
				cred.type === "oauth" &&
				initialRequest.credential.type === "oauth" &&
				initialRequest.credential.expiresAt !== undefined &&
				Date.now() >= initialRequest.credential.expiresAt
			) {
				const refreshable = buildRefreshableOauthCredential(initialRequest.credential);
				if (refreshable) {
					try {
						const refreshed = await this.#deps.refresher.refresh(
							row.provider as Provider,
							refreshable,
							row.id,
							probeSignal,
						);
						const refreshedCredential = mergeRefreshedUsageCredential(initialRequest.credential, refreshed);
						this.#deps.usage.persistRefreshedCredential(
							row.provider as Provider,
							initialRequest.credential,
							refreshedCredential,
							row.id,
						);
						params = {
							...params,
							credential: refreshedCredential,
							accountKey: usageCacheIdentity(refreshedCredential),
						};
					} catch (error) {
						refreshError = `oauth refresh failed: ${error instanceof Error ? error.message : String(error)}`;
					}
				}
			}

			if (refreshError) {
				base.ok = false;
				base.reason = refreshError;
				// Refresh failed → the access token is unusable. Skip both probes;
				// they would only re-surface the same upstream failure.
				results.push(base);
				continue;
			}

			const providerImpl = this.#deps.usage.providerFor(row.provider as Provider);
			if (!providerImpl) {
				base.reason = `no usage probe configured for provider ${row.provider}`;
			} else if (providerImpl.supports && !providerImpl.supports(initialRequest)) {
				base.reason = `usage probe does not support ${cred.type} credentials for ${row.provider}`;
			} else if (providerImpl.validatesCredentials === false) {
				base.reason = `usage probe for ${row.provider} does not validate credentials`;
			} else {
				try {
					const report = await providerImpl.fetchUsage(params, ctx);
					if (report === null) {
						base.reason = "usage probe returned no data for this credential";
					} else {
						base.ok = true;
						const accountId = usageReportMetadataValue(report, "accountId");
						const email = usageReportMetadataValue(report, "email");
						if (accountId) base.accountId = accountId;
						if (email) base.email = email;
						const { raw: _raw, ...trimmed } = report;
						base.report = trimmed;
					}
				} catch (error) {
					base.ok = false;
					base.reason = error instanceof Error ? error.message : String(error);
				}
			}

			if (completionProbe) {
				const probeCred = this.#buildCompletionProbeCredential(params.credential);
				if (!probeCred) {
					base.completion = {
						ok: null,
						reason: `no bearer bytes available for ${row.credential.type} credential`,
					};
				} else {
					const completionTimeoutSignal = AbortSignal.timeout(completionTimeoutMs);
					const completionSignal = options?.signal
						? AbortSignal.any([options.signal, completionTimeoutSignal])
						: completionTimeoutSignal;
					try {
						base.completion = await completionProbe({
							provider: row.provider as Provider,
							credentialId: row.id,
							credential: probeCred,
							signal: completionSignal,
						});
					} catch (error) {
						base.completion = {
							ok: false,
							reason: error instanceof Error ? error.message : String(error),
						};
					}
				}
			}

			results.push(base);
		}

		return results;
	}
}
