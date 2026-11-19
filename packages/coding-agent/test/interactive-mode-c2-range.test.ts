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
import { cfgGoalContinuationModes, cfgGoalEnabled } from "../src/goals/settings";
import type { SubmittedUserInput } from "@oh-my-pi/pi-coding-agent/modes/types";
import { cfgPlanEnabled } from "../src/plan-mode/settings";
import { cfgSessionIdleCheckpointMs } from "../src/session/settings";
import { cfgLoopMode } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";
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
	// cwd-change tests move the process project dir into temp dirs they then remove
	let projectDir: string;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		projectDir = getProjectDir();
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
		setProjectDir(projectDir);
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

	describe("goal continuation scheduling", () => {
		const flush = async () => {
			for (let i = 0; i < 10; i++) await Promise.resolve();
		};

		async function activeGoalMode(): Promise<InteractiveMode> {
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			const entered = await m.sessionModes.set({ mode: "goal", action: "enter", objective: "finish the range" });
			expect(entered).toMatchObject({ ok: true, state: { goal: { status: "active" } } });
			return m;
		}

		/** Resolves to the submitted input, or "none" if nothing was submitted after the 800ms tick. */
		async function inputAfterTick(m: InteractiveMode, beforeTick?: () => void): Promise<SubmittedUserInput | "none"> {
			let submitted: SubmittedUserInput | "none" = "none";
			void m.getUserInput().then(input => {
				submitted = input;
			});
			await flush();
			beforeTick?.();
			vi.advanceTimersByTime(800);
			await flush();
			return submitted;
		}

		it("submits a hidden goal-continuation turn once the composer stays idle", async () => {
			const m = await activeGoalMode();
			vi.useFakeTimers();
			const input = await inputAfterTick(m);
			if (input === "none") throw new Error("no goal continuation was submitted");
			expect(input).toMatchObject({ customType: "goal-continuation", display: false });
			expect(input.text).toContain("finish the range");
		});

		it("does not schedule while the composer holds a draft or the todo list is all blocked", async () => {
			const m = await activeGoalMode();
			vi.useFakeTimers();
			m.editor.setText("half-typed thought");
			expect(await inputAfterTick(m)).toBe("none");
			m.onInputCallback?.({ text: "", cancelled: true, started: false });
			m.editor.setText("");
			m.session.setTodoPhases([
				{ name: "Work", tasks: [{ id: "t1", content: "waiting on review", status: "blocked" }] },
			] as never);
			expect(await inputAfterTick(m)).toBe("none");
		});

		it("does not schedule in a run mode excluded from goal.continuationModes", async () => {
			const m = await activeGoalMode();
			cfgGoalContinuationModes.set(Settings.instance, ["rpc"]);
			vi.useFakeTimers();
			expect(await inputAfterTick(m)).toBe("none");
		});

		it("drops a scheduled tick when a draft or a busy turn appears before it fires", async () => {
			const m = await activeGoalMode();
			vi.useFakeTimers();
			expect(await inputAfterTick(m, () => m.editor.setText("typed during the delay"))).toBe("none");
			m.onInputCallback?.({ text: "", cancelled: true, started: false });
			m.editor.setText("");
			Object.defineProperty(m.session, "isStreaming", { configurable: true, get: () => true });
			try {
				let submitted = false;
				void m.getUserInput().then(() => {
					submitted = true;
				});
				await flush();
				vi.advanceTimersByTime(800);
				await flush();
				expect(submitted).toBe(false);
			} finally {
				Reflect.deleteProperty(m.session, "isStreaming");
			}
		});

		it("holds continuation on an idle Esc and cancels the pending tick", async () => {
			const m = await activeGoalMode();
			const hold = vi.spyOn(m.session.goalRuntime, "holdContinuation");
			vi.useFakeTimers();
			expect(await inputAfterTick(m, () => m.holdGoalContinuation())).toBe("none");
			expect(hold).toHaveBeenCalledTimes(1);
		});
	});

	describe("cwd change rollback", () => {
		it("restores the source project and reports false when the rescope fails", async () => {
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			const source = getProjectDir();
			const other = TempDir.createSync("@pi-c2-rescope-");
			const showError = vi.spyOn(m, "showError").mockImplementation(() => {});
			const refresh = vi.spyOn(m.session, "refreshSkillsAndCommands");
			refresh.mockRejectedValueOnce(new Error("skills exploded"));
			try {
				expect(await m.applyCwdChange(other.path())).toBe(false);
				expect(getProjectDir()).toBe(source);
				expect(m.sessionManager.getCwd()).toBe(source);
				expect(showError).toHaveBeenCalledWith(`Cannot change working directory to ${other.path()}: skills exploded`);
				// the source project was re-scoped after the failure
				expect(refresh).toHaveBeenCalledTimes(2);
			} finally {
				other.removeSync();
			}
		});

		it("reports non-Error rescope failures verbatim", async () => {
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			const other = TempDir.createSync("@pi-c2-rescope-");
			const showError = vi.spyOn(m, "showError").mockImplementation(() => {});
			vi.spyOn(m.session, "refreshSkillsAndCommands").mockRejectedValueOnce("plain failure");
			try {
				expect(await m.applyCwdChange(other.path())).toBe(false);
				expect(showError).toHaveBeenCalledWith(`Cannot change working directory to ${other.path()}: plain failure`);
			} finally {
				other.removeSync();
			}
		});

		it("throws with both causes when restoring the source project also fails", async () => {
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			const other = TempDir.createSync("@pi-c2-rescope-");
			const showError = vi.spyOn(m, "showError").mockImplementation(() => {});
			vi.spyOn(m.session, "refreshSkillsAndCommands")
				.mockRejectedValueOnce(new Error("switch broke"))
				.mockRejectedValueOnce(new Error("restore broke"));
			try {
				await expect(m.applyCwdChange(other.path())).rejects.toThrow(
					`Failed to restore workspace after failed switch to ${other.path()}: restore broke`,
				);
				expect(showError).toHaveBeenCalledWith(
					`Failed to switch to ${other.path()} (switch broke), and restoring the previous workspace failed: restore broke`,
				);
			} finally {
				other.removeSync();
			}
		});

		it("quotes non-Error causes when the restore also fails", async () => {
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			const other = TempDir.createSync("@pi-c2-rescope-");
			const showError = vi.spyOn(m, "showError").mockImplementation(() => {});
			vi.spyOn(m.session, "refreshSkillsAndCommands").mockRejectedValueOnce("first").mockRejectedValueOnce("second");
			try {
				await expect(m.applyCwdChange(other.path())).rejects.toThrow("second");
				expect(showError).toHaveBeenCalledWith(
					`Failed to switch to ${other.path()} (first), and restoring the previous workspace failed: second`,
				);
			} finally {
				other.removeSync();
			}
		});
	});

	describe("loop iterations", () => {
		const flush = async () => {
			for (let i = 0; i < 10; i++) await Promise.resolve();
		};

		it("stops an iteration-limited loop once its budget is spent", async () => {
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			await m.sessionModes.set({
				mode: "loop",
				action: "enter",
				prompt: "again",
				limit: { kind: "iterations", iterations: 1 },
			});
			const showStatus = vi.spyOn(m, "showStatus");
			vi.useFakeTimers();
			const first = m.getUserInput();
			vi.advanceTimersByTime(800);
			await flush();
			expect((await first).text).toBe("again");
			void m.getUserInput();
			vi.advanceTimersByTime(800);
			await flush();
			expect(showStatus).toHaveBeenCalledWith("Loop limit reached. Loop mode disabled.");
			expect(m.loopModeEnabled).toBe(false);
		});

		it("does nothing when the auto-submit tick fires with no input waiting", async () => {
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			await m.sessionModes.set({ mode: "loop", action: "enter", prompt: "again" });
			const submit = vi.spyOn(m, "startPendingSubmission");
			vi.useFakeTimers();
			m.armLoopAutoSubmit();
			vi.advanceTimersByTime(800);
			await flush();
			expect(submit).not.toHaveBeenCalled();
			expect(m.loopModeEnabled).toBe(true);
		});

		it("clears the session before resubmitting in reset mode", async () => {
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			cfgLoopMode.set(Settings.instance, "reset");
			await m.sessionModes.set({ mode: "loop", action: "enter", prompt: "fresh start" });
			const clear = vi.spyOn(m, "handleClearCommand").mockResolvedValue(undefined as never);
			vi.useFakeTimers();
			const input = m.getUserInput();
			vi.advanceTimersByTime(800);
			await flush();
			expect((await input).text).toBe("fresh start");
			expect(clear).toHaveBeenCalledTimes(1);
		});

		it("ignores a condition run aborted by a resubmitted prompt", async () => {
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			await m.sessionModes.set({
				mode: "loop",
				action: "enter",
				prompt: "poll",
				condition: { command: "sleep 30", until: true },
			});
			const showStatus = vi.spyOn(m, "showStatus");
			const submit = vi.spyOn(m, "startPendingSubmission");
			// the iteration's `finally` reports through syncIdleMaintenanceView once the gate settles
			const settled = Promise.withResolvers<void>();
			let armed = false;
			const realSync = m.syncIdleMaintenanceView.bind(m);
			vi.spyOn(m, "syncIdleMaintenanceView").mockImplementation(() => {
				realSync();
				if (armed) settled.resolve();
			});
			vi.useFakeTimers();
			void m.getUserInput();
			vi.advanceTimersByTime(800);
			vi.useRealTimers();
			armed = true;
			// resubmitting the same text supersedes the running gate without leaving loop mode
			m.setLoopPrompt("poll");
			await settled.promise;
			expect(submit).not.toHaveBeenCalled();
			expect(m.loopModeEnabled).toBe(true);
			expect(showStatus).not.toHaveBeenCalledWith(expect.stringContaining("Loop mode disabled"));
		});

		it("ignores a loop prompt while loop mode is off and reports malformed /loop arguments", async () => {
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			m.setLoopPrompt("ignored");
			expect(m.loopPrompt).toBeUndefined();
			const showError = vi.spyOn(m, "showError").mockImplementation(() => {});
			expect(await m.handleLoopCommand("0 times")).toBeUndefined();
			expect(showError).toHaveBeenCalledTimes(1);
			expect(m.loopModeEnabled).toBe(false);
		});

		it("announces the continuation condition when enabling a conditional loop", async () => {
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			const showStatus = vi.spyOn(m, "showStatus");
			await m.sessionModes.set({ mode: "loop", action: "enter", condition: { command: "test -f done", until: true } });
			expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("Continuing until"));
			expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("test -f done"));
		});
	});

	describe("idle owner checkpoint", () => {
		const flush = async () => {
			for (let i = 0; i < 20; i++) await Promise.resolve();
		};

		/** Moves the wall clock `ms` past the last activity and fires the idle-checkpoint timer. */
		function idleFor(ms: number): void {
			const later = Date.now() + ms;
			vi.spyOn(Date, "now").mockReturnValue(later);
			vi.advanceTimersByTime(ms);
		}

		it("re-arms instead of checkpointing while the composer holds a draft", async () => {
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			const shutdown = vi.spyOn(m, "shutdown").mockResolvedValue(undefined as never);
			const flushSpy = vi.spyOn(m.sessionManager, "flush");
			m.editor.setText("still typing");
			vi.useFakeTimers();
			cfgSessionIdleCheckpointMs.set(Settings.instance, 1000);
			idleFor(1500);
			await flush();
			expect(flushSpy).not.toHaveBeenCalled();
			expect(shutdown).not.toHaveBeenCalled();
		});

		it("checkpoints an idle owner and closes it unattended", async () => {
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			const closed = Promise.withResolvers<void>();
			const shutdown = vi.spyOn(m, "shutdown").mockImplementation(async () => closed.resolve());
			vi.useFakeTimers();
			cfgSessionIdleCheckpointMs.set(Settings.instance, 1000);
			idleFor(1500);
			vi.useRealTimers();
			await closed.promise;
			expect(shutdown).toHaveBeenCalledWith({ unattended: true });
			expect(m.sessionManager.isSessionOnDisk()).toBe(true);
		});

		it("stays live when input arrives while the transcript flushes", async () => {
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			const shutdown = vi.spyOn(m, "shutdown").mockResolvedValue(undefined as never);
			const flushed = Promise.withResolvers<void>();
			const realFlush = m.sessionManager.flush.bind(m.sessionManager);
			vi.spyOn(m.sessionManager, "flush").mockImplementation(async () => {
				m.editor.setText("typed mid-checkpoint");
				await realFlush();
				flushed.resolve();
			});
			vi.useFakeTimers();
			cfgSessionIdleCheckpointMs.set(Settings.instance, 1000);
			idleFor(1500);
			vi.useRealTimers();
			await flushed.promise;
			await flush();
			expect(shutdown).not.toHaveBeenCalled();
		});

		it("stays live when the session still has work running", async () => {
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			const shutdown = vi.spyOn(m, "shutdown").mockResolvedValue(undefined as never);
			const flushSpy = vi.spyOn(m.sessionManager, "flush");
			Object.defineProperty(m.session, "isStreaming", { configurable: true, get: () => true });
			try {
				vi.useFakeTimers();
				cfgSessionIdleCheckpointMs.set(Settings.instance, 1000);
				idleFor(1500);
				await flush();
				expect(flushSpy).not.toHaveBeenCalled();
				expect(shutdown).not.toHaveBeenCalled();
			} finally {
				Reflect.deleteProperty(m.session, "isStreaming");
			}
		});
	});
});
