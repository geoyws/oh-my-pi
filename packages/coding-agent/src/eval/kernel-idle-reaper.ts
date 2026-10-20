/**
 * Idle reaping for retained eval kernels (`eval.kernelIdleTimeoutSeconds`).
 *
 * A retained JS eval process or Python kernel is shut down once it has gone a
 * full window with no cell running. Callers own the busy check: the timer only
 * fires the callback, which must re-check that nothing started meanwhile and
 * re-arm instead of reaping while work is in flight. A running cell is never
 * cut.
 */
import type { Settings } from "../config/settings";
import { cfgEvalKernelIdleTimeoutSeconds } from "./settings";

/**
 * Idle window from `eval.kernelIdleTimeoutSeconds` in milliseconds, or
 * `undefined` when reaping is disabled (`0`, negative, or non-finite).
 * Callers without a settings instance get the registered default.
 */
export function resolveKernelIdleTimeoutMs(settings: Settings | undefined): number | undefined {
	const seconds = settings ? cfgEvalKernelIdleTimeoutSeconds.get(settings) : cfgEvalKernelIdleTimeoutSeconds.default;
	if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
	return Math.max(1, Math.round(seconds * 1000));
}

/**
 * Session keys whose retained kernel was idle-reaped. The first cell that
 * starts a fresh kernel on such a key takes the note, so the model learns its
 * state was reset exactly once.
 */
export class ReapedKernelNotices {
	readonly #byKey = new Map<string, { idleMs: number; ownerIds: Set<string> }>();
	readonly #languageLabel: string;

	constructor(languageLabel: string) {
		this.#languageLabel = languageLabel;
	}

	record(sessionKey: string, idleMs: number, ownerIds: Iterable<string>): void {
		this.#byKey.set(sessionKey, { idleMs, ownerIds: new Set(ownerIds) });
	}

	/** Removes and returns the model-visible restart note for `sessionKey`, if one is pending. */
	take(sessionKey: string): string | undefined {
		const entry = this.#byKey.get(sessionKey);
		if (!entry) return undefined;
		this.#byKey.delete(sessionKey);
		const seconds = Math.max(1, Math.round(entry.idleMs / 1000));
		return (
			`[kernel] The previous ${this.#languageLabel} kernel was shut down after ${seconds}s with no cell running ` +
			"(eval.kernelIdleTimeoutSeconds). This cell runs in a fresh kernel: variables, imports, and eval-defined tools from earlier cells are gone.\n"
		);
	}

	forget(sessionKey: string): void {
		this.#byKey.delete(sessionKey);
	}

	/** Drops `ownerId` from pending notes; a note with no owner left is discarded. */
	forgetOwner(ownerId: string): void {
		for (const [sessionKey, entry] of this.#byKey) {
			if (!entry.ownerIds.delete(ownerId)) continue;
			if (entry.ownerIds.size === 0) this.#byKey.delete(sessionKey);
		}
	}

	clear(): void {
		this.#byKey.clear();
	}
}

/** One retained kernel's idle timer. Never keeps the host event loop alive. */
export class KernelIdleTimer {
	readonly #onExpire: (idleMs: number) => void;
	#timer: NodeJS.Timeout | undefined;

	constructor(onExpire: (idleMs: number) => void) {
		this.#onExpire = onExpire;
	}

	/** (Re)start a full idle window; `undefined` disables reaping until the next arm. */
	arm(idleMs: number | undefined): void {
		this.disarm();
		if (idleMs === undefined) return;
		const timer = setTimeout(() => {
			this.#timer = undefined;
			this.#onExpire(idleMs);
		}, idleMs);
		timer.unref?.();
		this.#timer = timer;
	}

	disarm(): void {
		if (!this.#timer) return;
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}
}
