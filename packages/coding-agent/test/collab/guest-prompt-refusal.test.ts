/**
 * Contract: a writable guest's prompt that the host's `before_user_message`
 * gate refuses comes back to that guest only, as an `error` frame whose
 * `message` is the handler's safe notice and whose `refused` payload hands the
 * guest its own submission back. The TUI guest then restores the draft its
 * Enter already cleared, ahead of any newer draft, never clobbering it.
 *
 * Host half: real CollabHost over the in-memory relay with a raw guest socket.
 * Guest half: real CollabGuestLink driven by a scripted host socket and a real
 * CustomEditor. Only the TUI context and the network transport are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fsp from "node:fs/promises";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { generateRoomKey, importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import {
	COLLAB_PROTO,
	type CollabFrame,
	formatCollabLink,
	parseCollabLink,
} from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UserMessageRefusedError } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { getEditorTheme } from "@oh-my-pi/pi-tui/theme/tui-adapters";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

const SECRET = "token FAKE-SECRET-NOT-REAL-0000";
const NOTICE = "Blocked: this message looks like it contains a secret. It was not sent or saved.";
const IMAGE: ImageContent = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };

/** Frames that interleave nondeterministically with the directed replies under test. */
const FILTERED_FRAME_TYPES: Record<string, true> = {
	state: true,
	agents: true,
	entry: true,
	event: true,
	bus: true,
	"snapshot-chunk": true,
};

const cleanups: (() => Promise<void> | void)[] = [];
let writeSpy: { mockRestore(): void } | null = null;
let renameSpy: { mockRestore(): void } | null = null;

beforeEach(() => {
	installInMemoryRelay();
	// The guest writes its replica session file on welcome; keep it off disk.
	writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
	renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	writeSpy?.mockRestore();
	renameSpy?.mockRestore();
	writeSpy = null;
	renameSpy = null;
	uninstallInMemoryRelay();
});

// ── Host half ───────────────────────────────────────────────────────────────

/** Host context whose session refuses secrets and fails on "boom", like the real gate and a broken dispatch. */
function makeHostContext(): InteractiveModeContext {
	return {
		settings: Settings.isolated(),
		sessionManager: {
			getSessionId: () => "sess-1",
			getCwd: () => "/tmp",
			snapshotForReplication: () => ({
				header: { type: "session", id: "sess-1", timestamp: new Date().toISOString(), cwd: "/tmp" },
				entries: [],
			}),
			onEntryAppended: undefined,
		},
		session: {
			isStreaming: false,
			queuedMessageCount: 0,
			sessionName: "test",
			model: undefined,
			thinkingLevel: undefined,
			subscribe: () => () => {},
			emitNotice: () => {},
			promptCustomMessage: (message: { content: string | { type: string; text?: string }[] }) => {
				const text =
					typeof message.content === "string"
						? message.content
						: message.content.map(part => (part.type === "text" ? (part.text ?? "") : "")).join("");
				if (text.includes("FAKE-SECRET")) return Promise.reject(new UserMessageRefusedError(NOTICE));
				if (text.includes("boom")) return Promise.reject(new Error("dispatch exploded"));
				return Promise.resolve(true);
			},
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
		updatePendingMessagesDisplay: () => {},
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
}

async function joinRawGuest(link: string): Promise<{ socket: CollabSocket; nextFrame(): Promise<CollabFrame> }> {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: await importRoomKey(parsed.key) });
	const queue: CollabFrame[] = [];
	const waiters: ((frame: CollabFrame) => void)[] = [];
	socket.onFrame = frame => {
		if (FILTERED_FRAME_TYPES[frame.t]) return;
		const waiter = waiters.shift();
		if (waiter) waiter(frame);
		else queue.push(frame);
	};
	socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name: "guest", writeToken });
	socket.connect();
	return {
		socket,
		nextFrame: () => {
			const queued = queue.shift();
			if (queued) return Promise.resolve(queued);
			const { promise, resolve } = Promise.withResolvers<CollabFrame>();
			waiters.push(resolve);
			return promise;
		},
	};
}

async function startHost(): Promise<CollabHost> {
	const host = new CollabHost(makeHostContext());
	await host.start("ws://localhost:8787");
	cleanups.push(() => host.stop("test done"));
	return host;
}

describe("collab host: refused guest prompt", () => {
	it("returns the submission to its sender with only the safe notice", async () => {
		const host = await startHost();
		const guest = await joinRawGuest(host.link);
		cleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

		guest.socket.send({ t: "prompt", text: `please use ${SECRET}`, images: [IMAGE] });
		const reply = await guest.nextFrame();
		if (reply.t !== "error") throw new Error(`expected error, got ${reply.t}`);
		expect(reply.message).toBe(NOTICE);
		expect(reply.refused).toEqual({ text: `please use ${SECRET}`, images: [IMAGE] });
	});

	it("keeps ordinary dispatch failures as plain errors without a refused payload", async () => {
		const host = await startHost();
		const guest = await joinRawGuest(host.link);
		cleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

		guest.socket.send({ t: "prompt", text: "boom" });
		const reply = await guest.nextFrame();
		if (reply.t !== "error") throw new Error(`expected error, got ${reply.t}`);
		expect(reply.message).toContain("prompt failed:");
		expect(reply.refused).toBeUndefined();
	});
});

// ── Guest half ──────────────────────────────────────────────────────────────

interface GuestHarness {
	editor: CustomEditor;
	errors: string[];
	hostSocket: CollabSocket;
	/** Resolves once the guest has applied every frame sent before it (frames apply in order). */
	barrier(): Promise<void>;
}

async function openGuest(): Promise<GuestHarness> {
	const roomId = "prompt-refusal-room";
	const roomKey = generateRoomKey();
	const link = formatCollabLink("ws://localhost:8788", roomId, roomKey);
	const hostSocket = new CollabSocket({
		wsUrl: `ws://localhost:8788/r/${roomId}`,
		role: "host",
		key: await importRoomKey(roomKey),
	});
	const hostOpen = Promise.withResolvers<void>();
	hostSocket.onOpen = () => hostOpen.resolve();
	hostSocket.onFrame = frame => {
		if (frame.t !== "hello") return;
		hostSocket.send({
			t: "welcome",
			proto: COLLAB_PROTO,
			header: { type: "session", id: "remote-session", timestamp: "2026-10-15T00:00:00Z", cwd: "/tmp" },
			state: {
				isStreaming: false,
				queuedMessageCount: 0,
				sessionName: "host session",
				cwd: "/tmp",
				participants: [{ name: "Host", role: "host" }],
			},
			agents: [],
			entryCount: 0,
		});
	};
	hostSocket.connect();
	await hostOpen.promise;

	const editor = new CustomEditor(getEditorTheme());
	const errors: string[] = [];
	let barrierSeq = 0;
	const barrierWaiters = new Map<string, () => void>();
	const ctx = {
		collabGuest: undefined as CollabGuestLink | undefined,
		editor,
		settings: Settings.isolated(),
		sessionManager: { getSessionFile: () => null, getSessionName: () => "local session", getCwd: () => "/local" },
		session: {
			messages: [],
			switchSession: () => Promise.resolve(),
			newSession: () => Promise.resolve(),
			agent: {
				state: { model: undefined },
				setModel: () => {},
				setThinkingLevel: () => {},
				setDisableReasoning: () => {},
			},
		},
		statusContainer: { clear: () => {} },
		pendingMessagesContainer: { clear: () => {} },
		compactionQueuedMessages: [],
		streamingComponent: undefined,
		streamingMessage: undefined,
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map(),
		loadingAnimation: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			resetActiveTime: () => {},
			markActivityStart: () => {},
			markActivityEnd: () => {},
		},
		ui: { requestRender: () => {} },
		chatContainer: { clear: () => {}, disposeChildren: () => {} },
		resetObserverRegistry: () => {},
		renderInitialMessages: () => {},
		reloadTodos: () => Promise.resolve(),
		showStatus: () => {},
		showError: (message: string) => {
			for (const [sentinel, waiter] of barrierWaiters) {
				if (message.includes(sentinel)) {
					barrierWaiters.delete(sentinel);
					waiter();
					return;
				}
			}
			errors.push(message);
		},
		updateEditorTopBorder: () => {},
		updateEditorBorderColor: () => {},
		eventController: {
			dispatchSessionEvent: () => Promise.resolve(),
			takeDisplaceableComponents: () => [],
			resetTranscriptAnchors: () => {},
		},
		syncRunningSubagentBadge: () => {},
	} as unknown as InteractiveModeContext;

	const guest = new CollabGuestLink(ctx);
	await guest.join(link);
	cleanups.push(async () => {
		await guest.leave("test cleanup").catch(() => {});
		hostSocket.close();
	});
	return {
		editor,
		errors,
		hostSocket,
		barrier: () => {
			const sentinel = `__barrier_${++barrierSeq}__`;
			const { promise, resolve } = Promise.withResolvers<void>();
			barrierWaiters.set(sentinel, resolve);
			hostSocket.send({ t: "error", message: sentinel });
			return promise;
		},
	};
}

describe("collab TUI guest: refused prompt", () => {
	it("restores the refused text and images into the emptied composer", async () => {
		const h = await openGuest();
		await h.barrier();
		h.hostSocket.send({ t: "error", message: NOTICE, refused: { text: `please use ${SECRET}`, images: [IMAGE] } });
		await h.barrier();
		expect(h.editor.getExpandedText()).toBe(`please use ${SECRET}`);
		expect(h.editor.pendingImages).toEqual([IMAGE]);
		expect(h.errors).toEqual([NOTICE]);
	});

	it("puts the refused text ahead of a newer draft without clobbering it", async () => {
		const h = await openGuest();
		await h.barrier();
		h.editor.setText("newer draft");
		h.hostSocket.send({ t: "error", message: NOTICE, refused: { text: `refused ${SECRET}` } });
		await h.barrier();
		expect(h.editor.getExpandedText()).toBe(`refused ${SECRET}\nnewer draft`);
		expect(h.errors).toEqual([NOTICE]);
	});

	it("leaves the composer alone for a plain host error", async () => {
		const h = await openGuest();
		await h.barrier();
		h.editor.setText("keep me");
		h.hostSocket.send({ t: "error", message: "prompt failed: dispatch exploded" });
		await h.barrier();
		expect(h.editor.getExpandedText()).toBe("keep me");
		expect(h.errors).toEqual(["Collab host: prompt failed: dispatch exploded"]);
	});
});
