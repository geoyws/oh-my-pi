/**
 * InteractiveMode plan mode from line 5615: the plan-role model transition and
 * its failures, the queued model switch, session-switch teardown and restore,
 * plan entry and exit (including their rollbacks), and `/plan` dispatch. Drives
 * an initialized mode with the main turn faked as streaming where needed.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, Model } from "@oh-my-pi/pi-ai";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgGoalEnabled } from "@oh-my-pi/pi-coding-agent/goals/settings";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import {
	cfgMarketplaceAutoUpdate,
	cfgStartupChangelogMode,
	cfgStartupCheckUpdate,
	cfgStartupSetupWizard,
	cfgStartupShowSplash,
} from "@oh-my-pi/pi-coding-agent/modes/settings";
import * as skillCommand from "@oh-my-pi/pi-coding-agent/modes/skill-command";
import { cfgPlanEnabled } from "@oh-my-pi/pi-coding-agent/plan-mode/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { closeSessionIndex } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const image: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };

describe("InteractiveMode plan mode (lines 5615-7082)", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let streaming: boolean;
	let sonnet: Model;
	let opus: Model;
	let haiku: Model;
	let reconcileSwitch: (() => Promise<void>) | undefined;
	let setModel: ReturnType<typeof spyOn<AgentSession, "setModelTemporary">>;
	let warnings: string[];
	let statuses: string[];

	/** Build and initialize a mode; `prepare` runs before `init()` so it can journal entries to restore. */
	async function boot(
		options: {
			planEnabled?: boolean;
			prepare?: (sessionManager: SessionManager, settings: Settings) => void;
		} = {},
	): Promise<void> {
		const modelRegistry = new ModelRegistry(authStorage);
		const find = (id: string): Model => {
			const model = modelRegistry.find("anthropic", id);
			if (!model) throw new Error(`Expected anthropic/${id} in registry`);
			return model;
		};
		sonnet = find("claude-sonnet-4-5");
		opus = find("claude-opus-4-5");
		haiku = find("claude-haiku-4-5");
		const local = Settings.isolated();
		cfgStartupCheckUpdate.override(local, false);
		cfgStartupChangelogMode.override(local, "hidden");
		cfgStartupSetupWizard.override(local, false);
		cfgStartupShowSplash.override(local, false);
		cfgMarketplaceAutoUpdate.override(local, "off");
		cfgGoalEnabled.set(local, true);
		cfgPlanEnabled.set(local, options.planEnabled ?? true);
		local.setModelRole("default", "anthropic/claude-sonnet-4-5");
		local.setModelRole("plan", "anthropic/claude-opus-4-5");
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		options.prepare?.(sessionManager, local);
		session = new AgentSession({
			agent: new Agent({ initialState: { model: sonnet, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager,
			settings: local,
			modelRegistry,
		});
		streaming = false;
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => streaming });
		// Provider-side setup is out of scope: only the live model pointer has to move.
		setModel = spyOn(session, "setModelTemporary").mockImplementation(async model => {
			session.agent.setModel(model);
		});
		reconcileSwitch = undefined;
		const setReconciler = session.setSessionSwitchReconciler.bind(session);
		spyOn(session, "setSessionSwitchReconciler").mockImplementation(reconciler => {
			reconcileSwitch = reconciler ?? undefined;
			setReconciler(reconciler);
		});
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			new Composer({ terminal: new VirtualTerminal(160, 40) }),
		);
		spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		await mode.init({ suppressWelcomeIntro: true });
		warnings = [];
		statuses = [];
		spyOn(mode, "showWarning").mockImplementation(message => void warnings.push(message));
		spyOn(mode, "showStatus").mockImplementation(message => void statuses.push(message));
	}

	const modeChanges = () =>
		session.sessionManager
			.getEntries()
			.filter(entry => entry.type === "mode_change")
			.map(entry => (entry as { mode: string }).mode);

	/** Pretend the session has no live model: `session.model` is an accessor on the prototype. */
	function withoutModel(): void {
		Object.defineProperty(session, "model", { configurable: true, get: () => undefined });
	}

	async function enterPlan(): Promise<void> {
		expect(await mode.handlePlanModeCommand()).toBe(false);
		expect(mode.planModeEnabled).toBe(true);
		statuses.length = 0;
	}

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-im-r5601-plan-");
		resetSettingsForTest();
		await initTheme();
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
	});

	afterEach(async () => {
		mode?.stop();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage.close();
		AgentStorage.close();
		HistoryStorage.close();
		closeSessionIndex();
		closeModelCache();
		resetSettingsForTest();
		tempDir.removeSync();
	});

	describe("plan-role model transition", () => {
		it("with no live model, moves onto the plan model and has nothing to restore on exit", async () => {
			await boot();
			withoutModel();

			await enterPlan();
			expect(setModel.mock.calls.map(call => call[0].id)).toEqual(["claude-opus-4-5"]);

			await mode.handlePlanModeCommand();
			expect(mode.planModeEnabled).toBe(false);
			expect(setModel).toHaveBeenCalledTimes(1);
		});

		it("only applies the plan role's thinking level when the plan model is already live", async () => {
			await boot({ prepare: (_sm, settings) => settings.setModelRole("plan", "anthropic/claude-sonnet-4-5:high") });
			const setThinking = spyOn(session, "setThinkingLevel");

			await enterPlan();

			expect(setThinking).toHaveBeenCalledWith("high");
			expect(session.setModelTemporary).not.toHaveBeenCalled();
		});

		it.each([
			["an Error", new Error("provider refused"), "provider refused"],
			["a non-Error", "socket closed", "socket closed"],
		])("warns and stays in plan mode when the plan model switch fails with %s", async (_label, failure, detail) => {
			await boot();
			setModel.mockRejectedValue(failure);

			await enterPlan();

			expect(warnings).toEqual([`Failed to switch to plan model for plan mode: ${detail}`]);
			expect(session.model?.id).toBe("claude-sonnet-4-5");
		});

		it.each([
			["an Error", new Error("provider refused"), "provider refused"],
			["a non-Error", "socket closed", "socket closed"],
		])("warns when the plan switch queued during a turn fails with %s at the settle", async (_label, failure, detail) => {
			await boot();
			streaming = true;
			await enterPlan();
			expect(session.setModelTemporary).not.toHaveBeenCalled();
			streaming = false;
			setModel.mockRejectedValue(failure);

			await mode.flushPendingModelSwitch();

			expect(warnings).toEqual([`Failed to switch model after streaming: ${detail}`]);
		});

		it("drops the queued plan switch when the plan role is reassigned to nothing resolvable", async () => {
			await boot();
			streaming = true;
			await enterPlan();
			spyOn(session, "resolveRoleModelWithThinking").mockReturnValue({ model: undefined } as never);

			session.settings.setModelRole("plan", "anthropic/claude-haiku-4-5");
			await Bun.sleep(0);
			streaming = false;
			await mode.flushPendingModelSwitch();

			expect(session.setModelTemporary).not.toHaveBeenCalled();
			expect(session.model?.id).toBe("claude-sonnet-4-5");
		});
	});

	describe("user model switch routing", () => {
		it("lets another session's switch apply at once without queueing it here", async () => {
			await boot();
			streaming = true;
			const other = Object.create(session) as AgentSession;

			expect(mode.routeUserModelSwitch(other, opus, async () => true)).toBe("apply");

			expect(mode.pendingUserModelSwitch).toBeUndefined();
		});

		it("names the missing live model when queueing mid-turn", async () => {
			await boot();
			streaming = true;
			withoutModel();

			expect(mode.routeUserModelSwitch(session, haiku, async () => true)).toBe("queued");

			expect(statuses.at(-1)).toMatch(/^Model switch queued for after this turn: no model -> /);
			expect(mode.pendingUserModelSwitch?.model.id).toBe("claude-haiku-4-5");
		});
	});

	describe("restoring the pre-plan model on exit", () => {
		it("keeps a user switch queued during plan mode instead of restoring the pre-plan model", async () => {
			await boot();
			await enterPlan();
			streaming = true;
			mode.routeUserModelSwitch(session, haiku, async () => true);
			statuses.length = 0;

			await mode.handlePlanModeCommand();

			expect(statuses).toContain(
				`Keeping the queued switch to anthropic/claude-haiku-4-5 instead of restoring anthropic/claude-sonnet-4-5`,
			);
			expect(mode.pendingUserModelSwitch?.model.id).toBe("claude-haiku-4-5");
		});

		it("says nothing when the switch queued during plan mode is the pre-plan model itself", async () => {
			await boot();
			await enterPlan();
			streaming = true;
			mode.routeUserModelSwitch(session, sonnet, async () => true);
			statuses.length = 0;

			await mode.handlePlanModeCommand();

			expect(statuses.filter(line => line.startsWith("Keeping the queued switch"))).toEqual([]);
			expect(mode.pendingUserModelSwitch?.model.id).toBe("claude-sonnet-4-5");
		});

		it("queues the restore for the settle when plan mode is left mid-turn", async () => {
			await boot();
			await enterPlan();
			expect(session.model?.id).toBe("claude-opus-4-5");
			streaming = true;

			await mode.handlePlanModeCommand();
			expect(session.model?.id).toBe("claude-opus-4-5");

			streaming = false;
			await mode.flushPendingModelSwitch();
			expect(session.model?.id).toBe("claude-sonnet-4-5");
		});

		it("replays an absorbed user switch that reports no change without claiming a switch", async () => {
			await boot();
			streaming = true;
			const apply = vi.fn(async () => false);
			mode.routeUserModelSwitch(session, haiku, apply);
			await enterPlan();
			streaming = false;
			statuses.length = 0;

			await mode.handlePlanModeCommand();

			expect(apply).toHaveBeenCalledTimes(1);
			expect(statuses.filter(line => line.startsWith("Model switched to"))).toEqual([]);
		});

		it("an absorbed switch to the plan model with no thinking or role leaves both untouched", async () => {
			await boot();
			streaming = true;
			mode.routeUserModelSwitch(session, opus, async () => true);
			await enterPlan();
			streaming = false;
			await mode.flushPendingModelSwitch();
			expect(session.model?.id).toBe("claude-opus-4-5");
			const setThinking = spyOn(session, "setThinkingLevel");
			const appendModel = spyOn(session.sessionManager, "appendModelChange");

			await mode.handlePlanModeCommand();

			expect(setThinking).not.toHaveBeenCalled();
			expect(appendModel).not.toHaveBeenCalled();
			expect(session.model?.id).toBe("claude-opus-4-5");
		});
	});

	describe("session switch teardown", () => {
		function switchTo(modeEntry: string): Promise<void> {
			session.sessionManager.appendModeChange(modeEntry);
			if (!reconcileSwitch) throw new Error("init registered no session-switch reconciler");
			return reconcileSwitch();
		}

		it("clears an active goal and restores its pre-goal tools", async () => {
			await boot();
			const activate = spyOn(session, "setActiveToolsByName");
			await mode.handleGoalModeCommand("ship it");
			const goalTools = activate.mock.calls.at(-1)?.[0];
			expect(goalTools).toContain("goal");

			await switchTo("none");

			expect(mode.goalModeEnabled).toBe(false);
			expect(session.getGoalModeState()).toBeUndefined();
			expect(activate.mock.calls.at(-1)?.[0]).toEqual(goalTools?.filter(name => name !== "goal"));
		});

		it("clears a paused goal without touching tools it no longer holds", async () => {
			await boot();
			await mode.handleGoalModeCommand("ship it");
			await mode.handleGoalModeCommand("pause");
			expect(mode.goalModePaused).toBe(true);
			const activate = spyOn(session, "setActiveToolsByName");

			await switchTo("none");

			expect(mode.goalModePaused).toBe(false);
			expect(session.getGoalModeState()).toBeUndefined();
			expect(activate).not.toHaveBeenCalled();
		});

		it("drops a plan switch still queued from a turn when switching away from plan mode", async () => {
			await boot();
			streaming = true;
			await enterPlan();
			streaming = false;

			await switchTo("none");
			await mode.flushPendingModelSwitch();

			expect(mode.planModeEnabled).toBe(false);
			expect(session.setModelTemporary).not.toHaveBeenCalled();
		});

		it("tears a paused plan down without a tool presentation to restore", async () => {
			await boot();
			await enterPlan();
			await mode.handlePlanModeCommand();
			expect(mode.planModePaused).toBe(true);
			const restoreTools = spyOn(session, "restoreNonMCPToolPresentation");

			await switchTo("none");

			expect(mode.planModePaused).toBe(false);
			expect(restoreTools).not.toHaveBeenCalled();
		});
	});

	describe("restore on session load", () => {
		it("restores a paused plan as paused", async () => {
			await boot({ prepare: sm => void sm.appendModeChange("plan_paused") });

			expect(mode.planModePaused).toBe(true);
			expect(mode.planModeEnabled).toBe(false);
			expect(modeChanges()).toEqual(["plan_paused"]);
		});

		it.each(["plan", "plan_paused"])("journals a saved %s off while plan mode is disabled", async saved => {
			await boot({ planEnabled: false, prepare: sm => void sm.appendModeChange(saved) });

			expect(mode.planModeEnabled).toBe(false);
			expect(mode.planModePaused).toBe(false);
			expect(modeChanges()).toEqual([saved, "none"]);
		});

		it("journals nothing for a session with no saved plan while plan mode is disabled", async () => {
			await boot({ planEnabled: false, prepare: sm => void sm.appendModeChange("none") });

			expect(modeChanges()).toEqual(["none"]);
		});
	});

	describe("plan entry", () => {
		it("snapshots only non-MCP mounted tools and routes plan proposals to review", async () => {
			await boot();
			spyOn(session, "getMountedXdevToolNames").mockReturnValue(["xd_search", "mcp__srv__lookup"]);
			const proposal = spyOn(session, "setPlanProposalHandler");
			const prepare = spyOn(session, "preparePlanForReview").mockResolvedValue(undefined as never);
			const restoreTools = spyOn(session, "restoreNonMCPToolPresentation");

			await enterPlan();
			const handler = proposal.mock.calls.find(call => call[0] !== null)?.[0];
			await handler?.("Ship it");
			await mode.handlePlanModeCommand();

			expect(prepare).toHaveBeenCalledWith("Ship it");
			expect(restoreTools.mock.calls[0]?.[1]).toEqual(["xd_search"]);
		});

		it("rolls plan state back when the plan toolset cannot be activated", async () => {
			await boot();
			spyOn(session, "setActiveToolsByName").mockRejectedValue(new Error("tool registry locked"));

			await expect(mode.handlePlanModeCommand()).rejects.toThrow("tool registry locked");

			expect(mode.planModeEnabled).toBe(false);
			expect(session.getPlanModeState()).toBeUndefined();
			expect(modeChanges()).toEqual([]);
		});
	});

	describe("plan exit failures", () => {
		it("rolls back to the plan model and tools, and logs when either rollback fails", async () => {
			await boot();
			await enterPlan();
			expect(session.model?.id).toBe("claude-opus-4-5");
			// Each restore moves the model and then fails, so the exit and its rollback both fail.
			setModel.mockImplementation(async model => {
				session.agent.setModel(model);
				throw new Error("provider refused");
			});
			let enabledReads = 0;
			const planTools = ["read", "write"];
			spyOn(session, "getEnabledToolNames").mockImplementation(() => (enabledReads++ === 0 ? planTools : ["read"]));
			spyOn(session, "setActiveToolPresentation").mockRejectedValue(new Error("presentation locked"));
			const warn = spyOn(logger, "warn");

			await expect(mode.handlePlanModeCommand()).rejects.toThrow("provider refused");

			expect(mode.planModeEnabled).toBe(true);
			expect(session.getPlanModeState()?.enabled).toBe(true);
			expect(warn).toHaveBeenCalledWith("Failed to restore plan model after plan exit failure", {
				error: "Error: provider refused",
			});
			expect(warn).toHaveBeenCalledWith("Failed to restore plan tools after plan exit failure", {
				error: "Error: presentation locked",
			});
		});

		it("leaves the plan toolset alone when the failed exit did not change it", async () => {
			await boot();
			spyOn(session, "getMountedXdevToolNames").mockReturnValue(["xd_search"]);
			await enterPlan();
			spyOn(session, "restoreNonMCPToolPresentation").mockRejectedValue(new Error("presentation locked"));
			const present = spyOn(session, "setActiveToolPresentation");

			await expect(mode.handlePlanModeCommand()).rejects.toThrow("presentation locked");

			expect(present).not.toHaveBeenCalled();
			expect(mode.planModeEnabled).toBe(true);
		});
	});

	describe("/plan", () => {
		it.each([
			["an active goal", (m: InteractiveMode) => void (m.goalModeEnabled = true), "Exit goal mode first."],
			["a paused goal", (m: InteractiveMode) => void (m.goalModePaused = true), "Exit goal mode first."],
			["vibe mode", (m: InteractiveMode) => void (m.vibeModeEnabled = true), "Exit vibe mode first."],
		])("refuses inside %s", async (_label, arrange, warning) => {
			await boot();
			arrange(mode);

			expect(await mode.handlePlanModeCommand("draft it")).toBe(false);

			expect(warnings).toEqual([warning]);
			expect(mode.planModeEnabled).toBe(false);
		});

		it("refuses when plan mode is disabled in settings", async () => {
			await boot({ planEnabled: false });

			expect(await mode.handlePlanModeCommand()).toBe(false);

			expect(warnings).toEqual(["Plan mode is disabled. Enable it in settings (plan.enabled)."]);
		});

		it("a third bare /plan fully disables a paused plan", async () => {
			await boot();
			await enterPlan();
			await mode.handlePlanModeCommand();
			expect(mode.planModePaused).toBe(true);
			statuses.length = 0;

			expect(await mode.handlePlanModeCommand()).toBe(false);

			expect(mode.planModePaused).toBe(false);
			expect(mode.planModeEnabled).toBe(false);
			expect(statuses).toEqual(["Plan mode disabled."]);
			expect(modeChanges().at(-1)).toBe("none");
		});

		it("an extension's exit request disables plan mode with a status", async () => {
			await boot();
			await enterPlan();

			const result = await mode.sessionModes.set({ mode: "plan", action: "exit" });

			expect(result.ok).toBe(true);
			expect(mode.planModeEnabled).toBe(false);
			expect(mode.planModePaused).toBe(false);
			expect(statuses).toEqual(["Plan mode disabled."]);
		});

		it("does not pause a plan that was exited while its exit was being confirmed", async () => {
			await boot();
			await enterPlan();
			const planFile = mode.planModePlanFilePath;
			if (!planFile) throw new Error("expected a plan file");
			await Bun.write(
				resolveLocalUrlToPath(planFile, {
					getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
					getSessionId: () => session.sessionManager.getSessionId(),
				}),
				"# Draft",
			);
			spyOn(mode, "showHookConfirm").mockImplementation(async () => {
				mode.planModeEnabled = false;
				return true;
			});

			await mode.handlePlanModeCommand();

			expect(mode.planModePaused).toBe(false);
			expect(modeChanges()).not.toContain("plan_paused");
		});

		describe("a prompt gated while another mode starts", () => {
			function gateWhile(during: () => void): void {
				spyOn(session, "gateUserMessage").mockImplementation(async () => {
					during();
				});
			}

			it.each([
				["a goal", (m: InteractiveMode) => void (m.goalModeEnabled = true), "Exit goal mode first."],
				["vibe mode", (m: InteractiveMode) => void (m.vibeModeEnabled = true), "Exit vibe mode first."],
			])("does not enter plan mode over %s", async (_label, during, warning) => {
				await boot();
				gateWhile(() => during(mode));
				const activate = spyOn(session, "setActiveToolsByName");

				await mode.handlePlanModeCommand("draft it");

				expect(warnings).toEqual([warning]);
				expect(mode.planModeEnabled).toBe(false);
				expect(activate).not.toHaveBeenCalled();
			});

			it("does not enter plan mode twice when another /plan entered it meanwhile", async () => {
				await boot();
				gateWhile(() => {
					mode.planModeEnabled = true;
				});
				const activate = spyOn(session, "setActiveToolsByName");

				await mode.handlePlanModeCommand("draft it");

				expect(activate).not.toHaveBeenCalled();
				expect(modeChanges()).toEqual([]);
			});
		});

		describe("dispatching the first plan prompt", () => {
			it("runs a skill prompt as a steer", async () => {
				await boot();
				spyOn(skillCommand, "isKnownSkillCommand").mockReturnValue(true);
				const invoke = spyOn(skillCommand, "invokeSkillCommandFromText").mockResolvedValue(undefined as never);

				expect(await mode.handlePlanModeCommand("/skill:review now", { images: [image] })).toBe(true);

				expect(invoke).toHaveBeenCalledWith(mode, "/skill:review now", "steer", {
					images: [image],
					propagateErrors: true,
					source: "interactive",
				});
				expect(mode.planModeEnabled).toBe(true);
			});

			it.each([
				["with images", [image], [image], 1],
				["without images", [], undefined, 0],
			] as const)("steers into a running turn %s", async (_label, images, sent, imageCount) => {
				await boot();
				streaming = true;
				spyOn(session, "sendPlanModeContext").mockResolvedValue();
				const prompt = spyOn(session, "prompt").mockResolvedValue(true);
				const local = spyOn(mode, "withLocalSubmission");

				expect(await mode.handlePlanModeCommand("draft it", { images: [...images] })).toBe(true);

				expect(local).toHaveBeenCalledWith("draft it", expect.any(Function), { imageCount });
				expect(prompt).toHaveBeenCalledWith("draft it", { streamingBehavior: "steer", images: sent });
			});

			it("hands an idle prompt to the input callback as a draft-preserving submission", async () => {
				await boot();
				const submitted: unknown[] = [];
				mode.onInputCallback = input => void submitted.push(input);
				const start = spyOn(mode, "startPendingSubmission");

				expect(await mode.handlePlanModeCommand("draft it", { images: [image] })).toBe(true);

				expect(start).toHaveBeenCalledWith({ text: "draft it", images: [image] }, { preserveDraft: true });
				expect(submitted).toHaveLength(1);
			});

			it("sends nothing without an input callback", async () => {
				await boot();
				mode.onInputCallback = undefined;
				const prompt = spyOn(session, "prompt");

				expect(await mode.handlePlanModeCommand("draft it")).toBe(false);

				expect(prompt).not.toHaveBeenCalled();
				expect(mode.planModeEnabled).toBe(true);
			});

			it("a paused plan with a prompt re-enters plan mode instead of disabling it", async () => {
				await boot();
				await enterPlan();
				await mode.handlePlanModeCommand();
				expect(mode.planModePaused).toBe(true);
				mode.onInputCallback = undefined;

				await mode.handlePlanModeCommand("draft again");

				expect(mode.planModeEnabled).toBe(true);
				expect(mode.planModePaused).toBe(false);
			});
		});
	});
});
