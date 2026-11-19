import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { type Api, Effort, type Model } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { cfgStartupQuiet, cfgTuiMouse } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { cfgGoalEnabled } from "../src/goals/settings";
import { cfgPlanEnabled } from "../src/plan-mode/settings";
import { cfgSessionIdleCheckpointMs } from "../src/session/settings";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { cfgExtensionHandlersModeControl } from "../src/extensibility/settings";
import { formatModelString } from "../src/config/model-resolver";
import { hasTranscriptActions, runTranscriptAction } from "@oh-my-pi/pi-tui/chat/transcript-actions";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { DescribeContext } from "@oh-my-pi/pi-tui/native/node";

const cx: DescribeContext = { cols: 80, reduceMotion: false, dark: true, supports: () => true, feature: () => true };

describe("InteractiveMode constructed surface (C2)", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let mode: InteractiveMode | undefined;
	let session: AgentSession | undefined;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-c2-range-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		cfgStartupQuiet.set(Settings.instance, true);
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
	});

	afterEach(async () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		mode = undefined;
		session = undefined;
		resetSettingsForTest();
	});

	function createMode(
		eventBus?: EventBus,
		extra?: { lspServers?: Array<{ name: string; status: "ready"; fileTypes: string[] }>; mcpManager?: MCPManager },
	): InteractiveMode {
		const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), `models-${Bun.nanoseconds()}.yml`));
		const model = registry.find("anthropic", "claude-sonnet-4-5") as Model<Api>;
		const readTool: AgentTool = {
			name: "read",
			label: "read",
			description: "Fake read",
			parameters: type({}),
			async execute() {
				return { content: [{ type: "text" as const, text: "ok" }] };
			},
		};
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), `active-${Bun.nanoseconds()}`));
		session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [readTool], messages: [], thinkingLevel: Effort.Medium },
			}),
			sessionManager: manager,
			settings: Settings.instance,
			modelRegistry: registry,
			toolRegistry: new Map([[readTool.name, readTool]]),
			builtInToolNames: ["read"],
		});
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			() => {},
			extra?.lspServers,
			extra?.mcpManager,
			eventBus,
		);
		return mode;
	}

	it("reports the initial session-mode state and empty HUD descriptions", () => {
		const m = createMode();
		expect(m.sessionModes.getState()).toBeDefined();
		const pills = m.describeHudPills();
		expect(pills).toBeDefined();
		expect(m.describeHudPills()).toBe(pills);
		const status = m.describeStatusHud([], cx);
		expect(m.describeStatusHud([], cx)).toBe(status);
	});

	it("installs editor callbacks for mentions, hyperlinks, skills and hints", () => {
		const m = createMode();
		expect(m.editor.fileHyperlink("/tmp/a.ts", "a.ts")).toBe("a.ts"); // no OSC 8 in this terminal
		expect(m.editor.skillFilePath("missing")).toBeUndefined();
		expect(m.editor.modelMentionLabel("no-such-model-xyz")).toBeUndefined();
		expect(m.editor.modelMentionSelector({} as never)).toBeUndefined();
		expect(typeof m.editor.magicKeywordsEnabled()).toBe("boolean");
		void m.editor.placeholder?.();
	});

	it("routes LSP and MCP startup events from the session event bus", () => {
		const bus = new EventBus();
		const m = createMode(bus);
		// quiet startup: the LSP handler returns before touching the transcript
		bus.emit("lsp:startup", { type: "failed", error: "no servers" });
		cfgStartupQuiet.set(Settings.instance, false);
		bus.emit("lsp:startup", { type: "failed", error: "no servers" });
		bus.emit("lsp:startup", { type: "completed", servers: [] });
		// malformed MCP payloads are logged and dropped
		bus.emit("mcp:connection-status", { nope: true });
		bus.emit("mcp:connection-status", { type: "connecting", serverNames: ["srv1"] });
		bus.emit("mcp:connection-status", { type: "connected", serverName: "srv1" });
		bus.emit("mcp:connection-status", { type: "failed", serverName: "srv1", error: "boom" });
		bus.emit("mcp:connection-status", { type: "reconnecting", serverName: "srv1" });
		expect(m).toBeDefined();
	});

	it("reacts to editor geometry callbacks, mouse settings and judgment progress", () => {
		const bus = new EventBus();
		const m = createMode(bus);
		m.editor.onAutocompleteCancel?.();
		m.editor.onAutocompleteUpdate?.();
		expect(m.editor.viewportRowsProvider?.()).toBeGreaterThan(0);
		// mouse capture follows the tui.mouse setting in both directions
		cfgTuiMouse.set(Settings.instance, false);
		cfgTuiMouse.set(Settings.instance, true);
		// malformed judgment progress is dropped; a valid snapshot drives the HUD
		bus.emit("eval:judgment-batch-progress", { nope: true });
		bus.emit("eval:judgment-batch-progress", {
			id: "batch-1",
			intent: "grade answers",
			done: 1,
			total: 3,
			failed: 0,
			cost: 0.01,
			running: true,
		});
		bus.emit("eval:judgment-batch-progress", {
			id: "batch-1",
			intent: "grade answers",
			done: 3,
			total: 3,
			failed: 1,
			cost: 0.03,
			running: false,
		});
		m.statusLine.onNativePullRequest?.({ number: 42 } as never);
		m.statusLine.onNativePullRequest?.(undefined as never);
	});

	it("initializes once and refreshes the title system prompt", async () => {
		const m = createMode();
		await m.init({ suppressWelcomeIntro: true });
		expect(m.isInitialized).toBe(true);
		await m.init({ suppressWelcomeIntro: true }); // second init is a no-op
		await m.refreshTitleSystemPrompt(tempDir.path());
	});

	it("refreshes skill and slash-command state and accepts autocomplete providers", async () => {
		const m = createMode();
		await m.init({ suppressWelcomeIntro: true });
		await m.refreshSkillState();
		await m.refreshSlashCommandState(tempDir.path());
		m.addAutocompleteProvider(current => current);
		m.disableGoalMode();
		m.disableLoopMode();
		m.holdGoalContinuation();
		expect(m.editor).toBeDefined();
	});

	it("applies a cwd change to a sibling directory", async () => {
		const m = createMode();
		await m.init({ suppressWelcomeIntro: true });
		const other = TempDir.createSync("@pi-c2-other-");
		try {
			expect(await m.applyCwdChange(other.path())).toBe(true);
		} finally {
			other.removeSync();
		}
	});

	it("commits a cwd change even when the project settings file is unreadable", async () => {
		const m = createMode();
		await m.init({ suppressWelcomeIntro: true });
		const other = TempDir.createSync("@pi-c2-bad-");
		try {
			const fs = await import("node:fs");
			fs.mkdirSync(path.join(other.path(), ".claude"), { recursive: true });
			fs.mkdirSync(path.join(other.path(), ".claude", "settings.yml"), { recursive: true });
			// the settings loader tolerates an unreadable project file; the switch commits
			expect(await m.applyCwdChange(other.path())).toBe(true);
		} finally {
			other.removeSync();
		}
	});

	it("labels a mentionable model and registers the MCP auth handler", () => {
		let authHandler: unknown;
		const mcpManager = {
			setAuthHandler: (handler: unknown) => {
				authHandler = handler;
			},
		} as unknown as MCPManager;
		const m = createMode(undefined, {
			lspServers: [{ name: "tsserver", status: "ready", fileTypes: [".ts"] }],
			mcpManager,
		});
		expect(m.lspServers).toHaveLength(1);
		expect(typeof authHandler).toBe("function");
		const selector = formatModelString(m.session.model!);
		const label = m.editor.modelMentionLabel(selector);
		expect(typeof label).toBe("string");
		expect(label!.length).toBeGreaterThan(0);
	});

	it("plays the welcome intro on an unsuppressed init", async () => {
		const m = createMode();
		await m.init({ clearInitialTerminalHistory: true });
		expect(m.isInitialized).toBe(true);
	});

	it("drives the loop-mode command lifecycle", async () => {
		const m = createMode();
		await m.init({ suppressWelcomeIntro: true });
		// with no loop configured the handler reports through the UI, not a return value
		expect(await m.handleLoopCommand("")).toBeUndefined();
		m.setLoopPrompt("keep polishing");
		expect(await m.handleLoopCommand("show")).toBeUndefined();
		m.pauseLoop();
		m.armLoopAutoSubmit();
		m.disableLoopMode();
		expect(await m.handleLoopCommand("")).toBeUndefined();
	});

	it("dispatches native transcript actions to the mode commands", async () => {
		const m = createMode();
		await m.init({ suppressWelcomeIntro: true });
		expect(hasTranscriptActions()).toBe(true);
		expect(runTranscriptAction({ act: "copy", text: "hello" })).toBe(true);
		expect(runTranscriptAction({ act: "retry" })).toBe(true);
		expect(runTranscriptAction({ act: "resume", path: "/nonexistent/session.jsonl" })).toBe(true);
		await new Promise(resolve => setTimeout(resolve, 50));
	});

	it("refuses a cwd change to a missing directory", async () => {
		const m = createMode();
		await m.init({ suppressWelcomeIntro: true });
		expect(await m.applyCwdChange("/nonexistent-c2-dir-xyz")).toBe(false);
	});

	it("retitles the terminal when the session is renamed", async () => {
		const m = createMode();
		await m.init({ suppressWelcomeIntro: true });
		expect(await m.sessionManager.setSessionName("C2 Renamed Session", "user")).toBe(true);
		expect(m.sessionManager.getSessionName()).toBe("C2 Renamed Session");
	});

	it("starts a goal from an objective and schedules its continuation", async () => {
		const m = createMode();
		await m.init({ suppressWelcomeIntro: true });
		cfgGoalEnabled.set(Settings.instance, true);
		// waiting for input arms the schedulers; the goal objective then submits into it
		void m.getUserInput();
		expect(await m.handleGoalModeCommand("ship the coverage row")).toBe(true);
		expect(m.goalModeEnabled).toBe(true);
		m.disableGoalMode();
		expect(m.goalModeEnabled).toBe(false);
	});

	it("routes status-line native actions to their commands", async () => {
		const m = createMode();
		await m.init({ suppressWelcomeIntro: true });
		m.statusLine.onNativeAction?.("status.context");
		m.statusLine.onNativeAction?.("status.cost");
		await new Promise(resolve => setTimeout(resolve, 20));
	});

	it("re-arms the idle checkpoint when its bound changes", async () => {
		const m = createMode();
		await m.init({ suppressWelcomeIntro: true });
		cfgSessionIdleCheckpointMs.set(Settings.instance, 60_000);
		cfgSessionIdleCheckpointMs.set(Settings.instance, 0);
		expect(m.isInitialized).toBe(true);
	});

	it("auto-submits the loop prompt as the next user input", async () => {
		const m = createMode();
		await m.init({ suppressWelcomeIntro: true });
		// enabling through the command hands the inline prompt back for the first iteration
		expect(await m.handleLoopCommand("again please")).toBe("again please");
		m.setLoopPrompt("again please");
		m.armLoopAutoSubmit();
		const input = await Promise.race([
			m.getUserInput(),
			new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 2500)),
		]);
		expect(input?.text).toBe("again please");
		m.disableLoopMode();
	});

	it("restores a saved draft into the editor on init", async () => {
		const m = createMode();
		await m.sessionManager.saveDraft("unsent thought");
		await m.init({ suppressWelcomeIntro: true });
		expect(m.editor.getText()).toContain("unsent thought");
	});

	it("reacts to a model change on the live session", async () => {
		const m = createMode();
		await m.init({ suppressWelcomeIntro: true });
		const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), `models-alt-${Bun.nanoseconds()}.yml`));
		const other = registry.find("anthropic", "claude-opus-4-5") as Model<Api>;
		const result = await m.session.setModel(other);
		expect(result.switched).toBe(true);
		expect(m.session.model?.id).toBe("claude-opus-4-5");
	});

	it("tracks displayable thinking content per visible session", () => {
		const m = createMode();
		expect(m.hasDisplayableThinkingContent).toBe(false);
		const plain = { role: "assistant", content: [{ type: "text", text: "hi" }] } as never;
		expect(m.noteDisplayableThinkingContent(plain)).toBe(false);
		expect(m.hasDisplayableThinkingContent).toBe(false);
		const thinking = { role: "assistant", content: [{ type: "thinking", thinking: "reasoning" }] } as never;
		expect(m.noteDisplayableThinkingContent(thinking)).toBe(true);
		expect(m.hasDisplayableThinkingContent).toBe(true);
		expect(m.noteDisplayableThinkingContent(thinking)).toBe(false);
	});

	describe("extension mode control (sessionModes.set)", () => {
		it("refuses every request while extension mode control is disabled", async () => {
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			cfgExtensionHandlersModeControl.set(Settings.instance, false);
			const result = await m.sessionModes.set({ mode: "loop", action: "enter" });
			expect(result).toMatchObject({ ok: false, code: "disabled" });
			expect(m.loopModeEnabled).toBe(false);
		});

		it("refuses as busy until init has restored the saved modes", async () => {
			const m = createMode();
			const result = await m.sessionModes.set({ mode: "loop", action: "enter" });
			expect(result).toMatchObject({ ok: false, code: "busy" });
			expect(result.ok ? "" : result.message).toContain("still being restored");
		});

		it("refuses as busy while a completed goal is still being torn down", async () => {
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			vi.spyOn(m.session, "getGoalModeState").mockReturnValue({
				enabled: false,
				mode: "exiting",
				reason: "completed",
				goal: { objective: "done thing", status: "complete" },
			} as never);
			const result = await m.sessionModes.set({ mode: "loop", action: "enter" });
			expect(result).toMatchObject({ ok: false, code: "busy" });
			expect(result.ok ? "" : result.message).toContain("torn down");
		});

		it("refuses as busy while the session runs a turn", async () => {
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			Object.defineProperty(m.session, "isBusyForSnapshot", { configurable: true, get: () => true });
			const result = await m.sessionModes.set({ mode: "loop", action: "enter" });
			expect(result).toMatchObject({ ok: false, code: "busy" });
			expect(m.loopModeEnabled).toBe(false);
		});

		it("reports an already-held state as unchanged without running a transition", async () => {
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			for (const request of [
				{ mode: "plan", action: "exit" },
				{ mode: "vibe", action: "exit" },
				{ mode: "goal", action: "drop" },
				{ mode: "loop", action: "exit" },
			] as const) {
				const result = await m.sessionModes.set(request);
				expect(result).toMatchObject({ ok: true, changed: false });
			}
		});

		it("rejects malformed goal and loop requests and unknown modes", async () => {
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			const cases: Array<[unknown, string]> = [
				[{ mode: "goal", action: "enter", objective: "   " }, "non-empty string"],
				[{ mode: "goal", action: "enter", objective: "x", tokenBudget: 1.5 }, "positive integer"],
				[{ mode: "goal", action: "pause" }, "no active goal to pause"],
				[{ mode: "goal", action: "resume" }, "no paused goal"],
				[{ mode: "loop", action: "enter", prompt: "  " }, "Loop prompt"],
				[{ mode: "loop", action: "enter", limit: { kind: "iterations", iterations: 0 } }, "Loop limit"],
				[{ mode: "loop", action: "enter", condition: { command: "", until: true } }, "Loop condition"],
				[{ mode: "warp", action: "enter" }, "Unknown mode"],
				[{ mode: "plan", action: "toggle" }, "Unknown mode"],
			];
			for (const [request, message] of cases) {
				const result = await m.sessionModes.set(request as never);
				expect(result).toMatchObject({ ok: false, code: "invalid_request" });
				expect(result.ok ? "" : result.message).toContain(message);
			}
		});

		it("refuses goal entry when goal mode is disabled in settings", async () => {
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			cfgGoalEnabled.set(Settings.instance, false);
			const result = await m.sessionModes.set({ mode: "goal", action: "enter", objective: "ship it" });
			expect(result).toMatchObject({ ok: false, code: "disabled" });
		});

		it("enters, re-prompts, pauses, resumes and exits loop mode", async () => {
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			const entered = await m.sessionModes.set({
				mode: "loop",
				action: "enter",
				prompt: " keep going ",
				limit: { kind: "iterations", iterations: 3 },
			});
			expect(entered).toMatchObject({ ok: true, changed: true, state: { loop: { status: "active" } } });
			expect(m.loopPrompt).toBe("keep going");
			// bounds cannot change on a running loop
			const rebound = await m.sessionModes.set({
				mode: "loop",
				action: "enter",
				limit: { kind: "duration", durationMs: 1000 },
			});
			expect(rebound).toMatchObject({ ok: false, code: "invalid_request" });
			// the same prompt is a no-op; a new prompt replaces it
			expect(await m.sessionModes.set({ mode: "loop", action: "enter", prompt: "keep going" })).toMatchObject({
				ok: true,
				changed: false,
			});
			await m.sessionModes.set({ mode: "loop", action: "enter", prompt: "new body" });
			expect(m.loopPrompt).toBe("new body");
			// a paused loop resumes waiting on a bare enter
			m.pauseLoop();
			expect(m.sessionModes.getState().loop.status).toBe("paused");
			const resumed = await m.sessionModes.set({ mode: "loop", action: "enter" });
			expect(resumed).toMatchObject({ ok: true, changed: true, state: { loop: { status: "active" } } });
			expect(await m.sessionModes.set({ mode: "loop", action: "enter" })).toMatchObject({ changed: false });
			const exited = await m.sessionModes.set({ mode: "loop", action: "exit" });
			expect(exited).toMatchObject({ ok: true, changed: true, state: { loop: { status: "inactive" } } });
			expect(m.loopModeEnabled).toBe(false);
		});

		it("refuses a second transition while one is in flight", async () => {
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			const first = m.sessionModes.set({ mode: "loop", action: "enter" });
			const second = await m.sessionModes.set({ mode: "loop", action: "exit" });
			expect(second).toMatchObject({ ok: false, code: "busy" });
			expect(await first).toMatchObject({ ok: true, changed: true });
		});

		it("enters and exits plan mode, refusing goal and vibe while it holds", async () => {
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			const entered = await m.sessionModes.set({ mode: "plan", action: "enter" });
			expect(entered).toMatchObject({ ok: true, changed: true, state: { plan: { status: "active" } } });
			expect(m.planModeEnabled).toBe(true);
			expect(await m.sessionModes.set({ mode: "plan", action: "enter" })).toMatchObject({ changed: false });
			expect(await m.sessionModes.set({ mode: "goal", action: "enter", objective: "x" })).toMatchObject({
				ok: false,
				code: "conflict",
				message: "Exit plan mode first.",
			});
			expect(await m.sessionModes.set({ mode: "vibe", action: "enter" })).toMatchObject({
				ok: false,
				code: "conflict",
				message: "Exit plan mode first.",
			});
			const exited = await m.sessionModes.set({ mode: "plan", action: "exit" });
			expect(exited).toMatchObject({ ok: true, changed: true, state: { plan: { status: "inactive" } } });
			expect(m.planModeEnabled).toBe(false);
		});

		it("refuses plan entry when plan mode is disabled in settings", async () => {
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			cfgPlanEnabled.set(Settings.instance, false);
			expect(await m.sessionModes.set({ mode: "plan", action: "enter" })).toMatchObject({
				ok: false,
				code: "disabled",
			});
		});

		it("drives a goal through enter, pause, resume and drop", async () => {
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			const entered = await m.sessionModes.set({
				mode: "goal",
				action: "enter",
				objective: "cover the range",
				tokenBudget: 5000,
			});
			expect(entered).toMatchObject({
				ok: true,
				changed: true,
				state: { goal: { status: "active", objective: "cover the range", tokenBudget: 5000 } },
			});
			// the same objective and budget is already held; a different one is refused
			expect(
				await m.sessionModes.set({ mode: "goal", action: "enter", objective: "cover the range", tokenBudget: 5000 }),
			).toMatchObject({ ok: true, changed: false });
			expect(await m.sessionModes.set({ mode: "goal", action: "enter", objective: "other" })).toMatchObject({
				code: "invalid_request",
			});
			expect(await m.sessionModes.set({ mode: "plan", action: "enter" })).toMatchObject({
				code: "conflict",
				message: "Exit goal mode first.",
			});
			expect(await m.sessionModes.set({ mode: "goal", action: "resume" })).toMatchObject({ changed: false });
			const paused = await m.sessionModes.set({ mode: "goal", action: "pause" });
			expect(paused).toMatchObject({ ok: true, state: { goal: { status: "paused" } } });
			expect(await m.sessionModes.set({ mode: "goal", action: "pause" })).toMatchObject({ changed: false });
			expect(await m.sessionModes.set({ mode: "goal", action: "enter", objective: "other" })).toMatchObject({
				code: "invalid_request",
				message: "Resume or drop the paused goal first.",
			});
			const resumed = await m.sessionModes.set({ mode: "goal", action: "resume" });
			expect(resumed).toMatchObject({ ok: true, state: { goal: { status: "active" } } });
			const dropped = await m.sessionModes.set({ mode: "goal", action: "drop" });
			expect(dropped).toMatchObject({ ok: true, changed: true, state: { goal: { status: "inactive" } } });
			expect(m.goalModeEnabled).toBe(false);
		});
	});
});
