/**
 * Contract: a provider-internal retry backoff on the host must reach a joined
 * guest and replace its status line with the same "Provider retrying … in Xs…"
 * countdown the host shows locally (#12785 follow-up).
 *
 * Two halves, matching how the collab suites are split elsewhere:
 *  - Replication: real `CollabHost` + `CollabGuestLink` over the in-memory
 *    relay. `provider_retry_wait_start`/`_end` only cross the wire if they are
 *    in both the wire `AgentEvent` union and the host allowlist, so dropping
 *    either fails here rather than silently leaving guests on "Working…".
 *  - Guest status: a real `InteractiveMode` + `EventController` (what
 *    `CollabGuestLink` hands every replicated event to) driven with the
 *    replicated events plus the host `state`-frame reconcile that fires
 *    repeatedly inside one backoff — the countdown must own the status area
 *    until the wait ends, then give it back to "Working…".
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, type Mock, spyOn, vi } from "bun:test";
import * as os from "node:os";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { CollabGuestLink, reconcileGuestSnapshotHostState } from "@oh-my-pi/pi-coding-agent/collab/guest";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { refreshDirsFromEnv, TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

const WAIT_START: Extract<AgentSessionEvent, { type: "provider_retry_wait_start" }> = {
	type: "provider_retry_wait_start",
	waitId: 1,
	role: "main",
	delayMs: 4000,
	model: "claude-sonnet-4-5",
	provider: "anthropic",
	api: "anthropic-messages",
	attempt: 2,
	maxAttempts: 10,
};
const WAIT_END: Extract<AgentSessionEvent, { type: "provider_retry_wait_end" }> = {
	type: "provider_retry_wait_end",
	aborted: false,
	waitId: 1,
};

/** Rendered status rows carry SGR; compare against the visible text only. */
function visible(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Minimal host `InteractiveModeContext`: only the members `CollabHost` reads,
 * with a live `subscribe` so the test can push session events through the same
 * tap the real `AgentSession` feeds.
 */
function makeHostContext(manager: SessionManager, emit: { fn?: (event: AgentSessionEvent) => void }) {
	return {
		settings: { get: () => "" },
		sessionManager: manager,
		session: {
			isStreaming: true,
			isAborting: false,
			queuedMessageCount: 0,
			sessionName: "host session",
			model: undefined,
			thinkingLevel: undefined,
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				emit.fn = listener;
				return () => {
					emit.fn = undefined;
				};
			},
			emitNotice: () => {},
			promptCustomMessage: () => Promise.resolve(),
			abort: () => Promise.resolve(),
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
}

/**
 * Guest whose `eventController` records every replicated event verbatim. The
 * session and manager are real (the join path resumes the replicated snapshot
 * through `AgentSession.switchSession`); every UI touchpoint is a no-op double.
 */
function makeRecordingGuest(): { guest: CollabGuestLink; events: AgentSessionEvent[]; dispose: () => Promise<void> } {
	const tempDir = TempDir.createSync("@pi-collab-provider-retry-");
	const manager = SessionManager.create(tempDir.path(), tempDir.path());
	const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
	const session = new AgentSession({ agent, sessionManager: manager, settings: Settings.isolated(), modelRegistry });
	const events: AgentSessionEvent[] = [];
	const ctx = {
		settings: { get: () => "" },
		sessionManager: manager,
		session,
		statusContainer: { clear: () => {}, disposeChildren: () => {} },
		pendingMessagesContainer: { clear: () => {} },
		compactionQueuedMessages: [],
		pendingTools: new Map(),
		loadingAnimation: undefined,
		autoCompactionLoader: undefined,
		retryLoader: undefined,
		providerRetryLoader: undefined,
		ensureLoadingAnimation: () => {},
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			markActivityStart: () => {},
			markActivityEnd: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
			resetActiveTime: () => {},
		},
		ui: { requestRender: () => {} },
		chatContainer: { clear: () => {}, disposeChildren: () => {} },
		resetObserverRegistry: () => {},
		syncRunningSubagentBadge: () => {},
		renderInitialMessages: () => Promise.resolve(),
		reloadTodos: () => Promise.resolve(),
		showStatus: () => {},
		showError: () => {},
		eventController: {
			handleEvent: (event: AgentSessionEvent) => {
				events.push(event);
				return Promise.resolve();
			},
			takeDisplaceableComponents: () => [],
		},
		eventBus: undefined,
		collabGuest: undefined,
		handleResumeSession: () => Promise.resolve(),
	} as unknown as InteractiveModeContext;

	const guest = new CollabGuestLink(ctx);
	return {
		guest,
		events,
		dispose: async () => {
			await guest.leave("test cleanup").catch(() => {});
			await session.dispose().catch(() => {});
			await tempDir.remove().catch(() => {});
		},
	};
}

// See host-compaction-guest-sync.test.ts: frames traverse the real
// CollabSocket, whose AES-GCM seal/open resolve on WebCrypto — genuine async
// the test cannot drive with a fake clock — so settle against wall time.
async function settleFrames(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(1);
	}
	if (!predicate()) throw new Error("condition not met while settling collab frames");
}

// The guest writes its replica under getConfigRootDir(); redirect the config
// root to a temp HOME so the test never touches the real ~/.omp.
let homedirSpy: Mock<typeof os.homedir> | undefined;
let homeDir: TempDir | undefined;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
let model: Model;

beforeAll(async () => {
	homeDir = TempDir.createSync("@pi-collab-provider-retry-home-");
	homedirSpy = spyOn(os, "homedir").mockReturnValue(homeDir.path());
	refreshDirsFromEnv();
	await Settings.init({ inMemory: true });
	await initTheme(false);
	installInMemoryRelay();
	authStorage = createInMemoryAuthStorage();
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	modelRegistry = new ModelRegistry(authStorage);
	const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!bundled) throw new Error("expected bundled anthropic model");
	model = bundled;
});

afterAll(async () => {
	uninstallInMemoryRelay();
	authStorage.close();
	homedirSpy?.mockRestore();
	refreshDirsFromEnv();
	resetSettingsForTest();
	await homeDir?.remove().catch(() => {});
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

describe("collab provider-retry-wait replication", () => {
	it("replicates provider_retry_wait_start/_end to a joined guest with the payload intact", async () => {
		const hostManager = SessionManager.inMemory();
		const emit: { fn?: (event: AgentSessionEvent) => void } = {};
		const host = new CollabHost(makeHostContext(hostManager, emit));
		await host.start("ws://localhost:8788");
		cleanups.push(() => host.stop("test done"));

		const harness = makeRecordingGuest();
		cleanups.push(harness.dispose);
		await harness.guest.join(host.link);
		await settleFrames(() => emit.fn !== undefined);

		emit.fn?.(WAIT_START);
		emit.fn?.(WAIT_END);

		await settleFrames(() => harness.events.some(e => e.type === "provider_retry_wait_end"));
		const replicated = harness.events.filter(e => e.type.startsWith("provider_retry_wait"));
		expect(replicated).toEqual([WAIT_START, WAIT_END]);
	});

	it("keeps a non-wire session event off the wire", async () => {
		// Guard rail for the allowlist itself: widening it must stay a
		// deliberate, per-type act rather than "forward everything".
		const hostManager = SessionManager.inMemory();
		const emit: { fn?: (event: AgentSessionEvent) => void } = {};
		const host = new CollabHost(makeHostContext(hostManager, emit));
		await host.start("ws://localhost:8788");
		cleanups.push(() => host.stop("test done"));

		const harness = makeRecordingGuest();
		cleanups.push(harness.dispose);
		await harness.guest.join(host.link);
		await settleFrames(() => emit.fn !== undefined);

		emit.fn?.({ type: "model_changed" });
		emit.fn?.(WAIT_END);

		await settleFrames(() => harness.events.some(e => e.type === "provider_retry_wait_end"));
		expect(harness.events.some(e => e.type === "model_changed")).toBe(false);
	});
});

describe("guest status during a replicated provider retry wait", () => {
	function makeGuestUi(): { mode: InteractiveMode; controller: EventController } {
		const sessionManager = SessionManager.inMemory();
		const session = {
			sessionManager,
			settings,
			agent: { state: { tools: [] }, metadataForProvider: () => undefined, getPendingToolResults: () => [] },
			customCommands: [],
			skills: [],
			autoCompactionEnabled: true,
			messages: [],
			systemPrompt: [],
			state: { model: undefined },
			// A guest's replica session never streams locally: its activity state
			// comes from host `state` frames.
			isStreaming: false,
			model: undefined,
			thinkingLevel: undefined,
			titleGenerationSignal: new AbortController().signal,
			notifyTitleGenerationStart: () => undefined,
		} as unknown as AgentSession;
		const mode = new InteractiveMode(session, "test");
		// Replicated events only reach a guest after its UI came up; the full
		// `init()` train (slash commands, MCP, skills) is irrelevant here.
		mode.isInitialized = true;
		// Joined guest: the replica session never streams locally, so the host
		// turn the controller is replaying (`agent_start` → `agent_end`) is this
		// session's only notion of "a turn is running".
		mode.collabGuest = {} as unknown as InteractiveModeContext["collabGuest"];
		cleanups.push(async () => mode.stop());
		return { mode, controller: new EventController(mode as unknown as InteractiveModeContext) };
	}

	it("shows the countdown, survives the host's streaming reconcile, then restores Working…", async () => {
		const { mode, controller } = makeGuestUi();
		const ctx = mode as unknown as InteractiveModeContext;

		// The host's turn starts and its state frame lands: the guest shows "Working…".
		await controller.handleEvent({ type: "agent_start" });
		reconcileGuestSnapshotHostState(ctx, true);
		expect(ctx.loadingAnimation).toBeDefined();
		expect(visible(mode.statusContainer.render(120).join("\n"))).toContain("Working");

		await controller.handleEvent(WAIT_START);
		expect(ctx.providerRetryLoader).toBeDefined();
		expect(ctx.loadingAnimation).toBeUndefined();
		expect(visible(mode.statusContainer.render(120).join("\n"))).toContain("Provider retrying (2/10) in 4.0s");

		// The host keeps streaming through the backoff, so its periodic `state`
		// frame reconciles again mid-countdown: it must not trade the countdown
		// back for "Working…".
		reconcileGuestSnapshotHostState(ctx, true);
		reconcileGuestSnapshotHostState(ctx, true);
		expect(mode.statusContainer.children).toEqual([ctx.providerRetryLoader!]);
		expect(visible(mode.statusContainer.render(120).join("\n"))).toContain("Provider retrying (2/10)");

		await controller.handleEvent(WAIT_END);
		expect(ctx.providerRetryLoader).toBeUndefined();

		// With the countdown gone the next reconcile restores the working row.
		reconcileGuestSnapshotHostState(ctx, true);
		expect(ctx.loadingAnimation).toBeDefined();
		const restored = visible(mode.statusContainer.render(120).join("\n"));
		expect(restored).toContain("Working");
		expect(restored).not.toContain("Provider retrying");
	});

	it("does not let a lost wait_end pin the countdown into the next turn", async () => {
		// Replication makes the wait_end droppable: a guest reconnect (or a
		// renderer exception locally) can swallow it. A pinned countdown would
		// also suppress "Working…" forever, because `ensureLoadingAnimation`
		// yields to whoever owns the status area.
		const { mode, controller } = makeGuestUi();
		const ctx = mode as unknown as InteractiveModeContext;

		await controller.handleEvent({ type: "agent_start" });
		await controller.handleEvent(WAIT_START);
		expect(ctx.providerRetryLoader).toBeDefined();

		// wait_end never arrives; the host starts the next turn instead.
		await controller.handleEvent({ type: "agent_start" });
		expect(ctx.providerRetryLoader).toBeUndefined();
		const rendered = visible(mode.statusContainer.render(120).join("\n"));
		expect(rendered).toContain("Working");
		expect(rendered).not.toContain("Provider retrying");
	});

	it("does not let a lost wait_end outlive the turn it belonged to", async () => {
		const { mode, controller } = makeGuestUi();
		const ctx = mode as unknown as InteractiveModeContext;

		await controller.handleEvent({ type: "agent_start" });
		await controller.handleEvent(WAIT_START);
		expect(ctx.providerRetryLoader).toBeDefined();

		await controller.handleEvent({ type: "agent_end", messages: [] } as unknown as AgentSessionEvent);
		expect(ctx.providerRetryLoader).toBeUndefined();
		expect(visible(mode.statusContainer.render(120).join("\n"))).not.toContain("Provider retrying");
	});

	it("survives a replicated event type it has no handler for", async () => {
		// A guest dispatches events produced by the HOST's build. The hello
		// handshake rejects a proto mismatch, but a same-proto host carrying a
		// newer event type must not crash the guest: an unguarded handler lookup
		// threw a TypeError out of an unawaited handleEvent (unhandledRejection →
		// fatal exit) over a status-line nicety.
		const { mode, controller } = makeGuestUi();
		const ctx = mode as unknown as InteractiveModeContext;

		await controller.handleEvent({ type: "agent_start" });
		await controller.handleEvent({ type: "from_a_newer_host" } as unknown as AgentSessionEvent);

		// Still live and still rendering the turn it was given.
		await controller.handleEvent(WAIT_START);
		expect(ctx.providerRetryLoader).toBeDefined();
		expect(visible(mode.statusContainer.render(120).join("\n"))).toContain("Provider retrying (2/10)");
	});
});
