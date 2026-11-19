/**
 * InteractiveMode goal commands from line 7401: the guided-goal kickoff, the
 * `/goal` subcommands and menu, and the objective start/replace paths, run
 * against the real goal runtime of a temp-dir session.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import * as path from "node:path";
import { Agent, AgentBusyError } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgGoalEnabled } from "@oh-my-pi/pi-coding-agent/goals/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { UserMessageRefusedError } from "@oh-my-pi/pi-coding-agent/session/user-message-refused-error";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

const image: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };

describe("InteractiveMode goal commands (lines 7401-7685)", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession;
	let mode: InteractiveMode;
	let warnings: string[];
	let statuses: string[];
	let errors: string[];

	async function freshMode(): Promise<void> {
		if (mode) {
			mode.stop();
			await session.dispose();
		}
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		cfgGoalEnabled.set(session.settings, true);
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, new EventBus());
		warnings = [];
		statuses = [];
		errors = [];
		spyOn(mode, "showWarning").mockImplementation(message => void warnings.push(message));
		spyOn(mode, "showStatus").mockImplementation(message => void statuses.push(message));
		spyOn(mode, "showError").mockImplementation(message => void errors.push(message));
	}

	// bun's spyOn cannot wrap accessors yet: stub prototype getters by hand and restore them after each test.
	const stubbedGetters: Array<{ proto: object; prop: string; descriptor: PropertyDescriptor }> = [];
	function stubGetter(proto: object, prop: string, get: () => unknown): void {
		const descriptor = Object.getOwnPropertyDescriptor(proto, prop);
		if (!descriptor) throw new Error(`no accessor ${prop}`);
		stubbedGetters.push({ proto, prop, descriptor });
		Object.defineProperty(proto, prop, { ...descriptor, get });
	}
	function streaming(value: boolean): void {
		stubGetter(AgentSession.prototype, "isStreaming", () => value);
	}

	/** Start a real goal through `/goal <objective>` on an idle session with no input callback. */
	async function startGoal(objective = "ship the release"): Promise<void> {
		expect(await mode.handleGoalModeCommand(objective)).toBe(false);
		expect(mode.goalModeEnabled).toBe(true);
		statuses.length = 0;
	}

	async function pauseGoal(): Promise<void> {
		await startGoal();
		await mode.handleGoalModeCommand("pause");
		expect(mode.goalModeEnabled).toBe(false);
		expect(session.getGoalModeState()?.goal?.status).toBe("paused");
		statuses.length = 0;
	}

	beforeAll(async () => {
		await initTheme();
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-im-r7401-goal-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(() => {
		for (const { proto, prop, descriptor } of stubbedGetters.splice(0).reverse()) {
			Object.defineProperty(proto, prop, descriptor);
		}
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	describe("/guided-goal kickoff", () => {
		it("refuses while a paused goal is waiting", async () => {
			await freshMode();
			await pauseGoal();
			const prompt = spyOn(session, "prompt");

			expect(await mode.handleGuidedGoalCommand("another")).toBe(false);

			expect(warnings).toEqual(["Resume the current goal first, or drop it before setting a new objective."]);
			expect(prompt).not.toHaveBeenCalled();
		});

		it("gates the objective and images, exposes the goal tool and sends the kickoff with the images", async () => {
			await freshMode();
			const gate = spyOn(session, "gateUserMessage");
			const setTools = spyOn(session, "setActiveToolsByName");
			const prompt = spyOn(session, "prompt").mockResolvedValue(true);

			expect(await mode.handleGuidedGoalCommand("  ship the release  ", { images: [image] })).toBe(true);

			expect(gate).toHaveBeenCalledWith("ship the release", [image], "interactive");
			expect(setTools.mock.calls[0]?.[0]).toContain("goal");
			const [kickoff, options] = prompt.mock.calls[0] ?? [];
			expect(kickoff).toContain("ship the release");
			expect(options).toEqual({ synthetic: true, images: [image] });
			expect(mode.isGuidedGoalInterviewActive()).toBe(true);
		});

		it("skips the gate for a bare call and leaves an already-exposed goal tool alone", async () => {
			await freshMode();
			spyOn(session, "getEnabledToolNames").mockReturnValue(["read", "goal"]);
			const gate = spyOn(session, "gateUserMessage");
			const setTools = spyOn(session, "setActiveToolsByName");
			const prompt = spyOn(session, "prompt").mockResolvedValue(true);

			expect(await mode.handleGuidedGoalCommand(undefined, { images: [] })).toBe(true);

			expect(gate).not.toHaveBeenCalled();
			expect(setTools).not.toHaveBeenCalled();
			expect(prompt.mock.calls[0]?.[1]).toEqual({ synthetic: true });
		});

		it("queues the kickoff as a follow-up behind a streaming turn", async () => {
			await freshMode();
			streaming(true);
			const followUp = spyOn(session, "followUp").mockResolvedValue();
			const prompt = spyOn(session, "prompt");

			expect(await mode.handleGuidedGoalCommand("ship it")).toBe(true);

			expect(prompt).not.toHaveBeenCalled();
			expect(followUp).toHaveBeenCalledWith(expect.stringContaining("ship it"), undefined, { synthetic: true });
		});

		it("falls back to a follow-up when the agent turns out to be busy", async () => {
			await freshMode();
			spyOn(session, "prompt").mockRejectedValue(new AgentBusyError());
			const followUp = spyOn(session, "followUp").mockResolvedValue();

			expect(await mode.handleGuidedGoalCommand("ship it", { images: [image] })).toBe(true);

			expect(followUp).toHaveBeenCalledWith(expect.stringContaining("ship it"), [image], { synthetic: true });
		});

		it("reports any other kickoff failure and ends the interview", async () => {
			await freshMode();
			spyOn(session, "prompt").mockRejectedValue(new Error("provider down"));

			expect(await mode.handleGuidedGoalCommand("ship it")).toBe(false);

			expect(errors).toEqual(["provider down"]);
			expect(mode.isGuidedGoalInterviewActive()).toBe(false);
		});

		it("reports a non-Error failure as text", async () => {
			await freshMode();
			spyOn(session, "prompt").mockRejectedValue("socket closed");

			expect(await mode.handleGuidedGoalCommand("ship it")).toBe(false);

			expect(errors).toEqual(["socket closed"]);
		});

		it("rethrows a refused objective so the editor restores the command", async () => {
			await freshMode();
			const refusal = new UserMessageRefusedError("blocked by policy" as never);
			spyOn(session, "gateUserMessage").mockRejectedValue(refusal);
			const prompt = spyOn(session, "prompt");

			await expect(mode.handleGuidedGoalCommand("ship it")).rejects.toBe(refusal);

			expect(prompt).not.toHaveBeenCalled();
			expect(errors).toEqual([]);
		});
	});

	describe("/goal subcommands", () => {
		it("show reports no goal, then the objective, budget and status of a live goal", async () => {
			await freshMode();
			await mode.handleGoalModeCommand("show");
			expect(statuses).toEqual(["No goal set."]);

			await startGoal("ship the release");
			await mode.handleGoalModeCommand("show");
			const [details] = statuses.splice(0);
			expect(details).toContain("Objective: ship the release");
			expect(details).toContain("Status: active\n");
			expect(details).toContain("(no budget)");

			await mode.handleGoalModeCommand("budget 1000");
			statuses.length = 0;
			await mode.handleGoalModeCommand("show");
			expect(statuses[0]).toMatch(/Tokens: 0 \/ 1,000 \(1,000 left\)/);
		});

		it("show marks a paused goal", async () => {
			await freshMode();
			await pauseGoal();

			await mode.handleGoalModeCommand("show");

			expect(statuses[0]).toContain("Status: paused (paused)");
		});

		it("pause warns without a goal and otherwise pauses through goal-mode exit", async () => {
			await freshMode();
			await mode.handleGoalModeCommand("pause");
			expect(warnings).toEqual(["No active goal to pause."]);

			await startGoal();
			await mode.handleGoalModeCommand("pause");

			expect(mode.goalModeEnabled).toBe(false);
			expect(mode.goalModePaused).toBe(true);
			expect(statuses).toEqual(["Goal mode paused."]);
			expect(session.getEnabledToolNames()).not.toContain("goal");
		});

		it("resume warns without a paused goal and otherwise resumes it", async () => {
			await freshMode();
			await mode.handleGoalModeCommand("resume");
			expect(warnings).toEqual(["No paused goal to resume."]);

			await pauseGoal();
			await mode.handleGoalModeCommand("resume");

			expect(mode.goalModeEnabled).toBe(true);
			expect(session.getGoalModeState()?.goal?.status).toBe("active");
			expect(statuses).toEqual(["Goal mode resumed."]);
		});

		it("resume re-arms a held continuation on an active goal", async () => {
			await freshMode();
			await startGoal();
			const runtime = session.goalRuntime;
			stubGetter(Object.getPrototypeOf(runtime), "continuationSuppressed", () => true);
			const rearm = spyOn(runtime, "rearmContinuation");

			await mode.handleGoalModeCommand("resume");

			expect(rearm).toHaveBeenCalledTimes(1);
			expect(statuses).toEqual(["Goal continuation resumed."]);
		});

		it("drop warns without a goal, keeps it when not confirmed and drops it when confirmed", async () => {
			await freshMode();
			await mode.handleGoalModeCommand("drop");
			expect(warnings).toEqual(["No goal to drop."]);

			await startGoal();
			const confirm = spyOn(mode, "showHookConfirm").mockResolvedValueOnce(false).mockResolvedValueOnce(true);
			await mode.handleGoalModeCommand("drop");
			expect(mode.goalModeEnabled).toBe(true);

			await mode.handleGoalModeCommand("drop");

			expect(confirm).toHaveBeenCalledTimes(2);
			expect(confirm.mock.calls[0]?.[0]).toBe("Drop goal?");
			expect(mode.goalModeEnabled).toBe(false);
			expect(session.getGoalModeState()).toBeUndefined();
			expect(statuses).toEqual(["Goal dropped."]);
		});

		it("drop also clears a paused goal", async () => {
			await freshMode();
			await pauseGoal();
			spyOn(mode, "showHookConfirm").mockResolvedValue(true);

			await mode.handleGoalModeCommand("drop");

			expect(session.getGoalModeState()).toBeUndefined();
			expect(mode.goalModePaused).toBe(false);
		});

		it("budget without an active goal names why", async () => {
			await freshMode();
			await mode.handleGoalModeCommand("budget 10");
			expect(warnings).toEqual(["No active goal."]);

			await pauseGoal();
			await mode.handleGoalModeCommand("budget 10");
			expect(warnings.at(-1)).toBe("Resume the goal before adjusting the budget.");
		});

		it("budget with an amount sets it; bare budget prompts prefilled with the current amount", async () => {
			await freshMode();
			await startGoal();
			const editor = spyOn(mode, "showHookEditor")
				.mockResolvedValueOnce("  ")
				.mockResolvedValueOnce(" 750 ")
				.mockResolvedValueOnce(undefined);

			await mode.handleGoalModeCommand("budget 500");
			expect(statuses).toEqual(["Goal budget set to 500."]);

			await mode.handleGoalModeCommand("budget");
			await mode.handleGoalModeCommand("budget");
			expect(statuses.at(-1)).toBe("Goal budget set to 750.");
			expect(session.getGoalModeState()?.goal?.tokenBudget).toBe(750);

			await mode.handleGoalModeCommand("budget off");
			await mode.handleGoalModeCommand("budget");

			expect(editor.mock.calls.map(call => call[1])).toEqual(["500", "500", ""]);
			expect(statuses.at(-1)).toBe("Goal budget cleared.");
		});
	});

	describe("/goal set and objective start", () => {
		it("set refuses while a paused goal is waiting", async () => {
			await freshMode();
			await pauseGoal();

			expect(await mode.handleGoalModeCommand("set new objective")).toBe(false);

			expect(warnings).toEqual(["Resume the current goal first, or drop it before setting a new objective."]);
		});

		it("bare set asks for the objective; an empty answer starts nothing", async () => {
			await freshMode();
			const editor = spyOn(mode, "showHookEditor")
				.mockResolvedValueOnce("   ")
				.mockResolvedValueOnce(" typed goal ");

			expect(await mode.handleGoalModeCommand("set")).toBe(false);
			expect(mode.goalModeEnabled).toBe(false);

			expect(await mode.handleGoalModeCommand("set")).toBe(false);

			expect(editor.mock.calls[0]?.[0]).toBe("Goal objective");
			expect(mode.goalModeEnabled).toBe(true);
			expect(session.getGoalModeState()?.goal?.objective).toBe("typed goal");
		});

		it("start hands the objective to the input callback as a draft-preserving submission", async () => {
			await freshMode();
			const submitted: unknown[] = [];
			mode.onInputCallback = input => void submitted.push(input);
			const start = spyOn(mode, "startPendingSubmission");

			expect(await mode.handleGoalModeCommand("set ship it", { images: [image] })).toBe(true);

			expect(start).toHaveBeenCalledWith({ text: "ship it", images: [image] }, { preserveDraft: true });
			expect(submitted).toHaveLength(1);
			expect(mode.goalModeEnabled).toBe(true);
		});

		it.each([
			["with images", [image], [image], 1],
			["without images", [], undefined, 0],
		] as const)("start steers the objective into a streaming turn %s", async (_label, images, sent, imageCount) => {
			await freshMode();
			streaming(true);
			spyOn(session, "sendGoalModeContext").mockResolvedValue();
			const prompt = spyOn(session, "prompt").mockResolvedValue(true);
			const local = spyOn(mode, "withLocalSubmission");

			expect(await mode.handleGoalModeCommand("ship it", { images: [...images] })).toBe(true);

			expect(local).toHaveBeenCalledWith("ship it", expect.any(Function), { imageCount });
			expect(prompt).toHaveBeenCalledWith("ship it", { streamingBehavior: "steer", images: sent });
		});

		it("set on an active goal replaces it and submits the new objective", async () => {
			await freshMode();
			await startGoal("old objective");
			const submitted: unknown[] = [];
			mode.onInputCallback = input => void submitted.push(input);

			expect(await mode.handleGoalModeCommand("set new objective")).toBe(true);

			expect(session.getGoalModeState()?.goal?.objective).toBe("new objective");
			expect(mode.goalModeEnabled).toBe(true);
			expect(mode.goalModePaused).toBe(false);
			expect(submitted).toHaveLength(1);
		});

		it("set on an active goal without an input callback replaces it and sends nothing", async () => {
			await freshMode();
			await startGoal("old objective");
			const prompt = spyOn(session, "prompt");

			expect(await mode.handleGoalModeCommand("set new objective")).toBe(false);

			expect(session.getGoalModeState()?.goal?.objective).toBe("new objective");
			expect(prompt).not.toHaveBeenCalled();
		});

		it.each([
			["with images", [image], [image], 1],
			["without images", [], undefined, 0],
		] as const)(
			"a replacement mid-stream re-sends goal context and steers the objective %s",
			async (_label, images, sent, imageCount) => {
				await freshMode();
				await startGoal("old objective");
				streaming(true);
				const context = spyOn(session, "sendGoalModeContext").mockResolvedValue();
				const prompt = spyOn(session, "prompt").mockResolvedValue(true);
				const local = spyOn(mode, "withLocalSubmission");

				expect(await mode.handleGoalModeCommand("set new objective", { images: [...images] })).toBe(true);

				expect(context).toHaveBeenCalledWith({ deliverAs: "steer" });
				expect(local).toHaveBeenCalledWith("new objective", expect.any(Function), { imageCount });
				expect(prompt).toHaveBeenCalledWith("new objective", { streamingBehavior: "steer", images: sent });
			},
		);
	});

	describe("goal menu", () => {
		it("does nothing when goal mode is flagged on without a goal record", async () => {
			await freshMode();
			mode.goalModeEnabled = true;
			const selector = spyOn(mode, "showHookSelector");

			await mode.handleGoalModeCommand("");

			expect(selector).not.toHaveBeenCalled();
		});

		it("titles an active goal with its truncated objective and status and offers active actions", async () => {
			await freshMode();
			const objective = "a".repeat(60);
			await startGoal(objective);
			const selector = spyOn(mode, "showHookSelector").mockResolvedValue(undefined);

			await mode.handleGoalModeCommand("");

			expect(selector).toHaveBeenCalledWith(`Goal: ${"a".repeat(47)}… (active)`, [
				"Show details",
				"Adjust budget…",
				"Pause",
				"Drop",
			]);
			expect(statuses).toEqual([]);
		});

		it("titles a paused goal and offers resume first", async () => {
			await freshMode();
			await pauseGoal();
			const selector = spyOn(mode, "showHookSelector").mockResolvedValue(undefined);

			await mode.handleGoalModeCommand("");

			expect(selector).toHaveBeenCalledWith("Goal paused: ship the release", [
				"Resume",
				"Show details",
				"Adjust budget…",
				"Drop",
			]);
		});

		it("routes each active-menu choice to its action", async () => {
			await freshMode();
			await startGoal("short goal");
			const selector = spyOn(mode, "showHookSelector");
			spyOn(mode, "showHookEditor").mockResolvedValue("300");
			spyOn(mode, "showHookConfirm").mockResolvedValue(true);

			selector.mockResolvedValueOnce("Show details");
			await mode.handleGoalModeCommand("");
			expect(statuses.splice(0)[0]).toContain("Objective: short goal");

			selector.mockResolvedValueOnce("Adjust budget…");
			await mode.handleGoalModeCommand("");
			expect(statuses.splice(0)).toEqual(["Goal budget set to 300."]);

			selector.mockResolvedValueOnce("Pause");
			await mode.handleGoalModeCommand("");
			expect(mode.goalModePaused).toBe(true);

			selector.mockResolvedValueOnce("Resume");
			await mode.handleGoalModeCommand("");
			expect(mode.goalModeEnabled).toBe(true);

			selector.mockResolvedValueOnce("Drop");
			await mode.handleGoalModeCommand("");
			expect(session.getGoalModeState()).toBeUndefined();
		});
	});

	describe("startGoalAtStartup", () => {
		it("gates the objective, enters goal mode and steers the first turn", async () => {
			await freshMode();
			const gate = spyOn(session, "gateUserMessage");
			const prompt = spyOn(session, "prompt").mockResolvedValue(true);

			await mode.startGoalAtStartup("ship the release");

			expect(gate).toHaveBeenCalledWith("ship the release", undefined, "interactive");
			expect(mode.goalModeEnabled).toBe(true);
			expect(prompt).toHaveBeenCalledWith("ship the release", { streamingBehavior: "steer" });
		});

		it("sends nothing when goal mode could not be entered", async () => {
			await freshMode();
			mode.vibeModeEnabled = true;
			const prompt = spyOn(session, "prompt");

			await mode.startGoalAtStartup("ship the release");

			expect(warnings).toEqual(["Exit vibe mode first."]);
			expect(prompt).not.toHaveBeenCalled();
		});
	});
});
