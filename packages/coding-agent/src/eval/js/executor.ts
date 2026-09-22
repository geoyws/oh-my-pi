import { DEFAULT_MAX_BYTES, type OutputArtifactError, OutputSink } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { logger } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../../tools";
import { resolveOutputMaxColumns, resolveOutputSinkHeadBytes } from "../../tools/output-meta";
import { isEvalTimeoutControlEvent } from "../bridge-timeout";
import { executeInVmContext, type JsDisplayOutput } from "./context-manager";
import type { JsStatusEvent } from "./shared/types";

export interface JsExecutorOptions {
	cwd?: string;
	timeoutMs?: number;
	deadlineMs?: number;
	/**
	 * Runtime-work budget (ms). Used for worker cold-start headroom and
	 * timeout-annotation text when the caller drives cancellation via the eval
	 * watchdog `signal` instead of `deadlineMs`/`timeoutMs`. Never arms a timer.
	 */
	idleTimeoutMs?: number;
	onChunk?: (chunk: string) => Promise<void> | void;
	onStatus?: (event: JsStatusEvent) => void;
	signal?: AbortSignal;
	sessionId: string;
	/** Logical owner identifier; scopes `reset` on shared contexts and retained-worker cleanup. */
	kernelOwnerId?: string;
	reset?: boolean;
	sessionFile?: string;
	artifactPath?: string;
	artifactId?: string;
	session: ToolSession;
	/** On-disk roots the helpers substitute for internal-URL schemes (e.g. `local://`). */
	localRoots?: Record<string, string>;
}

export interface JsResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	artifactId?: string;
	artifactError?: OutputArtifactError;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	displayOutputs: JsDisplayOutput[];
}

function getExecutionTimeoutMs(options: Pick<JsExecutorOptions, "deadlineMs" | "timeoutMs">): number | undefined {
	if (options.deadlineMs !== undefined) {
		return Math.max(1, options.deadlineMs - Date.now());
	}
	return options.timeoutMs;
}

function isAbortError(error: unknown): boolean {
	return (
		(error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) ||
		(error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
	);
}

function isTimeoutReason(reason: unknown): boolean {
	return (
		(reason instanceof DOMException && reason.name === "TimeoutError") ||
		(reason instanceof Error && reason.name === "TimeoutError")
	);
}

function formatJsTimeoutAnnotation(timeoutMs: number | undefined): string {
	// Timeout cancellation kills the worker (the only way to interrupt
	// synchronous user code) and discards the retained runtime, so the next cell
	// starts from an empty VM. State loss is what the model must be told, and it
	// is guaranteed by the session being dropped — unlike the kill itself, whose
	// confirmation is logged by `terminate()`.
	const reset = "The JS worker was terminated and its VM state was reset; variables from earlier cells are gone.";
	if (timeoutMs === undefined) return `Command timed out. ${reset}`;
	const secs = Math.max(1, Math.round(timeoutMs / 1000));
	return `Command timed out after ${secs} seconds. ${reset}`;
}

export async function executeJs(code: string, options: JsExecutorOptions): Promise<JsResult> {
	const displayOutputs: JsDisplayOutput[] = [];
	const outputSink = new OutputSink({
		artifactPath: options.artifactPath,
		artifactId: options.artifactId,
		spillThreshold: DEFAULT_MAX_BYTES,
		headBytes: resolveOutputSinkHeadBytes(options.session.settings),
		maxColumns: resolveOutputMaxColumns(options.session.settings),
		onChunk: chunk => options.onChunk?.(chunk),
	});
	const legacyTimeoutMs = getExecutionTimeoutMs(options);
	const timeoutSignal =
		typeof legacyTimeoutMs === "number" && Number.isFinite(legacyTimeoutMs) && legacyTimeoutMs > 0
			? AbortSignal.timeout(legacyTimeoutMs)
			: undefined;
	const signal =
		options.signal && timeoutSignal
			? AbortSignal.any([options.signal, timeoutSignal])
			: (options.signal ?? timeoutSignal);
	// The eval tool drives cancellation via its own watchdog `signal` and passes
	// only the runtime-work budget; use it solely as worker cold-start headroom
	// and never derive a competing fixed timer from it.
	const acquireBudgetMs = legacyTimeoutMs ?? options.idleTimeoutMs;

	try {
		await executeInVmContext({
			sessionKey: options.sessionId,
			sessionId: options.sessionId,
			ownerId: options.kernelOwnerId,
			cwd: options.cwd ?? options.session.cwd,
			session: options.session,
			localRoots: options.localRoots,
			reset: options.reset,
			code,
			filename: `js-cell-${crypto.randomUUID()}.js`,
			timeoutMs: acquireBudgetMs,
			runState: {
				signal,
				onText: chunk => outputSink.push(chunk),
				onDisplay: output => {
					// Runtime-origin output only. The IPC boundary already drops
					// forged timeout control; this second guard keeps a control
					// event out of rendered cell output if one ever arrives here.
					if (output.type === "status") {
						if (isEvalTimeoutControlEvent(output.event)) return;
						options.onStatus?.(output.event);
					}
					displayOutputs.push(output);
				},
				// Host-owned watchdog control: only this process's bridge wrapper
				// can pause or resume the cell deadline. Observer fanout is
				// best-effort so a throwing consumer cannot unwind the control
				// channel; the applied pause/resume state stands.
				onTimeoutControl: event => {
					try {
						options.onStatus?.(event);
					} catch (error) {
						logger.warn("eval timeout control observer failed; keeping the applied pause/resume state", {
							op: event.op,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				},
			},
		});
		const summary = await outputSink.dump();
		return {
			output: summary.output,
			exitCode: 0,
			cancelled: false,
			truncated: summary.truncated,
			artifactId: summary.artifactId,
			artifactError: summary.artifactError,
			totalLines: summary.totalLines,
			totalBytes: summary.totalBytes,
			outputLines: summary.outputLines,
			outputBytes: summary.outputBytes,
			displayOutputs,
		};
	} catch (error) {
		if (signal?.aborted || isAbortError(error)) {
			const timedOut = Boolean(timeoutSignal?.aborted) || isTimeoutReason(options.signal?.reason);
			if (timedOut) {
				outputSink.push(formatJsTimeoutAnnotation(legacyTimeoutMs ?? options.idleTimeoutMs));
			}
			const summary = await outputSink.dump();
			return {
				output: summary.output,
				exitCode: undefined,
				cancelled: true,
				truncated: summary.truncated,
				artifactId: summary.artifactId,
				artifactError: summary.artifactError,
				totalLines: summary.totalLines,
				totalBytes: summary.totalBytes,
				outputLines: summary.outputLines,
				outputBytes: summary.outputBytes,
				displayOutputs,
			};
		}
		const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
		outputSink.push(message);
		const summary = await outputSink.dump();
		return {
			output: summary.output,
			exitCode: 1,
			cancelled: false,
			truncated: summary.truncated,
			artifactId: summary.artifactId,
			artifactError: summary.artifactError,
			totalLines: summary.totalLines,
			totalBytes: summary.totalBytes,
			outputLines: summary.outputLines,
			outputBytes: summary.outputBytes,
			displayOutputs,
		};
	} finally {
		await outputSink.dispose();
	}
}
