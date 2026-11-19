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
import * as composerCache from "@oh-my-pi/pi-tui/prompt/composer-cache";
import * as tuiTheme from "@oh-my-pi/pi-tui/theme";
import { cfgAdvisorEnabled } from "../src/advisor/settings";
import * as autoGraphPlanner from "../src/auto-graph/planner";
import { cfgExtensionAssistantTextRenderers } from "../src/extensibility/settings";
import * as judgment from "../src/judgment";
import { ComposerPredictionController } from "../src/modes/controllers/composer-prediction-controller";
import { EventController } from "../src/modes/controllers/event-controller";
import { InteractiveMode } from "../src/modes/interactive-mode";
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
import { AgentRegistry, MAIN_AGENT_ID } from "../src/registry/agent-registry";
import * as persistedAgents from "../src/registry/persisted-agents";
import { STTController } from "../src/stt";
import { cfgSttEnabled } from "../src/stt/settings";
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

	describe("local and optimistic submissions", () => {
		it("records a local submission's signature once and never for a known slash command", () => {
			const m = createMode();
			const dispose = m.recordLocalSubmission("hello there");
			expect(m.locallySubmittedUserSignatures.has("hello there\u00000")).toBe(true);
			dispose();
			expect(m.locallySubmittedUserSignatures.has("hello there\u00000")).toBe(false);
			// a second dispose cannot remove a later submission of the same text
			m.recordLocalSubmission("hello there");
			dispose();
			expect(m.locallySubmittedUserSignatures.has("hello there\u00000")).toBe(true);
			vi.spyOn(m, "isKnownSlashCommand").mockReturnValue(true);
			const before = new Set(m.locallySubmittedUserSignatures);
			m.recordLocalSubmission("/model")();
			expect(m.locallySubmittedUserSignatures).toEqual(before);
		});

		it("drops a local submission's signature when its dispatch throws", async () => {
			const m = createMode();
			await expect(
				m.withLocalSubmission("doomed", async () => {
					expect(m.locallySubmittedUserSignatures.has("doomed\u00000")).toBe(true);
					throw new Error("dispatch failed");
				}),
			).rejects.toThrow("dispatch failed");
			expect(m.locallySubmittedUserSignatures.has("doomed\u00000")).toBe(false);
		});

		it("swaps the optimistic user row for the canonical message", async () => {
			const m = await initialized();
			m.startPendingSubmission({ text: "draft question" });
			const optimistic = [...m.chatContainer.children];
			expect(optimistic.length).toBeGreaterThan(0);
			expect(m.optimisticUserMessageSignature).toBe("draft question\u00000");
			m.replaceOptimisticUserMessage({
				role: "user",
				content: [{ type: "text", text: "draft question" }],
				timestamp: Date.now(),
			} as never);
			expect(m.optimisticUserMessageSignature).toBeUndefined();
			expect(m.locallySubmittedUserSignatures.has("draft question\u00000")).toBe(false);
			for (const row of optimistic) expect(m.chatContainer.children).not.toContain(row);
			expect(m.chatContainer.children.length).toBe(optimistic.length);
		});

		it("adopts an optimistic row that already retired to scrollback, and drops one a dispatch abandons", async () => {
			const m = await initialized();
			const row = { role: "user", content: [{ type: "text", text: "/skill:x" }], timestamp: 1 } as never;
			m.renderOptimisticSkillMessage(row);
			const rendered = [...m.chatContainer.children];
			expect(m.optimisticSkillMessagePending).toBe(true);
			vi.spyOn(m.chatContainer, "canRemoveBlock").mockReturnValue(false);
			const add = vi.spyOn(m, "addMessageToChat");
			m.reconcileOptimisticSkillMessage(row);
			// retired rows stay where they are and no duplicate is appended
			expect(add).not.toHaveBeenCalled();
			expect(m.chatContainer.children).toEqual(rendered);
			m.renderOptimisticSkillMessage(row);
			const second = m.chatContainer.children.slice(rendered.length);
			expect(second.length).toBeGreaterThan(0);
			m.clearOptimisticSkillMessage();
			expect(m.optimisticSkillMessagePending).toBe(false);
			for (const component of second) expect(m.chatContainer.children).not.toContain(component);
		});

		it("cancels a goal continuation without restoring a draft, releasing its reserved turn", async () => {
			const m = await initialized();
			const sync = vi.spyOn(m, "syncIdleMaintenanceView");
			m.startPendingSubmission({ text: "continue the goal", customType: "goal-continuation" });
			sync.mockClear();
			m.editor.setText("typed meanwhile");
			expect(m.cancelPendingSubmission()).toBe(true);
			expect(sync).toHaveBeenCalled();
			expect(m.editor.getText()).toBe("typed meanwhile");
		});

		it("puts a cancelled prompt back ahead of text typed since", async () => {
			const m = await initialized();
			m.startPendingSubmission({ text: "first thought" });
			m.editor.setText("second thought");
			expect(m.cancelPendingSubmission()).toBe(true);
			expect(m.editor.getExpandedText()).toBe("first thought\nsecond thought");
			// nothing pending any more
			expect(m.cancelPendingSubmission()).toBe(false);
		});

		it("hands a refused prompt back ahead of the newer draft and stops the working row", async () => {
			const m = await initialized();
			m.startPendingSubmission({ text: "refused text" });
			expect(m.loadingAnimation).toBeDefined();
			m.editor.setText("newer");
			m.restoreRefusedPrompt({ text: "refused text" } as never);
			expect(m.loadingAnimation).toBeUndefined();
			expect(m.optimisticUserMessageSignature).toBeUndefined();
			expect(m.editor.getExpandedText()).toBe("refused text\nnewer");
			// without a working row the refusal still restores
			m.editor.setText("");
			m.restoreRefusedPrompt({ text: "again" } as never);
			expect(m.editor.getExpandedText()).toBe("again");
		});

		it("restores a dropped prompt with its reason, never clobbering a newer draft or tray", () => {
			let dropped: ((prompt: never) => void) | undefined;
			const m = createMode(undefined, {
				beforeMode: session => {
					vi.spyOn(session, "setPromptDropped").mockImplementation(callback => {
						dropped = callback as never;
					});
				},
			});
			const showError = vi.spyOn(m, "showError").mockImplementation(() => {});
			m.startPendingSubmission({ text: "dropped words" });
			expect(m.loadingAnimation).toBeDefined();
			dropped!({ text: "dropped words", reason: "Usage limit reached" } as never);
			expect(m.loadingAnimation).toBeUndefined();
			expect(showError).toHaveBeenCalledWith("Usage limit reached");
			expect(m.editor.getText()).toBe("dropped words");
			expect(m.editor.pendingImages).toEqual([]);
			// a draft typed since stays put
			m.editor.setText("newer draft");
			dropped!({ text: "older words" } as never);
			expect(m.editor.getText()).toBe("newer draft");
			// an attachment added since is kept; the text still comes back
			const kept = { type: "image", data: "aGk=", mimeType: "image/png" } as never;
			m.editor.setText("");
			m.editor.pendingImages = [kept];
			dropped!({ text: "with images", images: [{ type: "image", data: "eA==", mimeType: "image/png" }] } as never);
			expect(m.editor.pendingImages).toEqual([kept]);
			expect(m.editor.getText()).toBe("with images");
		});

		it("starts only the pending, uncancelled submission", async () => {
			const m = await initialized();
			const pending = m.startPendingSubmission({ text: "go" });
			expect(m.markPendingSubmissionStarted({ ...pending })).toBe(false);
			expect(m.markPendingSubmissionStarted(pending)).toBe(true);
			expect(pending.started).toBe(true);
			const cancelled = m.startPendingSubmission({ text: "stop" });
			cancelled.cancelled = true;
			expect(m.markPendingSubmissionStarted(cancelled)).toBe(false);
		});

		it("finishes a submission: releasing a refused continuation, keeping a streaming or async-waiting row", async () => {
			const m = await initialized();
			const sync = vi.spyOn(m, "syncIdleMaintenanceView");
			const continuation = m.startPendingSubmission({ text: "next step", customType: "goal-continuation" });
			continuation.started = true;
			sync.mockClear();
			m.finishPendingSubmission(continuation);
			// a started continuation that never dispatched gives back its turn
			expect(sync).toHaveBeenCalled();
			// finishing a submission that is no longer pending leaves the current one alone
			const current = m.startPendingSubmission({ text: "current" });
			m.finishPendingSubmission(continuation);
			expect(m.optimisticUserMessageSignature).toBe("current\u00000");
			// while the session streams, the optimistic row and working row stay
			Object.defineProperty(m.session, "isStreaming", { configurable: true, get: () => true });
			m.finishPendingSubmission(current);
			expect(m.optimisticUserMessageSignature).toBe("current\u00000");
			Reflect.deleteProperty(m.session, "isStreaming");
			// a run waiting only on background jobs keeps its working row
			vi.spyOn(EventController.prototype, "isAwaitingAsyncWork").mockReturnValue(true);
			const waiting = m.startPendingSubmission({ text: "waits on jobs" });
			m.finishPendingSubmission(waiting);
			expect(m.optimisticUserMessageSignature).toBeUndefined();
			expect(m.loadingAnimation).toBeDefined();
		});
	});

	describe("rebuilding the transcript", () => {
		const toolResult = (toolCallId: string, details?: unknown) =>
			({ role: "toolResult", toolCallId, toolName: "read", content: [], isError: false, details, timestamp: 1 }) as never;

		it("keeps in-flight rows across a streaming rebuild, handing settled results to the replay", async () => {
			const m = await initialized();
			const row = (label: string) => new piTui.Text(label, 0, 0);
			const [streaming, segment, reply, offscreen, done, background, shared, live, stale] = [
				"streaming",
				"segment",
				"reply",
				"offscreen",
				"done",
				"background",
				"shared",
				"live",
				"stale",
			].map(row);
			m.chatContainer.clear();
			for (const child of [stale, done, streaming, background, segment, shared, reply, live]) m.chatContainer.addChild(child);
			m.streamingComponent = streaming as never;
			vi.spyOn(EventController.prototype, "liveAssistantSegments").mockReturnValue([segment, offscreen] as never);
			vi.spyOn(EventController.prototype, "liveToolReplies").mockReturnValue([reply] as never);
			m.pendingTools.clear();
			m.pendingTools.set("done", done as never);
			m.pendingTools.set("bg", background as never);
			m.pendingTools.set("r1", shared as never);
			m.pendingTools.set("r2", shared as never);
			m.pendingTools.set("live", live as never);
			Object.defineProperty(m.session, "isStreaming", { configurable: true, get: () => true });
			const kept = { role: "user", content: [], timestamp: 1 } as never;
			const dropped = { role: "user", content: [], timestamp: 2 } as never;
			m.transcriptMessageComponents.set(kept, row("kept"));
			m.transcriptMessageComponents.set(dropped, row("dropped"));
			const context = {
				messages: [
					kept,
					toolResult("unrelated"),
					toolResult("done", { async: { state: "completed" } }),
					toolResult("bg", { async: { state: "running" } }),
					toolResult("r1"),
				],
			};
			vi.spyOn(m.session, "buildTranscriptSessionContext").mockReturnValue(context as never);
			const render = vi.spyOn(m, "renderSessionContext").mockImplementation(() => {
				m.pendingTools.clear();
			});
			m.rebuildChatFromMessages({ reuseSettledComponents: true });
			expect(render).toHaveBeenCalledWith(context, {
				reuseSettledComponents: true,
				preservedLiveToolCallIds: new Set(["bg", "r1"]),
			});
			// live rows return in their original order; the settled tool and stale rows go
			expect(m.chatContainer.children).toEqual([streaming, background, segment, shared, reply, live]);
			// the settled shared member stops routing; its pending sibling still owns the group
			expect([...m.pendingTools]).toEqual([
				["bg", background],
				["r2", shared],
				["live", live],
			]);
			expect(m.transcriptMessageComponents.has(kept)).toBe(true);
			expect(m.transcriptMessageComponents.has(dropped)).toBe(false);
		});

		it("preserves nothing when a streaming rebuild has no live rows", async () => {
			const m = await initialized();
			const stale = new piTui.Text("stale", 0, 0);
			m.chatContainer.addChild(stale);
			m.streamingComponent = undefined;
			m.pendingTools.clear();
			Object.defineProperty(m.session, "isStreaming", { configurable: true, get: () => true });
			vi.spyOn(m.session, "buildTranscriptSessionContext").mockReturnValue({ messages: [] } as never);
			const render = vi.spyOn(m, "renderSessionContext").mockImplementation(() => {});
			m.rebuildChatFromMessages();
			expect(render).toHaveBeenCalledWith({ messages: [] }, { reuseSettledComponents: undefined, preservedLiveToolCallIds: new Set() });
			expect(m.chatContainer.children).toEqual([]);
		});

		it("replays the optimistic user row only for a live, uncancelled user submission", async () => {
			const m = await initialized();
			const userRows = () =>
				m.chatContainer.children.filter(child => Bun.stripANSI(child.render(80).join("\n")).includes("pending ask"));
			const pending = m.startPendingSubmission({ text: "pending ask" });
			m.rebuildChatFromMessages();
			expect(userRows()).toHaveLength(1);
			pending.cancelled = true;
			m.rebuildChatFromMessages();
			expect(userRows()).toHaveLength(0);
			// a signature without a matching user submission replays nothing
			pending.cancelled = false;
			pending.customType = "goal-continuation";
			m.rebuildChatFromMessages();
			expect(userRows()).toHaveLength(0);
			m.cancelPendingSubmission();
			m.optimisticUserMessageSignature = "pending ask\u00000";
			m.rebuildChatFromMessages();
			expect(userRows()).toHaveLength(0);
		});
	});

	describe("native composer state", () => {
		it("reports the draft's shell mode and whether its prefix excludes it from context", () => {
			const m = createMode();
			m.isBashMode = true;
			m.editor.setText("!!ls -la");
			expect(m.editor.composerState?.().shell).toEqual({ kind: "bash", excluded: true });
			m.editor.setText("ls");
			expect(m.editor.composerState?.().shell).toEqual({ kind: "bash", excluded: false });
			m.isBashMode = false;
			m.isPythonMode = true;
			m.editor.setText("$$print(1)");
			expect(m.editor.composerState?.().shell).toEqual({ kind: "python", excluded: true });
			m.isPythonMode = false;
			expect(m.editor.composerState?.().shell).toBeUndefined();
		});

		it("shows the dictation state only while speech input is enabled or a capture is live", async () => {
			const m = createMode();
			expect(m.editor.composerState?.().dictation).toBeUndefined();
			await change(cfgSttEnabled, true);
			expect(m.editor.composerState?.().dictation).toBe("idle");
			const started = Promise.withResolvers<void>();
			vi.spyOn(STTController.prototype, "start").mockReturnValue(started.promise as never);
			m.editor.onToggleDictation?.();
			// the mic reads "starting" until the capture is up
			expect(m.editor.composerState?.().dictation).toBe("starting");
			started.resolve();
			await Promise.resolve();
			await Promise.resolve();
			expect(m.editor.composerState?.().dictation).toBe("idle");
			// a capture still recording shows even after the setting turns off
			const state = Object.getOwnPropertyDescriptor(STTController.prototype, "state")!;
			Object.defineProperty(STTController.prototype, "state", { configurable: true, get: () => "recording" });
			try {
				await change(cfgSttEnabled, false);
				expect(m.editor.composerState?.().dictation).toBe("recording");
			} finally {
				Object.defineProperty(STTController.prototype, "state", state);
			}
		});

		it("lists the focused subagent's live ancestors below main, outermost first", () => {
			const m = createMode();
			expect(m.editor.composerState?.().viewing).toBeUndefined();
			const parents: Record<string, string | undefined> = {
				grandchild: "child",
				child: "root-task",
				"root-task": MAIN_AGENT_ID,
				looped: "looper",
				looper: "looped",
				orphan: "gone",
			};
			vi.spyOn(AgentRegistry.global(), "get").mockImplementation(
				(id: string) => (id in parents ? { id, parentId: parents[id] } : undefined) as never,
			);
			let focused = "grandchild";
			Object.defineProperty(m, "focusedAgentId", { configurable: true, get: () => focused });
			expect(m.editor.composerState?.().viewing).toEqual(["root-task", "child", "grandchild"]);
			// a parent cycle stops at the first repeat; a parent no longer registered ends the chain
			focused = "looped";
			expect(m.editor.composerState?.().viewing).toEqual(["looper", "looped"]);
			focused = "orphan";
			expect(m.editor.composerState?.().viewing).toEqual(["orphan"]);
		});
	});

	describe("editor border colour", () => {
		it("colours the border for bash, python and each vim mode", () => {
			const m = createMode();
			const border = () => m.editor.borderColor("x");
			m.isBashMode = true;
			m.updateEditorBorderColor();
			expect(border()).toBe(tuiTheme.theme.getBashModeBorderColor()("x"));
			m.isBashMode = false;
			m.isPythonMode = true;
			m.updateEditorBorderColor();
			expect(border()).toBe(tuiTheme.theme.getPythonModeBorderColor()("x"));
			m.isPythonMode = false;
			let vimMode = "insert";
			Object.defineProperty(m.editor, "vimEnabled", { configurable: true, get: () => true });
			Object.defineProperty(m.editor, "vimMode", { configurable: true, get: () => vimMode });
			for (const [mode, color] of [
				["visual", "warning"],
				["visual-line", "warning"],
				["normal", "accent"],
				["replace", "accent"],
				["insert", "success"],
			] as const) {
				vimMode = mode;
				m.updateEditorBorderColor();
				expect(border()).toBe(tuiTheme.theme.fg(color, "x"));
			}
		});
	});

	describe("composer status cache", () => {
		it("persists the settled status bar once per burst, recovering the border's ANSI wrapper", async () => {
			vi.useFakeTimers();
			const writeStatus = vi.fn();
			vi.spyOn(composerCache, "sharedComposerCache").mockReturnValue({ writeStatus } as never);
			const m = createMode();
			vi.spyOn(m.sessionManager, "getSessionFile").mockReturnValue("/tmp/c3-session.jsonl");
			m.syncComposerShape();
			m.syncComposerShape();
			// the timer reads whatever border the mode last applied
			m.editor.borderColor = (text: string) => `<${text}>`;
			expect(writeStatus).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1_000);
			expect(writeStatus).toHaveBeenCalledTimes(1);
			const [cwd, status] = writeStatus.mock.calls[0]!;
			expect(cwd).toBe(m.sessionManager.getCwd());
			expect(status.borderColor).toEqual({ prefix: "<", suffix: ">" });
			expect(status.statusLine.model).toBe(m.session.model);
			expect(status.statusLine.compactionBoundaries).not.toBeNull();
		});

		it("caches no border wrapper or model-derived tiers when neither can be recovered", () => {
			vi.useFakeTimers();
			const writeStatus = vi.fn();
			vi.spyOn(composerCache, "sharedComposerCache").mockReturnValue({ writeStatus } as never);
			const m = createMode(undefined, {
				beforeMode: session => Object.defineProperty(session, "model", { configurable: true, get: () => undefined }),
			});
			vi.spyOn(m.sessionManager, "getSessionFile").mockReturnValue("/tmp/c3-session.jsonl");
			// a default role that resolves to nothing falls back to the launch model (none here)
			vi.spyOn(m.settings, "getModelRole").mockReturnValue("anthropic/missing" as never);
			vi.spyOn(m.session, "resolveRoleModelWithThinking").mockReturnValue({ model: undefined } as never);
			m.syncComposerShape();
			m.editor.borderColor = () => "plain";
			vi.advanceTimersByTime(1_000);
			const [, status] = writeStatus.mock.calls[0]!;
			expect(status.borderColor).toBeUndefined();
			expect(status.statusLine).toMatchObject({
				model: undefined,
				fastMode: false,
				usingSubscription: false,
				compactionBoundaries: null,
			});
		});

		it("caches a role model without a context window with no compaction boundaries", () => {
			vi.useFakeTimers();
			const writeStatus = vi.fn();
			vi.spyOn(composerCache, "sharedComposerCache").mockReturnValue({ writeStatus } as never);
			const m = createMode();
			vi.spyOn(m.sessionManager, "getSessionFile").mockReturnValue("/tmp/c3-session.jsonl");
			const roleModel = { ...m.session.model!, contextWindow: 0 };
			vi.spyOn(m.settings, "getModelRole").mockReturnValue("anthropic/role" as never);
			vi.spyOn(m.session, "resolveRoleModelWithThinking").mockReturnValue({ model: roleModel } as never);
			m.syncComposerShape();
			vi.advanceTimersByTime(1_000);
			const [, status] = writeStatus.mock.calls[0]!;
			expect(status.statusLine.model).toBe(roleModel);
			expect(status.statusLine.compactionBoundaries).toBeNull();
		});
	});

	describe("running-subagent badge", () => {
		it("repaints only on a change and when the caller allows it", () => {
			const m = createMode();
			const render = vi.spyOn(m.ui, "requestRender");
			const running = vi.spyOn(m.statusLine, "setRunningSubagents").mockReturnValue(true);
			expect(m.syncRunningSubagentBadge()).toBe(true);
			expect(render).toHaveBeenCalledTimes(1);
			expect(m.syncRunningSubagentBadge({ requestRender: false })).toBe(true);
			expect(render).toHaveBeenCalledTimes(1);
			running.mockReturnValue(false);
			vi.spyOn(m.statusLine, "setSubagentTreeCost").mockReturnValue(false);
			expect(m.syncRunningSubagentBadge()).toBe(false);
			expect(render).toHaveBeenCalledTimes(1);
		});

		it("skips the subagent tree cost for a collab guest", () => {
			const m = createMode();
			m.collabGuest = {} as never;
			const cost = vi.spyOn(m.statusLine, "setSubagentTreeCost");
			const hydrate = vi.spyOn(persistedAgents, "registerPersistedSubagents");
			m.syncRunningSubagentBadge();
			expect(cost).toHaveBeenLastCalledWith(0);
			expect(hydrate).not.toHaveBeenCalled();
			m.collabGuest = undefined;
		});

		it("hydrates a resumed session's subagent costs once and logs a failed hydration", async () => {
			const m = createMode();
			vi.spyOn(m.sessionManager, "getSessionFile").mockReturnValue("/tmp/c3-root.jsonl");
			vi.spyOn(m.sessionManager, "isSessionOnDisk").mockReturnValue(true);
			const hydrate = vi
				.spyOn(persistedAgents, "registerPersistedSubagents")
				.mockRejectedValue(new Error("unreadable transcript"));
			const warn = vi.spyOn(piUtils.logger, "warn");
			m.syncRunningSubagentBadge();
			m.syncRunningSubagentBadge();
			expect(hydrate).toHaveBeenCalledTimes(1);
			await Promise.resolve();
			await Promise.resolve();
			expect(warn).toHaveBeenCalledWith("Persisted subagent cost hydration failed", {
				rootSessionFile: "/tmp/c3-root.jsonl",
				error: "Error: unreadable transcript",
			});
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
