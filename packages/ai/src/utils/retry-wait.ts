import { scheduler } from "node:timers/promises";
import type { ProviderRetryAttemptInfo, ProviderRetryWaitFn } from "../types";

/** Injected retry sleep: `StreamOptions.providerRetryWait` / `UsageFetchContext.retryWait`. */
export type RetryWaitHook = ProviderRetryWaitFn;

/**
 * Waits `delayMs` between retry attempts. Honors the caller's retry-wait hook
 * when one is set (tests and custom transports inject it to avoid real sleeps)
 * and otherwise sleeps on `signal`, so an abort rejects instead of the retry
 * proceeding. `info` carries the waiting loop's attempt counter when it has
 * one; loops without a counter omit it.
 */
export async function waitForRetry(
	retryWait: RetryWaitHook | undefined,
	delayMs: number,
	signal?: AbortSignal,
	info?: ProviderRetryAttemptInfo,
): Promise<void> {
	if (retryWait) await retryWait(delayMs, signal, info);
	else await scheduler.wait(delayMs, { signal });
}
