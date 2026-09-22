/**
 * Timeout suspension for in-flight host-side eval bridge calls.
 *
 * The eval watchdog caps a cell's `timeout` as a budget on the cell runtime's
 * own work. Host-side waits on `agent()` / `completion()` handles hand control
 * to the outer TypeScript process, where the Python kernel or JS VM is
 * only waiting for a result. While that delegated work is in flight, the cell
 * timeout must be ignored completely; once the bridge returns and the runtime is
 * back in control, the watchdog starts a fresh timeout window.
 *
 * Bridge helpers express that handoff with synthetic pause/resume status events
 * on the existing `emitStatus → onStatus` path. Consumers MUST treat these as
 * timeout-control events only: update the watchdog and drop them from rendered
 * or persisted cell output.
 *
 * ## Pause authority is host-owned
 *
 * These events are *control* messages for the parent's deadline, so only the
 * parent may mint them. {@link withBridgeTimeoutPause} emits a pause and its
 * matching resume from the same host-side `try`/`finally`, which is what makes
 * a pause lifecycle-coupled to a real in-flight bridge call instead of to a
 * message an evaluated cell can send.
 *
 * The status *data* channel (`__omp_emit_status__` in JS, an
 * `application/x-omp-status` display bundle in Python) is reachable by
 * evaluated code, so a runtime can forge a `timeout-pause` and disarm its own
 * deadline forever. Every runtime → host status boundary therefore drops these
 * ops with {@link rejectRuntimeTimeoutControl} and fails closed (deadline stays
 * armed).
 *
 * Host-side status is not trustworthy by origin either: a generic status sink
 * carries `{ op: <tool name> }` events, and a tool may simply be *named*
 * `timeout-pause`. Authority is therefore carried by the channel, not by the
 * string: {@link withBridgeTimeoutPause} writes to a dedicated
 * {@link EvalTimeoutControlSink} that nothing else can reach, and every generic
 * host status sink rejects a colliding op with
 * {@link rejectTimeoutControlCollision}. Legitimate — and arbitrarily long —
 * bridge waits are unaffected.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { JsStatusEvent } from "./js/shared/types";

/** Synthetic status op emitted when a bridge call leaves the cell runtime. */
export const EVAL_TIMEOUT_PAUSE_OP = "timeout-pause";

/** Synthetic status op emitted when a bridge call returns control to the runtime. */
export const EVAL_TIMEOUT_RESUME_OP = "timeout-resume";

/** Whether a status event is pure eval-timeout control and should not render. */
export function isEvalTimeoutControlEvent(event: JsStatusEvent): boolean {
	return event.op === EVAL_TIMEOUT_PAUSE_OP || event.op === EVAL_TIMEOUT_RESUME_OP;
}

/**
 * Dedicated host-only channel for {@link EVAL_TIMEOUT_PAUSE_OP} /
 * {@link EVAL_TIMEOUT_RESUME_OP}.
 *
 * Separate from the generic `emitStatus` sink on purpose: reaching this
 * function *is* the authority to move the cell watchdog, so no string on a
 * shared channel can impersonate it.
 */
export type EvalTimeoutControlSink = (event: JsStatusEvent) => void;

/**
 * Warn once per source+op per window. A cell can emit forged control events in
 * a loop, and an unthrottled warn per event turns a hostile (or merely
 * enthusiastic) cell into a host log flood.
 */
const REJECT_LOG_INTERVAL_MS = 60_000;
const rejectLogState = new Map<string, { lastLoggedAt: number; suppressed: number }>();

function logRejectedTimeoutControl(key: string, message: string, op: string): void {
	const now = Date.now();
	const state = rejectLogState.get(key);
	if (state && now - state.lastLoggedAt < REJECT_LOG_INTERVAL_MS) {
		state.suppressed++;
		logger.debug(message, { op, suppressed: state.suppressed });
		return;
	}
	logger.warn(message, { op, suppressed: state?.suppressed ?? 0 });
	rejectLogState.set(key, { lastLoggedAt: now, suppressed: 0 });
}

/**
 * Boundary guard for a status event arriving *from* a language runtime.
 *
 * Returns true when the event claims host-owned timeout authority and must be
 * discarded: evaluated code can reach the status data channel, and honouring a
 * forged `timeout-pause` would suspend the cell deadline indefinitely. Dropping
 * it fails closed — the watchdog keeps running — and a lost/echoed resume
 * cannot decrement a pause the host never took.
 */
export function rejectRuntimeTimeoutControl(event: JsStatusEvent, runtimeLabel: string): boolean {
	if (!isEvalTimeoutControlEvent(event)) return false;
	logRejectedTimeoutControl(
		`runtime:${runtimeLabel}:${event.op}`,
		`${runtimeLabel} runtime emitted a host-owned eval timeout control event; ignoring it`,
		event.op,
	);
	return true;
}

/**
 * Boundary guard for a *generic host* status sink (tool progress, tool errors,
 * bridge progress). Those events carry `{ op: <tool name> }`, so a tool named
 * `timeout-pause` would otherwise be read as a deadline suspension that never
 * resumes.
 *
 * Returns true when the op collides with host-owned timeout control and the
 * event must not be treated as authority. Real control never arrives here: it
 * travels on {@link EvalTimeoutControlSink}.
 */
export function rejectTimeoutControlCollision(event: JsStatusEvent, sourceLabel: string): boolean {
	if (!isEvalTimeoutControlEvent(event)) return false;
	logRejectedTimeoutControl(
		`host:${sourceLabel}:${event.op}`,
		`${sourceLabel} status event collides with a reserved eval timeout control op; not treating it as timeout control`,
		event.op,
	);
	return true;
}

/** Optional behavior for a timeout pause around a host bridge call. */
export interface BridgeTimeoutPauseOptions {
	/**
	 * Holds an external eval abort back from the *kernel* until this bridge call
	 * settles, so the runtime is never torn down mid-phase (`agent()` isolation
	 * worktree setup and merge/cherry-pick). It does not shield the delegated
	 * work itself: the bridge hands subagents the caller's real signal, so a
	 * turn cancel still stops them immediately.
	 */
	deferExternalAbort?: boolean;
}

/**
 * Run {@link operation} while suspending the eval watchdog through
 * {@link onTimeoutControl}. A no-op wrapper when no control sink is wired.
 *
 * The sink is the dedicated control channel, never the generic `emitStatus`
 * one: reaching it is the authority, so an ordinary tool status event that
 * happens to carry the same `op` string can never move the deadline.
 */
export async function withBridgeTimeoutPause<T>(
	onTimeoutControl: EvalTimeoutControlSink | undefined,
	operation: () => Promise<T>,
	options?: BridgeTimeoutPauseOptions,
): Promise<T> {
	if (!onTimeoutControl) return operation();
	onTimeoutControl(
		options?.deferExternalAbort
			? { op: EVAL_TIMEOUT_PAUSE_OP, deferExternalAbort: true }
			: { op: EVAL_TIMEOUT_PAUSE_OP },
	);
	try {
		return await operation();
	} finally {
		onTimeoutControl(
			options?.deferExternalAbort
				? { op: EVAL_TIMEOUT_RESUME_OP, deferExternalAbort: true }
				: { op: EVAL_TIMEOUT_RESUME_OP },
		);
	}
}
