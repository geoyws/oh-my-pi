import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * A user model switch queued mid-turn shares InteractiveMode's single pending
 * slot with plan-mode's deferred transitions: the latest switch of either origin
 * wins, and dropping a stale plan-role switch never discards the user's pick.
 */
describe("user model switch queued alongside plan mode", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let modelRegistry: ModelRegistry;
	let isStreaming: boolean;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-user-model-switch-plan-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const defaultModel = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!defaultModel) throw new Error("Expected claude-sonnet-4-5 in registry");
		session = new AgentSession({
			agent: new Agent({
				initialState: { model: defaultModel, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		isStreaming = false;
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => isStreaming });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		HistoryStorage.close();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	/** Enter plan mode and pick a replacement plan model plus a distinct user target. */
	async function enterPlanMode(): Promise<{ activePlan: Model; replacementPlan: Model; userTarget: Model }> {
		await mode.init({ suppressWelcomeIntro: true });
		await mode.handlePlanModeCommand();
		const activePlan = session.model;
		const candidates = ["claude-haiku-4-5", "claude-opus-4-5", "claude-sonnet-4-5"].map(id =>
			modelRegistry.find("anthropic", id),
		);
		if (!activePlan || candidates.some(candidate => !candidate)) throw new Error("Expected plan models");
		const others = (candidates as Model[]).filter(candidate => !modelsAreEqual(candidate, activePlan));
		return { activePlan, replacementPlan: others[0], userTarget: others[1] };
	}

	const roleValue = (model: Model) => `${model.provider}/${model.id}`;

	it("keeps a queued user switch when a stale plan-role switch is dropped", async () => {
		const { activePlan, replacementPlan, userTarget } = await enterPlanMode();
		isStreaming = true;

		session.settings.setModelRole("plan", roleValue(replacementPlan));
		await Promise.resolve();
		expect(mode.getPendingModelSwitch()).toMatchObject({ source: "plan", model: replacementPlan });

		// The user's pick replaces the queued plan switch (last write wins).
		await mode.switchSessionModel(userTarget);
		expect(mode.getPendingModelSwitch()).toMatchObject({ source: "user", model: userTarget });

		// Restoring the plan role drops only plan-origin switches.
		session.settings.setModelRole("plan", roleValue(activePlan));
		await Promise.resolve();
		expect(mode.getPendingModelSwitch()).toMatchObject({ source: "user", model: userTarget });

		const setModelTemporary = vi.spyOn(session, "setModelTemporary").mockResolvedValue(undefined);
		isStreaming = false;
		await mode.flushPendingModelSwitch();

		expect(setModelTemporary).toHaveBeenCalledTimes(1);
		expect(setModelTemporary.mock.calls[0]?.[0]).toBe(userTarget);
		expect(mode.getPendingModelSwitch()).toBeUndefined();
	});

	it("lets a later plan-role reassignment replace a queued user switch", async () => {
		const { replacementPlan, userTarget } = await enterPlanMode();
		isStreaming = true;

		await mode.switchSessionModel(userTarget);
		session.settings.setModelRole("plan", roleValue(replacementPlan));
		await Promise.resolve();
		expect(mode.getPendingModelSwitch()).toMatchObject({ source: "plan", model: replacementPlan });

		const setModelTemporary = vi.spyOn(session, "setModelTemporary").mockResolvedValue(undefined);
		isStreaming = false;
		await mode.flushPendingModelSwitch();

		expect(setModelTemporary).toHaveBeenCalledTimes(1);
		expect(setModelTemporary).toHaveBeenCalledWith(replacementPlan, undefined);
	});

	it("notifies pending-switch subscribers when a switch is queued and flushed", async () => {
		const { userTarget } = await enterPlanMode();
		const listener = vi.fn();
		const unsubscribe = mode.onPendingModelSwitchChange(listener);
		isStreaming = true;

		await mode.switchSessionModel(userTarget);
		expect(listener).toHaveBeenCalledTimes(1);

		vi.spyOn(session, "setModelTemporary").mockResolvedValue(undefined);
		isStreaming = false;
		await mode.flushPendingModelSwitch();
		expect(listener).toHaveBeenCalledTimes(2);
		unsubscribe();
	});
});
