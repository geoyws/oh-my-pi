/**
 * The working row (loader), its label lifecycle, the session-accent tint and the
 * idle "to retry" hint row, all of which share InteractiveMode.statusContainer.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { Loader } from "@oh-my-pi/pi-tui/components/loader";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { setShimmerMode } from "@oh-my-pi/pi-tui/theme/shimmer";
import { TempDir } from "@oh-my-pi/pi-utils";

const COLUMNS = 60;

function statusText(mode: InteractiveMode): string {
	return Bun.stripANSI(mode.statusContainer.render(COLUMNS).join("\n"));
}

describe("InteractiveMode working row and retry hint (lines 8801-9064)", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let abortedToolTail = false;

	beforeAll(async () => {
		await initTheme();
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-im-r8801-working-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		Object.defineProperty(session, "hasAbortedToolCallTail", { get: () => abortedToolTail, configurable: true });
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, new EventBus());
		Object.defineProperty(mode.ui.terminal, "columns", { get: () => COLUMNS, configurable: true });
	});

	beforeEach(() => {
		abortedToolTail = false;
		mode.collabGuest = undefined;
	});

	afterEach(() => {
		// Tear the row down through the public error path, which stops a live loader.
		if (mode.loadingAnimation) mode.showError("reset");
		mode.statusContainer.clear();
		mode.syncRetryHintRow();
		mode.setWorkingMessage();
		mode.retryLoader = undefined;
		setShimmerMode("classic");
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	describe("loader lifecycle", () => {
		it("does not mount a working row while an auto-retry loader owns the status area", () => {
			const retry = new Loader(
				mode.ui,
				s => s,
				m => m,
				"Retrying…",
			);
			mode.retryLoader = retry;
			mode.statusContainer.addChild(retry);

			mode.ensureLoadingAnimation();

			expect(mode.loadingAnimation).toBeUndefined();
			expect(mode.statusContainer.children).toEqual([retry]);
			retry.stop();
		});

		it("re-mounts the existing loader when something else cleared the status area, and is idempotent when mounted", () => {
			mode.ensureLoadingAnimation();
			const loader = mode.loadingAnimation;
			expect(loader).toBeDefined();
			const render = spyOn(mode.ui, "requestRender");

			mode.ensureLoadingAnimation();
			expect(mode.loadingAnimation).toBe(loader);
			expect(mode.statusContainer.children).toEqual([loader!]);
			expect(render).not.toHaveBeenCalled();

			mode.statusContainer.clear();
			mode.ensureLoadingAnimation();
			expect(mode.loadingAnimation).toBe(loader);
			expect(mode.statusContainer.children).toEqual([loader!]);
			expect(render).toHaveBeenCalled();
		});

		it("keeps a static message unanimated when shimmer is disabled", () => {
			setShimmerMode("disabled");
			mode.ensureLoadingAnimation();
			mode.setWorkingMessage("Thinking about it");

			expect(statusText(mode)).toContain("Thinking about it");
		});

		it("routes a click on the working row's stop control to the interrupt (Escape) handler", () => {
			const onEscape = vi.fn();
			const previous = mode.editor.onEscape;
			mode.editor.onEscape = onEscape;
			try {
				mode.ensureLoadingAnimation();
				mode.loadingAnimation!.handleNativeEvent({ type: "action", act: "interrupt" } as never);
				expect(onEscape).toHaveBeenCalledTimes(1);
			} finally {
				mode.editor.onEscape = previous;
			}
		});

		it("showError stops a live loader and clears the status area", () => {
			mode.ensureLoadingAnimation();
			expect(mode.statusContainer.children.length).toBe(1);

			mode.showError("boom");

			expect(mode.loadingAnimation).toBeUndefined();
			expect(mode.statusContainer.children).toEqual([]);
		});
	});

	describe("working message", () => {
		it("holds a label set before the loader exists and applies it when the loader mounts", () => {
			mode.setWorkingMessage("Indexing repository");
			expect(mode.loadingAnimation).toBeUndefined();

			mode.ensureLoadingAnimation();

			expect(statusText(mode)).toContain("Indexing repository");
			// Applied once: a second mount does not resurrect it after a reset.
			mode.setWorkingMessage();
			mode.ensureLoadingAnimation();
			expect(statusText(mode)).not.toContain("Indexing repository");
		});

		it("clearing the label without a loader drops the pending label", () => {
			mode.setWorkingMessage("Never shown");
			mode.setWorkingMessage();

			mode.ensureLoadingAnimation();

			expect(statusText(mode)).not.toContain("Never shown");
		});

		it("clearing the label on a live loader restores the default label", () => {
			mode.ensureLoadingAnimation();
			const defaultText = statusText(mode);
			mode.setWorkingMessage("Custom label");
			expect(statusText(mode)).toContain("Custom label");

			mode.setWorkingMessage();

			expect(statusText(mode)).not.toContain("Custom label");
			expect(statusText(mode)).toBe(defaultText);
		});
	});

	describe("session accent", () => {
		it("renders no accent when the terminal cannot express the session colour", async () => {
			await session.sessionManager.setSessionName(`accentless ${Date.now()}`, "user");
			spyOn(Bun, "color").mockReturnValue(null as never);

			mode.ensureLoadingAnimation();
			const raw = mode.statusContainer.render(COLUMNS).join("\n");

			expect(Bun.stripANSI(raw)).toContain("Working");
			expect(raw).not.toContain("\x1b[38;2;");
		});
	});

	describe("retry hint row", () => {
		it("mounts the hint after an aborted tool call and keeps it while still applicable", () => {
			abortedToolTail = true;
			mode.syncRetryHintRow();
			const [hint] = mode.statusContainer.children;
			expect(statusText(mode)).toContain("to retry");

			mode.syncRetryHintRow();

			expect(mode.statusContainer.children).toEqual([hint!]);
		});

		it("removes the hint once the transcript no longer ends on an aborted tool call", () => {
			abortedToolTail = true;
			mode.syncRetryHintRow();
			expect(statusText(mode)).toContain("to retry");

			abortedToolTail = false;
			mode.syncRetryHintRow();

			expect(mode.statusContainer.children).toEqual([]);
		});

		it("re-creates the hint when something else unmounted it", () => {
			abortedToolTail = true;
			mode.syncRetryHintRow();
			const [first] = mode.statusContainer.children;
			mode.statusContainer.clear();

			mode.syncRetryHintRow();

			expect(mode.statusContainer.children).toHaveLength(1);
			expect(mode.statusContainer.children[0]).not.toBe(first);
			expect(statusText(mode)).toContain("to retry");
		});

		it("forgets an unmounted stale hint without remounting it", () => {
			abortedToolTail = true;
			mode.syncRetryHintRow();
			mode.statusContainer.clear();
			abortedToolTail = false;

			mode.syncRetryHintRow();
			abortedToolTail = true;
			mode.ensureLoadingAnimation();
			mode.syncRetryHintRow();

			// A live loader owns the row: the hint never contends with it.
			expect(mode.statusContainer.children).toEqual([mode.loadingAnimation!]);
		});

		it("advertises F5 when the retry action has no bound key", () => {
			abortedToolTail = true;
			const getKeys = mode.keybindings.getKeys.bind(mode.keybindings);
			spyOn(mode.keybindings, "getKeys").mockImplementation(((id: string) =>
				id === "app.retry" ? [] : getKeys(id as never)) as never);

			mode.syncRetryHintRow();

			expect(statusText(mode).toLowerCase()).toContain("f5");
		});

		it("stays hidden for a collab guest", () => {
			abortedToolTail = true;
			mode.collabGuest = {} as never;

			mode.syncRetryHintRow();

			expect(mode.statusContainer.children).toEqual([]);
		});
	});

	describe("transcript replay", () => {
		it("notes displayable thinking for every message before an incremental replay", async () => {
			const replay = spyOn(UiHelpers.prototype, "renderSessionContextIncrementally").mockResolvedValue();
			const note = spyOn(mode, "noteDisplayableThinkingContent");
			const messages = [
				{ role: "user", content: "hi", timestamp: 1 },
				{ role: "assistant", content: [{ type: "thinking", thinking: "hmm" }], timestamp: 2 },
			] as unknown as AgentMessage[];
			const context = { messages } as never;
			const chunk = vi.fn();
			const options = {} as Parameters<InteractiveMode["renderSessionContextIncrementally"]>[1];

			await mode.renderSessionContextIncrementally(context, options, chunk);

			expect(note.mock.calls.map(call => call[0])).toEqual(messages);
			expect(replay).toHaveBeenCalledWith(context, options, chunk);
		});
	});
});
