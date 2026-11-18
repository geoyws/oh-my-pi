import { beforeAll, describe, expect, it } from "bun:test";
import { Container } from "@oh-my-pi/pi-tui";
import {
	pickRecentFocusableAgentId,
	SessionFocusController,
} from "@oh-my-pi/pi-coding-agent/modes/controllers/session-focus-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID, type AgentRef } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

interface SessionStub {
	session: AgentSession;
	/** Emit an event through the listener captured by the last subscribe(). */
	emit: (event: unknown) => Promise<void>;
	unsubscribeCalls: () => number;
	setStreaming: (streaming: boolean) => void;
	/** Seed the steering/follow-up queue that getQueuedMessages() returns. */
	setQueue: (queue: { steering?: string[]; followUp?: string[] }) => void;
}

function makeSessionStub(opts: { isStreaming?: boolean } = {}): SessionStub {
	let listener: ((event: AgentSessionEvent) => Promise<void> | void) | undefined;
	let unsubscribeCalls = 0;
	let queue: { steering: string[]; followUp: string[] } = { steering: [], followUp: [] };
	const stub = {
		isStreaming: opts.isStreaming ?? false,
		agent: { state: { streamMessage: null } },
		subscribe(fn: (event: AgentSessionEvent) => Promise<void> | void) {
			listener = fn;
			return () => {
				if (listener === fn) listener = undefined;
				unsubscribeCalls++;
			};
		},
		async settleInFlightMessagePersistence() {},
		activeToolExecutionUpdates: () => [],
		getQueuedMessages: () => queue,
	};
	return {
		session: stub as unknown as AgentSession,
		emit: async event => {
			if (!listener) throw new Error("no listener captured: subscribe() was never called");
			await listener(event as AgentSessionEvent);
		},
		unsubscribeCalls: () => unsubscribeCalls,
		setStreaming: streaming => {
			stub.isStreaming = streaming;
		},
		setQueue: next => {
			queue = { steering: next.steering ?? [], followUp: next.followUp ?? [] };
		},
	};
}

interface Harness {
	ctx: InteractiveModeContext;
	controller: SessionFocusController;
	registry: AgentRegistry;
	main: SessionStub;
	handledEvents: unknown[];
	setSessionCalls: Array<[AgentSession, string | undefined]>;
	reloadTodoSessions: AgentSession[];
	pendingMessagesContainer: Container;
	counts: {
		clearTransientSessionUi: () => number;
		resetTranscriptAnchors: () => number;
		renderInitialMessages: () => number;
		mainUnsubscribe: () => number;
	};
}

function makeHarness(options: { renderInitialMessages?: () => void | Promise<void> } = {}): Harness {
	const main = makeSessionStub();
	const handledEvents: unknown[] = [];
	const setSessionCalls: Array<[AgentSession, string | undefined]> = [];
	const reloadTodoSessions: AgentSession[] = [];
	const pendingMessagesContainer = new Container();
	let clearTransientSessionUi = 0;
	let resetTranscriptAnchors = 0;
	let renderInitialMessages = 0;
	let mainUnsubscribe = 0;

	const ctx = {
		session: main.session,
		get viewSession() {
			return controller.target ?? main.session;
		},
		pendingMessagesContainer,
		compactionQueuedMessages: [],
		keybindings: { getKeys: () => ["alt+up"] },
		unsubscribe: () => {
			mainUnsubscribe++;
		},
		eventController: {
			handleEvent: async (event: unknown) => {
				handledEvents.push(event);
			},
			resetTranscriptAnchors: () => {
				resetTranscriptAnchors++;
			},
			restorePendingToolResults() {},
		},
		statusLine: {
			setSession: (session: AgentSession, focusedAgentId?: string) => {
				setSessionCalls.push([session, focusedAgentId]);
			},
			invalidate() {},
		},
		clearTransientSessionUi: () => {
			clearTransientSessionUi++;
			// Mirror interactive-mode.ts: focus teardown disposes the pending block.
			pendingMessagesContainer.disposeChildren();
		},
		renderInitialMessages: async () => {
			renderInitialMessages++;
			await options.renderInitialMessages?.();
		},
		reloadTodos: async (source?: AgentSession) => {
			reloadTodoSessions.push(source ?? main.session);
		},
		flushPendingModelSwitch: async () => {},
		updatePendingMessagesDisplay: () => uiHelpers.updatePendingMessagesDisplay(),
		updateEditorBorderColor() {},
		syncIdleMaintenanceView() {},
		ui: { requestRender() {}, requestComponentRender() {} },
		showStatus() {},
		collabGuest: undefined,
	} as unknown as InteractiveModeContext;

	const registry = new AgentRegistry();
	const lifecycle = new AgentLifecycleManager(registry);
	const controller = new SessionFocusController(ctx, registry, () => lifecycle);
	const uiHelpers = new UiHelpers(ctx);

	return {
		ctx,
		controller,
		registry,
		main,
		handledEvents,
		setSessionCalls,
		reloadTodoSessions,
		pendingMessagesContainer,
		counts: {
			clearTransientSessionUi: () => clearTransientSessionUi,
			resetTranscriptAnchors: () => resetTranscriptAnchors,
			renderInitialMessages: () => renderInitialMessages,
			mainUnsubscribe: () => mainUnsubscribe,
		},
	};
}

function registerSub(registry: AgentRegistry, id: string, session: AgentSession, parentId?: string) {
	return registry.register({ id, displayName: id, kind: "sub", parentId, session, status: "running" });
}

/** Settle the async unfocus chain (registry event → void unfocus() → #attach). */
async function flushAsync(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("SessionFocusController", () => {
	beforeAll(async () => {
		// updatePendingMessagesDisplay renders through the global theme singleton.
		await initTheme(false);
	});

	it("focusAgent retargets subscription, transcript anchors, and status line onto the worker session", async () => {
		const h = makeHarness();
		const worker = makeSessionStub();
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);

		await h.controller.focusAgent("Worker");

		expect(h.controller.focusedAgentId).toBe("Worker");
		expect(h.controller.target).toBe(worker.session);
		expect(h.counts.mainUnsubscribe()).toBe(1);
		expect(h.counts.clearTransientSessionUi()).toBe(1);
		expect(h.counts.resetTranscriptAnchors()).toBe(1);
		expect(h.counts.renderInitialMessages()).toBe(1);
		expect(h.reloadTodoSessions).toEqual([worker.session]);
		expect(h.setSessionCalls).toEqual([[worker.session, "Worker"]]);

		const event = { type: "message_start", message: { role: "user" } };
		await worker.emit(event);
		expect(h.handledEvents).toEqual([event]);
	});

	it("re-attaching the main session refreshes the todo HUD so it can't freeze at the pre-focus snapshot (#9571)", async () => {
		// While a subagent is focused the main session's `todo` completions never
		// reach the HUD (the event subscription points at the subagent). Returning
		// to the main session rebuilds the transcript from committed messages but
		// must also reload the HUD, or it stays stuck on the pre-focus snapshot
		// (e.g. a `todo init` 0/N) while the transcript shows current progress.
		const h = makeHarness();
		const worker = makeSessionStub();
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);

		await h.controller.focusAgent("Worker");
		expect(h.reloadTodoSessions).toEqual([worker.session]);

		await h.controller.unfocus();
		expect(h.controller.focusedAgentId).toBeUndefined();
		expect(h.setSessionCalls.at(-1)).toEqual([h.main.session, undefined]);
		expect(h.reloadTodoSessions).toEqual([worker.session, h.main.session]);
	});

	it("re-renders the pending steering block against the attached session's real queue on both focus directions (#11379)", async () => {
		// clearTransientSessionUi() disposes pendingMessagesContainer on every attach.
		// The queue survives, but nothing repainted it, so returning from a focused
		// agent left the steering block permanently blank. #attach() must rebuild the
		// real container from viewSession's queue in both directions: the subagent's
		// own queue on focus, main's queue on unfocus.
		const h = makeHarness();
		const worker = makeSessionStub();
		h.main.setQueue({ steering: ["main steer alpha"] });
		worker.setQueue({ steering: ["worker steer beta"] });
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);

		const rendered = () => h.pendingMessagesContainer.render(80).join("\n");

		await h.controller.focusAgent("Worker");
		expect(rendered()).toContain("worker steer beta");
		expect(rendered()).not.toContain("main steer alpha");

		await h.controller.unfocus();
		expect(rendered()).toContain("main steer alpha");
		expect(rendered()).not.toContain("worker steer beta");
	});

	it("does not let a superseded focus attachment restore the worker todo HUD after unfocusing", async () => {
		let releaseWorkerRender: (() => void) | undefined;
		let markWorkerRenderStarted: (() => void) | undefined;
		const workerRender = new Promise<void>(resolve => {
			releaseWorkerRender = resolve;
		});
		const workerRenderStarted = new Promise<void>(resolve => {
			markWorkerRenderStarted = resolve;
		});
		let renderCalls = 0;
		const h = makeHarness({
			renderInitialMessages: () => {
				renderCalls++;
				if (renderCalls !== 1) return;
				markWorkerRenderStarted?.();
				return workerRender;
			},
		});
		const worker = makeSessionStub();
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);

		const focus = h.controller.focusAgent("Worker");
		await workerRenderStarted;
		await h.controller.unfocus();
		expect(h.reloadTodoSessions).toEqual([h.main.session]);

		releaseWorkerRender?.();
		await focus;
		expect(h.controller.focusedAgentId).toBeUndefined();
		expect(h.setSessionCalls.at(-1)).toEqual([h.main.session, undefined]);
		expect(h.reloadTodoSessions).toEqual([h.main.session]);
	});

	it("mid-turn attach synthesizes agent_start, and an orphaned assistant message_update gets a synthesized message_start", async () => {
		const h = makeHarness();
		const worker = makeSessionStub({ isStreaming: true });
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);

		await h.controller.focusAgent("Worker");
		expect(h.handledEvents).toEqual([{ type: "agent_start" }]);

		const message = { role: "assistant", content: "partial" };
		await worker.emit({ type: "message_update", message });
		expect(h.handledEvents.slice(1)).toEqual([
			{ type: "message_start", message },
			{ type: "message_update", message },
		]);

		// Guard fires once: subsequent updates pass through unsynthesized.
		await worker.emit({ type: "message_update", message });
		expect(h.handledEvents.slice(3)).toEqual([{ type: "message_update", message }]);
	});

	it("does not restart the next assistant when an older message end finishes rendering", async () => {
		const h = makeHarness();
		const worker = makeSessionStub({ isStreaming: true });
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);
		await h.controller.focusAgent("Worker");
		const endGate = Promise.withResolvers<void>();
		const endStarted = Promise.withResolvers<void>();
		const handleEvent = h.ctx.eventController.handleEvent.bind(h.ctx.eventController);
		h.ctx.eventController.handleEvent = async event => {
			await handleEvent(event);
			if (event.type === "message_end") {
				endStarted.resolve();
				await endGate.promise;
			}
		};
		const previous = { role: "assistant", content: "previous" };
		const next = { role: "assistant", content: "next" };
		await worker.emit({ type: "message_start", message: previous });
		const ending = worker.emit({ type: "message_end", message: previous });
		await endStarted.promise;
		await worker.emit({ type: "message_start", message: next });
		endGate.resolve();
		await ending;
		h.handledEvents.length = 0;
		const update = { type: "message_update", message: next };
		await worker.emit(update);
		expect(h.handledEvents).toEqual([update]);
	});

	it("focusParent walks parentId to a registered non-main agent, then re-attaches the main session", async () => {
		const h = makeHarness();
		const parent = makeSessionStub();
		const worker = makeSessionStub();
		registerSub(h.registry, "Parent", parent.session, MAIN_AGENT_ID);
		registerSub(h.registry, "Worker", worker.session, "Parent");

		await h.controller.focusAgent("Worker");
		await h.controller.focusParent();
		expect(h.controller.focusedAgentId).toBe("Parent");
		expect(h.setSessionCalls).toEqual([
			[worker.session, "Worker"],
			[parent.session, "Parent"],
		]);

		// Parent's parent is Main → unfocus back to ctx.session.
		await h.controller.focusParent();
		expect(h.controller.focusedAgentId).toBeUndefined();
		expect(h.controller.target).toBeUndefined();
		expect(h.setSessionCalls).toEqual([
			[worker.session, "Worker"],
			[parent.session, "Parent"],
			[h.main.session, undefined],
		]);
	});

	it("parking the focused agent auto-unfocuses back to the main session", async () => {
		const h = makeHarness();
		const worker = makeSessionStub();
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);

		await h.controller.focusAgent("Worker");
		expect(h.controller.focusedAgentId).toBe("Worker");

		h.registry.setStatus("Worker", "parked");
		await flushAsync();

		expect(h.controller.focusedAgentId).toBeUndefined();
		expect(h.setSessionCalls).toEqual([
			[worker.session, "Worker"],
			[h.main.session, undefined],
		]);
	});

	it("drops a slower focus that resolves after a newer request", async () => {
		const h = makeHarness();
		const slow = makeSessionStub();
		const fast = makeSessionStub();
		const { promise: slowGate, resolve: releaseSlow } = Promise.withResolvers<AgentSession>();
		const lifecycle = {
			ensureLive: (id: string) => (id === "Slow" ? slowGate : Promise.resolve(fast.session)),
		};
		const controller = new SessionFocusController(
			h.ctx,
			h.registry,
			() => lifecycle as unknown as AgentLifecycleManager,
		);

		const slowFocus = controller.focusAgent("Slow");
		await controller.focusAgent("Fast");
		expect(controller.focusedAgentId).toBe("Fast");

		releaseSlow(slow.session);
		await slowFocus;
		expect(controller.focusedAgentId).toBe("Fast");
		expect(controller.target).toBe(fast.session);
	});

	it("drops a pending focus when returning to main first", async () => {
		const h = makeHarness();
		const slow = makeSessionStub();
		const { promise: slowGate, resolve: releaseSlow } = Promise.withResolvers<AgentSession>();
		const lifecycle = {
			ensureLive: (_id: string) => slowGate,
		};
		const controller = new SessionFocusController(
			h.ctx,
			h.registry,
			() => lifecycle as unknown as AgentLifecycleManager,
		);

		const slowFocus = controller.focusAgent("Slow");
		await controller.unfocus();
		releaseSlow(slow.session);
		await slowFocus;
		expect(controller.focusedAgentId).toBeUndefined();
		expect(controller.target).toBeUndefined();
	});

	it("drops the failure of a superseded focus request", async () => {
		const h = makeHarness();
		const fast = makeSessionStub();
		const { promise: slowGate, reject: failSlow } = Promise.withResolvers<AgentSession>();
		const lifecycle = {
			ensureLive: (id: string) => (id === "Slow" ? slowGate : Promise.resolve(fast.session)),
		};
		const controller = new SessionFocusController(
			h.ctx,
			h.registry,
			() => lifecycle as unknown as AgentLifecycleManager,
		);

		const slowFocus = controller.focusAgent("Slow");
		await controller.focusAgent("Fast");
		expect(controller.focusedAgentId).toBe("Fast");

		failSlow(new Error("revive failed"));
		await slowFocus;
		expect(controller.focusedAgentId).toBe("Fast");
		expect(controller.target).toBe(fast.session);
	});

	it("drops a pending focus when disposed first", async () => {
		const h = makeHarness();
		const slow = makeSessionStub();
		const { promise: slowGate, resolve: releaseSlow } = Promise.withResolvers<AgentSession>();
		const lifecycle = {
			ensureLive: (_id: string) => slowGate,
		};
		const controller = new SessionFocusController(
			h.ctx,
			h.registry,
			() => lifecycle as unknown as AgentLifecycleManager,
		);

		const slowFocus = controller.focusAgent("Slow");
		controller.dispose();
		releaseSlow(slow.session);
		await slowFocus;
		expect(controller.focusedAgentId).toBeUndefined();
		expect(controller.target).toBeUndefined();
	});

	it("drops a superseded attachment once the newer request attaches", async () => {
		const slowA = makeSessionStub();
		const slowB = makeSessionStub();
		const { promise: renderGate, resolve: releaseRender } = Promise.withResolvers<void>();
		let renderCalls = 0;
		const h = makeHarness({
			renderInitialMessages: () => {
				renderCalls++;
				return renderGate;
			},
		});
		const { promise: reviveB, resolve: releaseReviveB } = Promise.withResolvers<AgentSession>();
		const lifecycle = {
			ensureLive: (id: string) => (id === "A" ? Promise.resolve(slowA.session) : reviveB),
		};
		const controller = new SessionFocusController(
			h.ctx,
			h.registry,
			() => lifecycle as unknown as AgentLifecycleManager,
		);

		const focusA = controller.focusAgent("A");
		for (let i = 0; i < 50 && renderCalls === 0; i++) await Promise.resolve();
		expect(renderCalls).toBe(1);

		const focusB = controller.focusAgent("B");
		releaseReviveB(slowB.session);
		// B's attach starts first and dooms A's; releasing the shared render
		// gate lets A bail out while B runs to completion.
		for (let i = 0; i < 50 && renderCalls < 2; i++) await Promise.resolve();
		releaseRender();
		await focusA;
		await focusB;
		expect(controller.focusedAgentId).toBe("B");
		expect(h.reloadTodoSessions).toEqual([slowB.session]);
	});

	it("keeps the current attachment when a newer revive fails", async () => {
		const slowA = makeSessionStub();
		const { promise: renderGate, resolve: releaseRender } = Promise.withResolvers<void>();
		let renderCalls = 0;
		const h = makeHarness({
			renderInitialMessages: () => {
				renderCalls++;
				return renderGate;
			},
		});
		const { promise: reviveB, reject: failReviveB } = Promise.withResolvers<AgentSession>();
		const lifecycle = {
			ensureLive: (id: string) => (id === "A" ? Promise.resolve(slowA.session) : reviveB),
		};
		const controller = new SessionFocusController(
			h.ctx,
			h.registry,
			() => lifecycle as unknown as AgentLifecycleManager,
		);

		const focusA = controller.focusAgent("A");
		for (let i = 0; i < 50 && renderCalls === 0; i++) await Promise.resolve();
		expect(renderCalls).toBe(1);

		const focusB = controller.focusAgent("B");
		releaseRender();
		await focusA;
		expect(controller.focusedAgentId).toBe("A");
		expect(h.reloadTodoSessions).toEqual([slowA.session]);

		const failure = new Error("revive failed");
		failReviveB(failure);
		await expect(focusB).rejects.toBe(failure);
		expect(controller.focusedAgentId).toBe("A");
		expect(controller.target).toBe(slowA.session);
	});

	it("drops a running attachment on dispose", async () => {
		const slow = makeSessionStub();
		const { promise: renderGate, resolve: releaseRender } = Promise.withResolvers<void>();
		let renderCalls = 0;
		const h = makeHarness({
			renderInitialMessages: () => {
				renderCalls++;
				return renderGate;
			},
		});
		const lifecycle = {
			ensureLive: (_id: string) => Promise.resolve(slow.session),
		};
		const controller = new SessionFocusController(
			h.ctx,
			h.registry,
			() => lifecycle as unknown as AgentLifecycleManager,
		);

		const focusA = controller.focusAgent("A");
		for (let i = 0; i < 50 && renderCalls === 0; i++) await Promise.resolve();
		expect(renderCalls).toBe(1);

		controller.dispose();
		releaseRender();
		await focusA;
		expect(h.reloadTodoSessions).toEqual([]);
	});

	it("does not orphan an in-flight attach when the same session is focused again", async () => {
		const renderStarted = Promise.withResolvers<void>();
		const { promise: renderGate, resolve: releaseRender } = Promise.withResolvers<void>();
		const h = makeHarness({
			renderInitialMessages: () => {
				renderStarted.resolve();
				return renderGate;
			},
		});
		const worker = makeSessionStub();
		worker.setQueue({ steering: ["queued worker input"] });
		const lifecycle = {
			ensureLive: (_id: string) => Promise.resolve(worker.session),
		};
		const controller = new SessionFocusController(
			h.ctx,
			h.registry,
			() => lifecycle as unknown as AgentLifecycleManager,
		);
		Object.defineProperty(h.ctx, "viewSession", { get: () => controller.target ?? h.main.session });

		const first = controller.focusAgent("Worker");
		await renderStarted.promise;

		const second = controller.focusAgent("Worker");
		releaseRender();
		await first;
		await second;
		expect(controller.focusedAgentId).toBe("Worker");
		expect(controller.target).toBe(worker.session);
		expect(h.pendingMessagesContainer.render(80).join("\n")).toContain("queued worker input");
	});

	it("reports attachment failure to a repeated same-session focus request", async () => {
		const renderStarted = Promise.withResolvers<void>();
		const renderGate = Promise.withResolvers<void>();
		const failure = new Error("worker replay failed");
		let firstReplay = true;
		const h = makeHarness({
			renderInitialMessages: async () => {
				if (!firstReplay) return;
				firstReplay = false;
				renderStarted.resolve();
				await renderGate.promise;
				throw failure;
			},
		});
		const worker = makeSessionStub();
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);
		const first = h.controller.focusAgent("Worker");
		await renderStarted.promise;
		const second = h.controller.focusAgent("Worker").then(
			() => undefined,
			error => error,
		);
		await flushAsync();
		renderGate.resolve();
		await first;
		expect(await second).toBe(failure);
		expect(h.controller.focusedAgentId).toBeUndefined();
	});

	it("attaches once when a second same-session request arrives before revive completes", async () => {
		const h = makeHarness();
		const worker = makeSessionStub();
		const { promise: revive, resolve: releaseRevive } = Promise.withResolvers<AgentSession>();
		const lifecycle = {
			ensureLive: (_id: string) => revive,
		};
		const controller = new SessionFocusController(
			h.ctx,
			h.registry,
			() => lifecycle as unknown as AgentLifecycleManager,
		);

		const first = controller.focusAgent("Worker");
		const second = controller.focusAgent("Worker");
		expect(controller.focusedAgentId).toBeUndefined();

		releaseRevive(worker.session);
		await first;
		await second;
		expect(controller.focusedAgentId).toBe("Worker");
		expect(controller.target).toBe(worker.session);
	});

	it("drops a pending revive when the current view is reaffirmed", async () => {
		const h = makeHarness();
		const focused = makeSessionStub();
		const slow = makeSessionStub();
		const { promise: slowGate, resolve: releaseSlow } = Promise.withResolvers<AgentSession>();
		const lifecycle = {
			ensureLive: (id: string) => (id === "Slow" ? slowGate : Promise.resolve(focused.session)),
		};
		const controller = new SessionFocusController(
			h.ctx,
			h.registry,
			() => lifecycle as unknown as AgentLifecycleManager,
		);

		await controller.focusAgent("Focused");
		expect(controller.focusedAgentId).toBe("Focused");

		const slowFocus = controller.focusAgent("Slow");
		controller.invalidatePendingFocus();
		releaseSlow(slow.session);
		await slowFocus;
		expect(controller.focusedAgentId).toBe("Focused");
		expect(controller.target).toBe(focused.session);
	});

	it("drops a pending revive when the already-attached session is focused again", async () => {
		const h = makeHarness();
		const focused = makeSessionStub();
		const slow = makeSessionStub();
		const { promise: slowGate, resolve: releaseSlow } = Promise.withResolvers<AgentSession>();
		const lifecycle = {
			ensureLive: (id: string) => (id === "Slow" ? slowGate : Promise.resolve(focused.session)),
		};
		const controller = new SessionFocusController(
			h.ctx,
			h.registry,
			() => lifecycle as unknown as AgentLifecycleManager,
		);

		await controller.focusAgent("Focused");

		const slowFocus = controller.focusAgent("Slow");
		await controller.focusAgent("Focused");
		releaseSlow(slow.session);
		await slowFocus;
		expect(controller.focusedAgentId).toBe("Focused");
		expect(controller.target).toBe(focused.session);
	});

	it("retries the same worker after an attachment failure", async () => {
		let failReplay = true;
		const h = makeHarness({
			renderInitialMessages: () => {
				if (failReplay) {
					failReplay = false;
					throw new Error("replay failed");
				}
			},
		});
		h.main.setQueue({ steering: ["main input after recovery"] });
		const worker = makeSessionStub();
		worker.setQueue({ steering: ["worker input after retry"] });
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);
		await expect(h.controller.focusAgent("Worker")).rejects.toThrow("replay failed");
		expect(h.controller.focusedAgentId).toBeUndefined();
		expect(h.pendingMessagesContainer.render(80).join("\n")).toContain("main input after recovery");
		const mainEvent = {
			type: "message_start",
			message: { role: "user", content: "MAIN_AFTER_FAILURE", timestamp: 1 },
		};
		await h.main.emit(mainEvent);
		expect(h.handledEvents).toContainEqual(mainEvent);
		await h.controller.focusAgent("Worker");
		expect(h.pendingMessagesContainer.render(80).join("\n")).toContain("worker input after retry");
		expect(h.controller.target).toBe(worker.session);
	});

	it("does not clear a newer focused view when an older attachment fails", async () => {
		const replayStarted = Promise.withResolvers<void>();
		const oldReplay = Promise.withResolvers<void>();
		let firstReplay = true;
		const h = makeHarness({
			renderInitialMessages: () => {
				if (!firstReplay) return;
				firstReplay = false;
				replayStarted.resolve();
				return oldReplay.promise;
			},
		});
		const first = makeSessionStub();
		const second = makeSessionStub();
		second.setQueue({ steering: ["newer worker input"] });
		registerSub(h.registry, "First", first.session, MAIN_AGENT_ID);
		registerSub(h.registry, "Second", second.session, MAIN_AGENT_ID);
		const oldFocus = h.controller.focusAgent("First");
		await replayStarted.promise;
		await h.controller.focusAgent("Second");
		oldReplay.reject(new Error("old replay failed"));
		await oldFocus;
		expect(h.controller.target).toBe(second.session);
		expect(h.pendingMessagesContainer.render(80).join("\n")).toContain("newer worker input");
	});

	it("retains main event delivery if its recovery replay also fails", async () => {
		const workerFailure = new Error("worker replay failed");
		const mainFailure = new Error("main replay failed");
		let firstReplay = true;
		const h = makeHarness({
			renderInitialMessages: () => {
				if (firstReplay) {
					firstReplay = false;
					throw workerFailure;
				}
				throw mainFailure;
			},
		});
		const worker = makeSessionStub();
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);
		const failure = await h.controller.focusAgent("Worker").catch((error: unknown) => error);
		if (!(failure instanceof AggregateError)) throw new Error("Expected both attachment errors");
		expect(failure.errors).toEqual([workerFailure, mainFailure]);
		const mainEvent = {
			type: "message_start",
			message: { role: "user", content: "MAIN_AFTER_DOUBLE_FAILURE", timestamp: 1 },
		};
		await h.main.emit(mainEvent);
		expect(h.handledEvents).toContainEqual(mainEvent);
		expect(h.controller.focusedAgentId).toBeUndefined();
	});

	it("does not overwrite a newer focus while recovering the main attachment", async () => {
		const recoveryStarted = Promise.withResolvers<void>();
		const recoveryReplay = Promise.withResolvers<void>();
		let replay = 0;
		const h = makeHarness({
			renderInitialMessages: () => {
				replay++;
				if (replay === 1) throw new Error("worker replay failed");
				if (replay === 2) {
					recoveryStarted.resolve();
					return recoveryReplay.promise;
				}
			},
		});
		const first = makeSessionStub();
		const newer = makeSessionStub();
		newer.setQueue({ steering: ["newer view stays active"] });
		registerSub(h.registry, "First", first.session, MAIN_AGENT_ID);
		registerSub(h.registry, "Newer", newer.session, MAIN_AGENT_ID);
		const firstFocus = h.controller.focusAgent("First");
		await Promise.race([recoveryStarted.promise, firstFocus]);
		await h.controller.focusAgent("Newer");
		recoveryReplay.resolve();
		await firstFocus;
		expect(h.controller.target).toBe(newer.session);
		expect(h.pendingMessagesContainer.render(80).join("\n")).toContain("newer view stays active");
	});
});

	it("rejects focusing in a collab session", async () => {
		const h = makeHarness();
		const worker = makeSessionStub();
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);
		(h.ctx as { collabGuest?: unknown }).collabGuest = { id: "guest" };
		await expect(h.controller.focusAgent("Worker")).rejects.toThrow("Viewing agents is unavailable in a collab session.");
		expect(h.controller.focusedAgentId).toBeUndefined();
	});

	it("focusParent is a no-op when unfocused and falls back to main for main or missing parents", async () => {
		const h = makeHarness();
		await h.controller.focusParent();
		expect(h.controller.focusedAgentId).toBeUndefined();

		const worker = makeSessionStub();
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);
		await h.controller.focusAgent("Worker");
		await h.controller.focusParent();
		expect(h.controller.focusedAgentId).toBeUndefined();

		const orphan = makeSessionStub();
		registerSub(h.registry, "Orphan", orphan.session, "MissingParent");
		await h.controller.focusAgent("Orphan");
		await h.controller.focusParent();
		expect(h.controller.focusedAgentId).toBeUndefined();
	});

	it("ignores registry events for other agents and for a focused agent staying alive", async () => {
		const h = makeHarness();
		const worker = makeSessionStub();
		const other = makeSessionStub();
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);
		registerSub(h.registry, "Other", other.session, MAIN_AGENT_ID);
		await h.controller.focusAgent("Worker");
		h.registry.setStatus("Other", "aborted");
		await flushAsync();
		expect(h.controller.focusedAgentId).toBe("Worker");
		h.registry.setStatus("Worker", "idle");
		await flushAsync();
		expect(h.controller.focusedAgentId).toBe("Worker");
	});

	it("restores a live assistant stream and tool updates when focusing mid-turn", async () => {
		const h = makeHarness();
		const worker = makeSessionStub();
		const live = { role: "assistant", content: [{ type: "text", text: "live" }] };
		(worker.session.agent.state as { streamMessage: unknown }).streamMessage = live;
		const toolUpdate = { type: "tool_execution_update", toolCallId: "t1" };
		(worker.session as unknown as { activeToolExecutionUpdates: () => unknown[] }).activeToolExecutionUpdates = () => [toolUpdate];
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);
		await h.controller.focusAgent("Worker");
		const types = h.handledEvents.map(e => (e as { type: string }).type);
		expect(types).toContain("message_start");
		expect(types).toContain("message_update");
		expect(h.handledEvents).toContain(toolUpdate);
	});

	it("synthesizes a start before an orphaned assistant message_end", async () => {
		const h = makeHarness();
		const worker = makeSessionStub();
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);
		await h.controller.focusAgent("Worker");
		h.handledEvents.length = 0;
		const message = { role: "assistant", content: [{ type: "text", text: "done" }] };
		await worker.emit({ type: "message_end", message });
		const types = h.handledEvents.map(e => (e as { type: string }).type);
		expect(types).toEqual(["message_start", "message_update", "message_end"]);
	});

	it("flushes the main session's pending model switch when returning unfocused", async () => {
		const h = makeHarness();
		const worker = makeSessionStub();
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);
		let flushes = 0;
		(h.ctx as unknown as { flushPendingModelSwitch: () => Promise<void> }).flushPendingModelSwitch = async () => {
			flushes++;
		};
		await h.controller.focusAgent("Worker");
		flushes = 0;
		await h.controller.unfocus();
		expect(flushes).toBe(1);
	});

	it("focusing the main agent returns to the main session", async () => {
		const h = makeHarness();
		const worker = makeSessionStub();
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);
		await h.controller.focusAgent("Worker");
		await h.controller.focusAgent(MAIN_AGENT_ID);
		expect(h.controller.focusedAgentId).toBeUndefined();
	});

	it("reports a removed focused agent as gone", async () => {
		const h = makeHarness();
		const statuses: string[] = [];
		(h.ctx as unknown as { showStatus: (m: string) => void }).showStatus = m => statuses.push(m);
		const worker = makeSessionStub();
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);
		await h.controller.focusAgent("Worker");
		statuses.length = 0;
		h.registry.unregister("Worker");
		await flushAsync();
		await flushAsync();
		expect(h.controller.focusedAgentId).toBeUndefined();
		expect(statuses.some(s => s.includes("is gone"))).toBe(true);
	});

	it("drops an attach superseded while settling in-flight persistence", async () => {
		const h = makeHarness();
		const worker = makeSessionStub();
		let release: (() => void) | undefined;
		(worker.session as unknown as { settleInFlightMessagePersistence: () => Promise<void> }).settleInFlightMessagePersistence =
			() => new Promise<void>(resolve => { release = resolve; });
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);
		const focus = h.controller.focusAgent("Worker");
		await flushAsync();
		await h.controller.unfocus();
		release?.();
		await focus;
		expect(h.controller.focusedAgentId).toBeUndefined();
		expect(h.setSessionCalls.filter(([, id]) => id === "Worker")).toEqual([]);
	});

	it("drops an attach superseded while reloading todos", async () => {
		const h = makeHarness();
		const worker = makeSessionStub();
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);
		let release: (() => void) | undefined;
		const original = h.ctx.reloadTodos.bind(h.ctx);
		(h.ctx as unknown as { reloadTodos: (s?: AgentSession) => Promise<void> }).reloadTodos = async s => {
			if (s === worker.session) await new Promise<void>(resolve => { release = resolve; });
			return original(s);
		};
		const focus = h.controller.focusAgent("Worker");
		await flushAsync();
		await h.controller.unfocus();
		release?.();
		await focus;
		expect(h.controller.focusedAgentId).toBeUndefined();
	});

	it("does not show the viewing status when a completed attach is no longer focused", async () => {
		const h = makeHarness();
		const statuses: string[] = [];
		(h.ctx as unknown as { showStatus: (m: string) => void }).showStatus = m => statuses.push(m);
		const worker = makeSessionStub();
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);
		await h.controller.focusAgent("Worker");
		expect(statuses.some(s => s.includes("Viewing agent Worker"))).toBe(true);
	});

	it("drops a live-stream restore superseded during its synthesized start", async () => {
		const h = makeHarness();
		const worker = makeSessionStub();
		const live = { role: "assistant", content: [{ type: "text", text: "live" }] };
		(worker.session.agent.state as { streamMessage: unknown }).streamMessage = live;
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);
		let release: (() => void) | undefined;
		let started: (() => void) | undefined;
		const startSeen = new Promise<void>(r => { started = r; });
		const original = h.ctx.eventController.handleEvent.bind(h.ctx.eventController);
		(h.ctx.eventController as unknown as { handleEvent: (e: unknown) => Promise<void> }).handleEvent = async e => {
			if ((e as { type: string }).type === "message_start") {
				started?.();
				await new Promise<void>(r => { release = r; });
			}
			return original(e as never);
		};
		const focus = h.controller.focusAgent("Worker");
		await startSeen;
		await h.controller.unfocus();
		release?.();
		await focus;
		expect(h.handledEvents.map(e => (e as { type: string }).type)).not.toContain("message_update");
	});

	it("handles a focused agent removed while its attach is in flight", async () => {
		const h = makeHarness();
		const statuses: string[] = [];
		(h.ctx as unknown as { showStatus: (m: string) => void }).showStatus = m => statuses.push(m);
		const worker = makeSessionStub();
		let release: (() => void) | undefined;
		(worker.session as unknown as { settleInFlightMessagePersistence: () => Promise<void> }).settleInFlightMessagePersistence =
			() => new Promise<void>(resolve => { release = resolve; });
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);
		const focus = h.controller.focusAgent("Worker");
		await flushAsync();
		h.registry.unregister("Worker");
		await flushAsync();
		release?.();
		await focus;
		expect(h.controller.focusedAgentId).toBeUndefined();
		expect(statuses.some(s => s.includes("Viewing agent Worker"))).toBe(false);
	});

	it("does not announce return to main when that detach is superseded by a refocus", async () => {
		const h = makeHarness({
			renderInitialMessages: async () => {},
		});
		const statuses: string[] = [];
		(h.ctx as unknown as { showStatus: (m: string) => void }).showStatus = m => statuses.push(m);
		const worker = makeSessionStub();
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);
		await h.controller.focusAgent("Worker");
		statuses.length = 0;
		const unfocus = h.controller.unfocus();
		await h.controller.focusAgent("Worker");
		await unfocus;
		expect(statuses.some(s => s.includes("Returned to main session"))).toBe(false);
		expect(h.controller.focusedAgentId).toBe("Worker");
	});

	it("ignores a captured subscription and restore after the generation moves on", async () => {
		const h = makeHarness();
		const worker = makeSessionStub();
		let listener: ((event: unknown) => Promise<void>) | undefined;
		(worker.session as unknown as { subscribe: (fn: (e: unknown) => Promise<void>) => () => void }).subscribe = fn => {
			listener = fn;
			return () => {};
		};
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);
		await h.controller.focusAgent("Worker");
		await h.controller.unfocus();
		h.handledEvents.length = 0;
		// The captured listener belongs to the dead generation: both a plain
		// event and an orphaned message_end restore must be dropped.
		await listener?.({ type: "message_end", message: { role: "user" } });
		await listener?.({ type: "message_end", message: { role: "assistant", content: [] } });
		expect(h.handledEvents).toEqual([]);
	});

	it("drops an orphaned update superseded during its synthesized start", async () => {
		const h = makeHarness();
		const worker = makeSessionStub();
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);
		await h.controller.focusAgent("Worker");
		h.handledEvents.length = 0;
		let release: (() => void) | undefined;
		let started: (() => void) | undefined;
		const startSeen = new Promise<void>(r => { started = r; });
		const original = h.ctx.eventController.handleEvent.bind(h.ctx.eventController);
		(h.ctx.eventController as unknown as { handleEvent: (e: unknown) => Promise<void> }).handleEvent = async e => {
			if ((e as { type: string }).type === "message_start") {
				started?.();
				await new Promise<void>(r => { release = r; });
			}
			return original(e as never);
		};
		const emit = worker.emit({ type: "message_update", message: { role: "assistant", content: [] } });
		await startSeen;
		await h.controller.unfocus();
		release?.();
		await emit;
		expect(h.handledEvents.map(e => (e as { type: string }).type)).toEqual(["message_start"]);
	});

	it("drops a streaming attach superseded after agent_start", async () => {
		const h = makeHarness();
		const worker = makeSessionStub({ isStreaming: true });
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);
		let release: (() => void) | undefined;
		let started: (() => void) | undefined;
		const startSeen = new Promise<void>(r => { started = r; });
		const original = h.ctx.eventController.handleEvent.bind(h.ctx.eventController);
		(h.ctx.eventController as unknown as { handleEvent: (e: unknown) => Promise<void> }).handleEvent = async e => {
			if ((e as { type: string }).type === "agent_start") {
				started?.();
				await new Promise<void>(r => { release = r; });
			}
			return original(e as never);
		};
		const focus = h.controller.focusAgent("Worker");
		await startSeen;
		await h.controller.unfocus();
		const afterMain = h.counts.renderInitialMessages();
		release?.();
		await focus;
		expect(h.counts.renderInitialMessages()).toBe(afterMain);
		expect(h.controller.focusedAgentId).toBeUndefined();
	});

	it("stops replaying tool updates when superseded after the first", async () => {
		const h = makeHarness();
		const worker = makeSessionStub();
		const updates = [{ type: "tool_execution_update", toolCallId: "a" }, { type: "tool_execution_update", toolCallId: "b" }];
		(worker.session as unknown as { activeToolExecutionUpdates: () => unknown[] }).activeToolExecutionUpdates = () => updates;
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);
		let release: (() => void) | undefined;
		let started: (() => void) | undefined;
		const startSeen = new Promise<void>(r => { started = r; });
		const original = h.ctx.eventController.handleEvent.bind(h.ctx.eventController);
		let deferred = true;
		(h.ctx.eventController as unknown as { handleEvent: (e: unknown) => Promise<void> }).handleEvent = async e => {
			if (deferred && (e as { type: string }).type === "tool_execution_update") {
				deferred = false;
				started?.();
				await new Promise<void>(r => { release = r; });
			}
			return original(e as never);
		};
		const focus = h.controller.focusAgent("Worker");
		await startSeen;
		await h.controller.unfocus();
		release?.();
		await focus;
		const handled = h.handledEvents.filter(e => (e as { type: string }).type === "tool_execution_update");
		expect(handled).toHaveLength(1);
	});

	it("does not repaint the pending block when the main attach is superseded during its model-switch flush", async () => {
		const h = makeHarness();
		const worker = makeSessionStub();
		h.main.setQueue({ steering: ["main steer"] });
		worker.setQueue({ steering: ["worker steer"] });
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);
		await h.controller.focusAgent("Worker");
		let release: (() => void) | undefined;
		let flushing: (() => void) | undefined;
		const flushSeen = new Promise<void>(r => { flushing = r; });
		(h.ctx as unknown as { flushPendingModelSwitch: () => Promise<void> }).flushPendingModelSwitch = async () => {
			flushing?.();
			await new Promise<void>(r => { release = r; });
		};
		const unfocus = h.controller.unfocus();
		await flushSeen;
		await h.controller.focusAgent("Worker");
		release?.();
		await unfocus;
		expect(h.pendingMessagesContainer.render(80).join("\n")).toContain("worker steer");
		expect(h.controller.focusedAgentId).toBe("Worker");
	});

	it("restores pending tool results after a live restore that was already synced", async () => {
		const h = makeHarness();
		const worker = makeSessionStub();
		const live = { role: "assistant", content: [{ type: "text", text: "live" }] };
		(worker.session.agent.state as { streamMessage: unknown }).streamMessage = live;
		let restored = 0;
		(h.ctx.eventController as unknown as { restorePendingToolResults: () => void }).restorePendingToolResults = () => { restored++; };
		// Mark the stream synced by emitting a start through the subscription
		// captured during attach, before the live restore runs: use a deferred
		// persistence settle so the emit lands first.
		let release: (() => void) | undefined;
		(worker.session as unknown as { settleInFlightMessagePersistence: () => Promise<void> }).settleInFlightMessagePersistence =
			() => new Promise<void>(r => { release = r; });
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);
		const focus = h.controller.focusAgent("Worker");
		await flushAsync();
		await worker.emit({ type: "message_start", message: live });
		release?.();
		await focus;
		expect(restored).toBeGreaterThan(0);
		const starts = h.handledEvents.filter(e => (e as { type: string }).type === "message_start");
		expect(starts).toHaveLength(1);
	});

describe("pickRecentFocusableAgentId", () => {
	function ref(id: string, overrides: Partial<AgentRef> = {}): AgentRef {
		return {
			id,
			displayName: id,
			kind: "sub",
			status: "running",
			session: null,
			sessionFile: `${id}.jsonl`,
			createdAt: 1000,
			lastActivity: 1000,
			...overrides,
		};
	}

	it("picks the most recently active agent and keeps parked agents eligible for revive", () => {
		const refs = [
			ref("Old", { status: "idle", lastActivity: 1000 }),
			ref("Parked", { status: "parked", lastActivity: 2000 }),
			ref("Live", { status: "running", lastActivity: 3000 }),
		];
		expect(pickRecentFocusableAgentId(refs)).toBe("Live");
		expect(pickRecentFocusableAgentId(refs.filter(r => r.id !== "Live"))).toBe("Parked");
	});

	it("skips the main session, advisors, and aborted agents", () => {
		const refs = [
			ref(MAIN_AGENT_ID, { kind: "main", lastActivity: 9000 }),
			ref("Advisor", { kind: "advisor", lastActivity: 8000 }),
			ref("Dead", { status: "aborted", lastActivity: 7000 }),
			ref("Worker", { status: "idle", lastActivity: 1000 }),
		];
		expect(pickRecentFocusableAgentId(refs)).toBe("Worker");
	});

	it("returns undefined when no agent has a focusable session state", () => {
		expect(pickRecentFocusableAgentId([])).toBeUndefined();
		expect(
			pickRecentFocusableAgentId([
				ref(MAIN_AGENT_ID, { kind: "main" }),
				ref("Advisor", { kind: "advisor" }),
				ref("Dead", { status: "aborted" }),
			]),
		).toBeUndefined();
	});

	it("breaks activity and creation ties by id, in both directions", () => {
		const refs = [ref("Bravo"), ref("Alpha"), ref("Charlie")];
		expect(pickRecentFocusableAgentId(refs)).toBe("Alpha");
		for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
			const permuted = order.map(i => refs[i]!);
			expect(pickRecentFocusableAgentId(permuted)).toBe("Alpha");
		}
		expect(pickRecentFocusableAgentId(refs, "Alpha")).toBe("Bravo");
		const later = [ref("Bravo", { createdAt: 2000 }), ref("Alpha", { createdAt: 1000 })];
		expect(pickRecentFocusableAgentId(later)).toBe("Bravo");
		expect(pickRecentFocusableAgentId([ref("Charlie"), ref("Bravo"), ref("Alpha")])).toBe("Alpha");
	});

	it("cycles to the next-most-recent agent from the focused one, wrapping at the end", () => {
		const refs = [
			ref("Newest", { lastActivity: 3000 }),
			ref("Middle", { lastActivity: 2000 }),
			ref("Oldest", { lastActivity: 1000 }),
		];
		expect(pickRecentFocusableAgentId(refs, "Newest")).toBe("Middle");
		expect(pickRecentFocusableAgentId(refs, "Oldest")).toBe("Newest");
		expect(pickRecentFocusableAgentId(refs, "Gone")).toBe("Newest");
	});
});
