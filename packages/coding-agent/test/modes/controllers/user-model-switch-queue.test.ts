import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { cfgCycleOrder } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { ModelSwitchQueue } from "@oh-my-pi/pi-coding-agent/modes/model-switch-queue";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as modelHubModule from "@oh-my-pi/pi-tui/overlays/model-hub";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../../helpers/settings-test-state";

/**
 * A user model switch made while a turn streams (ctrl+p role cycle, alt+p
 * picker / `/switch`, model hub assign/unassign — which `/model` opens) must
 * wait for the turn to end: the live model stays put, the target is recorded
 * as the single pending switch, and the turn-end flush applies it exactly once.
 * Idle switches apply immediately with their usual status text.
 */
const model = (id: string) => getBundledModel("anthropic", id) as Model;
const SONNET = "claude-sonnet-4-5";
const OPUS = "claude-opus-4-5";
const HAIKU = "claude-haiku-4-5";
type StatusSpy = Mock<(message: string) => void>;

describe("user model switches during a streaming turn", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;
	let state: SettingsTestState | undefined;

	beforeEach(async () => {
		state = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-user-model-switch-queue-");
		authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
	});

	afterEach(async () => {
		restoreSettingsTestState(state);
		state = undefined;
		await session?.dispose();
		session = undefined;
		authStorage.close();
		AgentStorage.close();
		// SQLite keeps agent.db open until GC finalizes its statements; Windows cannot delete an open file.
		Bun.gc(true);
		tempDir.removeSync();
	});

	interface Harness {
		live: AgentSession;
		ctx: InteractiveModeContext;
		queue: ModelSwitchQueue;
		showStatus: StatusSpy;
		setStreaming(streaming: boolean): void;
	}

	async function start(): Promise<Harness> {
		const settings = await Settings.init({ agentDir: tempDir.join("agent"), cwd: tempDir.path() });
		settings.setModelRole("slow", `anthropic/${OPUS}`);
		settings.setModelRole("smol", `anthropic/${HAIKU}`);
		cfgCycleOrder.set(settings, ["default", "slow", "smol"]);
		const live = new AgentSession({
			agent: new Agent({ initialState: { model: model(SONNET), systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			obfuscator: new SecretObfuscator([]),
		});
		session = live;
		let streaming = false;
		Object.defineProperty(live, "isStreaming", { configurable: true, get: () => streaming });
		const showStatus: StatusSpy = vi.fn((_message: string) => {});
		const ctx = createInteractiveModeContext({
			session: live,
			settings,
			ui: { showOverlay: () => ({ hide: () => {}, setHidden: () => {}, isHidden: () => false }) },
			keybindings: { getKeys: () => [], getDisplayString: () => "" },
			showStatus,
			showModelCycleTrack: vi.fn(),
		});
		// Wire the context to the same queue InteractiveMode owns.
		const queue = new ModelSwitchQueue(ctx);
		ctx.flushPendingModelSwitch = () => queue.flush();
		ctx.getPendingModelSwitch = () => queue.pending;
		ctx.onPendingModelSwitchChange = listener => queue.subscribe(listener);
		ctx.queueUserModelSwitch = request => queue.queueUser(request);
		return {
			live,
			ctx,
			queue,
			showStatus,
			setStreaming: value => {
				streaming = value;
			},
		};
	}

	function openModelHub(controller: SelectorController): modelHubModule.ModelHubCallbacks {
		let callbacks: modelHubModule.ModelHubCallbacks | undefined;
		vi.spyOn(modelHubModule, "ModelHubComponent").mockImplementation(function (...args: unknown[]) {
			callbacks = args[4] as modelHubModule.ModelHubCallbacks;
			return { refreshAfterExternalMutation: () => {}, dispose: () => {} };
		} as never);
		controller.showModelSelector();
		if (!callbacks) throw new Error("model hub was not opened");
		return callbacks;
	}

	const statusLines = (showStatus: StatusSpy, prefix: string) =>
		showStatus.mock.calls.filter(([message]) => message.startsWith(prefix));

	it("queues a ctrl+p role step while streaming without touching the live model", async () => {
		const { live, ctx, queue, showStatus, setStreaming } = await start();
		const cycleRoleModels = vi.spyOn(live, "cycleRoleModels");
		const applyRoleModel = vi.spyOn(live, "applyRoleModel");
		setStreaming(true);

		await new InputController(ctx).cycleRoleModel("forward");

		expect(live.model?.id).toBe(SONNET);
		expect(cycleRoleModels).not.toHaveBeenCalled();
		expect(applyRoleModel).not.toHaveBeenCalled();
		expect(queue.pending).toMatchObject({ source: "user", role: "slow", model: { id: OPUS } });
		expect(showStatus).toHaveBeenCalledWith(
			`Model switch queued for after this turn: anthropic/${SONNET} -> anthropic/${OPUS}`,
		);
	});

	it("advances repeated ctrl+p presses from the pending target and applies only the last one", async () => {
		const { live, ctx, queue, showStatus, setStreaming } = await start();
		const applyRoleModel = vi.spyOn(live, "applyRoleModel");
		const controller = new InputController(ctx);
		setStreaming(true);

		await controller.cycleRoleModel("forward");
		await controller.cycleRoleModel("forward");
		expect(queue.pending).toMatchObject({ source: "user", role: "smol", model: { id: HAIKU } });
		expect(live.model?.id).toBe(SONNET);

		setStreaming(false);
		await ctx.flushPendingModelSwitch();
		await ctx.flushPendingModelSwitch();

		expect(applyRoleModel).toHaveBeenCalledTimes(1);
		expect(applyRoleModel.mock.calls[0]?.[0]).toMatchObject({ role: "smol", model: { id: HAIKU } });
		expect(live.model?.id).toBe(HAIKU);
		expect(queue.pending).toBeUndefined();
		expect(statusLines(showStatus, "Model switched to")).toEqual([[`Model switched to anthropic/${HAIKU}`]]);
	});

	it("walks backward from the pending target with shift+ctrl+p", async () => {
		const { ctx, queue, setStreaming } = await start();
		const controller = new InputController(ctx);
		setStreaming(true);

		await controller.cycleRoleModel("backward");
		expect(queue.pending).toMatchObject({ role: "smol", model: { id: HAIKU } });
		await controller.cycleRoleModel("backward");
		expect(queue.pending).toMatchObject({ role: "slow", model: { id: OPUS } });
	});

	it("applies ctrl+p immediately while idle with no queued status", async () => {
		const { live, ctx, queue, showStatus } = await start();
		const cycleRoleModels = vi.spyOn(live, "cycleRoleModels");

		await new InputController(ctx).cycleRoleModel("forward");

		expect(cycleRoleModels).toHaveBeenCalledTimes(1);
		expect(live.model?.id).toBe(OPUS);
		expect(queue.pending).toBeUndefined();
		expect(statusLines(showStatus, "Model switch queued")).toEqual([]);
	});

	it("queues an alt+p picker / /switch pick while streaming and applies it once at the turn end", async () => {
		const { live, ctx, queue, showStatus, setStreaming } = await start();
		const setModelTemporary = vi.spyOn(live, "setModelTemporary");
		setStreaming(true);

		await new SelectorController(ctx).switchSessionModel(model(OPUS));

		expect(setModelTemporary).not.toHaveBeenCalled();
		expect(live.model?.id).toBe(SONNET);
		expect(queue.pending).toMatchObject({ source: "user", model: { id: OPUS } });
		expect(statusLines(showStatus, "Session-only model")).toEqual([]);

		setStreaming(false);
		await ctx.flushPendingModelSwitch();
		await ctx.flushPendingModelSwitch();

		expect(setModelTemporary).toHaveBeenCalledTimes(1);
		expect(setModelTemporary.mock.calls[0]?.[0]).toMatchObject({ id: OPUS });
		expect(live.model?.id).toBe(OPUS);
		expect(statusLines(showStatus, "Model switched to")).toEqual([[`Model switched to anthropic/${OPUS}`]]);
	});

	it("applies an idle alt+p pick immediately with the unchanged status text", async () => {
		const { live, ctx, queue, showStatus } = await start();

		await new SelectorController(ctx).switchSessionModel(model(OPUS));

		expect(live.model?.id).toBe(OPUS);
		expect(queue.pending).toBeUndefined();
		expect(statusLines(showStatus, `Session-only model: anthropic/${OPUS}.`)).toHaveLength(1);
		expect(statusLines(showStatus, "Model switch")).toEqual([]);
	});

	it("replaces an earlier queued switch with the latest one", async () => {
		const { live, ctx, queue, setStreaming } = await start();
		const setModelTemporary = vi.spyOn(live, "setModelTemporary");
		const controller = new SelectorController(ctx);
		setStreaming(true);

		await controller.switchSessionModel(model(OPUS));
		await controller.switchSessionModel(model(HAIKU));
		expect(queue.pending).toMatchObject({ model: { id: HAIKU } });

		setStreaming(false);
		await ctx.flushPendingModelSwitch();

		expect(setModelTemporary).toHaveBeenCalledTimes(1);
		expect(setModelTemporary.mock.calls[0]?.[0]).toMatchObject({ id: HAIKU });
		expect(live.model?.id).toBe(HAIKU);
	});

	it("queues a model hub default assignment (what /model opens) while streaming", async () => {
		const { live, ctx, queue, showStatus, setStreaming } = await start();
		const setModel = vi.spyOn(live, "setModel");
		setStreaming(true);

		const assigned = await openModelHub(new SelectorController(ctx)).onAssign(
			model(OPUS),
			"default",
			undefined,
			`anthropic/${OPUS}`,
		);

		expect(assigned).toBe(true);
		expect(setModel).not.toHaveBeenCalled();
		expect(live.model?.id).toBe(SONNET);
		expect(queue.pending).toMatchObject({ source: "user", model: { id: OPUS } });
		expect(statusLines(showStatus, "Default model")).toEqual([]);

		setStreaming(false);
		await ctx.flushPendingModelSwitch();
		await ctx.flushPendingModelSwitch();

		expect(setModel).toHaveBeenCalledTimes(1);
		expect(setModel.mock.calls[0]?.[0]).toMatchObject({ id: OPUS });
		expect(setModel.mock.calls[0]?.[1]).toBe("default");
		expect(setModel.mock.calls[0]?.[2]).toMatchObject({ selector: `anthropic/${OPUS}`, persist: true });
		expect(live.model?.id).toBe(OPUS);
		expect(statusLines(showStatus, "Model switched to")).toEqual([[`Model switched to anthropic/${OPUS}`]]);
	});

	it("applies an idle model hub default assignment immediately with the unchanged status text", async () => {
		const { live, ctx, queue, showStatus } = await start();

		await openModelHub(new SelectorController(ctx)).onAssign(model(OPUS), "default", undefined, `anthropic/${OPUS}`);

		expect(live.model?.id).toBe(OPUS);
		expect(queue.pending).toBeUndefined();
		expect(showStatus).toHaveBeenCalledWith(`Default model: anthropic/${OPUS}`);
	});

	it("clears the role at once but queues the hub unassign fallback switch while streaming", async () => {
		await Bun.write(tempDir.join(".omp", "config.yml"), YAML.stringify({ modelRoles: { default: `anthropic/${OPUS}` } }));
		const { live, ctx, queue, setStreaming } = await start();
		const setModel = vi.spyOn(live, "setModel");
		setStreaming(true);

		// The hub shows the project default as assigned, so picking it sends unassign.
		await openModelHub(new SelectorController(ctx)).onUnassign("default");

		expect(setModel).not.toHaveBeenCalled();
		expect(live.model?.id).toBe(SONNET);
		expect(queue.pending).toMatchObject({ source: "user", model: { id: OPUS } });

		setStreaming(false);
		await ctx.flushPendingModelSwitch();

		expect(setModel).toHaveBeenCalledTimes(1);
		expect(setModel.mock.calls[0]?.[1]).toBe("default");
		expect(setModel.mock.calls[0]?.[2]).toMatchObject({ persist: false });
		expect(live.model?.id).toBe(OPUS);
	});
});
