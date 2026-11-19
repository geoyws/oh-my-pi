import { afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as piTui from "@oh-my-pi/pi-tui";
import * as extensionLinks from "@oh-my-pi/pi-tui/render/extension-links";
import * as piUtils from "@oh-my-pi/pi-utils";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import * as svgFigure from "@oh-my-pi/pi-tui/chat/svg-figure";
import * as tableChart from "@oh-my-pi/pi-tui/chat/table-chart";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import * as tuiTheme from "@oh-my-pi/pi-tui/theme";
import { cfgAdvisorEnabled } from "../src/advisor/settings";
import * as autoGraphPlanner from "../src/auto-graph/planner";
import { cfgExtensionAssistantTextRenderers } from "../src/extensibility/settings";
import * as judgment from "../src/judgment";
import { ComposerPredictionController } from "../src/modes/controllers/composer-prediction-controller";
import { EventController } from "../src/modes/controllers/event-controller";
import type { InteractiveMode } from "../src/modes/interactive-mode";
import { UiHelpers } from "../src/modes/utils/ui-helpers";
import {
	cfgComposerPredictions,
	cfgComposerShape,
	cfgDisplayHideToolActivity,
	cfgDisplayPinnedAgents,
	cfgDisplayShowTurnTime,
	cfgStatusLinePreset,
	cfgStatusLineSessionAccent,
	cfgTerminalProgramStatus,
	cfgTerminalShowImages,
	cfgTuiAutoGraph,
	cfgTuiHyperlinks,
	cfgTuiRenderMermaid,
	cfgTuiRenderSvg,
	cfgTuiTextSizing,
	cfgTuiTight,
	cfgTuiTitleSpinner,
	cfgTuiTitleState,
	cfgTuiMouse,
	cfgTuiVimMode,
} from "../src/modes/settings";
import { cfgCompactionEnabled } from "../src/session/context-settings";
import { cfgExpandThinkingBlocks, cfgHideThinkingBlock, cfgProseOnlyThinking } from "../src/session/settings";
import { cfgGoalEnabled } from "../src/goals/settings";
import * as runStatus from "../src/utils/run-status";
import * as titleGenerator from "../src/utils/title-generator";
import { useConstructedInteractiveMode } from "./helpers/constructed-interactive-mode";

/** A finished read call and its result: replay renders an assistant reply plus one tool block. */
const readTurn = (): AgentMessage[] =>
	[
		{ role: "user", content: [{ type: "text", text: "read it" }], timestamp: 1 },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "looking" },
				{ type: "toolCall", id: "call-1", name: "read", arguments: {} },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 3,
		},
	] as never;

/** Changes a setting and lets its coalesced listener (one microtask later) apply it. */
async function change<T>(setting: { set(settings: Settings, value: T): unknown }, value: T): Promise<void> {
	setting.set(Settings.instance, value);
	await Promise.resolve();
}

describe("InteractiveMode constructed surface (C3)", () => {
	const harness = useConstructedInteractiveMode("@pi-c3-range-");
	const { createMode } = harness;

	/** Seeds `transcript` as session entries and renders it the way startup does after init. */
	async function initialized(transcript: AgentMessage[] = []) {
		const m = createMode(undefined, {
			beforeMode: session => {
				for (const message of transcript) session.sessionManager.appendMessage(message as never);
			},
		});
		await m.init({ suppressWelcomeIntro: true });
		if (transcript.length > 0) await m.renderInitialMessages();
		return m;
	}

	/** Gives the session a fake extension runner registering `schemes`; returns its link-activate spy. */
	function fakeLinkRunner(m: InteractiveMode, schemes: () => string[], uiContext: unknown = { ui: "main" }) {
		const emitLinkActivate = vi.fn(async (_url: string, _ctx: unknown) => {});
		Object.defineProperty(m.session, "extensionRunner", {
			configurable: true,
			get: () => ({
				getLinkSchemes: schemes,
				followSuspension: () => {},
				emitLinkActivate,
				getUIContext: () => uiContext,
			}),
		});
		return emitLinkActivate;
	}

	describe("extension links and link hints", () => {
		afterEach(() => {
			// the scheme registry is process-wide
			extensionLinks.setExtensionLinks([]);
		});

		it("rebuilds the transcript once, after the first replay, when the registered link schemes change", async () => {
			const m = await initialized(readTurn());
			let schemes = ["acme"];
			fakeLinkRunner(m, () => schemes);
			const rebuild = vi.spyOn(m, "rebuildChatFromMessages");
			const resetDisplay = vi.spyOn(m.ui, "resetDisplay");
			m.syncExtensionLinks();
			// unchanged schemes do nothing; a second change before the microtask coalesces
			m.syncExtensionLinks();
			schemes = ["acme", "beta"];
			m.syncExtensionLinks();
			expect(extensionLinks.extensionLinksRouted()).toBe(true);
			expect(rebuild).not.toHaveBeenCalled();
			// the queued rebuild renders through the session's real runner
			Reflect.deleteProperty(m.session, "extensionRunner");
			await Promise.resolve();
			expect(rebuild).toHaveBeenCalledTimes(1);
			expect(resetDisplay).toHaveBeenCalledTimes(1);
		});

		it("drops a queued link redraw that a rebuild already covered", async () => {
			const m = await initialized(readTurn());
			fakeLinkRunner(m, () => ["acme"]);
			const resetDisplay = vi.spyOn(m.ui, "resetDisplay");
			m.syncExtensionLinks();
			Reflect.deleteProperty(m.session, "extensionRunner");
			m.rebuildChatFromMessages();
			const rebuild = vi.spyOn(m, "rebuildChatFromMessages");
			await Promise.resolve();
			expect(rebuild).not.toHaveBeenCalled();
			expect(resetDisplay).not.toHaveBeenCalled();
		});

		it("leaves the redraw to a transcript replay still in flight", async () => {
			const m = await initialized(readTurn());
			fakeLinkRunner(m, () => ["acme"]);
			const restart = vi.spyOn(UiHelpers.prototype, "restartTranscriptReplay").mockReturnValue(true);
			const rebuild = vi.spyOn(m, "rebuildChatFromMessages");
			m.syncExtensionLinks();
			await Promise.resolve();
			expect(restart).toHaveBeenCalledTimes(1);
			expect(rebuild).not.toHaveBeenCalled();
		});

		it("offers link clicks while mouse capture is on, else only with a bound hint key", async () => {
			cfgTuiMouse.set(Settings.instance, true);
			const withMouse = createMode();
			extensionLinks.setExtensionLinks(["acme"]);
			expect(extensionLinks.extensionLinkClicksAvailable()).toBe(true);
			withMouse.stop();
			cfgTuiMouse.set(Settings.instance, false);
			const m = createMode();
			// stop() released the schemes along with the picker
			extensionLinks.setExtensionLinks(["acme"]);
			const hintKeyBound = m.keybindings.getKeys("app.links.hint").length > 0;
			expect(extensionLinks.extensionLinkClicksAvailable()).toBe(hintKeyBound);
		});

		it("activates a viewport link through the viewed session's runner with the main UI", async () => {
			const m = await initialized();
			const uiContext = { ui: "main" };
			const emit = fakeLinkRunner(m, () => ["acme"], uiContext);
			vi.spyOn(m.composer, "viewportLinkAt")
				.mockReturnValueOnce({ url: "acme://open/1" } as never)
				.mockReturnValueOnce(undefined as never);
			expect(m.activateViewportLink(0, 4)).toBe(true);
			expect(emit).toHaveBeenCalledWith("acme://open/1", uiContext);
			// no link under the cursor
			expect(m.activateViewportLink(1, 4)).toBe(false);
			expect(emit).toHaveBeenCalledTimes(1);
		});

		it("refuses link activation without an extension runner and logs a failed dispatch", async () => {
			const m = await initialized();
			vi.spyOn(m.composer, "viewportLinkAt").mockReturnValue({ url: "acme://open/1" } as never);
			expect(m.activateViewportLink(0, 0)).toBe(false);
			const emit = fakeLinkRunner(m, () => ["acme"]);
			emit.mockRejectedValueOnce(new Error("handler threw"));
			const warn = vi.spyOn(piUtils.logger, "warn");
			expect(m.activateViewportLink(0, 0)).toBe(true);
			await Promise.resolve();
			await Promise.resolve();
			expect(warn).toHaveBeenCalledWith("link_activate dispatch failed", {
				url: "acme://open/1",
				error: "Error: handler threw",
			});
		});

		it("starts link hints only for routed links on screen and reports a crowded row after the frame", async () => {
			const m = await initialized();
			const start = vi.spyOn(m.composer, "startLinkHints").mockImplementation(() => {});
			const showStatus = vi.spyOn(m, "showStatus").mockImplementation(() => {});
			const hookStatus = vi.spyOn(m.statusLine, "setHookStatus");
			// no registered scheme: the key falls through
			expect(m.startLinkHints()).toBe(false);
			extensionLinks.setExtensionLinks(["acme"]);
			const count = vi.spyOn(m.composer, "viewportLinkCount").mockReturnValue(0);
			expect(m.startLinkHints()).toBe(true);
			expect(showStatus).toHaveBeenLastCalledWith("No extension links on screen");
			expect(start).not.toHaveBeenCalled();
			count.mockReturnValue(2);
			expect(m.startLinkHints()).toBe(true);
			const hintKey = hookStatus.mock.calls.at(-1)?.[0];
			expect(hookStatus).toHaveBeenLastCalledWith(hintKey, "Type a link tag · Esc cancels");
			const onEnd = start.mock.calls[0]![0] as (reason: string) => void;
			showStatus.mockClear();
			onEnd("picked");
			expect(hookStatus).toHaveBeenLastCalledWith(hintKey, undefined);
			await Promise.resolve();
			expect(showStatus).not.toHaveBeenCalled();
			onEnd("crowded");
			expect(showStatus).not.toHaveBeenCalled();
			await Promise.resolve();
			expect(showStatus).toHaveBeenCalledWith("Too many extension links on one row to tag; widen the terminal");
		});

		it("activates the link a typed hint tag picks, and forwards cancel", async () => {
			const m = await initialized();
			const emit = fakeLinkRunner(m, () => ["acme"]);
			vi.spyOn(m.composer, "typeLinkHint")
				.mockReturnValueOnce(true)
				.mockReturnValueOnce({ url: "acme://pick" } as never);
			// a partial tag keeps waiting
			m.typeLinkHint("a");
			expect(emit).not.toHaveBeenCalled();
			m.typeLinkHint("s");
			expect(emit).toHaveBeenCalledWith("acme://pick", { ui: "main" });
			const cancel = vi.spyOn(m.composer, "cancelLinkHints");
			m.cancelLinkHints();
			expect(cancel).toHaveBeenCalledTimes(1);
		});
	});

	describe("session-mode transition gates (sessionModes.set)", () => {
		it("disables a paused plan on exit and refuses plan entry while vibe holds", async () => {
			const m = await initialized();
			m.planModePaused = true;
			const exited = await m.sessionModes.set({ mode: "plan", action: "exit" });
			expect(exited).toMatchObject({ ok: true, changed: true });
			expect(m.planModePaused).toBe(false);
			m.vibeModeEnabled = true;
			expect(await m.sessionModes.set({ mode: "plan", action: "enter" })).toMatchObject({
				ok: false,
				code: "conflict",
				message: "Exit vibe mode first.",
			});
		});

		it("enters and exits vibe mode, treating a repeat enter as unchanged", async () => {
			const vibeTool: AgentTool = {
				name: "vibe_spawn",
				label: "vibe_spawn",
				description: "Fake vibe spawn",
				parameters: type({}),
				async execute() {
					return { content: [{ type: "text" as const, text: "spawned" }] };
				},
			};
			const m = createMode(undefined, { createVibeTools: () => [vibeTool] });
			await m.init({ suppressWelcomeIntro: true });
			const entered = await m.sessionModes.set({ mode: "vibe", action: "enter" });
			expect(entered).toMatchObject({ ok: true, changed: true });
			expect(m.vibeModeEnabled).toBe(true);
			expect(m.session.getActiveToolNames()).toContain("vibe_spawn");
			expect(await m.sessionModes.set({ mode: "vibe", action: "enter" })).toMatchObject({ ok: true, changed: false });
			const exited = await m.sessionModes.set({ mode: "vibe", action: "exit" });
			expect(exited).toMatchObject({ ok: true, changed: true });
			expect(m.vibeModeEnabled).toBe(false);
		});

		it("refuses vibe entry while plan or goal holds, and goal entry while vibe holds", async () => {
			const m = await initialized();
			m.planModePaused = true;
			expect(await m.sessionModes.set({ mode: "vibe", action: "enter" })).toMatchObject({
				code: "conflict",
				message: "Exit plan mode first.",
			});
			m.planModePaused = false;
			m.goalModePaused = true;
			expect(await m.sessionModes.set({ mode: "vibe", action: "enter" })).toMatchObject({
				code: "conflict",
				message: "Exit goal mode first.",
			});
			m.goalModePaused = false;
			m.vibeModeEnabled = true;
			expect(await m.sessionModes.set({ mode: "goal", action: "enter", objective: "ship" })).toMatchObject({
				code: "conflict",
				message: "Exit vibe mode first.",
			});
			expect(m.goalModeEnabled).toBe(false);
		});

		it("refuses resuming a paused goal while goal mode is disabled in settings", async () => {
			const m = await initialized();
			vi.spyOn(m.session, "getGoalModeState").mockReturnValue({
				enabled: false,
				goal: { objective: "parked", status: "paused" },
			} as never);
			await change(cfgGoalEnabled, false);
			expect(await m.sessionModes.set({ mode: "goal", action: "resume" })).toMatchObject({
				ok: false,
				code: "disabled",
				message: "Goal mode is disabled in settings (goal.enabled).",
			});
		});

		it("rejects a non-string goal objective and unknown goal, loop or vibe actions", async () => {
			const m = await initialized();
			const cases: Array<[unknown, string]> = [
				[{ mode: "goal", action: "enter", objective: 42 }, "non-empty string"],
				[{ mode: "goal", action: "stretch" }, "Unknown mode"],
				[{ mode: "loop", action: "stretch" }, "Unknown mode"],
				[{ mode: "vibe", action: "stretch" }, "Unknown mode"],
			];
			for (const [request, message] of cases) {
				const result = await m.sessionModes.set(request as never);
				expect(result).toMatchObject({ ok: false, code: "invalid_request" });
				expect(result.ok ? "" : result.message).toContain(message);
			}
		});
	});

	describe("live UI setting changes", () => {
		it("rebuilds the transcript once for render-time display options and retires committed rows", async () => {
			const m = await initialized();
			const rebuild = vi.spyOn(m, "rebuildChatFromMessages");
			const resetDisplay = vi.spyOn(m.ui, "resetDisplay");
			const mermaid = vi.spyOn(tuiTheme, "setMarkdownMermaidRendering");
			const svg = vi.spyOn(svgFigure, "setSvgFigureRendering");
			await change(cfgDisplayShowTurnTime, true);
			expect(rebuild).toHaveBeenCalledTimes(1);
			expect(resetDisplay).toHaveBeenCalledTimes(1);
			await change(cfgTuiRenderMermaid, !cfgTuiRenderMermaid.get(Settings.instance));
			expect(mermaid).toHaveBeenLastCalledWith(cfgTuiRenderMermaid.get(Settings.instance));
			await change(cfgTuiRenderSvg, !cfgTuiRenderSvg.get(Settings.instance));
			expect(svg).toHaveBeenLastCalledWith(cfgTuiRenderSvg.get(Settings.instance));
			expect(rebuild).toHaveBeenCalledTimes(3);
			expect(resetDisplay).toHaveBeenCalledTimes(3);
		});

		it("hands extension assistant-text renderers to the live reply and rebuilds", async () => {
			const m = await initialized();
			const apply = vi.spyOn(EventController.prototype, "applyAssistantTextRenderers");
			const rebuild = vi.spyOn(m, "rebuildChatFromMessages");
			await change(cfgExtensionAssistantTextRenderers, true);
			expect(apply).toHaveBeenCalledTimes(1);
			expect(rebuild).toHaveBeenCalledTimes(1);
		});

		it("routes table charts per tui.autoGraph, consulting the judge only when allowed", async () => {
			const m = await initialized();
			const setCharts = vi.spyOn(tableChart, "setTableCharts");
			const pick = vi.spyOn(autoGraphPlanner, "pickTableChart").mockReturnValue("picked" as never);
			const nativeJudge = vi.spyOn(judgment, "hasNativeJudge").mockReturnValue(false);
			await change(cfgTuiAutoGraph, "off");
			expect(setCharts).toHaveBeenLastCalledWith("off");
			await change(cfgTuiAutoGraph, "always");
			expect(setCharts).toHaveBeenLastCalledWith("always");
			const request = { rows: [] } as never;
			await change(cfgTuiAutoGraph, "smart");
			const smart = setCharts.mock.calls.at(-1) as unknown as [string, (request: never) => unknown];
			expect(smart[0]).toBe("smart");
			// smart always asks the judge
			expect(smart[1](request)).toBe("picked");
			await change(cfgTuiAutoGraph, "auto");
			const auto = setCharts.mock.calls.at(-1) as unknown as [string, (request: never) => unknown];
			// auto falls back to the local guess without a native judge, and asks once one resolves
			expect(auto[1](request)).toBeUndefined();
			nativeJudge.mockReturnValue(true);
			expect(auto[1](request)).toBe("picked");
			expect(pick).toHaveBeenCalledTimes(2);
			expect(m.isInitialized).toBe(true);
		});

		it("applies text sizing only where the terminal supports it and resets the display without a rebuild", async () => {
			const m = await initialized();
			const sizing = vi.spyOn(piTui, "setTerminalTextSizing");
			const rebuild = vi.spyOn(m, "rebuildChatFromMessages");
			const resetDisplay = vi.spyOn(m.ui, "resetDisplay");
			await change(cfgTuiTextSizing, true);
			expect(sizing).toHaveBeenLastCalledWith(piTui.TERMINAL.supportsTextSizing);
			expect(rebuild).not.toHaveBeenCalled();
			expect(resetDisplay).toHaveBeenCalledTimes(1);
		});

		it("repaints in place for tight layout, hyperlinks and advisor changes", async () => {
			const m = await initialized();
			const tight = vi.spyOn(piTui, "setTuiTight");
			const invalidateStatus = vi.spyOn(m.statusLine, "invalidate");
			const resetDisplay = vi.spyOn(m.ui, "resetDisplay");
			await change(cfgTuiTight, true);
			expect(tight).toHaveBeenLastCalledWith(true);
			await change(cfgTuiHyperlinks, "off");
			expect(invalidateStatus).toHaveBeenCalledTimes(1);
			await change(cfgAdvisorEnabled, true);
			expect(invalidateStatus).toHaveBeenCalledTimes(2);
			expect(resetDisplay).not.toHaveBeenCalled();
		});

		it("forwards terminal title and program-status preferences", async () => {
			await initialized();
			const titleState = vi.spyOn(titleGenerator, "setTerminalTitleStateEnabled");
			const spinner = vi.spyOn(titleGenerator, "setTerminalTitleSpinnerStyle");
			const programStatus = vi.spyOn(runStatus, "setProgramStatusEnabled");
			await change(cfgTuiTitleState, false);
			await change(cfgTuiTitleSpinner, "dots");
			await change(cfgTerminalProgramStatus, false);
			expect(titleState).toHaveBeenLastCalledWith(false);
			expect(spinner).toHaveBeenLastCalledWith("dots");
			expect(programStatus).toHaveBeenLastCalledWith(false);
		});

		it("pushes status-line layout changes to the status line", async () => {
			const m = await initialized();
			const update = vi.spyOn(m.statusLine, "updateSettings");
			await change(cfgStatusLinePreset, "minimal");
			expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ preset: "minimal" }));
			await change(cfgStatusLineSessionAccent, false);
			expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ sessionAccent: false }));
		});

		it("re-syncs the composer shape, vim mode and pinned agents, and cancels predictions only when turned off", async () => {
			const m = await initialized();
			const shape = vi.spyOn(m, "syncComposerShape");
			const pinned = vi.spyOn(m, "applyPinnedAgentsSetting");
			const cancel = vi.spyOn(ComposerPredictionController.prototype, "cancel");
			await change(cfgComposerShape, "boxed");
			expect(shape).toHaveBeenCalledTimes(1);
			await change(cfgDisplayPinnedAgents, "off");
			expect(pinned).toHaveBeenCalledTimes(1);
			await change(cfgTuiVimMode, true);
			// vim mode starts in insert
			expect(m.editor.vimMode).toBe("insert");
			await change(cfgComposerPredictions, true);
			expect(cancel).not.toHaveBeenCalled();
			await change(cfgComposerPredictions, false);
			expect(cancel).toHaveBeenCalledTimes(1);
		});

		it("tells the status line when auto-compaction turns off", async () => {
			const m = await initialized();
			const autoCompact = vi.spyOn(m.statusLine, "setAutoCompactEnabled");
			await change(cfgCompactionEnabled, false);
			expect(autoCompact).toHaveBeenLastCalledWith(m.session.autoCompactionEnabled);
			expect(m.session.autoCompactionEnabled).toBe(false);
		});

		it("hides tool activity across the transcript and restores it collapsed", async () => {
			const m = await initialized(readTurn());
			const tools = m.chatContainer.children.filter(child => child instanceof ToolExecutionComponent);
			const replies = m.chatContainer.children.filter(child => child instanceof AssistantMessageComponent);
			expect(tools).toHaveLength(1);
			expect(replies).toHaveLength(1);
			const expand = vi.spyOn(tools[0] as ToolExecutionComponent, "setExpanded");
			const resultImages = vi.spyOn(replies[0] as AssistantMessageComponent, "setToolResultImagesVisible");
			const clearImages = vi.spyOn(m.ui, "clearInlineImages");
			const resetDisplay = vi.spyOn(m.ui, "resetDisplay");
			await change(cfgDisplayHideToolActivity, true);
			expect(m.hideToolActivity).toBe(true);
			expect(resultImages).toHaveBeenLastCalledWith(false);
			expect(clearImages).toHaveBeenCalledTimes(1);
			expect(resetDisplay).toHaveBeenCalledTimes(1);
			m.toolOutputExpanded = true;
			await change(cfgDisplayHideToolActivity, false);
			expect(m.toolOutputExpanded).toBe(false);
			expect(expand).toHaveBeenLastCalledWith(false);
			expect(clearImages).toHaveBeenCalledTimes(1);
			expect(resetDisplay).toHaveBeenCalledTimes(2);
		});

		it("skips tool-activity effects a keybinding toggle already applied", async () => {
			const m = await initialized(readTurn());
			const resetDisplay = vi.spyOn(m.ui, "resetDisplay");
			m.hideToolActivity = true;
			await change(cfgDisplayHideToolActivity, true);
			expect(resetDisplay).not.toHaveBeenCalled();
		});

		it("shows or hides images on every tool block and reply", async () => {
			const m = await initialized(readTurn());
			const tool = m.chatContainer.children.find(child => child instanceof ToolExecutionComponent) as ToolExecutionComponent;
			const reply = m.chatContainer.children.find(
				child => child instanceof AssistantMessageComponent,
			) as AssistantMessageComponent;
			const toolImages = vi.spyOn(tool, "setShowImages");
			const replyImages = vi.spyOn(reply, "setImagesVisible");
			const clearImages = vi.spyOn(m.ui, "clearInlineImages");
			await change(cfgTerminalShowImages, false);
			expect(toolImages).toHaveBeenLastCalledWith(false);
			expect(replyImages).toHaveBeenLastCalledWith(false);
			expect(clearImages).toHaveBeenCalledTimes(1);
			await change(cfgTerminalShowImages, true);
			expect(toolImages).toHaveBeenLastCalledWith(true);
			expect(clearImages).toHaveBeenCalledTimes(1);
		});

		it("applies thinking-block visibility, prose-only and expansion to every reply", async () => {
			const m = await initialized(readTurn());
			const reply = m.chatContainer.children.find(
				child => child instanceof AssistantMessageComponent,
			) as AssistantMessageComponent;
			const hide = vi.spyOn(reply, "setHideThinkingBlock");
			const prose = vi.spyOn(reply, "setProseOnlyThinking");
			const expandThinking = vi.spyOn(reply, "setExpandThinkingBlocks");
			await change(cfgHideThinkingBlock, !m.hideThinkingBlock);
			expect(hide).toHaveBeenLastCalledWith(m.effectiveHideThinkingBlock);
			await change(cfgProseOnlyThinking, !m.proseOnlyThinking);
			expect(prose).toHaveBeenLastCalledWith(m.proseOnlyThinking);
			await change(cfgExpandThinkingBlocks, !m.expandThinkingBlocks);
			expect(expandThinking).toHaveBeenLastCalledWith(m.expandThinkingBlocks);
			// a value the mode already holds (a keybinding toggle) is not re-applied
			hide.mockClear();
			m.hideThinkingBlock = !m.hideThinkingBlock;
			await change(cfgHideThinkingBlock, m.hideThinkingBlock);
			expect(hide).not.toHaveBeenCalled();
		});
	});
});
