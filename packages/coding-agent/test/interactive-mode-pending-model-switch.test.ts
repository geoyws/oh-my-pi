import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
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
 * A user model switch made while a turn streams is queued for the turn's
 * settle and shown on the model chip (`A -> B (after this turn)`), instead of
 * flipping the live model mid-turn. Drives ctrl+p (`cycleRoleModel`) on a real
 * InteractiveMode with the turn faked as streaming.
 */
describe("queued user model switch (ctrl+p mid-turn)", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let isStreaming: boolean;
	let sonnet: Model;
	let opus: Model;
	let haiku: Model;

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
		// lands on slow (opus), then wraps to smol (haiku).
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
	// The thinking-level tail sits between `A -> B` and the dim trailer.
	const expectPendingChip = (from: Model, to: Model) => {
		const text = chip();
		expect(text).toContain(`${name(from)} -> ${name(to)}`);
		expect(text.indexOf("(after this turn)")).toBeGreaterThan(text.indexOf(`-> ${name(to)}`));
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
		expect(chip()).not.toContain("(after this turn)");
		const switchedLines = showStatus.mock.calls.filter(([message]) => message.startsWith("Model switched to"));
		expect(switchedLines).toEqual([[`Model switched to ${selector(haiku)}`]]);
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
