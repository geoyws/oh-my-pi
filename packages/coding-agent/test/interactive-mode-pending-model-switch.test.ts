import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import * as modelHubModule from "@oh-my-pi/pi-tui/overlays/model-hub";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * A user model switch made while a turn streams is queued for the turn's
 * settle and shown on the model chip (`A -> B (after this turn)`), instead of
 * flipping the live model mid-turn. Drives the real InteractiveMode router
 * with the main turn faked as streaming.
 */
describe("queued user model switch", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let isStreaming: boolean;
	let sonnet: Model;
	let opus: Model;
	let haiku: Model;
	/** Live main-session listeners, so tests can deliver session events. */
	let listeners: Array<(event: AgentSessionEvent) => unknown>;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-pending-model-switch-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const find = (id: string): Model => {
			const model = modelRegistry.find("anthropic", id);
			if (!model) throw new Error(`Expected anthropic/${id} in registry`);
			return model;
		};
		sonnet = find("claude-sonnet-4-5");
		opus = find("claude-opus-4-5");
		haiku = find("claude-haiku-4-5");

		session = new AgentSession({
			agent: new Agent({ initialState: { model: sonnet, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		// Default ctrl+p order is smol -> default -> slow: from default, forward
		// lands on slow (opus), then smol (haiku), then wraps to default (sonnet).
		session.settings.setModelRole("default", "anthropic/claude-sonnet-4-5");
		session.settings.setModelRole("slow", "anthropic/claude-opus-4-5");
		session.settings.setModelRole("smol", "anthropic/claude-haiku-4-5");

		isStreaming = true;
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => isStreaming });
		// The real switch path refreshes provider metadata; the test only needs the
		// live model pointer to move when the queued switch finally applies.
		vi.spyOn(session, "applyRoleModel").mockImplementation(async entry => {
			session.agent.setModel(entry.model);
		});

		listeners = [];
		const subscribe = session.subscribe.bind(session);
		vi.spyOn(session, "subscribe").mockImplementation(listener => {
			listeners.push(listener);
			const unsubscribe = subscribe(listener);
			return () => {
				listeners = listeners.filter(entry => entry !== listener);
				unsubscribe();
			};
		});

		mode = new InteractiveMode(session, "test");
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

	const chip = () => Bun.stripANSI(mode.statusLine.renderBottomBar(400, "full"));
	const name = (model: Model) => (model.name.startsWith("Claude ") ? model.name.slice(7) : model.name);
	const selector = (model: Model) => `${model.provider}/${model.id}`;
	const expectPendingChip = (from: Model, to: Model) => {
		expect(chip()).toContain(`${name(from)} -> ${name(to)} (after this turn)`);
	};
	const statusLines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(([message]) => String(message));
	/** Pretend a subagent view is focused: the event controller follows that view, not main. */
	const focusSubagent = () => {
		Object.defineProperty(mode, "focusedAgentId", { configurable: true, get: () => "worker-1" });
	};
	const emitMainEvent = async (event: AgentSessionEvent) => {
		for (const listener of [...listeners]) await listener(event);
	};
	const abortedAgentEnd = (): AgentSessionEvent =>
		({
			type: "agent_end",
			messages: [{ role: "assistant", content: [], stopReason: "aborted" } as unknown as AssistantMessage],
		}) as AgentSessionEvent;
	/** Open the model hub with a stub component and hand back the controller's real callbacks. */
	const openHub = (): modelHubModule.ModelHubCallbacks => {
		let callbacks: modelHubModule.ModelHubCallbacks | undefined;
		vi.spyOn(modelHubModule, "ModelHubComponent").mockImplementation(function (this: unknown, ...args: unknown[]) {
			callbacks = args[4] as modelHubModule.ModelHubCallbacks;
			return {
				render: () => [],
				invalidate: () => {},
				handleInput: () => {},
				dispose: () => {},
				refreshAfterExternalMutation: () => {},
			};
		} as never);
		mode.showModelSelector();
		if (!callbacks) throw new Error("model hub did not open");
		return callbacks;
	};

	it("queues ctrl+p while streaming, shows it on the chip, and applies it once at settle", async () => {
		const showStatus = vi.spyOn(mode, "showStatus");

		await mode.cycleRoleModel("forward");

		// Acceptance 1/2: nothing switched mid-turn; chip and chat announce the queue.
		expect(session.applyRoleModel).not.toHaveBeenCalled();
		expect(session.model?.id).toBe(sonnet.id);
		expect(mode.pendingUserModelSwitch?.model.id).toBe(opus.id);
		expectPendingChip(sonnet, opus);
		expect(showStatus).toHaveBeenCalledWith(
			`Model switch queued for after this turn: ${selector(sonnet)} -> ${selector(opus)}`,
		);

		// Acceptance 4: a second press advances from the queued target, replacing it.
		await mode.cycleRoleModel("forward");
		expect(session.applyRoleModel).not.toHaveBeenCalled();
		expect(mode.pendingUserModelSwitch?.model.id).toBe(haiku.id);
		expectPendingChip(sonnet, haiku);
		expect(chip()).not.toContain(name(opus));

		// Acceptance 3: the turn settles; the switch applies exactly once.
		isStreaming = false;
		await mode.flushPendingModelSwitch();
		await mode.flushPendingModelSwitch();

		expect(session.applyRoleModel).toHaveBeenCalledTimes(1);
		expect(session.applyRoleModel).toHaveBeenCalledWith(expect.objectContaining({ role: "smol" }));
		expect(session.model?.id).toBe(haiku.id);
		expect(mode.pendingUserModelSwitch).toBeUndefined();
		expect(chip()).toContain(name(haiku));
		expect(chip()).not.toContain("->");
		expect(statusLines(showStatus).filter(line => line.startsWith("Model switched to"))).toEqual([
			`Model switched to ${selector(haiku)}`,
		]);
	});

	it("applies ctrl+p immediately when no turn is running", async () => {
		isStreaming = false;
		const cycleRoleModels = vi.spyOn(session, "cycleRoleModels");

		await mode.cycleRoleModel("forward");

		expect(cycleRoleModels).toHaveBeenCalledTimes(1);
		expect(session.model?.id).toBe(opus.id);
		expect(mode.pendingUserModelSwitch).toBeUndefined();
		expect(chip()).not.toContain("(after this turn)");
	});

	it("cancels the queue instead of queueing `A -> A` when ctrl+p wraps back to the live model", async () => {
		const showStatus = vi.spyOn(mode, "showStatus");

		await mode.cycleRoleModel("forward"); // -> opus
		await mode.cycleRoleModel("forward"); // -> haiku
		await mode.cycleRoleModel("forward"); // -> sonnet, the live model

		expect(mode.pendingUserModelSwitch).toBeUndefined();
		expect(chip()).not.toContain("(after this turn)");
		expect(statusLines(showStatus)).toContain(`Queued model switch cancelled; staying on ${selector(sonnet)}`);
		expect(statusLines(showStatus).some(line => line.includes(`-> ${selector(sonnet)}`))).toBe(false);

		isStreaming = false;
		await mode.flushPendingModelSwitch();
		expect(session.applyRoleModel).not.toHaveBeenCalled();
	});

	it("an idle switch drops a switch left queued from the earlier turn", async () => {
		await mode.cycleRoleModel("forward");
		expect(mode.pendingUserModelSwitch?.model.id).toBe(opus.id);

		// Main idled without a flush (e.g. it settled while another view was focused).
		isStreaming = false;
		await mode.cycleRoleModel("backward"); // idle: default -> smol applies now
		expect(session.model?.id).toBe(haiku.id);
		expect(mode.pendingUserModelSwitch).toBeUndefined();

		await mode.flushPendingModelSwitch();
		expect(session.model?.id).toBe(haiku.id);
		expect(session.applyRoleModel).not.toHaveBeenCalled();
	});

	it("applies the queued switch when main settles while a subagent view is focused", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		await mode.cycleRoleModel("forward");
		expect(mode.pendingUserModelSwitch?.model.id).toBe(opus.id);

		// Focusing a subagent moves the event controller onto that view, so main's
		// agent_end never reaches the event controller's flush sites.
		focusSubagent();
		mode.unsubscribe?.();
		const applied = Promise.withResolvers<void>();
		vi.spyOn(session, "applyRoleModel").mockImplementation(async entry => {
			session.agent.setModel(entry.model);
			applied.resolve();
		});
		isStreaming = false;
		await emitMainEvent({ type: "agent_end", messages: [] } as AgentSessionEvent);
		// The main-session listener flushes fire-and-forget; wait for the switch itself.
		await applied.promise;

		expect(session.applyRoleModel).toHaveBeenCalledTimes(1);
		expect(session.model?.id).toBe(opus.id);
		expect(mode.pendingUserModelSwitch).toBeUndefined();
	});

	it("keeps the switch across an Esc abort and applies it once at the settle", async () => {
		const showStatus = vi.spyOn(mode, "showStatus");
		await mode.cycleRoleModel("forward");

		// Esc: the turn is aborted; the queued switch survives until the settle.
		await session.abort();
		expect(mode.pendingUserModelSwitch?.model.id).toBe(opus.id);

		isStreaming = false;
		await mode.eventController.handleEvent(abortedAgentEnd());
		await mode.eventController.handleEvent(abortedAgentEnd());

		expect(session.applyRoleModel).toHaveBeenCalledTimes(1);
		expect(session.model?.id).toBe(opus.id);
		expect(statusLines(showStatus).filter(line => line.startsWith("Model switched to"))).toEqual([
			`Model switched to ${selector(opus)}`,
		]);
	});

	it("keeps the switch for the next settle when a superseded agent_end lands after a new turn started", async () => {
		await mode.cycleRoleModel("forward");

		// The follow-up turn is already streaming when the old turn's agent_end arrives.
		await mode.eventController.handleEvent({ type: "agent_end", messages: [] } as AgentSessionEvent);
		await mode.flushPendingModelSwitch();
		expect(session.applyRoleModel).not.toHaveBeenCalled();
		expect(mode.pendingUserModelSwitch?.model.id).toBe(opus.id);
		expectPendingChip(sonnet, opus);

		isStreaming = false;
		await mode.eventController.handleEvent({ type: "agent_end", messages: [] } as AgentSessionEvent);
		expect(session.applyRoleModel).toHaveBeenCalledTimes(1);
		expect(session.model?.id).toBe(opus.id);
	});

	it("plan entry mid-turn absorbs the queued switch as the model to restore, and replays it in full on exit", async () => {
		const showStatus = vi.spyOn(mode, "showStatus");
		await mode.cycleRoleModel("forward");
		vi.spyOn(session, "resolveRoleModelWithThinking").mockReturnValue({
			model: haiku,
			thinkingLevel: undefined,
			explicitThinkingLevel: false,
			warning: undefined,
		});
		vi.spyOn(session, "sendPlanModeContext").mockResolvedValue(undefined);
		const setModelTemporary = vi.spyOn(session, "setModelTemporary").mockResolvedValue(undefined);

		await mode.handlePlanModeCommand();
		expect(mode.planModeEnabled).toBe(true);
		expect(mode.pendingUserModelSwitch).toBeUndefined();
		expect(statusLines(showStatus)).toContain(
			`Queued model switch to ${selector(opus)} replaced by plan mode; it is restored when plan mode exits`,
		);

		// The settle applies the plan model; exiting plan mode then replays the
		// user's queued switch itself (role and thinking included), not a bare swap.
		isStreaming = false;
		await mode.flushPendingModelSwitch();
		expect(setModelTemporary).toHaveBeenLastCalledWith(haiku, undefined);
		vi.spyOn(mode, "showHookConfirm").mockResolvedValue(true);
		await mode.handlePlanModeCommand();
		expect(mode.planModeEnabled).toBe(false);
		expect(setModelTemporary).toHaveBeenCalledTimes(1);
		expect(session.applyRoleModel).toHaveBeenCalledTimes(1);
		expect(session.applyRoleModel).toHaveBeenCalledWith(expect.objectContaining({ role: "slow", model: opus }));
		expect(session.model?.id).toBe(opus.id);
		expect(statusLines(showStatus)).toContain(`Model switched to ${selector(opus)}`);
	});

	it("plan exit mid-turn re-queues the absorbed user switch on the chip", async () => {
		await mode.cycleRoleModel("forward");
		vi.spyOn(session, "resolveRoleModelWithThinking").mockReturnValue({
			model: haiku,
			thinkingLevel: undefined,
			explicitThinkingLevel: false,
			warning: undefined,
		});
		vi.spyOn(session, "sendPlanModeContext").mockResolvedValue(undefined);
		vi.spyOn(session, "setModelTemporary").mockResolvedValue(undefined);
		await mode.handlePlanModeCommand();
		expect(mode.pendingUserModelSwitch).toBeUndefined();

		vi.spyOn(mode, "showHookConfirm").mockResolvedValue(true);
		await mode.handlePlanModeCommand();
		expect(mode.planModeEnabled).toBe(false);
		expect(mode.pendingUserModelSwitch).toEqual({ model: opus, role: "slow" });
		expectPendingChip(sonnet, opus);

		isStreaming = false;
		await mode.flushPendingModelSwitch();
		expect(session.applyRoleModel).toHaveBeenCalledTimes(1);
		expect(session.applyRoleModel).toHaveBeenCalledWith(expect.objectContaining({ role: "slow" }));
		expect(session.model?.id).toBe(opus.id);
	});

	it("picking the live model while only a plan switch is queued keeps it and does not claim a cancel", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		mode.planModeEnabled = true;
		// Mid-turn plan-role reassignment queues a silent plan-role switch to haiku.
		session.settings.setModelRole("plan", "anthropic/claude-haiku-4-5");
		await Promise.resolve();
		const setModelTemporary = vi.spyOn(session, "setModelTemporary").mockResolvedValue(undefined);
		const showStatus = vi.spyOn(mode, "showStatus");

		await executeBuiltinSlashCommand(`/model ${selector(sonnet)}`, { ctx: mode } as never);

		expect(statusLines(showStatus).at(-1)).toBe(`Already on ${selector(sonnet)}`);
		expect(statusLines(showStatus).some(line => line.startsWith("Queued model switch cancelled"))).toBe(false);
		isStreaming = false;
		await mode.flushPendingModelSwitch();
		expect(setModelTemporary).toHaveBeenCalledTimes(1);
		expect(setModelTemporary).toHaveBeenCalledWith(haiku, undefined);
	});

	it("/model <selector> queues on the main session even while a subagent view is focused", async () => {
		focusSubagent();
		const showStatus = vi.spyOn(mode, "showStatus");
		const setModel = vi.spyOn(session, "setModel");

		await executeBuiltinSlashCommand(`/model ${selector(opus)}`, { ctx: mode } as never);

		expect(setModel).not.toHaveBeenCalled();
		expect(mode.pendingUserModelSwitch?.model.id).toBe(opus.id);
		expect(statusLines(showStatus)).toContain(
			`Model switch queued for after this turn: ${selector(sonnet)} -> ${selector(opus)}`,
		);
		expect(statusLines(showStatus).some(line => line.startsWith("Model set to"))).toBe(false);

		isStreaming = false;
		await mode.flushPendingModelSwitch();
		expect(setModel).toHaveBeenCalledTimes(1);
		expect(session.model?.id).toBe(opus.id);
		expect(statusLines(showStatus)).toContain(`Model switched to ${selector(opus)}`);
	});

	it("/model <selector> while idle switches now and reports `Model set to ...`", async () => {
		isStreaming = false;
		const showStatus = vi.spyOn(mode, "showStatus");

		await executeBuiltinSlashCommand(`/model ${selector(opus)}`, { ctx: mode } as never);

		expect(session.model?.id).toBe(opus.id);
		expect(mode.pendingUserModelSwitch).toBeUndefined();
		expect(statusLines(showStatus)).toContain(`Model set to ${selector(opus)}.`);
	});

	it("prints no success line when the queued switch reports it did not switch", async () => {
		const showStatus = vi.spyOn(mode, "showStatus");
		vi.spyOn(session, "setModel").mockResolvedValue({ switched: false });

		await executeBuiltinSlashCommand(`/model ${selector(opus)}`, { ctx: mode } as never);
		isStreaming = false;
		await mode.flushPendingModelSwitch();

		expect(session.setModel).toHaveBeenCalledTimes(1);
		expect(mode.pendingUserModelSwitch).toBeUndefined();
		expect(statusLines(showStatus).some(line => line.startsWith("Model switched to"))).toBe(false);
	});

	it("model hub default assignment while focused: persists now, queues only the live switch", async () => {
		const setModel = vi.spyOn(session, "setModel");
		const showStatus = vi.spyOn(mode, "showStatus");

		// The hub only opens on the main view; the subagent is focused while it is up.
		const callbacks = openHub();
		focusSubagent();
		expect(await callbacks.onAssign(opus, "default", undefined, selector(opus))).toBe(true);

		// The role assignment is recorded at assign time; only the live switch waits.
		expect(session.settings.getModelRole("default")).toContain(opus.id);
		expect(setModel).not.toHaveBeenCalled();
		expect(mode.pendingUserModelSwitch?.model.id).toBe(opus.id);
		// One visible line states both the role write and the queued live switch.
		expect(statusLines(showStatus).at(-1)).toBe(
			`Default model: ${selector(opus)}. Model switch queued for after this turn: ${selector(sonnet)} -> ${selector(opus)}`,
		);

		// A later switch replaces the queued live switch, never the persisted role.
		await mode.cycleRoleModel("backward");
		expect(mode.pendingUserModelSwitch?.model.id).toBe(haiku.id);
		expect(session.settings.getModelRole("default")).toContain(opus.id);

		isStreaming = false;
		await mode.flushPendingModelSwitch();
		expect(setModel).not.toHaveBeenCalled();
		expect(session.applyRoleModel).toHaveBeenCalledTimes(1);
		expect(session.settings.getModelRole("default")).toContain(opus.id);
	});

	it("model hub default assignment back onto the live model mid-turn keeps the cancel notice visible", async () => {
		const showStatus = vi.spyOn(mode, "showStatus");
		const callbacks = openHub();
		expect(await callbacks.onAssign(opus, "default", undefined, selector(opus))).toBe(true);
		expect(await callbacks.onAssign(sonnet, "default", undefined, selector(sonnet))).toBe(true);

		expect(mode.pendingUserModelSwitch).toBeUndefined();
		expect(session.settings.getModelRole("default")).toContain(sonnet.id);
		expect(statusLines(showStatus).at(-1)).toBe(
			`Default model: ${selector(sonnet)}. Queued model switch cancelled; staying on ${selector(sonnet)}`,
		);
	});

	it("model hub default assignment mid-turn refuses a model without credentials and persists nothing", async () => {
		const callbacks = openHub();
		const showError = vi.spyOn(mode, "showError");
		vi.spyOn(session.modelRegistry, "hasConfiguredAuth").mockImplementation(model => model.id !== opus.id);

		expect(await callbacks.onAssign(opus, "default", undefined, selector(opus))).toBe(false);

		expect(showError).toHaveBeenCalledWith(`No API key for ${selector(opus)}`);
		expect(session.settings.getModelRole("default")).toBe("anthropic/claude-sonnet-4-5");
		expect(mode.pendingUserModelSwitch).toBeUndefined();
		expect(chip()).not.toContain("(after this turn)");
	});

	it("model hub unassign of the default role mid-turn clears it now and queues the live switch", async () => {
		// A project default shadowed by nothing once the global one is cleared.
		session.settings.setProjectModelRole("default", "anthropic/claude-opus-4-5");
		const setModel = vi.spyOn(session, "setModel");
		const showStatus = vi.spyOn(mode, "showStatus");
		const callbacks = openHub();

		await callbacks.onUnassign("default");

		// The clear is recorded at once; the live model waits for the settle.
		expect(session.settings.getModelRoleProvenance("default")).toBe("project");
		expect(setModel).not.toHaveBeenCalled();
		expect(session.model?.id).toBe(sonnet.id);
		expect(mode.pendingUserModelSwitch?.model.id).toBe(opus.id);
		expectPendingChip(sonnet, opus);
		expect(statusLines(showStatus).at(-1)).toBe(
			`Default model: ${selector(opus)}. Model switch queued for after this turn: ${selector(sonnet)} -> ${selector(opus)}`,
		);

		isStreaming = false;
		await mode.flushPendingModelSwitch();
		expect(setModel).toHaveBeenCalledTimes(1);
		expect(setModel).toHaveBeenCalledWith(opus, "default", expect.objectContaining({ persist: false }));
		expect(session.model?.id).toBe(opus.id);
		expect(statusLines(showStatus)).toContain(`Model switched to ${selector(opus)}`);
	});

	it("a non-plan role edit in plan mode keeps the queued user switch; a plan-role edit says so", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		// The plan model (haiku) differs from the live model, so an unguarded
		// reconcile would queue a plan-role switch over the user's entry.
		session.settings.setModelRole("plan", "anthropic/claude-haiku-4-5");
		// Role listeners run on the next microtask.
		await Promise.resolve();
		const showStatus = vi.spyOn(mode, "showStatus");
		mode.planModeEnabled = true;
		await mode.cycleRoleModel("forward");
		expect(mode.pendingUserModelSwitch?.model.id).toBe(opus.id);

		session.settings.setModelRole("smol", "anthropic/claude-sonnet-4-5");
		await Promise.resolve();
		expect(mode.pendingUserModelSwitch?.model.id).toBe(opus.id);
		expect(statusLines(showStatus).some(line => line.startsWith("Plan role changed"))).toBe(false);

		session.settings.setModelRole("plan", "anthropic/claude-sonnet-4-5");
		await Promise.resolve();
		expect(mode.pendingUserModelSwitch?.model.id).toBe(opus.id);
		expect(statusLines(showStatus)).toContain(`Plan role changed; keeping the queued switch to ${selector(opus)}`);
	});

	it("drops a queued user switch on session teardown but keeps it across focus retargeting", async () => {
		await mode.cycleRoleModel("forward");
		expect(mode.pendingUserModelSwitch?.model.id).toBe(opus.id);

		mode.clearTransientSessionUi({ keepPendingModelSwitch: true });
		expect(mode.pendingUserModelSwitch?.model.id).toBe(opus.id);

		mode.clearTransientSessionUi();
		expect(mode.pendingUserModelSwitch).toBeUndefined();
		expect(chip()).not.toContain("(after this turn)");

		isStreaming = false;
		await mode.flushPendingModelSwitch();
		expect(session.applyRoleModel).not.toHaveBeenCalled();
	});
});
