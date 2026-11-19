import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { formatMCPConnectionStatusMessage, type McpConnectionFailure } from "../src/mcp/startup-events";
import { cfgStartupQuiet, cfgTuiMouse } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { cfgGoalContinuationModes, cfgGoalEnabled } from "../src/goals/settings";
import type { SubmittedUserInput } from "@oh-my-pi/pi-coding-agent/modes/types";
import { cfgPlanEnabled } from "../src/plan-mode/settings";
import { cfgSessionIdleCheckpointMs } from "../src/session/settings";
import { cfgLoopMode, cfgStartupChangelogMode } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { getProjectDir, postmortem, setProjectDir } from "@oh-my-pi/pi-utils";
import { type AgentMessage } from "@oh-my-pi/pi-agent-core";
import * as imageReferences from "@oh-my-pi/pi-tui/prompt/image-references";
import * as tuiTodo from "@oh-my-pi/pi-tui/tools/todo";
import { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line";
import { CodexResetFireworksController } from "@oh-my-pi/pi-tui/overlays/codex-reset-fireworks";
import * as cfgProtocol from "../src/internal-urls/cfg-protocol";
import * as titleGenerator from "../src/utils/title-generator";
import * as openModule from "../src/utils/open";
import * as clipboard from "../src/utils/clipboard";
import { trackDownload } from "../src/downloads/activity";
import { HistoryStorage } from "../src/session/history-storage";
import { StreamPublisher } from "../src/stream/publisher";
import { StreamRedactor } from "../src/stream/redactor";
import { ExtensionRuntime, loadExtensionFromFactory } from "../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import { cfgStreamRedactPatterns } from "../src/stream/settings";
import type { StartupChangelogSelection } from "../src/utils/changelog";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { cfgExtensionHandlersModeControl } from "../src/extensibility/settings";
import { formatModelString } from "../src/config/model-resolver";
import { hasTranscriptActions, runTranscriptAction } from "@oh-my-pi/pi-tui/chat/transcript-actions";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { DescribeContext } from "@oh-my-pi/pi-tui/native/node";
import * as tuiTheme from "@oh-my-pi/pi-tui/theme";
import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import { setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import * as extensionLinks from "@oh-my-pi/pi-tui/render/extension-links";
import { TERMINAL } from "@oh-my-pi/pi-tui";
import { MCPCommandController } from "../src/modes/controllers/mcp-command-controller";
import { EventController } from "../src/modes/controllers/event-controller";
import { InputController } from "../src/modes/controllers/input-controller";
import {
	cfgAskTimeout,
	cfgDisplaySubagentLivePreview,
	cfgShowHardwareCursor,
	cfgSymbolPreset,
} from "@oh-my-pi/pi-coding-agent/modes/settings";
import * as piUtils from "@oh-my-pi/pi-utils";
import * as settingsModule from "@oh-my-pi/pi-coding-agent/config/settings";
import * as loopCondition from "../src/modes/loop-condition";
import * as loopLimit from "../src/modes/loop-limit";
import { setEditorGapComposerShape } from "@oh-my-pi/pi-tui/prompt/editor-top-gap";
import { useConstructedInteractiveMode } from "./helpers/constructed-interactive-mode";

const cx: DescribeContext = { cols: 80, reduceMotion: false, dark: true, supports: () => true, feature: () => true };

describe("InteractiveMode constructed surface (C2)", () => {
	const harness = useConstructedInteractiveMode("@pi-c2-range-");
	const { createMode } = harness;

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

	it("warns about LSP startup failures only when startup is not quiet", () => {
		const bus = new EventBus();
		const m = createMode(bus);
		const showWarning = vi.spyOn(m, "showWarning").mockImplementation(() => {});
		bus.emit("lsp:startup", { type: "failed", error: "no servers" });
		expect(showWarning).not.toHaveBeenCalled();
		cfgStartupQuiet.set(Settings.instance, false);
		bus.emit("lsp:startup", { type: "failed", error: "no servers" });
		expect(showWarning).toHaveBeenLastCalledWith("LSP startup failed: no servers. It will retry lazily on write.");
		bus.emit("lsp:startup", { type: "completed", servers: [{ name: "tsserver", status: "error", error: "spawn ENOENT" }] });
		expect(showWarning).toHaveBeenLastCalledWith("LSP startup failed for tsserver: spawn ENOENT. It will retry lazily on write.");
		bus.emit("lsp:startup", {
			type: "completed",
			servers: [
				{ name: "tsserver", status: "error" },
				{ name: "pyright", status: "error" },
			],
		});
		expect(showWarning).toHaveBeenLastCalledWith("LSP startup failed for tsserver, pyright. It will retry lazily on write.");
		showWarning.mockClear();
		bus.emit("lsp:startup", { type: "completed", servers: [{ name: "tsserver", status: "ready" }] });
		expect(showWarning).not.toHaveBeenCalled();
	});

	it("tracks each MCP server through connecting, connected, failed and reconnecting in one status line", () => {
		const bus = new EventBus();
		const m = createMode(bus);
		const showStatus = vi.spyOn(m, "showStatus").mockImplementation(() => {});
		// quiet startup posts nothing; malformed payloads are dropped
		bus.emit("mcp:connection-status", { type: "connecting", serverNames: ["srv1"] });
		cfgStartupQuiet.set(Settings.instance, false);
		bus.emit("mcp:connection-status", { nope: true });
		expect(showStatus).not.toHaveBeenCalled();
		const status = (pendingServers: string[], connectedServers: string[], failedServers: McpConnectionFailure[]) =>
			formatMCPConnectionStatusMessage({ pendingServers, connectedServers, failedServers });
		bus.emit("mcp:connection-status", { type: "connecting", serverNames: ["srv1", "srv2"] });
		expect(showStatus).toHaveBeenLastCalledWith(status(["srv1", "srv2"], [], []), { toast: false });
		bus.emit("mcp:connection-status", { type: "connected", serverName: "srv1" });
		expect(showStatus).toHaveBeenLastCalledWith(status(["srv2"], ["srv1"], []), { toast: false });
		bus.emit("mcp:connection-status", { type: "failed", serverName: "srv1", error: "boom" });
		expect(showStatus).toHaveBeenLastCalledWith(
			status(["srv2"], [], [{ serverName: "srv1", error: "boom", sourcePath: undefined }]),
			{ toast: false },
		);
		bus.emit("mcp:connection-status", { type: "reconnecting", serverName: "srv1" });
		expect(showStatus).toHaveBeenLastCalledWith(status(["srv1", "srv2"], [], []), { toast: false });
		expect(showStatus.mock.calls.at(-1)?.[0]).toContain("srv1");
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

	it("initializes once: a second init neither re-subscribes nor re-arms anything", async () => {
		const m = createMode();
		await m.init({ suppressWelcomeIntro: true });
		const subscribe = vi.spyOn(m.session, "subscribe");
		const keybindings = m.keybindings;
		await m.init({ suppressWelcomeIntro: true });
		expect(subscribe).not.toHaveBeenCalled();
		expect(m.keybindings).toBe(keybindings);
	});

	it("reloads the title system prompt from an explicit cwd", async () => {
		const m = createMode();
		const prompts = path.join(harness.tempDir().path(), "explicit-cwd");
		const setTitle = vi.spyOn(m.session, "setTitleSystemPrompt");
		await m.refreshTitleSystemPrompt(prompts);
		expect(setTitle).toHaveBeenCalledTimes(1);
	});

	it("rebuilds the slash-command picker from reloaded file commands", async () => {
		const m = createMode();
		await m.init({ suppressWelcomeIntro: true });
		const setCommands = vi.spyOn(m.session, "setSlashCommands");
		const createProvider = vi.spyOn(InputController.prototype, "createAutocompleteProvider");
		await m.refreshSlashCommandState(harness.tempDir().path(), [
			{ name: "review-pr", description: "Review a PR", argumentHint: "<number>\nor url" } as never,
		]);
		expect(setCommands).toHaveBeenCalledWith([expect.objectContaining({ name: "review-pr" })]);
		const picked = createProvider.mock.calls.at(-1)?.[0].find(command => command.name === "review-pr");
		expect(picked).toMatchObject({ description: "Review a PR", iconName: "prompt", argumentHint: "<number> or url" });
		// skill reloads go through the session; its metadata notification rebuilds the picker
		const refreshSkills = vi.spyOn(m.session, "refreshSkills");
		await m.refreshSkillState();
		expect(refreshSkills).toHaveBeenCalledTimes(1);
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
			// a directory where the project settings file should be
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
		const retry = vi.spyOn(InputController.prototype, "handleRetry").mockResolvedValue(undefined as never);
		expect(runTranscriptAction({ act: "retry" })).toBe(true);
		expect(retry).toHaveBeenCalledTimes(1);
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

	it("routes status-line context and cost clicks to their commands", async () => {
		const m = createMode();
		await m.init({ suppressWelcomeIntro: true });
		const context = vi.spyOn(m, "handleContextCommand").mockResolvedValue(undefined as never);
		const usage = vi.spyOn(m, "handleUsageCommand").mockResolvedValue(undefined as never);
		m.statusLine.onNativeAction?.("status.context");
		expect(context).toHaveBeenCalledTimes(1);
		expect(usage).not.toHaveBeenCalled();
		m.statusLine.onNativeAction?.("status.cost");
		expect(usage).toHaveBeenCalledTimes(1);
		expect(context).toHaveBeenCalledTimes(1);
	});

	it("auto-submits the loop prompt as the next user input", async () => {
		const m = createMode();
		await m.init({ suppressWelcomeIntro: true });
		// enabling through the command hands the inline prompt back for the first iteration
		expect(await m.handleLoopCommand("again please")).toBe("again please");
		m.setLoopPrompt("again please");
		m.armLoopAutoSubmit();
		const input = await Promise.race([m.getUserInput(), Bun.sleep(2500).then(() => undefined)]);
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
		const registry = new ModelRegistry(
			harness.authStorage(),
			path.join(harness.tempDir().path(), `models-alt-${Bun.nanoseconds()}.yml`),
		);
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

		it("an idle Esc or disable without goal mode holds nothing and posts no status", async () => {
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			const hold = vi.spyOn(m.session.goalRuntime, "holdContinuation");
			const showStatus = vi.spyOn(m, "showStatus").mockImplementation(() => {});
			m.holdGoalContinuation();
			m.disableGoalMode();
			expect(hold).not.toHaveBeenCalled();
			expect(showStatus).not.toHaveBeenCalled();
		});

		const cancelInput = (m: InteractiveMode) => m.onInputCallback?.({ text: "", cancelled: true, started: false });
		const image = { type: "image", data: "aGk=", mimeType: "image/png" } as never;

		it("does not schedule while plan mode is on, an image is attached, no prompt exists or a submission is pending", async () => {
			const m = await activeGoalMode();
			vi.useFakeTimers();
			m.planModeEnabled = true;
			expect(await inputAfterTick(m)).toBe("none");
			cancelInput(m);
			m.planModeEnabled = false;
			m.editor.pendingImages = [image];
			expect(await inputAfterTick(m)).toBe("none");
			cancelInput(m);
			m.editor.pendingImages = [];
			const prompt = vi.spyOn(m.session.goalRuntime, "buildContinuationPrompt").mockReturnValue(undefined as never);
			expect(await inputAfterTick(m)).toBe("none");
			cancelInput(m);
			prompt.mockRestore();
			m.startPendingSubmission({ text: "queued by the user" });
			expect(await inputAfterTick(m)).toBe("none");
		});

		it("drops a tick whose input, goal, prompt, attachments or todo list changed before it fired", async () => {
			const m = await activeGoalMode();
			vi.useFakeTimers();
			let waiting: InteractiveMode["onInputCallback"];
			expect(
				await inputAfterTick(m, () => {
					waiting = m.onInputCallback;
					m.onInputCallback = undefined;
				}),
			).toBe("none");
			m.onInputCallback = waiting;
			cancelInput(m);
			expect(await inputAfterTick(m, () => (m.goalModePaused = true))).toBe("none");
			cancelInput(m);
			m.goalModePaused = false;
			expect(await inputAfterTick(m, () => (m.editor.pendingImages = [image]))).toBe("none");
			cancelInput(m);
			m.editor.pendingImages = [];
			const state = m.session.getGoalModeState();
			const goalState = vi.spyOn(m.session, "getGoalModeState");
			expect(
				await inputAfterTick(m, () => goalState.mockReturnValue({ ...state, enabled: false } as never)),
			).toBe("none");
			cancelInput(m);
			goalState.mockRestore();
			const prompt = vi.spyOn(m.session.goalRuntime, "buildContinuationPrompt");
			expect(await inputAfterTick(m, () => prompt.mockReturnValue(undefined as never))).toBe("none");
			cancelInput(m);
			prompt.mockRestore();
			const blocked = [{ name: "Work", tasks: [{ id: "t1", content: "waiting on review", status: "blocked" }] }];
			expect(await inputAfterTick(m, () => m.session.setTodoPhases(blocked as never))).toBe("none");
			cancelInput(m);
			m.session.setTodoPhases([]);
			expect(await inputAfterTick(m, () => m.startPendingSubmission({ text: "typed during the delay" }))).toBe("none");
		});

		it("continues past a todo list that still has actionable work", async () => {
			const m = await activeGoalMode();
			vi.useFakeTimers();
			m.session.setTodoPhases([
				{
					name: "Work",
					tasks: [
						{ id: "t1", content: "first", status: "completed" },
						{ id: "t2", content: "next", status: "pending" },
					],
				},
			] as never);
			expect(await inputAfterTick(m)).toMatchObject({ customType: "goal-continuation" });
		});

		it("continues past a todo list whose work is all finished", async () => {
			const m = await activeGoalMode();
			vi.useFakeTimers();
			m.session.setTodoPhases([{ name: "Work", tasks: [{ id: "t1", content: "first", status: "completed" }] }] as never);
			expect(await inputAfterTick(m)).toMatchObject({ customType: "goal-continuation" });
		});

		it("suppresses the next continuation after a continuation turn that made no progress", async () => {
			const m = createMode();
			const subscribe = vi.spyOn(m.session, "subscribe");
			await m.init({ suppressWelcomeIntro: true });
			await m.sessionModes.set({ mode: "goal", action: "enter", objective: "finish the range" });
			vi.useFakeTimers();
			expect(await inputAfterTick(m)).toMatchObject({ customType: "goal-continuation" });
			let submitted = false;
			void m.getUserInput().then(() => {
				submitted = true;
			});
			await flush();
			// the continuation turn ends with no tool or text activity
			for (const [listener] of subscribe.mock.calls) listener({ type: "agent_end", messages: [] } as never);
			await flush();
			vi.advanceTimersByTime(800);
			await flush();
			expect(submitted).toBe(false);
		});

		it("finishes a completed goal's teardown silently before waiting for input", async () => {
			const m = await activeGoalMode();
			const state = m.session.getGoalModeState();
			vi.spyOn(m.session, "getGoalModeState").mockReturnValueOnce({ ...state, mode: "exiting", reason: "completed" } as never);
			const showStatus = vi.spyOn(m, "showStatus");
			vi.useFakeTimers();
			expect(await inputAfterTick(m)).toBe("none");
			expect(m.goalModeEnabled).toBe(false);
			expect(showStatus).not.toHaveBeenCalledWith("Goal mode completed.");
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

		it("skips an iteration whose loop prompt changed while its tick was pending", async () => {
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			await m.sessionModes.set({ mode: "loop", action: "enter", prompt: "again" });
			const submit = vi.spyOn(m, "startPendingSubmission");
			vi.useFakeTimers();
			void m.getUserInput();
			m.loopPrompt = "something else";
			vi.advanceTimersByTime(800);
			await flush();
			expect(submit).not.toHaveBeenCalled();
			expect(m.loopModeEnabled).toBe(true);
		});

		it("does not resubmit when the prompt changes or the time limit expires during a compaction", async () => {
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			cfgLoopMode.set(Settings.instance, "compact");
			await m.sessionModes.set({ mode: "loop", action: "enter", prompt: "again" });
			const submit = vi.spyOn(m, "startPendingSubmission");
			const compact = vi.spyOn(m, "handleCompactCommand").mockImplementation(async () => {
				m.loopPrompt = "replaced mid-compaction";
			});
			vi.useFakeTimers();
			void m.getUserInput();
			vi.advanceTimersByTime(800);
			await flush();
			expect(compact).toHaveBeenCalledTimes(1);
			expect(submit).not.toHaveBeenCalled();
			m.onInputCallback?.({ text: "", cancelled: true, started: false });
			// a time-limited loop whose deadline passes while compacting stops instead of submitting
			m.disableLoopMode();
			await m.sessionModes.set({
				mode: "loop",
				action: "enter",
				prompt: "timed",
				limit: { kind: "duration", durationMs: 60_000 },
			});
			const showStatus = vi.spyOn(m, "showStatus");
			compact.mockImplementation(async () => {
				vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
			});
			void m.getUserInput();
			vi.advanceTimersByTime(800);
			await flush();
			expect(showStatus).toHaveBeenCalledWith("Loop time limit reached. Loop mode disabled.");
			expect(submit).not.toHaveBeenCalled();
			expect(m.loopModeEnabled).toBe(false);
		});

		it("defers an iteration whose condition gate let a turn start, and stops when the budget cannot be spent", async () => {
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			await m.sessionModes.set({ mode: "loop", action: "enter", prompt: "poll", condition: { command: "true", until: false } });
			const submit = vi.spyOn(m, "startPendingSubmission");
			let busy = false;
			// a background job starts a turn while the gate's command runs
			const gate = vi.spyOn(loopCondition, "evaluateLoopCondition").mockImplementation(async () => {
				busy = true;
				return { kind: "continue" } as never;
			});
			Object.defineProperty(m.session, "isStreaming", { configurable: true, get: () => busy });
			try {
				vi.useFakeTimers();
				void m.getUserInput();
				vi.advanceTimersByTime(800);
				await flush();
				expect(gate).toHaveBeenCalledTimes(1);
				expect(submit).not.toHaveBeenCalled();
				// the deferred iteration retries once the turn settles; a budget that cannot be spent ends the loop
				busy = false;
				gate.mockResolvedValue({ kind: "continue" } as never);
				vi.spyOn(loopLimit, "consumeLoopLimitIteration").mockReturnValue(false);
				const showStatus = vi.spyOn(m, "showStatus");
				vi.advanceTimersByTime(800);
				await flush();
				expect(showStatus).toHaveBeenCalledWith("Loop limit reached. Loop mode disabled.");
				expect(submit).not.toHaveBeenCalled();
			} finally {
				Reflect.deleteProperty(m.session, "isStreaming");
			}
		});

		it("toggles loop mode with no arguments and reports a mode change once per session switch", async () => {
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			const switched = Promise.withResolvers<void>();
			Object.defineProperty(m.session, "isSessionTransitioning", { configurable: true, get: () => true });
			const wait = vi.spyOn(m.session, "waitForSessionTransition").mockReturnValue(switched.promise);
			try {
				await m.handleLoopCommand();
				expect(m.loopModeEnabled).toBe(true);
				await m.handleLoopCommand();
				expect(m.loopModeEnabled).toBe(false);
				// both changes wait on the one switch
				expect(wait).toHaveBeenCalledTimes(1);
			} finally {
				Reflect.deleteProperty(m.session, "isSessionTransitioning");
				switched.resolve();
			}
			await flush();
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
			let shutdownReads = 0;
			Object.defineProperty(m, "isShuttingDown", {
				configurable: true,
				get: () => {
					shutdownReads++;
					return false;
				},
			});
			// already idle past the bound: the settings listener arms a timer with no delay
			vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1500);
			cfgSessionIdleCheckpointMs.set(Settings.instance, 1000);
			await flush();
			const armed = shutdownReads;
			// the fire reads the flag, finds the draft and re-arms for a full window (a second read)
			for (let i = 0; i < 50 && shutdownReads < armed + 2; i++) await Bun.sleep(10);
			expect(shutdownReads).toBeGreaterThanOrEqual(armed + 2);
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

		it("disarms the idle checkpoint when the bound is set to zero", async () => {
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			const shutdown = vi.spyOn(m, "shutdown").mockResolvedValue(undefined as never);
			const flushSpy = vi.spyOn(m.sessionManager, "flush");
			vi.useFakeTimers();
			cfgSessionIdleCheckpointMs.set(Settings.instance, 1000);
			cfgSessionIdleCheckpointMs.set(Settings.instance, 0);
			idleFor(1500);
			vi.useRealTimers();
			await flush();
			expect(flushSpy).not.toHaveBeenCalled();
			expect(shutdown).not.toHaveBeenCalled();
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

	describe("constructor and init wiring", () => {
		const flush = async () => {
			for (let i = 0; i < 10; i++) await Promise.resolve();
		};
		const renderText = (component: { render(width: number): string[] }) => component.render(100).join("\n");

		it("routes cfg:// applied changes for this session only", async () => {
			const hostSpy = vi.spyOn(cfgProtocol, "setCfgApprovalHost");
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			const host = hostSpy.mock.calls.at(-1)?.[0];
			if (!host) throw new Error("init registered no cfg approval host");
			expect(host.persistentSettings).toBe(Settings.instance);
			const level = vi.spyOn(m.session, "setThinkingLevel");
			// another settings instance's change is not this session's to apply
			host.applied({ settings: {} as never, path: "defaultThinkingLevel", value: "high" } as never);
			expect(level).not.toHaveBeenCalled();
			host.applied({ settings: m.session.settings, path: "defaultThinkingLevel", value: "high" } as never);
			expect(level).toHaveBeenCalledWith("high");
		});

		it("persists the draft and disposes the session on a signal teardown", async () => {
			const registerSpy = vi.spyOn(postmortem, "register");
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			const teardown = registerSpy.mock.calls.find(([name]) => name === "session-teardown")?.[1];
			if (!teardown) throw new Error("init registered no session teardown");
			m.editor.setText("words worth keeping");
			const saveDraft = vi.spyOn(m.sessionManager, "saveDraft");
			const dispose = vi.spyOn(m.session, "dispose");
			await teardown("SIGTERM" as never);
			expect(saveDraft).toHaveBeenCalledWith("words worth keeping");
			expect(dispose).toHaveBeenCalledWith(expect.objectContaining({ reason: "SIGTERM" }));
		});

		it("publishes the live session file, cwd, todo descriptions and image blobs to process-global readers", async () => {
			const sourceSpy = vi.spyOn(titleGenerator, "setTerminalSessionSource");
			const todoSpy = vi.spyOn(tuiTodo, "setActiveTodoDescriptionsProvider");
			const blobSpy = vi.spyOn(imageReferences, "setImageBlobWriter");
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			const source = sourceSpy.mock.calls.at(-1)?.[0];
			expect(source?.cwd()).toBe(m.sessionManager.getCwd());
			expect(source?.file()).toBe(m.sessionManager.getSessionFile());
			expect(todoSpy.mock.calls.at(-1)?.[0]()).toEqual([]);
			const writer = blobSpy.mock.calls.at(-1)?.[0];
			const putBlob = vi.spyOn(m.sessionManager, "putBlobSync");
			writer?.(new Uint8Array([1, 2, 3]), { mimeType: "image/png" } as never);
			expect(putBlob).toHaveBeenCalledTimes(1);
		});

		it("reveals tracked downloads in the progress HUD after the reveal delay", () => {
			vi.useFakeTimers();
			const m = createMode();
			const tracker = trackDownload("weights.safetensors");
			vi.advanceTimersByTime(200);
			expect(renderText(m.progressHudContainer)).toContain("weights.safetensors");
			tracker.done();
		});

		it("retains a finished judgment batch briefly and clears it after the retain window", () => {
			vi.useFakeTimers();
			const bus = new EventBus();
			const m = createMode(bus);
			const progress = { id: "b1", intent: "grade essays", done: 2, total: 2, failed: 0, cost: 0, running: false };
			bus.emit("eval:judgment-batch-progress", progress);
			vi.advanceTimersByTime(500);
			// a repeated final snapshot restarts the retain window
			bus.emit("eval:judgment-batch-progress", progress);
			vi.advanceTimersByTime(600);
			expect(renderText(m.progressHudContainer)).toContain("grade essays");
			vi.advanceTimersByTime(500);
			expect(renderText(m.progressHudContainer)).not.toContain("grade essays");
		});

		it("drops the hover band when mouse capture turns off", async () => {
			const m = createMode();
			cfgTuiMouse.set(Settings.instance, true);
			await flush();
			const hover = vi.spyOn(m.composer, "setHoveredClickId");
			cfgTuiMouse.set(Settings.instance, false);
			await flush();
			expect(hover).toHaveBeenCalledWith(undefined);
		});

		it("warns when a prompt cannot be saved to history and survives an unavailable history store", () => {
			const errorListenerSpy = vi.spyOn(HistoryStorage.prototype, "setErrorListener");
			const m = createMode();
			const onError = errorListenerSpy.mock.calls.at(-1)?.[0];
			const showWarning = vi.spyOn(m, "showWarning").mockImplementation(() => {});
			onError?.(new Error("disk full") as never);
			expect(showWarning).toHaveBeenCalledWith(
				"Prompt history could not be saved; this prompt may be unavailable after restart.",
			);
			m.stop();
			vi.spyOn(HistoryStorage, "open").mockImplementation(() => {
				throw new Error("locked");
			});
			const noHistory = createMode();
			expect(noHistory.historyStorage).toBeUndefined();
		});

		it("routes status-line reset notices and native segment clicks", async () => {
			const noticeSpy = vi.spyOn(StatusLineComponent.prototype, "setResetExpiryNoticeHandler");
			const fireworksSpy = vi.spyOn(StatusLineComponent.prototype, "setCodexResetFireworksHandler");
			const show = vi.spyOn(CodexResetFireworksController.prototype, "show").mockReturnValue(true);
			const open = vi.spyOn(openModule, "openPath").mockImplementation(() => {});
			const m = createMode();
			const showWarning = vi.spyOn(m, "showWarning").mockImplementation(() => {});
			noticeSpy.mock.calls.at(-1)?.[0]("Codex limits reset in 5m");
			expect(showWarning).toHaveBeenCalledWith("Codex limits reset in 5m");
			const event = { kind: "reset" } as never;
			fireworksSpy.mock.calls.at(-1)?.[0](event);
			expect(show).toHaveBeenCalledWith(event);
			const modelSelector = vi.spyOn(m, "showModelSelector").mockImplementation(() => {});
			const gitUi = vi.spyOn(m, "showGitUi").mockImplementation(() => {});
			m.statusLine.onNativeAction?.("status.model");
			m.statusLine.onNativeAction?.("status.git");
			m.statusLine.onNativeAction?.("status.path");
			expect(modelSelector).toHaveBeenCalledWith({ temporaryOnly: true });
			expect(gitUi).toHaveBeenCalledTimes(1);
			expect(open).toHaveBeenCalledWith(m.sessionManager.getCwd());
		});

		it("runs native transcript actions and reports their failures", async () => {
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			const modelSelector = vi.spyOn(m, "showModelSelector").mockImplementation(() => {});
			const rewind = vi.spyOn(m, "showUserMessageSelector").mockImplementation(() => {});
			const showError = vi.spyOn(m, "showError").mockImplementation(() => {});
			const showWarning = vi.spyOn(m, "showWarning").mockImplementation(() => {});
			const showStatus = vi.spyOn(m, "showStatus").mockImplementation(() => {});
			runTranscriptAction({ act: "switch-model" });
			runTranscriptAction({ act: "rewind" });
			expect(modelSelector).toHaveBeenCalledWith({ temporaryOnly: true });
			expect(rewind).toHaveBeenCalledTimes(1);
			vi.spyOn(m, "handleResumeSession").mockRejectedValueOnce(new Error("gone")).mockRejectedValueOnce("vanished");
			runTranscriptAction({ act: "resume", path: "/x.jsonl" });
			runTranscriptAction({ act: "resume", path: "/y.jsonl" });
			vi.spyOn(clipboard, "copyToClipboard")
				.mockRejectedValueOnce(new Error("no display"))
				.mockRejectedValueOnce("denied")
				.mockResolvedValueOnce(undefined);
			runTranscriptAction({ act: "copy", text: "a" });
			runTranscriptAction({ act: "copy", text: "b" });
			runTranscriptAction({ act: "copy", text: "c" });
			await flush();
			expect(showError).toHaveBeenCalledWith("gone");
			expect(showError).toHaveBeenCalledWith("vanished");
			expect(showWarning).toHaveBeenCalledWith("Copy failed: no display");
			expect(showWarning).toHaveBeenCalledWith("Copy failed: denied");
			expect(showStatus).toHaveBeenCalledWith("Copied to clipboard");
			expect(showWarning).toHaveBeenCalledTimes(2);
		});

		it("restores a prompt the session dropped", () => {
			let dropped: ((prompt: never) => void) | undefined;
			const m = createMode(undefined, {
				beforeMode: s => {
					vi.spyOn(s, "setPromptDropped").mockImplementation(cb => {
						dropped = cb as never;
					});
				},
			});
			dropped?.({ text: "lost words", images: [] } as never);
			expect(m.editor.getText()).toContain("lost words");
		});

		it("replays the welcome intro and paints the editor gap, draft links and resize geometry", async () => {
			const m = createMode();
			const intro = vi.spyOn(m.composer, "playWelcomeIntro").mockImplementation(() => {});
			m.playWelcomeIntro();
			expect(intro).toHaveBeenCalledTimes(1);
			expect(Array.isArray(m.hookWidgetContainerAbove.render(80))).toBe(true);
			expect(await m.editor.draftImageLinkMaterializer?.([])).toEqual([]);
			const maxHeight = vi.spyOn(m.editor, "setMaxHeight");
			process.stdout.emit("resize");
			expect(maxHeight).toHaveBeenCalled();
		});

		it("shows the full startup changelog as markdown when configured", async () => {
			cfgStartupQuiet.set(Settings.instance, false);
			cfgStartupChangelogMode.set(Settings.instance, "expanded");
			const m = createMode(undefined, {
				startupChangelog: {
					markdown: "## 9.9.9\n- brand new widget",
					persistCurrentVersion: true,
					truncated: false,
					selectedEntries: 1,
					totalUnseenEntries: 1,
					latestVersion: "9.9.9",
				},
			});
			const extras = vi.spyOn(m.composer, "setHeaderExtras");
			await m.init({ suppressWelcomeIntro: true });
			const after = extras.mock.calls.at(-1)?.[1] ?? [];
			expect(after.map(component => component.render(100).join("\n")).join("\n")).toContain("brand new widget");
		});

		it("wires the stream publisher's status, chat and redaction reloads", async () => {
			let options: Parameters<typeof StreamPublisher.connectLazy>[0] | undefined;
			const setRedactor = vi.fn();
			vi.spyOn(StreamPublisher, "connectLazy").mockImplementation(async opts => {
				options = opts;
				return { setRedactor, close: () => {}, dispose: () => {} } as never;
			});
			const m = createMode();
			const showStatus = vi.spyOn(m, "showStatus").mockImplementation(() => {});
			const streamStatus = vi.spyOn(m.statusLine, "setStreamStatus");
			await m.init({ suppressWelcomeIntro: true });
			if (!options) throw new Error("init did not connect the stream publisher");
			options.onStatus?.({ state: "live" } as never);
			expect(streamStatus).toHaveBeenCalledWith({ state: "live" });
			options.onChat?.({ name: "viewer", text: "hello\nthere" } as never);
			expect(showStatus).toHaveBeenCalledWith("viewer: hello there");
			expect(await options.loadRedactor()).toBeDefined();
			cfgStreamRedactPatterns.set(Settings.instance, ["secret-\\d+"]);
			for (let i = 0; i < 50 && setRedactor.mock.calls.length === 0; i++) await Bun.sleep(5); // real fs load
			expect(setRedactor).toHaveBeenCalledTimes(1);
		});

		it("auto-starts collaboration when asked and keeps going when the draft cannot be read", async () => {
			const m = createMode();
			const autoStart = vi.spyOn(m.collabController, "autoStart").mockImplementation(() => {});
			vi.spyOn(m.sessionManager, "consumeDraft").mockRejectedValue(new Error("corrupt draft"));
			await m.init({ suppressWelcomeIntro: true, autoStartCollab: true });
			expect(autoStart).toHaveBeenCalledTimes(1);
			expect(m.isInitialized).toBe(true);
			expect(m.editor.getText()).toBe("");
		});

		it("re-arms the loop when a turn the TUI did not submit ends while input is pending", async () => {
			const m = createMode();
			const subscribe = vi.spyOn(m.session, "subscribe");
			await m.init({ suppressWelcomeIntro: true });
			await m.sessionModes.set({ mode: "loop", action: "enter", prompt: "again" });
			vi.useFakeTimers();
			const input = m.getUserInput();
			vi.advanceTimersByTime(400);
			for (const [listener] of subscribe.mock.calls) listener({ type: "agent_end", messages: [] } as never);
			// the agent_end re-armed the 800ms timer: nothing at the original deadline
			let resolved = false;
			void input.then(() => {
				resolved = true;
			});
			vi.advanceTimersByTime(400);
			await flush();
			expect(resolved).toBe(false);
			vi.advanceTimersByTime(400);
			await flush();
			expect((await input).text).toBe("again");
		});

		it("skips broken extension autocomplete factories and waits for the base provider", async () => {
			const m = createMode();
			const setProvider = vi.spyOn(m.editor, "setAutocompleteProvider");
			m.addAutocompleteProvider(current => current);
			// before init there is no base provider to wrap
			expect(setProvider).not.toHaveBeenCalled();
			await m.init({ suppressWelcomeIntro: true });
			const base = setProvider.mock.calls.at(-1)?.[0];
			m.addAutocompleteProvider(() => ({}) as never);
			m.addAutocompleteProvider(() => {
				throw new Error("factory bug");
			});
			expect(setProvider.mock.calls.at(-1)?.[0]).toBe(base);
		});

		it("reloads the title system prompt from the session cwd by default", async () => {
			const m = createMode();
			const setTitle = vi.spyOn(m.session, "setTitleSystemPrompt");
			await m.refreshTitleSystemPrompt();
			expect(setTitle).toHaveBeenCalledTimes(1);
		});
	});

	describe("init event wiring", () => {
		const flush = async () => {
			for (let i = 0; i < 20; i++) await Promise.resolve();
		};
		const renderAll = (components: ReadonlyArray<{ render(width: number): string[] }>) =>
			components.map(component => component.render(100).join("\n")).join("\n");
		const nextImmediate = () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setImmediate(resolve);
			return promise;
		};

		it("presents the idle recap delivered for the viewed session", async () => {
			const m = createMode();
			const enable = vi.spyOn(m.session, "enableIdleMaintenance");
			await m.init({ suppressWelcomeIntro: true });
			const onRecap = enable.mock.calls.at(-1)?.[0]?.onRecap;
			if (!onRecap) throw new Error("init enabled no idle maintenance recap");
			const present = vi.spyOn(m, "present").mockImplementation(() => {});
			onRecap("Refactored the parser; tests are green.");
			expect(present).toHaveBeenCalledTimes(1);
		});

		it("asks for cfg:// approval as a user wait unless ask.timeout bounds the prompt", async () => {
			const hostSpy = vi.spyOn(cfgProtocol, "setCfgApprovalHost");
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			const host = hostSpy.mock.calls.at(-1)?.[0];
			if (!host) throw new Error("init registered no cfg approval host");
			const wait = vi.spyOn(m.session, "waitForUser").mockImplementation(async run => run());
			const request = { path: "tui.mouse", previous: "true", value: "false", save: false } as never;
			// an aborted turn dismisses the prompt the user wait opened
			expect(await host.approve(request, { signal: AbortSignal.abort() })).toBe("deny");
			expect(wait).toHaveBeenCalledTimes(1);
			// a bounded prompt settles on its own, so it stays agent time; an aborted turn dismisses it
			cfgAskTimeout.set(Settings.instance, 5);
			expect(await host.approve(request, { signal: AbortSignal.abort() })).toBe("deny");
			expect(wait).toHaveBeenCalledTimes(1);
		});

		it("repaints after a resume only while subagent live previews are on", async () => {
			const onChange = vi.spyOn(agentPauseGate, "onChange");
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			const listener = onChange.mock.calls.at(-1)?.[0];
			if (!listener) throw new Error("init subscribed no pause listener");
			const render = vi.spyOn(m.ui, "requestRender");
			cfgDisplaySubagentLivePreview.set(Settings.instance, false);
			render.mockClear();
			listener(false);
			expect(render).not.toHaveBeenCalled();
			cfgDisplaySubagentLivePreview.set(Settings.instance, true);
			render.mockClear();
			listener(true);
			expect(render).not.toHaveBeenCalled();
			listener(false);
			expect(render).toHaveBeenCalled();
		});

		it("warns when the session saves to a new file after a persistence conflict", async () => {
			const m = createMode();
			const onNotice = vi.spyOn(m.sessionManager, "onPersistenceNotice");
			await m.init({ suppressWelcomeIntro: true });
			const listener = onNotice.mock.calls.at(-1)?.[0];
			if (!listener) throw new Error("init subscribed no persistence notice listener");
			const showWarning = vi.spyOn(m, "showWarning").mockImplementation(() => {});
			listener({ reason: "replaced", from: "/tmp/a.jsonl", to: "/tmp/b.jsonl" } as never);
			expect(showWarning).toHaveBeenCalledWith(expect.stringContaining("no longer reads as this session"));
		});

		it("rebuilds the config warning header when the session's warnings change", async () => {
			const m = createMode();
			const subscribe = vi.spyOn(m.session, "subscribe");
			await m.init({ suppressWelcomeIntro: true });
			Object.defineProperty(m.session, "configWarnings", { configurable: true, get: () => ["unknown key foo"] });
			try {
				const extras = vi.spyOn(m.composer, "setHeaderExtras");
				for (const [listener] of subscribe.mock.calls) listener({ type: "config_warnings_changed" } as never);
				expect(renderAll(extras.mock.calls.at(-1)?.[0] ?? [])).toContain("Warning: unknown key foo");
			} finally {
				Reflect.deleteProperty(m.session, "configWarnings");
			}
		});

		it("re-applies composer preferences on a live UI setting edit", async () => {
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			const preferences = vi.spyOn(m.composer, "setPreferences");
			cfgShowHardwareCursor.set(Settings.instance, !cfgShowHardwareCursor.get(Settings.instance));
			await flush();
			expect(preferences).toHaveBeenCalled();
		});

		/** Counts reads of `isShuttingDown`: each idle-checkpoint arm and fire reads it once. */
		function watchShutdownFlag(m: InteractiveMode): { reads: () => number; set: (on: boolean) => void } {
			let reads = 0;
			let on = false;
			Object.defineProperty(m, "isShuttingDown", {
				configurable: true,
				get: () => {
					reads++;
					return on;
				},
			});
			return { reads: () => reads, set: value => (on = value) };
		}

		it("treats terminal input as activity that postpones the idle checkpoint", async () => {
			const m = createMode();
			const addInput = vi.spyOn(m.ui, "addInputListener");
			await m.init({ suppressWelcomeIntro: true });
			const flushSpy = vi.spyOn(m.sessionManager, "flush");
			const flag = watchShutdownFlag(m);
			const start = Date.now();
			vi.spyOn(Date, "now").mockReturnValue(start + 980);
			// 20ms of the 1000ms window remain
			cfgSessionIdleCheckpointMs.set(Settings.instance, 1000);
			await flush(); // the settings listener arms asynchronously
			const armed = flag.reads();
			for (const [listener] of addInput.mock.calls) expect(listener("x" as never)).toBeUndefined();
			// the timer fires, finds the window restarted by the keypress and re-arms
			for (let i = 0; i < 50 && flag.reads() < armed + 2; i++) await Bun.sleep(10);
			expect(flag.reads()).toBeGreaterThanOrEqual(armed + 2);
			expect(flushSpy).not.toHaveBeenCalled();
		});

		it("does not checkpoint once shutdown has begun", async () => {
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			const flushSpy = vi.spyOn(m.sessionManager, "flush");
			const flag = watchShutdownFlag(m);
			vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1500);
			cfgSessionIdleCheckpointMs.set(Settings.instance, 1000);
			await flush();
			const armed = flag.reads();
			flag.set(true);
			for (let i = 0; i < 50 && flag.reads() === armed; i++) await Bun.sleep(10);
			await flush();
			expect(flag.reads()).toBeGreaterThan(armed);
			expect(flushSpy).not.toHaveBeenCalled();
		});

		it("repaints in place for theme previews and rebuilds history for a committed theme", async () => {
			const themeSpy = vi.spyOn(tuiTheme, "onThemeChange");
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			const listener = themeSpy.mock.calls.at(-1)?.[0];
			if (!listener) throw new Error("init subscribed no theme listener");
			const render = vi.spyOn(m.ui, "requestRender");
			listener({ ephemeral: true });
			expect(render).toHaveBeenLastCalledWith();
			// a preset switch since the picker was built rebuilds the slash-command icons
			const createProvider = vi.spyOn(InputController.prototype, "createAutocompleteProvider");
			const current = tuiTheme.theme.getSymbolPreset();
			vi.spyOn(tuiTheme.theme, "getSymbolPreset").mockReturnValue(current === "nerd" ? "unicode" : "nerd");
			listener({});
			expect(render).toHaveBeenLastCalledWith(true, { clearScrollback: true });
			expect(createProvider).toHaveBeenCalled();
		});

		it("upgrades the default unicode preset to nerd only on a confirmed glyph handshake", async () => {
			const m = createMode();
			let report: ((supported: boolean) => void) | undefined;
			m.ui.terminal.onGlyphProtocolReport = callback => {
				report = callback;
			};
			await m.init({ suppressWelcomeIntro: true });
			if (!report) throw new Error("init subscribed no glyph report");
			const setPreset = vi.spyOn(tuiTheme, "setSymbolPreset").mockResolvedValue(undefined);
			const preset = vi.spyOn(tuiTheme.theme, "getSymbolPreset").mockReturnValue("nerd");
			report(false);
			report(true); // already nerd
			expect(setPreset).not.toHaveBeenCalled();
			preset.mockReturnValue("unicode");
			const invalidate = vi.spyOn(m.ui, "invalidate");
			report(true);
			expect(setPreset).toHaveBeenCalledWith("nerd");
			await flush();
			expect(invalidate).toHaveBeenCalled();
			// an explicit preset choice is never overridden
			cfgSymbolPreset.set(Settings.instance, "unicode");
			report(true);
			expect(setPreset).toHaveBeenCalledTimes(1);
		});

		it("commits a Ctrl+L appearance probe's theme change only for its own timely report", async () => {
			const m = createMode();
			let report: ((mode: "dark" | "light", token?: unknown) => void) | undefined;
			let change: ((mode: "dark" | "light", token?: unknown) => void) | undefined;
			let issued: unknown;
			const terminal = m.ui.terminal as unknown as Record<string, unknown>;
			terminal.onAppearanceReport = (callback: typeof report) => {
				report = callback;
				return () => {};
			};
			terminal.onAppearanceChange = (callback: typeof change) => {
				change = callback;
			};
			terminal.refreshAppearance = (token: unknown) => {
				issued = token;
				return token;
			};
			await m.init({ suppressWelcomeIntro: true });
			if (!report || !change) throw new Error("init subscribed no appearance listeners");
			vi.spyOn(m.ui, "resetDisplay").mockImplementation(() => {});
			const apply = vi.spyOn(tuiTheme, "onTerminalAppearanceChange").mockImplementation(() => {});
			// no probe pending: reports are ignored and automatic changes stay ephemeral
			report("dark", undefined);
			change("dark", undefined);
			expect(apply).toHaveBeenLastCalledWith("dark", undefined);
			// an unchanged report for the probe consumes it on the next microtask
			m.resetDisplayAfterAppearanceRefresh();
			report("dark", Symbol("other probe"));
			report("dark", issued);
			await flush();
			change("light", issued);
			expect(apply).toHaveBeenLastCalledWith("light", undefined);
			// a changed report: the change callback commits and consumes before the microtask runs
			m.resetDisplayAfterAppearanceRefresh();
			report("dark", issued);
			change("dark", issued);
			expect(apply).toHaveBeenLastCalledWith("dark", {});
			await flush();
			// an automatic query (no token) ahead of the probe's response also commits
			m.resetDisplayAfterAppearanceRefresh();
			change("light", undefined);
			expect(apply).toHaveBeenLastCalledWith("light", {});
			// another probe's token does not, nor does any report past the deadline
			change("dark", Symbol("stale probe"));
			expect(apply).toHaveBeenLastCalledWith("dark", undefined);
			vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
			change("light", issued);
			expect(apply).toHaveBeenLastCalledWith("light", undefined);
		});

		it("redraws extension links when native rendering toggles only if links are registered", async () => {
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			const reapply = vi.spyOn(EventController.prototype, "applyAssistantTextRenderers");
			try {
				setNativeRendering(true);
				expect(reapply).not.toHaveBeenCalled();
				setNativeRendering(false);
				Object.defineProperty(m.session, "extensionRunner", {
					configurable: true,
					get: () => ({ getLinkSchemes: () => ["acme"] }),
				});
				setNativeRendering(true);
				expect(reapply).toHaveBeenCalledTimes(1);
			} finally {
				setNativeRendering(false);
				Reflect.deleteProperty(m.session, "extensionRunner");
			}
		});

		it("redraws extension links when the mouse setting changes whether they can be clicked", async () => {
			const m = createMode();
			const reapply = vi.spyOn(EventController.prototype, "applyAssistantTextRenderers");
			vi.spyOn(extensionLinks, "extensionLinkClicksAvailable").mockReturnValueOnce(false).mockReturnValueOnce(true);
			cfgTuiMouse.set(Settings.instance, !cfgTuiMouse.get(Settings.instance));
			await flush();
			expect(reapply).toHaveBeenCalledTimes(1);
			expect(m).toBeDefined();
		});

		it("routes an MCP sign-in challenge through a user wait", () => {
			let authHandler: ((serverName: string, challenge: unknown) => Promise<unknown>) | undefined;
			const mcpManager = {
				setAuthHandler: (handler: typeof authHandler) => {
					authHandler = handler;
				},
			} as unknown as MCPManager;
			const m = createMode(undefined, { mcpManager });
			const handle = vi
				.spyOn(MCPCommandController.prototype, "handleMCPAuthChallenge")
				.mockResolvedValue("signed-in" as never);
			const wait = vi.spyOn(m.session, "waitForUser").mockImplementation(async run => run());
			const challenge = { url: "https://auth.example/login" };
			return authHandler!("srv1", challenge).then(result => {
				expect(result).toBe("signed-in");
				expect(wait).toHaveBeenCalledTimes(1);
				expect(handle).toHaveBeenCalledWith("srv1", challenge);
			});
		});

		it("resolves an agent's model mention to its selector", () => {
			const m = createMode();
			const agent = { name: "reviewer" };
			Object.defineProperty(m.session, "modelMentions", {
				configurable: true,
				get: () => [
					{ agent: { name: "other" }, selector: "openai/gpt-5" },
					{ agent, selector: "anthropic/claude-opus-4-5" },
				],
			});
			try {
				expect(m.editor.modelMentionSelector(agent as never)).toBe("anthropic/claude-opus-4-5");
			} finally {
				Reflect.deleteProperty(m.session, "modelMentions");
			}
		});

		it("warms the syntax highlighter after init only for a resumed transcript", async () => {
			const warm = vi.spyOn(tuiTheme, "warmHighlighter").mockImplementation(async () => {});
			const fresh = createMode();
			await fresh.init({ suppressWelcomeIntro: true });
			await nextImmediate();
			expect(warm).not.toHaveBeenCalled();
			fresh.stop();
			await fresh.session.dispose();
			const resumed = createMode(undefined, {
				messages: [{ role: "user", content: "earlier question", timestamp: Date.now() } as AgentMessage],
			});
			await resumed.init({ suppressWelcomeIntro: true });
			await nextImmediate();
			expect(warm).toHaveBeenCalledTimes(1);
		});

		it("observes a session with no file yet and reuses a composer that is already running", async () => {
			const prepaint = createMode();
			const composer = prepaint.composer;
			const start = vi.spyOn(composer, "start");
			Object.defineProperty(composer, "started", { configurable: true, get: () => true });
			const m = new InteractiveMode(prepaint.session, "test", undefined, () => {}, undefined, undefined, undefined, composer);
			vi.spyOn(m.sessionManager, "getSessionFile").mockReturnValue(undefined as never);
			await m.init({ suppressWelcomeIntro: true });
			expect(start).not.toHaveBeenCalled();
			expect(m.isInitialized).toBe(true);
			// the prepaint mode shares this session; the harness stops it after the test
			m.stop();
		});

		it("applies only the newest stream redaction pattern load", async () => {
			const setRedactor = vi.fn();
			vi.spyOn(StreamPublisher, "connectLazy").mockResolvedValue({
				setRedactor,
				close: () => {},
				dispose: () => {},
			} as never);
			const loads = [Promise.withResolvers<never>(), Promise.withResolvers<never>()];
			const realLoad = StreamRedactor.load.bind(StreamRedactor);
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			let call = 0;
			vi.spyOn(StreamRedactor, "load").mockImplementation(() => loads[call++]!.promise);
			cfgStreamRedactPatterns.set(Settings.instance, ["first-\\d+"]);
			await flush();
			cfgStreamRedactPatterns.set(Settings.instance, ["second-\\d+"]);
			await flush();
			expect(call).toBe(2);
			const dir = harness.tempDir().path();
			const [first, second] = [await realLoad(dir, ["first-\\d+"]), await realLoad(dir, ["second-\\d+"])];
			// the newer load settles first and applies; the older one settles late and is dropped
			loads[1]!.resolve(second as never);
			await flush();
			loads[0]!.resolve(first as never);
			await flush();
			expect(setRedactor).toHaveBeenCalledTimes(1);
			expect(setRedactor).toHaveBeenCalledWith(second);
			expect(m.isInitialized).toBe(true);
		});

		it("redraws extension links when an extension is suspended or resumed", async () => {
			const runtime = new ExtensionRuntime();
			const extension = await loadExtensionFromFactory(
				() => {},
				harness.tempDir().path(),
				new EventBus(),
				runtime,
				"c2-suspendable",
			);
			let runner: ExtensionRunner | undefined;
			const m = createMode(undefined, {
				extensionRunner: (manager, registry) => {
					runner = new ExtensionRunner([extension], runtime, harness.tempDir().path(), manager, registry);
					return runner;
				},
			});
			await m.init({ suppressWelcomeIntro: true });
			const reapply = vi.spyOn(EventController.prototype, "applyAssistantTextRenderers");
			// a live `disabledExtensions` edit suspends the extension, then resumes it
			runner!.setSuspendedExtensions(() => true);
			expect(reapply).toHaveBeenCalledTimes(1);
			runner!.setSuspendedExtensions(() => false);
			expect(reapply).toHaveBeenCalledTimes(2);
		});

		it("shows an empty expanded changelog entry when the selection carries no markdown", async () => {
			cfgStartupQuiet.set(Settings.instance, false);
			cfgStartupChangelogMode.set(Settings.instance, "expanded");
			const m = createMode(undefined, {
				startupChangelog: {
					persistCurrentVersion: true,
					truncated: false,
					selectedEntries: 0,
					totalUnseenEntries: 0,
					latestVersion: "9.9.9",
				} as never,
			});
			const extras = vi.spyOn(m.composer, "setHeaderExtras");
			await m.init({ suppressWelcomeIntro: true });
			expect(extras).toHaveBeenCalled();
		});

		it("posts no MCP status line when a connecting round names no servers", () => {
			const bus = new EventBus();
			const m = createMode(bus);
			cfgStartupQuiet.set(Settings.instance, false);
			const showStatus = vi.spyOn(m, "showStatus").mockImplementation(() => {});
			bus.emit("mcp:connection-status", { type: "connecting", serverNames: [] });
			expect(showStatus).not.toHaveBeenCalled();
			bus.emit("mcp:connection-status", { type: "connecting", serverNames: ["srv1"] });
			expect(showStatus).toHaveBeenCalledTimes(1);
		});

		it("starts the macOS appearance re-probe fallback for WezTerm outside a multiplexer", async () => {
			const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
			const terminalId = Object.getOwnPropertyDescriptor(TERMINAL, "id")!;
			const reprobe = vi.spyOn(tuiTheme, "startMacOSAppearanceReprobeFallback").mockReturnValue(() => {});
			const m = createMode();
			Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
			Object.defineProperty(TERMINAL, "id", { configurable: true, value: "wezterm" });
			try {
				await m.init({ suppressWelcomeIntro: true });
			} finally {
				Object.defineProperty(process, "platform", platform);
				Object.defineProperty(TERMINAL, "id", terminalId);
			}
			expect(reprobe).toHaveBeenCalledWith(m.ui.terminal);
		});
	});

	describe("slash commands, cwd scope and checkpoint edges", () => {
		const flush = async () => {
			for (let i = 0; i < 20; i++) await Promise.resolve();
		};

		it("lists extension and custom commands in the picker and drops skill commands when disabled", async () => {
			const m = createMode();
			const metadata = vi.spyOn(m.session, "subscribeCommandMetadataChanged");
			await m.init({ suppressWelcomeIntro: true });
			const rebuild = metadata.mock.calls.at(-1)?.[0];
			if (!rebuild) throw new Error("init subscribed no command metadata listener");
			const complete = vi.fn((prefix: string, cwd: string) => [{ value: `${prefix}-${cwd}`, label: "x" }]);
			const props = {
				extensionRunner: {
					getRegisteredCommands: () => [{ name: "deploy" }, { name: "ship", description: "Ship it" }],
				},
				customCommands: [
					{ command: { name: "mcp-tool", description: "Do things", getArgumentCompletions: complete }, source: "mcp", path: "mcp:srv/tool" },
					{ command: { name: "tpl", description: "Template" }, source: "user", path: "/home/u/.omp/commands/tpl.ts" },
				],
				skillsSettings: { enableSkillCommands: false },
				skills: [{ name: "review", filePath: "/s/review/SKILL.md" }],
			};
			for (const [key, value] of Object.entries(props)) {
				Object.defineProperty(m.session, key, { configurable: true, get: () => value });
			}
			const createProvider = vi.spyOn(InputController.prototype, "createAutocompleteProvider");
			try {
				rebuild();
				const commands = createProvider.mock.calls.at(-1)?.[0] ?? [];
				const byName = new Map(commands.map(command => [command.name, command]));
				expect(byName.get("deploy")).toMatchObject({ description: "(hook command)", iconName: "extension" });
				expect(byName.get("ship")).toMatchObject({ description: "Ship it", iconName: "extension" });
				expect(byName.get("mcp-tool")).toMatchObject({ description: "Do things (mcp)", iconName: "mcp" });
				expect(byName.get("tpl")).toMatchObject({ description: "Template (user)", iconName: "prompt" });
				expect(byName.get("tpl")?.getArgumentCompletions).toBeUndefined();
				byName.get("mcp-tool")?.getArgumentCompletions?.("ar");
				expect(complete).toHaveBeenCalledWith("ar", m.sessionManager.getCwd());
				expect(commands.some(command => command.name.startsWith("skill:"))).toBe(false);
			} finally {
				for (const key of Object.keys(props)) Reflect.deleteProperty(m.session, key);
			}
		});

		it("re-scopes a cwd change without a settings layer and reports a non-Error chdir failure verbatim", async () => {
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			const showError = vi.spyOn(m, "showError").mockImplementation(() => {});
			vi.spyOn(piUtils, "setProjectDir").mockImplementationOnce(() => {
				throw "EACCES as a string";
			});
			expect(await m.applyCwdChange("/c2-chdir-refused")).toBe(false);
			expect(showError).toHaveBeenCalledWith("Cannot change working directory to /c2-chdir-refused: EACCES as a string");
			// headless embedders run without the settings singleton: every rescope path skips the reload
			vi.spyOn(settingsModule, "isSettingsInitialized").mockReturnValue(false);
			const reload = vi.spyOn(Settings.instance, "reloadForCwd");
			const refresh = vi.spyOn(m.session, "refreshSkillsAndCommands");
			const other = TempDir.createSync("@pi-c2-nosettings-");
			try {
				expect(await m.applyCwdChange(other.path())).toBe(true);
				m.sessionManager.setCwdWithoutRelocation(harness.projectDir());
				setProjectDir(harness.projectDir());
				refresh.mockRejectedValueOnce(new Error("switch broke"));
				expect(await m.applyCwdChange(other.path())).toBe(false);
				refresh.mockRejectedValueOnce(new Error("switch broke")).mockRejectedValueOnce(new Error("restore broke"));
				await expect(m.applyCwdChange(other.path())).rejects.toThrow("restore broke");
				expect(reload).not.toHaveBeenCalled();
			} finally {
				other.removeSync();
			}
		});

		it("defers the idle checkpoint when the checkpoint refuses with a non-Error", async () => {
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			const shutdown = vi.spyOn(m, "shutdown").mockResolvedValue(undefined as never);
			const flushed = Promise.withResolvers<void>();
			vi.spyOn(m.sessionManager, "flush").mockImplementation(async () => {
				flushed.resolve();
				throw "transcript store offline";
			});
			// already idle past the bound: the timer arms with no delay
			vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1500);
			cfgSessionIdleCheckpointMs.set(Settings.instance, 1000);
			await flushed.promise;
			await flush();
			expect(shutdown).not.toHaveBeenCalled();
		});

		it("collapses the editor gap under an occupied status row in the band composer", () => {
			const m = createMode();
			try {
				setEditorGapComposerShape("band");
				m.statusRowOccupied = true;
				expect(m.hookWidgetContainerAbove.render(80)).toEqual([]);
				m.statusRowOccupied = false;
				expect(m.hookWidgetContainerAbove.render(80)).toEqual([""]);
			} finally {
				setEditorGapComposerShape("box");
			}
		});

		it("repaints when an attachment chip finishes converting its preview", () => {
			const m = createMode();
			const render = vi.spyOn(m.ui, "requestRender");
			(m.editor.attachmentChips as unknown as { requestRender(): void }).requestRender();
			expect(render).toHaveBeenCalled();
		});
	});
});
