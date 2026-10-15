import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Settings } from "../../src/config/settings";
import {
	EVAL_TIMEOUT_PAUSE_OP,
	EVAL_TIMEOUT_RESUME_OP,
	isEvalTimeoutControlEvent,
	withBridgeTimeoutPause,
} from "../../src/eval/bridge-timeout";
import { executeWithKernelBase, type GenericKernel } from "../../src/eval/executor-base";
import type { JsStatusEvent } from "../../src/eval/js/shared/types";
import * as pyToolBridge from "../../src/eval/py/tool-bridge";
import type { ToolSession } from "../../src/tools";

/** Minimal `ToolSession` exposing `tools` to the eval tool bridge. */
function makeToolSession(...tools: AgentTool[]): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": false }),
		taskDepth: 0,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getActiveModelString: () => "p/active",
		getModelString: () => "p/fallback",
		getArtifactsDir: () => null,
		getSessionId: () => "bridge-timeout-session",
		getEvalSessionId: () => "bridge-timeout-eval-session",
		getToolByName: name => tools.find(tool => tool.name === name),
	};
}

/**
 * Capture the host-side timeout-control sink the executor hands the tool bridge.
 *
 * Pause/resume are host bridge lifecycle, not runtime output and not generic
 * tool status: they travel a dedicated channel precisely so neither a cell nor
 * a tool named `timeout-pause` can reach them. A test modelling a real bridge
 * phase must emit through that same host handle.
 */
function captureHostTimeoutControl(): { emit: (event: JsStatusEvent) => void } {
	const register = pyToolBridge.registerPyToolBridge;
	const handle = {
		emit: (_event: JsStatusEvent): void => {
			throw new Error("tool bridge was never registered");
		},
	};
	vi.spyOn(pyToolBridge, "registerPyToolBridge").mockImplementation((sessionId, runId, entry) => {
		handle.emit = event => entry.onTimeoutControl?.(event);
		return register(sessionId, runId, entry);
	});
	return handle;
}

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(async () => {
	await pyToolBridge.disposePyToolBridge();
});

describe("withBridgeTimeoutPause", () => {
	it("emits one pause before the operation and one resume after it settles", async () => {
		const events: JsStatusEvent[] = [];

		const value = await withBridgeTimeoutPause(
			event => events.push(event),
			async () => {
				await Bun.sleep(80);
				return "done";
			},
			{ deferExternalAbort: true },
		);

		expect(value).toBe("done");
		expect(events.map(event => event.op)).toEqual([EVAL_TIMEOUT_PAUSE_OP, EVAL_TIMEOUT_RESUME_OP]);
		expect(events.every(event => event.deferExternalAbort === true)).toBe(true);

		const settledCount = events.length;
		await Bun.sleep(40);
		expect(events.length).toBe(settledCount);
	});

	it("resumes timeout accounting even when the operation throws", async () => {
		const events: JsStatusEvent[] = [];

		await expect(
			withBridgeTimeoutPause(
				event => events.push(event),
				async () => {
					await Bun.sleep(20);
					throw new Error("boom");
				},
			),
		).rejects.toThrow("boom");

		expect(events.map(event => event.op)).toEqual([EVAL_TIMEOUT_PAUSE_OP, EVAL_TIMEOUT_RESUME_OP]);
	});

	it("runs the operation without emitting when no status sink is wired", async () => {
		let ran = 0;

		const value = await withBridgeTimeoutPause(undefined, async () => {
			ran++;
			await Bun.sleep(20);
			return 42;
		});

		expect(value).toBe(42);
		expect(ran).toBe(1);
	});

	it("propagates a throwing pause with the operation unrun and no resume", async () => {
		const events: JsStatusEvent[] = [];
		let operationRan = false;
		// Per the atomic-sink contract a throwing pause mutated nothing, so no
		// compensating resume may follow: an unmatched resume would decrement
		// an outer pause depth this call does not own.
		const throwingSink = (event: JsStatusEvent): void => {
			events.push(event);
			if (event.op === EVAL_TIMEOUT_PAUSE_OP) throw new Error("pause blew up");
		};

		await expect(
			withBridgeTimeoutPause(throwingSink, async () => {
				operationRan = true;
				return "done";
			}),
		).rejects.toThrow("pause blew up");

		expect(operationRan).toBe(false);
		expect(events.map(event => event.op)).toEqual([EVAL_TIMEOUT_PAUSE_OP]);
	});

	it("never emits a compensating resume that could steal an outer pause depth", async () => {
		let depth = 0;
		let failInnerPause = false;
		const events: JsStatusEvent[] = [];
		const sink = (event: JsStatusEvent): void => {
			events.push(event);
			if (event.op === EVAL_TIMEOUT_PAUSE_OP) {
				if (failInnerPause) throw new Error("inner pause blew up");
				depth++;
				return;
			}
			if (event.op === EVAL_TIMEOUT_RESUME_OP && depth > 0) depth--;
		};

		await withBridgeTimeoutPause(sink, async () => {
			expect(depth).toBe(1);
			failInnerPause = true;
			await expect(withBridgeTimeoutPause(sink, async () => "inner")).rejects.toThrow("inner pause blew up");
			// No compensating resume stole the outer level.
			expect(depth).toBe(1);
			expect(events.map(event => event.op)).toEqual([EVAL_TIMEOUT_PAUSE_OP, EVAL_TIMEOUT_PAUSE_OP]);
		});
		expect(depth).toBe(0);
		expect(events.map(event => event.op)).toEqual([
			EVAL_TIMEOUT_PAUSE_OP,
			EVAL_TIMEOUT_PAUSE_OP,
			EVAL_TIMEOUT_RESUME_OP,
		]);
	});

	it("keeps the operation error when the resume sink throws", async () => {
		const resumeSink = (event: JsStatusEvent): void => {
			if (event.op === EVAL_TIMEOUT_RESUME_OP) throw new Error("resume blew up");
		};

		await expect(
			withBridgeTimeoutPause(resumeSink, async () => {
				throw new Error("operation blew up");
			}),
		).rejects.toThrow("operation blew up");
	});

	it("identifies timeout-control events as non-renderable status", () => {
		expect(isEvalTimeoutControlEvent({ op: EVAL_TIMEOUT_PAUSE_OP })).toBe(true);
		expect(isEvalTimeoutControlEvent({ op: EVAL_TIMEOUT_RESUME_OP })).toBe(true);
		expect(isEvalTimeoutControlEvent({ op: "agent", id: "subagent-1" })).toBe(false);
	});
});

class TestCancelledError extends Error {
	readonly timedOut: boolean;

	constructor(timedOut: boolean) {
		super(timedOut ? "timed out" : "cancelled");
		this.name = "TestCancelledError";
		this.timedOut = timedOut;
	}
}

it("defers external aborts until an in-flight agent bridge call resumes", async () => {
	const abortController = new AbortController();
	const host = captureHostTimeoutControl();
	const entered = Promise.withResolvers<void>();
	const triggerAbort = Promise.withResolvers<void>();
	const observed = Promise.withResolvers<boolean>();
	const release = Promise.withResolvers<void>();
	const kernel: GenericKernel<Record<string, string | null>> = {
		async execute(_code, options) {
			entered.resolve();
			await triggerAbort.promise;
			host.emit({ op: EVAL_TIMEOUT_PAUSE_OP, deferExternalAbort: true });
			abortController.abort(new Error("external interrupt"));
			observed.resolve(options.signal?.aborted ?? false);
			await release.promise;
			host.emit({ op: EVAL_TIMEOUT_RESUME_OP, deferExternalAbort: true });
			return { status: "ok", cancelled: false, timedOut: false };
		},
	};

	const resultPromise = executeWithKernelBase({
		kernel,
		code: "agent('slow')",
		options: {
			signal: abortController.signal,
			toolSession: makeToolSession(),
			bridgeSessionId: `bridge-${crypto.randomUUID()}`,
		},
		runIdPrefix: "test",
		errorLogLabel: "test",
		cancelledErrorClass: TestCancelledError,
		buildKernelEnvPatch: () => ({}),
		formatKernelTimeoutAnnotation: () => "kernel timed out",
		formatTimeoutAnnotation: () => "timed out",
	});

	await entered.promise;
	triggerAbort.resolve();
	expect(await observed.promise).toBe(false);
	release.resolve();
	const result = await resultPromise;
	expect(result.cancelled).toBe(true);
	expect(result.exitCode).toBeUndefined();
});

it("contains observer failures on the dedicated channel without corrupting nested pause depth", async () => {
	// Regression: the production control sink fans out to generic status
	// observers after applying the pause. A throwing observer must neither
	// leak through the dedicated channel nor unbalance nesting: both bridge
	// waits below run through the real abort shield, and the deferred abort
	// is delivered only once the outermost pause resumes.
	const abortController = new AbortController();
	const host = captureHostTimeoutControl();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const shieldedDuringBridge: boolean[] = [];
	const kernel: GenericKernel<Record<string, string | null>> = {
		async execute(_code, options) {
			entered.resolve();
			await release.promise;
			await withBridgeTimeoutPause(
				host.emit,
				async () => {
					await withBridgeTimeoutPause(
						host.emit,
						async () => {
							abortController.abort(new Error("external interrupt"));
							shieldedDuringBridge.push(options.signal?.aborted === true);
						},
						{ deferExternalAbort: true },
					);
					// The inner resume released only its own level.
					shieldedDuringBridge.push(options.signal?.aborted === true);
				},
				{ deferExternalAbort: true },
			);
			// Fully resumed: the deferred abort is delivered now.
			shieldedDuringBridge.push(options.signal?.aborted === true);
			return { status: "ok", cancelled: false, timedOut: false };
		},
	};

	const resultPromise = executeWithKernelBase({
		kernel,
		code: "agent('slow')",
		options: {
			signal: abortController.signal,
			toolSession: makeToolSession(),
			bridgeSessionId: `bridge-${crypto.randomUUID()}`,
			onStatus: () => {
				throw new Error("status observer blew up");
			},
		},
		runIdPrefix: "test",
		errorLogLabel: "test",
		cancelledErrorClass: TestCancelledError,
		buildKernelEnvPatch: () => ({}),
		formatKernelTimeoutAnnotation: () => "kernel timed out",
		formatTimeoutAnnotation: () => "timed out",
	});

	await entered.promise;
	release.resolve();
	const result = await resultPromise;
	// The observer failure never surfaced: the cell ran to completion and the
	// abort is still reported as a cancellation.
	expect(result.cancelled).toBe(true);
	expect(shieldedDuringBridge).toEqual([false, false, true]);
});

it("does not defer external aborts for a completion bridge call", async () => {
	const abortController = new AbortController();
	const host = captureHostTimeoutControl();
	const entered = Promise.withResolvers<void>();
	const triggerAbort = Promise.withResolvers<void>();
	const observed = Promise.withResolvers<boolean>();
	const release = Promise.withResolvers<void>();
	const kernel: GenericKernel<Record<string, string | null>> = {
		async execute(_code, options) {
			entered.resolve();
			await triggerAbort.promise;
			host.emit({ op: EVAL_TIMEOUT_PAUSE_OP });
			abortController.abort(new Error("external interrupt"));
			observed.resolve(options.signal?.aborted ?? false);
			await release.promise;
			host.emit({ op: EVAL_TIMEOUT_RESUME_OP });
			return { status: "ok", cancelled: false, timedOut: false };
		},
	};

	const resultPromise = executeWithKernelBase({
		kernel,
		code: "completion('slow')",
		options: {
			signal: abortController.signal,
			toolSession: makeToolSession(),
			bridgeSessionId: `bridge-${crypto.randomUUID()}`,
		},
		runIdPrefix: "test",
		errorLogLabel: "test",
		cancelledErrorClass: TestCancelledError,
		buildKernelEnvPatch: () => ({}),
		formatKernelTimeoutAnnotation: () => "kernel timed out",
		formatTimeoutAnnotation: () => "timed out",
	});

	await entered.promise;
	triggerAbort.resolve();
	expect(await observed.promise).toBe(true);
	release.resolve();
	const result = await resultPromise;
	expect(result.cancelled).toBe(true);
	expect(result.exitCode).toBeUndefined();
});

it("hands the tool bridge the unshielded signal so a deferred phase still cancels subagents", async () => {
	// Regression: the bridge used to receive the kernel shield, so `agent()`
	// fan-outs from a Python/Ruby/Julia cell survived a turn cancel and kept
	// running until they finished on their own.
	const abortController = new AbortController();
	const entered = Promise.withResolvers<void>();
	const observedKernelAbort = Promise.withResolvers<boolean>();
	const release = Promise.withResolvers<void>();
	let bridgeSignal: AbortSignal | undefined;
	let hostEmit: (event: JsStatusEvent) => void = () => {
		throw new Error("tool bridge was never registered");
	};
	const registerSpy = vi
		.spyOn(pyToolBridge, "registerPyToolBridge")
		.mockImplementation((_sessionId, _runId, entry) => {
			bridgeSignal = entry.signal;
			hostEmit = event => entry.onTimeoutControl?.(event);
			return () => {};
		});

	const kernel: GenericKernel<Record<string, string | null>> = {
		async execute(_code, options) {
			entered.resolve();
			hostEmit({ op: EVAL_TIMEOUT_PAUSE_OP, deferExternalAbort: true });
			abortController.abort(new Error("external interrupt"));
			observedKernelAbort.resolve(options.signal?.aborted ?? false);
			await release.promise;
			hostEmit({ op: EVAL_TIMEOUT_RESUME_OP, deferExternalAbort: true });
			return { status: "ok", cancelled: false, timedOut: false };
		},
	};

	const resultPromise = executeWithKernelBase({
		kernel,
		code: "agent('slow')",
		options: {
			signal: abortController.signal,
			toolSession: makeToolSession(),
			bridgeSessionId: "bridge-session",
		},
		runIdPrefix: "test",
		errorLogLabel: "test",
		cancelledErrorClass: TestCancelledError,
		buildKernelEnvPatch: () => ({}),
		formatKernelTimeoutAnnotation: () => "kernel timed out",
		formatTimeoutAnnotation: () => "timed out",
	});

	await entered.promise;
	// The kernel stays shielded mid-phase so the runtime can't die during an
	// isolation merge...
	expect(await observedKernelAbort.promise).toBe(false);
	// ...but everything dispatched through the bridge cancels right away.
	expect(registerSpy).toHaveBeenCalledTimes(1);
	expect(bridgeSignal?.aborted).toBe(true);

	release.resolve();
	const result = await resultPromise;
	expect(result.cancelled).toBe(true);
});

it("holds the cell open through a deferred phase while still aborting the tool at once", async () => {
	// Regression: the tool call and the wait-for-result race must use different
	// aborts. Sharing the raw signal answered the HTTP call the moment the turn
	// was cancelled, letting the cell settle and the bridge unregister on top of
	// an abort-insensitive isolation merge still rewriting the repo.
	//
	// The discriminator is the reply itself, not its timing: losing the race
	// makes the bridge answer `ok: false, aborted`, while a correctly deferred
	// wait answers with the tool's real value once the phase releases.
	const bridge = await pyToolBridge.ensurePyToolBridge();
	const abortController = new AbortController();
	const host = captureHostTimeoutControl();
	const toolStarted = Promise.withResolvers<void>();
	const toolSawAbort = Promise.withResolvers<void>();
	const releaseTool = Promise.withResolvers<void>();

	// Stands in for `runStructuredSubagent`: observes its abort at once (the
	// subagent dies) but keeps working afterwards, exactly like a cherry-pick
	// that never looks at a signal.
	const parkedTool: AgentTool = {
		name: "merge",
		label: "Merge",
		description: "Parks until released, ignoring its abort",
		parameters: type({}),
		execute: async (_id, _args, signal) => {
			signal?.addEventListener("abort", () => toolSawAbort.resolve(), { once: true });
			toolStarted.resolve();
			await releaseTool.promise;
			return { content: [{ type: "text", text: "merged" }] };
		},
	};
	const toolSession = makeToolSession(parkedTool);

	const bridgeSessionId = `bridge-${crypto.randomUUID()}`;
	let reply: { ok: boolean; value?: unknown; error?: string } | undefined;
	const kernel: GenericKernel<Record<string, string | null>> = {
		async execute(_code, options) {
			host.emit({ op: EVAL_TIMEOUT_PAUSE_OP, deferExternalAbort: true });
			// Mirrors the Python prelude's blocking loopback call.
			const pending = fetch(`${bridge.url}/v1/tool`, {
				method: "POST",
				headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
				body: JSON.stringify({ session: bridgeSessionId, run: options.id, name: "merge", args: {} }),
			}).then(res => res.json() as Promise<{ ok: boolean; value?: unknown; error?: string }>);

			await toolStarted.promise;
			abortController.abort(new Error("external interrupt"));
			// The raw signal reached the tool: delegated work is already dying.
			await toolSawAbort.promise;

			releaseTool.resolve();
			reply = await pending;
			host.emit({ op: EVAL_TIMEOUT_RESUME_OP, deferExternalAbort: true });
			return { status: "ok", cancelled: false, timedOut: false };
		},
	};

	const result = await executeWithKernelBase({
		kernel,
		code: "agent('isolated')",
		options: { signal: abortController.signal, toolSession, bridgeSessionId },
		runIdPrefix: "test",
		errorLogLabel: "test",
		cancelledErrorClass: TestCancelledError,
		buildKernelEnvPatch: () => ({}),
		formatKernelTimeoutAnnotation: () => "kernel timed out",
		formatTimeoutAnnotation: () => "timed out",
	});

	// The host waited out the critical phase instead of bailing on the cancel.
	expect(reply).toEqual({ ok: true, value: "merged" });
	// ...and the turn is still reported as cancelled.
	expect(result.cancelled).toBe(true);
});
it("expires the wall-clock timeout through the shield so blocked bridge calls unwind instead of the kernel dying", async () => {
	// Regression: the cell timeout used to arm only a kernel-internal timer.
	// SIGINT then raised KeyboardInterrupt in the runner's main thread while
	// a runner worker thread stayed parked in a blocking urllib bridge call
	// nobody rejected; the runner wedged waiting for that thread,
	// never emitted `done`, and the 5s escalation killed the kernel with all
	// session state. The timeout must abort the same signals a turn cancel
	// does: the bridge's raced signal (rejecting in-flight calls) and the
	// kernel's execute signal (delivering SIGINT).
	const bridge = await pyToolBridge.ensurePyToolBridge();
	const toolSession = makeToolSession({
		name: "parked",
		label: "Parked",
		description: "Never settles on its own; the raced bridge abort must answer instead",
		parameters: type({}),
		execute: async () => {
			await new Promise<never>(() => {});
			throw new Error("unreachable");
		},
	});

	const bridgeSessionId = `bridge-${crypto.randomUUID()}`;
	let kernelAbortReason: unknown;
	const kernel: GenericKernel<Record<string, string | null>> = {
		async execute(_code, options) {
			// Mirrors the Python prelude: a worker thread blocked in a loopback
			// bridge call that only settles if the host rejects it.
			const pending = fetch(`${bridge.url}/v1/tool`, {
				method: "POST",
				headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
				body: JSON.stringify({ session: bridgeSessionId, run: options.id, name: "parked", args: {} }),
			}).then(res => res.json() as Promise<{ ok: boolean; error?: string }>);

			// Like the real runner, the cell only finishes once the timeout abort
			// arrives (SIGINT) AND the blocked bridge call has been answered.
			const aborted = Promise.withResolvers<void>();
			options.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
			await aborted.promise;
			kernelAbortReason = options.signal?.reason;
			const reply = await pending;
			expect(reply.ok).toBe(false);
			expect(reply.error).toContain("interrupted");
			return { status: "error", cancelled: true, timedOut: true };
		},
	};

	const result = await executeWithKernelBase({
		kernel,
		code: "import asyncio, threading\nt = threading.Thread(target=lambda: asyncio.run(tool.parked({})))\nt.start()\nt.join()",
		options: { timeoutMs: 100, toolSession, bridgeSessionId },
		runIdPrefix: "test",
		errorLogLabel: "test",
		cancelledErrorClass: TestCancelledError,
		buildKernelEnvPatch: () => ({}),
		formatKernelTimeoutAnnotation: () => "kernel timed out",
		formatTimeoutAnnotation: () => "timed out",
	});

	// The kernel saw a timeout abort, not a plain cancel...
	expect(kernelAbortReason).toBeInstanceOf(DOMException);
	expect((kernelAbortReason as DOMException).name).toBe("TimeoutError");
	// ...the cell settled as a timed-out cancellation with the kernel alive.
	expect(result.cancelled).toBe(true);
	expect(result.output).toContain("kernel timed out");
});
