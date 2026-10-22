import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { type RawSettings, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as modelHubModule from "@oh-my-pi/pi-tui/overlays/model-hub";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../../helpers/settings-test-state";

const model = (id: string) => getBundledModel("anthropic", id) as Model;

// Settings writes made through the model hub, driven through the controller's real hub callbacks.
describe("SelectorController model hub writes", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;
	let state: SettingsTestState | undefined;

	beforeEach(async () => {
		state = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-selector-model-writes-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
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

	function start(settings: Settings, initial: Model): { controller: SelectorController; showError: () => unknown } {
		const live = new AgentSession({
			agent: new Agent({ initialState: { model: initial, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			obfuscator: new SecretObfuscator([]),
		});
		session = live;
		const showError = vi.fn();
		const controller = new SelectorController(
			createInteractiveModeContext({
				session: live,
				settings,
				ui: {
					showOverlay: () => ({ hide: () => {}, setHidden: () => {}, isHidden: () => false }),
					terminal: { rows: 40 },
				},
				keybindings: { getKeys: () => [], getDisplayString: () => "" },
				showError,
			}),
		);
		return { controller, showError };
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

	it("saves only the edited fallback chain, never the chains a --config overlay supplies", async () => {
		const agentDir = tempDir.join("agent");
		const overlayPath = tempDir.join("overlay.yml");
		await Bun.write(overlayPath, YAML.stringify({ retry: { fallbackChains: { smol: ["overlay/cheap"] } } }));
		// The global instance, as in the app: the hub's status text reads the global settings.
		const settings = await Settings.init({ agentDir, cwd: tempDir.path(), configFiles: [overlayPath] });
		const { controller, showError } = start(settings, model("claude-sonnet-4-5"));

		openModelHub(controller).onFallbackChainChange?.("slow", ["user/slow-fallback"]);
		await settings.flush();

		expect(showError).not.toHaveBeenCalled();
		const saved = YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text()) as RawSettings;
		expect(saved).toEqual({ retry: { fallbackChains: { slow: ["user/slow-fallback"] } } });
	});

	it("switches the session to the project default when its already-assigned chip is picked", async () => {
		const agentDir = tempDir.join("agent");
		await Bun.write(
			tempDir.join(".omp", "config.yml"),
			YAML.stringify({ modelRoles: { default: "anthropic/claude-opus-4-5" } }),
		);
		const settings = await Settings.init({ agentDir, cwd: tempDir.path() });
		// The session moved off the configured default earlier (an in-session pick).
		const { controller, showError } = start(settings, model("claude-sonnet-4-5"));

		// The hub shows the project default as assigned, so picking it sends unassign.
		await openModelHub(controller).onUnassign("default");

		expect(showError).not.toHaveBeenCalled();
		expect(session?.model?.id).toBe("claude-opus-4-5");
	});

	it("refreshes the open hub once a confirmed compaction point has moved the model to its extended window", async () => {
		const settings = await Settings.init({ agentDir: tempDir.join("agent"), cwd: tempDir.path() });
		const { controller, showError } = start(settings, model("claude-sonnet-4-5"));
		const registry = session!.modelRegistry;
		const terra = registry.find("openai", "gpt-5.6-terra");
		if (!terra) throw new Error("Expected bundled gpt-5.6-terra");
		const refreshed = Promise.withResolvers<number | null | undefined>();
		vi.spyOn(modelHubModule, "ModelHubComponent").mockImplementation(function (...args: unknown[]) {
			const callbacks = args[4] as modelHubModule.ModelHubCallbacks;
			queueMicrotask(() => {
				expect(callbacks.onCompactionPointChange?.(terra, "400k", true)).toBeUndefined();
			});
			return {
				// The window the hub would re-read when it refreshes.
				refreshAfterExternalMutation: () =>
					refreshed.resolve(registry.find("openai", "gpt-5.6-terra")?.contextWindow),
				dispose: () => {},
			};
		} as never);
		controller.showModelSelector();

		expect(await refreshed.promise).toBe(1_050_000);
		expect(showError).not.toHaveBeenCalled();
	});

	// The real hub, opened by the controller: its #assignRole forwards the role's current level to onAssign.
	function openRealModelHub(controller: SelectorController) {
		const RealHub = modelHubModule.ModelHubComponent;
		let hub: modelHubModule.ModelHubComponent | undefined;
		let onAssign: Mock<modelHubModule.ModelHubCallbacks["onAssign"]> | undefined;
		vi.spyOn(modelHubModule, "ModelHubComponent").mockImplementation(function (
			...args: ConstructorParameters<typeof RealHub>
		) {
			onAssign = vi.fn(args[4].onAssign);
			args[4] = { ...args[4], onAssign };
			hub = new RealHub(...args);
			return hub;
		} as never);
		controller.showModelSelector();
		if (!hub || !onAssign) throw new Error("model hub was not opened");
		return { hub, onAssign };
	}

	for (const [role, label] of [
		["smol", "SMOL"],
		["default", "DEFAULT"],
	] as const) {
		it(`keeps the persisted ${role} thinking suffix when the same model is re-picked in the hub`, async () => {
			const theme = await getThemeByName("dark");
			if (!theme) throw new Error("Failed to load dark theme");
			setThemeInstance(theme);
			const agentDir = tempDir.join("agent");
			const config = path.join(agentDir, "config.yml");
			const sonnet = model("claude-sonnet-4-5");
			const selector = `${sonnet.provider}/${sonnet.id}`;
			const source = `# user config\nmodelRoles:\n  default: ${selector}:high # keep\n  smol: ${selector}:high\n`;
			await Bun.write(config, source);
			const settings = await Settings.init({ agentDir, cwd: tempDir.path() });
			const { controller, showError } = start(settings, sonnet);
			session!.setScopedModels([{ model: sonnet }]);

			const { hub, onAssign } = openRealModelHub(controller);
			try {
				hub.handleInput("\x1b[A"); // All models → Roles.
				hub.handleInput("\n"); // Dive into the role rows.
				let selectedRow = "";
				for (let step = 0; step < 20; step++) {
					selectedRow =
						hub
							.render(220)
							.map(line => stripVTControlCharacters(line))
							.find(line => line.includes("❯")) ?? "";
					if (selectedRow.includes(label)) break;
					hub.handleInput("\x1b[B");
				}
				expect(selectedRow).toContain(label);
				hub.handleInput("\n"); // Pick a model for the role.
				hub.handleInput("\n"); // Re-pick the sole (already assigned) model.

				expect(onAssign).toHaveBeenCalledTimes(1);
				const [picked, assignedRole, level, assignedSelector] = onAssign.mock.calls[0]!;
				expect(picked.id).toBe(sonnet.id);
				expect(assignedRole).toBe(role);
				expect(level).toBe(Effort.High);
				expect(assignedSelector).toBe(selector);
				expect(await onAssign.mock.results[0]!.value).toBe(true);
			} finally {
				hub.dispose();
			}
			await settings.flush();

			expect(showError).not.toHaveBeenCalled();
			expect(settings.getModelRole(role)).toBe(`${selector}:high`);
			expect(await Bun.file(config).text()).toBe(source);
		});
	}
});
