/**
 * InteractiveMode goal mode from line 5560: continuation suppression and goal
 * completion on `agent_end`, goal restore on session load, entry guards that a
 * gated prompt can race, the budget command, and `/goal` / `/guided-goal`
 * refusals. Runs against an initialized mode and the real goal runtime.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { GoalRuntime } from "@oh-my-pi/pi-coding-agent/goals/runtime";
import { cfgGoalEnabled } from "@oh-my-pi/pi-coding-agent/goals/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import {
	cfgMarketplaceAutoUpdate,
	cfgStartupChangelogMode,
	cfgStartupCheckUpdate,
	cfgStartupSetupWizard,
	cfgStartupShowSplash,
} from "@oh-my-pi/pi-coding-agent/modes/settings";
import type { SubmittedUserInput } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { closeSessionIndex } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import type { Goal } from "@oh-my-pi/pi-tui/tools/goal";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

/** The continuation timer in #scheduleGoalContinuation, plus margin. */
const CONTINUATION_WAIT_MS = 900;

function goal(overrides: Partial<Goal> = {}): Goal {
	return {
		id: "goal-1",
		objective: "ship the release",
		status: "active",
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	} as Goal;
}

function toolTurn(argument: string): AssistantMessage[] {
	return [
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: argument } }],
			stopReason: "toolUse",
		} as unknown as AssistantMessage,
	];
}

describe("InteractiveMode goal mode (lines 5560-7400)", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let listeners: Array<(event: AgentSessionEvent) => unknown>;
	let toolActivations: ReturnType<typeof spyOn<AgentSession, "setActiveToolsByName">>;
	let warnings: string[];
	let statuses: string[];
	let errors: string[];

	/**
	 * Build a session in a fresh temp dir; `prepare` runs before `init()`, so a
	 * test can journal mode entries that the init-time reconcile restores.
	 */
	async function boot(options: {
		goalEnabled?: boolean;
		prepare?: (sessionManager: SessionManager) => void;
	} = {}): Promise<void> {
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		const local = Settings.isolated();
		cfgStartupCheckUpdate.override(local, false);
		cfgStartupChangelogMode.override(local, "hidden");
		cfgStartupSetupWizard.override(local, false);
		cfgStartupShowSplash.override(local, false);
		cfgMarketplaceAutoUpdate.override(local, "off");
		cfgGoalEnabled.set(local, options.goalEnabled ?? true);
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		options.prepare?.(sessionManager);
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager,
			settings: local,
			modelRegistry,
		});
		listeners = [];
		const subscribe = session.subscribe.bind(session);
		spyOn(session, "subscribe").mockImplementation(listener => {
			listeners.push(listener);
			return subscribe(listener);
		});
		// The test agent registers no tools, so the active set itself stays empty: read the requests.
		toolActivations = spyOn(session, "setActiveToolsByName");
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
		errors = [];
		spyOn(mode, "showWarning").mockImplementation(message => void warnings.push(message));
		spyOn(mode, "showStatus").mockImplementation(message => void statuses.push(message));
		spyOn(mode, "showError").mockImplementation(message => void errors.push(message));
	}

	async function emit(event: AgentSessionEvent): Promise<void> {
		for (const listener of [...listeners]) await listener(event);
		// #handleGoalSessionEvent runs detached (`void`); let it settle.
		await Bun.sleep(0);
	}

	const agentEnd = (messages: unknown[] = []) => ({ type: "agent_end", messages }) as unknown as AgentSessionEvent;

	async function startGoal(objective = "ship the release"): Promise<void> {
		expect(await mode.handleGoalModeCommand(objective)).toBe(false);
		expect(mode.goalModeEnabled).toBe(true);
		statuses.length = 0;
	}

	/** Capture continuation submissions and hand each one to the session at once, as the main loop does. */
	function acceptContinuations(): SubmittedUserInput[] {
		const submitted: SubmittedUserInput[] = [];
		mode.onInputCallback = input => {
			submitted.push(input);
			mode.markPendingSubmissionStarted(input);
			input.dispatched = true;
			mode.finishPendingSubmission(input);
		};
		return submitted;
	}

	/** The tool names of every setActiveToolsByName call, oldest first. */
	const toolSets = () => toolActivations.mock.calls.map(call => call[0]);

	const modeChanges = () =>
		session.sessionManager
			.getEntries()
			.filter(entry => entry.type === "mode_change")
			.map(entry => (entry as { mode: string }).mode);

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-im-r5601-goal-");
		resetSettingsForTest();
		await initTheme();
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
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

	describe("continuation turns", () => {
		it("stops continuing once a continuation turn repeats the previous one's tool activity", async () => {
			await boot();
			await startGoal();
			const submitted = acceptContinuations();

			// A user turn ends: the goal continues.
			await emit(agentEnd(toolTurn("a.ts")));
			await Bun.sleep(CONTINUATION_WAIT_MS);
			expect(submitted.map(input => input.customType)).toEqual(["goal-continuation"]);

			// The first continuation does new work: continue again.
			await emit(agentEnd(toolTurn("b.ts")));
			await Bun.sleep(CONTINUATION_WAIT_MS);
			expect(submitted).toHaveLength(2);

			// The second repeats it exactly: no third continuation.
			await emit(agentEnd(toolTurn("b.ts")));
			await Bun.sleep(CONTINUATION_WAIT_MS);
			expect(submitted).toHaveLength(2);
			expect(mode.goalModeEnabled).toBe(true);
		});

		it("stops continuing after a continuation turn that did no tool work", async () => {
			await boot();
			await startGoal();
			const submitted = acceptContinuations();

			await emit(agentEnd());
			await Bun.sleep(CONTINUATION_WAIT_MS);
			expect(submitted).toHaveLength(1);

			await emit(agentEnd([{ role: "assistant", content: [], stopReason: "stop" } as unknown as AssistantMessage]));
			await Bun.sleep(CONTINUATION_WAIT_MS);
			expect(submitted).toHaveLength(1);
		});

		it("completes a goal left exiting when its turn ends: silent, journaled, tools restored", async () => {
			await boot();
			await startGoal("finish the docs");
			const goalTools = toolSets().at(-1);
			expect(goalTools).toContain("goal");
			const state = session.getGoalModeState();
			if (!state) throw new Error("expected goal state");
			session.setGoalModeState({ ...state, mode: "exiting" });

			await emit(agentEnd());

			expect(mode.goalModeEnabled).toBe(false);
			expect(mode.goalModePaused).toBe(false);
			expect(session.getGoalModeState()).toBeUndefined();
			expect(toolSets().at(-1)).toEqual(goalTools?.filter(name => name !== "goal"));
			expect(modeChanges().at(-1)).toBe("none");
			const completed = session.sessionManager
				.getEntries()
				.find(entry => entry.type === "custom" && (entry as { customType: string }).customType === "goal-completed");
			expect((completed as { data?: { objective?: string } } | undefined)?.data?.objective).toBe("finish the docs");
			expect(statuses).toEqual([]);
		});
	});

	describe("restore on session load", () => {
		it("restores an active goal with the goal tool added back", async () => {
			await boot({ prepare: sm => void sm.appendModeChange("goal", { goal: goal() }) });

			expect(mode.goalModeEnabled).toBe(true);
			expect(mode.goalModePaused).toBe(false);
			expect(session.getGoalModeState()?.goal.objective).toBe("ship the release");
			expect(toolSets().at(-1)).toContain("goal");
		});

		it("restores a paused goal as paused, still exposing the goal tool for resume", async () => {
			await boot({ prepare: sm => void sm.appendModeChange("goal_paused", { goal: goal({ status: "paused" }) }) });

			expect(mode.goalModeEnabled).toBe(false);
			expect(mode.goalModePaused).toBe(true);
			expect(toolSets().at(-1)).toContain("goal");
		});

		it("leaves goal mode off and the goal tool out when the runtime restores no goal", async () => {
			spyOn(AgentSession.prototype, "getEnabledToolNames").mockReturnValue(["read"]);
			const resumed = spyOn(GoalRuntime.prototype, "onThreadResumed").mockResolvedValue(undefined);
			await boot({ prepare: sm => void sm.appendModeChange("goal", { goal: goal() }) });

			expect(resumed).toHaveBeenCalledTimes(1);
			expect(mode.goalModeEnabled).toBe(false);
			expect(mode.goalModePaused).toBe(false);
			expect(toolSets().flat()).not.toContain("goal");
		});

		it("journals the goal off when its saved data is unreadable", async () => {
			await boot({ prepare: sm => void sm.appendModeChange("goal", { goal: { objective: "no id" } }) });

			expect(mode.goalModeEnabled).toBe(false);
			expect(session.getGoalModeState()).toBeUndefined();
			expect(modeChanges()).toEqual(["goal", "none"]);
		});

		it.each(["goal", "goal_paused"])("journals a saved %s off when goal mode is disabled in settings", async saved => {
			await boot({ goalEnabled: false, prepare: sm => void sm.appendModeChange(saved, { goal: goal() }) });

			expect(mode.goalModeEnabled).toBe(false);
			expect(mode.goalModePaused).toBe(false);
			expect(session.getGoalModeState()).toBeUndefined();
			expect(modeChanges()).toEqual([saved, "none"]);
		});
	});

	describe("a prompt gated while another mode starts", () => {
		/** Make the next gateUserMessage run `during` before it lets the command continue. */
		function gateWhile(during: () => void): void {
			spyOn(session, "gateUserMessage").mockImplementation(async () => {
				during();
			});
		}

		it("/goal <objective> does not start a second goal over one that started meanwhile", async () => {
			await boot();
			gateWhile(() => {
				mode.goalModeEnabled = true;
			});
			const create = spyOn(session.goalRuntime, "createGoal");

			await mode.handleGoalModeCommand("ship it");

			expect(create).not.toHaveBeenCalled();
		});

		it.each([
			["active", false, "Exit plan mode first."],
			["paused", true, "Plan mode is paused — run /plan again to fully exit."],
		] as const)("/goal <objective> refuses plan mode that became %s meanwhile", async (_label, paused, warning) => {
			await boot();
			gateWhile(() => {
				if (paused) mode.planModePaused = true;
				else mode.planModeEnabled = true;
			});
			const create = spyOn(session.goalRuntime, "createGoal");

			await mode.handleGoalModeCommand("ship it");

			expect(create).not.toHaveBeenCalled();
			expect(mode.goalModeEnabled).toBe(false);
			expect(warnings).toEqual([warning]);
		});
	});

	describe("goal entry failures", () => {
		it.each([
			["a new goal", false, "dropGoal"],
			["a resumed goal", true, "pauseGoal"],
		] as const)("rolls back %s whose goal tool could not be activated", async (_label, resume, rollback) => {
			await boot();
			if (resume) {
				await startGoal();
				await mode.handleGoalModeCommand("pause");
				expect(mode.goalModePaused).toBe(true);
			}
			const undo = spyOn(session.goalRuntime, rollback);
			spyOn(session, "setActiveToolsByName").mockRejectedValue(new Error("tool registry locked"));

			await expect(mode.handleGoalModeCommand(resume ? "resume" : "ship it")).rejects.toThrow("tool registry locked");

			expect(undo).toHaveBeenCalledTimes(1);
			expect(mode.goalModeEnabled).toBe(false);
		});

		it("still reports the activation failure when the rollback fails too", async () => {
			await boot();
			spyOn(session.goalRuntime, "dropGoal").mockRejectedValue(new Error("journal closed"));
			spyOn(session, "setActiveToolsByName").mockRejectedValue(new Error("tool registry locked"));
			const warn = spyOn(logger, "warn");

			await expect(mode.handleGoalModeCommand("ship it")).rejects.toThrow("tool registry locked");

			expect(warn).toHaveBeenCalledWith("Failed to roll back goal after tool activation failed", {
				error: "Error: journal closed",
			});
		});

		it("drops nothing when the goal itself could not be created", async () => {
			await boot();
			spyOn(session.goalRuntime, "createGoal").mockRejectedValue(new Error("journal closed"));
			const drop = spyOn(session.goalRuntime, "dropGoal");

			await expect(mode.handleGoalModeCommand("ship it")).rejects.toThrow("journal closed");

			expect(drop).not.toHaveBeenCalled();
		});
	});

	describe("/goal budget", () => {
		it("refuses a budget that is not a positive integer and keeps the old one", async () => {
			await boot();
			await startGoal();
			const mutate = spyOn(session.goalRuntime, "onBudgetMutated");

			await mode.handleGoalModeCommand("budget lots");
			await mode.handleGoalModeCommand("budget 0");

			expect(errors).toEqual([
				"Goal budget must be a positive integer or `off`.",
				"Goal budget must be a positive integer or `off`.",
			]);
			expect(mutate).not.toHaveBeenCalled();
		});

		it("reports a goal that is already complete instead of changing its budget", async () => {
			await boot();
			await startGoal();
			const state = session.getGoalModeState();
			if (!state) throw new Error("expected goal state");
			session.setGoalModeState({ ...state, goal: { ...state.goal, status: "complete" } });
			const mutate = spyOn(session.goalRuntime, "onBudgetMutated");

			await mode.handleGoalModeCommand("budget 5000");

			expect(statuses).toEqual(["Goal is already complete."]);
			expect(mutate).not.toHaveBeenCalled();
		});

		it("refuses a budget typed into the prompt after the goal stopped being active", async () => {
			await boot();
			await startGoal();
			spyOn(mode, "showHookEditor").mockImplementation(async () => {
				const state = session.getGoalModeState();
				if (state) session.setGoalModeState({ ...state, enabled: false });
				return "5000";
			});
			const mutate = spyOn(session.goalRuntime, "onBudgetMutated");

			await mode.handleGoalModeCommand("budget");

			expect(warnings).toEqual(["No active goal."]);
			expect(mutate).not.toHaveBeenCalled();
		});
	});

	describe("/goal refusals and prompts", () => {
		it("refuses inside vibe mode", async () => {
			await boot();
			mode.vibeModeEnabled = true;

			expect(await mode.handleGoalModeCommand("ship it")).toBe(false);

			expect(warnings).toEqual(["Exit vibe mode first."]);
			expect(mode.goalModeEnabled).toBe(false);
		});

		it("refuses when goal mode is disabled in settings", async () => {
			await boot({ goalEnabled: false });

			expect(await mode.handleGoalModeCommand("ship it")).toBe(false);

			expect(warnings).toEqual(["Goal mode is disabled. Enable it in settings (goal.enabled)."]);
		});

		it("an objective typed over an active goal is refused with a pointer to /goal", async () => {
			await boot();
			await startGoal("old");

			expect(await mode.handleGoalModeCommand("new objective")).toBe(false);

			expect(statuses).toEqual(["Goal mode is already active. Use /goal to manage it, or /goal drop to start over."]);
			expect(session.getGoalModeState()?.goal.objective).toBe("old");
		});

		it("an objective typed over a paused goal is refused", async () => {
			await boot();
			await startGoal("old");
			await mode.handleGoalModeCommand("pause");
			warnings.length = 0;

			expect(await mode.handleGoalModeCommand("new objective")).toBe(false);

			expect(warnings).toEqual(["Resume the current goal first, or drop it before setting a new objective."]);
			expect(session.getGoalModeState()?.goal.objective).toBe("old");
		});

		it("bare /goal asks for the objective and starts it", async () => {
			await boot();
			const editor = spyOn(mode, "showHookEditor").mockResolvedValue("  typed objective  ");

			await mode.handleGoalModeCommand();

			expect(editor.mock.calls[0]?.[0]).toBe("Goal objective");
			expect(session.getGoalModeState()?.goal.objective).toBe("typed objective");
			expect(mode.goalModeEnabled).toBe(true);
		});

		it.each([
			["a blank answer", "   "],
			["a dismissed prompt", undefined],
		])("bare /goal starts nothing on %s", async (_label, answer) => {
			await boot();
			spyOn(mode, "showHookEditor").mockResolvedValue(answer);

			expect(await mode.handleGoalModeCommand()).toBe(false);

			expect(mode.goalModeEnabled).toBe(false);
			expect(session.getGoalModeState()).toBeUndefined();
		});
	});

	describe("/guided-goal refusals", () => {
		it.each([
			["active plan mode", (m: InteractiveMode) => void (m.planModeEnabled = true), "Exit plan mode first."],
			[
				"paused plan mode",
				(m: InteractiveMode) => void (m.planModePaused = true),
				"Plan mode is paused — run /plan again to fully exit.",
			],
			["vibe mode", (m: InteractiveMode) => void (m.vibeModeEnabled = true), "Exit vibe mode first."],
		])("refuses inside %s without prompting", async (_label, arrange, warning) => {
			await boot();
			arrange(mode);
			const prompt = spyOn(session, "prompt");

			expect(await mode.handleGuidedGoalCommand("ship it")).toBe(false);

			expect(warnings).toEqual([warning]);
			expect(prompt).not.toHaveBeenCalled();
		});

		it("refuses when goal mode is disabled in settings", async () => {
			await boot({ goalEnabled: false });
			const prompt = spyOn(session, "prompt");

			expect(await mode.handleGuidedGoalCommand("ship it")).toBe(false);

			expect(warnings).toEqual(["Goal mode is disabled. Enable it in settings (goal.enabled)."]);
			expect(prompt).not.toHaveBeenCalled();
		});

		it("points an active goal at /goal instead of interviewing", async () => {
			await boot();
			await startGoal();
			const prompt = spyOn(session, "prompt");

			expect(await mode.handleGuidedGoalCommand("another")).toBe(false);

			expect(statuses).toEqual(["Goal mode is already active. Use /goal to manage it, or /goal drop to start over."]);
			expect(prompt).not.toHaveBeenCalled();
		});
	});

	describe("a toolset that already holds the goal tool", () => {
		beforeEach(() => {
			spyOn(AgentSession.prototype, "getEnabledToolNames").mockReturnValue(["read", "goal"]);
		});

		it("restores a saved goal without listing the goal tool twice", async () => {
			await boot({ prepare: sm => void sm.appendModeChange("goal", { goal: goal() }) });

			expect(toolSets().at(-1)).toEqual(["read", "goal"]);
		});

		it("enters a goal without listing the goal tool twice, and leaves only the rest on drop", async () => {
			await boot();
			await startGoal();
			expect(toolSets().at(-1)).toEqual(["read", "goal"]);

			expect(await mode.sessionModes.set({ mode: "goal", action: "drop" })).toMatchObject({ ok: true });

			expect(toolSets().at(-1)).toEqual(["read"]);
		});
	});

	describe("extension mode transitions", () => {
		it("announces a goal an extension enters, then one it resumes", async () => {
			await boot();

			const entered = await mode.sessionModes.set({ mode: "goal", action: "enter", objective: "ship it" });
			expect(entered).toMatchObject({ ok: true, changed: true });
			expect(statuses).toEqual(["Goal mode enabled."]);

			expect(await mode.sessionModes.set({ mode: "goal", action: "pause" })).toMatchObject({ ok: true });
			expect(mode.goalModePaused).toBe(true);
			statuses.length = 0;

			const resumed = await mode.sessionModes.set({ mode: "goal", action: "resume" });
			expect(resumed).toMatchObject({ ok: true, changed: true });
			expect(mode.goalModeEnabled).toBe(true);
			expect(statuses).toEqual(["Goal mode resumed."]);
		});
	});
});
