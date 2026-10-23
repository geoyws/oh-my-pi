import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { YAML } from "bun";
import { Effort } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { createPluginSettingsHost } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/settings-host";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { ALL_SCENES, runSetupWizard, selectSetupScenes } from "@oh-my-pi/pi-coding-agent/modes/setup";
import { cfgDisplayHideToolActivity, cfgSetupVersion } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { cfgDefaultThinkingLevel, cfgHideThinkingBlock } from "@oh-my-pi/pi-coding-agent/session/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { type SettingItem, SettingsList } from "@oh-my-pi/pi-tui";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import * as modelHubModule from "@oh-my-pi/pi-tui/overlays/model-hub";
import { getThemeByName, initTheme, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { AUTO_THINKING } from "@oh-my-pi/pi-tui/thinking";
import { getProjectAgentDir, isRecord, setAgentDir, setProjectDir, TempDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const READ_ONLY_BYTES = "config:\n  readOnly: true\n# managed bytes\nhideThinkingBlock: false\n";

let state: SettingsTestState;
let temp: TempDir;
let agentDir: string;
let cwd: string;
let config: string;
let instance: Settings | undefined;
let restoreGeometry: (() => void) | undefined;

beforeAll(async () => {
	await initTheme();
});

beforeEach(() => {
	state = beginSettingsTest();
	delete process.env.PI_CONFIG_READONLY;
	delete process.env.PI_CONFIG_FILES;
	temp = TempDir.createSync("@omp-global-readonly-ui-");
	agentDir = temp.join("agent");
	cwd = temp.join("project");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(cwd, { recursive: true });
	config = path.join(agentDir, "config.yml");
	instance = undefined;
	restoreGeometry = stubStdoutGeometry(120, 40);
});

afterEach(async () => {
	instance?.cancelPendingSaves();
	restoreGeometry?.();
	AgentStorage.close();
	restoreSettingsTestState(state);
	await temp.remove();
});

function stubStdoutGeometry(columns: number, rows: number): () => void {
	const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	const columnsDesc = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => rows, set: () => {} });
	Object.defineProperty(process.stdout, "columns", { configurable: true, get: () => columns, set: () => {} });
	return () => {
		if (rowsDesc) Object.defineProperty(process.stdout, "rows", rowsDesc);
		if (columnsDesc) Object.defineProperty(process.stdout, "columns", columnsDesc);
	};
}

/** Load the global singleton from a managed read-only global config, as a real session does. */
async function initReadOnly(bytes = READ_ONLY_BYTES): Promise<Settings> {
	fs.writeFileSync(config, bytes);
	instance = await Settings.init({ cwd, agentDir });
	expect(instance.isGlobalConfigReadOnly()).toBe(true);
	return instance;
}

function createSettingsSelector(onChange: (path: string, value: unknown) => void): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			providers: [],
			settings: createSettingsHost(),
			plugins: createPluginSettingsHost(cwd),
		},
		{ onChange, onCancel: () => {} },
	);
}

function activeList(selector: SettingsSelectorComponent): SettingsList {
	const [list] = selector.debugChildren;
	if (!(list instanceof SettingsList)) throw new Error("Expected the settings tab list");
	return list;
}

function selectedId(list: SettingsList): string {
	const id = list.getSelectedItem()?.id;
	if (id === undefined) throw new Error("Expected a selected setting row");
	return id;
}

/** 1-based terminal cell of a row's label in a fresh full-frame render, for SGR mouse reports. */
function rowCell(selector: SettingsSelectorComponent, item: SettingItem): { row: number; col: number } {
	const lines = Bun.stripANSI(selector.render(120).join("\n")).split("\n");
	// A setting row carries its label and value on one line; tabs and the description area do not.
	const row = lines.findIndex(line => line.includes(item.label) && line.includes(item.currentValue));
	if (row === -1) throw new Error(`Missing settings row: ${item.label}`);
	return { row: row + 1, col: lines[row]!.indexOf(item.label) + 1 };
}

describe("/settings under the global read-only policy", () => {
	it("keeps rows visible but disabled with a focus and hover reason, and refuses activation", async () => {
		const settings = await initReadOnly();
		const onChange = vi.fn();
		const selector = createSettingsSelector(onChange);
		const list = activeList(selector);

		const first = list.getSelectedItem();
		if (!first) throw new Error("Expected the first appearance row");
		expect(first.disabled?.reason).toBe("read-only");
		expect(first.disabled?.message).toBe(settings.getGlobalConfigReadOnlyReason());
		expect(list.debugState().selectedItemDisabledReason).toBe("read-only");
		expect(list.debugState().describedItemDisabledReason).toBe("read-only");

		// Enter, Space, and a repeated click on the focused row stay inert.
		const firstValue = first.currentValue;
		const firstStored = lookup(first.id)?.get(settings);
		selector.handleInput("\n");
		selector.handleInput(" ");
		const firstCell = rowCell(selector, first);
		for (let click = 0; click < 2; click++) {
			selector.handleInput(`\x1b[<0;${firstCell.col};${firstCell.row}M`);
			selector.handleInput(`\x1b[<0;${firstCell.col};${firstCell.row}m`);
		}
		expect(list.hasOpenSubmenu()).toBe(false);
		expect(selectedId(list)).toBe(first.id);
		expect(list.getSelectedItem()?.currentValue).toBe(firstValue);
		expect(lookup(first.id)?.get(settings)).toEqual(firstStored);

		// Keyboard focus reaches the next disabled row and shows its reason.
		selector.handleInput("\x1b[B");
		const next = selectedId(list);
		expect(next).not.toBe(first.id);
		expect(list.debugState().selectedItemDisabledReason).toBe("read-only");

		// Pointer hover over another disabled row explains that row instead.
		const hoverCell = rowCell(selector, first);
		selector.handleInput(`\x1b[<35;${hoverCell.col};${hoverCell.row}M`);
		expect(list.debugState()).toMatchObject({
			hoveredItemId: first.id,
			describedItemId: first.id,
			describedItemDisabledReason: "read-only",
			selectedItemId: next,
		});

		// A boolean toggle never flips, persists, or reaches the host callback.
		let toggle = list.getSelectedItem();
		for (let step = 0; step < 100 && toggle?.values?.join(",") !== "true,false"; step++) {
			selector.handleInput("\x1b[B");
			toggle = list.getSelectedItem();
		}
		if (!toggle || toggle.values?.join(",") !== "true,false") throw new Error("Expected a boolean appearance row");
		expect(toggle.disabled?.reason).toBe("read-only");
		const toggleValue = toggle.currentValue;
		const toggleStored = lookup(toggle.id)?.get(settings);
		expect(() => selector.handleInput("\n")).not.toThrow();
		expect(list.getSelectedItem()?.currentValue).toBe(toggleValue);
		expect(lookup(toggle.id)?.get(settings)).toEqual(toggleStored);

		expect(onChange).not.toHaveBeenCalled();
		await settings.flush();
		expect(fs.readFileSync(config, "utf8")).toBe(READ_ONLY_BYTES);
	});

	it("leaves rows enabled while global config is writable", async () => {
		instance = await Settings.init({ cwd, agentDir });
		expect(instance.isGlobalConfigReadOnly()).toBe(false);
		const list = activeList(createSettingsSelector(() => {}));
		expect(list.getSelectedItem()?.disabled).toBeUndefined();
		expect(list.debugState().selectedItemDisabledReason).toBeNull();
	});
});

describe("keyboard display toggles under the global read-only policy", () => {
	it("refuses tool activity and thinking block toggles before changing the view", async () => {
		const settings = await initReadOnly();
		const showError = vi.fn();
		const resetDisplay = vi.fn();
		const ctx = {
			hideToolActivity: false,
			toolOutputExpanded: false,
			hideThinkingBlock: false,
			hasDisplayableThinkingContent: true,
			settings,
			session: { thinkingLevel: "high" },
			chatContainer: { children: [], setToolActivityVisible: vi.fn(), resetStableEmission: vi.fn() },
			ui: { resetDisplay, clearInlineImages: vi.fn() },
			showStatus: vi.fn(),
			showError,
		};
		const controller = new InputController(ctx as unknown as InteractiveModeContext);

		expect(() => controller.toggleToolActivityVisibility()).not.toThrow();
		expect(() => controller.toggleThinkingBlockVisibility()).not.toThrow();

		expect(showError).toHaveBeenCalledTimes(2);
		expect(ctx.hideToolActivity).toBe(false);
		expect(ctx.hideThinkingBlock).toBe(false);
		expect(resetDisplay).not.toHaveBeenCalled();
		expect(cfgDisplayHideToolActivity.get(settings)).toBe(false);
		expect(cfgHideThinkingBlock.get(settings)).toBe(false);
		await settings.flush();
		expect(fs.readFileSync(config, "utf8")).toBe(READ_ONLY_BYTES);
	});
});

describe("setup under the global read-only policy", () => {
	function setupContext(settings: Settings, showOverlay = vi.fn(), showError = vi.fn()): InteractiveModeContext {
		return {
			settings,
			session: { modelRegistry: { getAvailable: () => [], getAll: () => [] } },
			ui: { terminal: { rows: 24 }, showOverlay, setFocus: vi.fn(), requestRender: vi.fn() },
			showError,
			playWelcomeIntro: vi.fn(),
		} as unknown as InteractiveModeContext;
	}

	it("skips automatic onboarding and refuses an explicit wizard without opening it", async () => {
		const settings = await initReadOnly();
		const showOverlay = vi.fn();
		const showError = vi.fn();
		const ctx = setupContext(settings, showOverlay, showError);

		expect(await selectSetupScenes(0, ALL_SCENES, ctx, { isTTY: true })).toEqual([]);
		await runSetupWizard(ctx, ALL_SCENES);

		expect(showOverlay).not.toHaveBeenCalled();
		expect(showError).toHaveBeenCalledTimes(1);
		expect(cfgSetupVersion.get(settings)).toBe(0);
		await settings.flush();
		expect(fs.readFileSync(config, "utf8")).toBe(READ_ONLY_BYTES);
	});
});

describe("/model default role clear under the global read-only policy", () => {
	it("switches to the exposed auto fallback without a rejected global thinking write", async () => {
		const testTheme = await getThemeByName("dark");
		if (!testTheme) throw new Error("Failed to load dark theme for model selector test");
		setThemeInstance(testTheme);

		const projectModel = getBundledModel("openai", "gpt-5.5");
		const globalModel = getBundledModel("openai", "gpt-5.6");
		if (!projectModel || !globalModel) throw new Error("Expected bundled OpenAI models for selector test");
		const projectSelector = `${projectModel.provider}/${projectModel.id}`;
		const globalSelector = `${globalModel.provider}/${globalModel.id}`;
		const bytes = `config:\n  readOnly: true\ndefaultThinkingLevel: auto\nmodelRoles:\n  default: ${globalSelector}\n`;
		const projectConfig = path.join(getProjectAgentDir(cwd), "config.yml");
		fs.mkdirSync(getProjectAgentDir(cwd));
		fs.writeFileSync(
			projectConfig,
			`autoResume: false\nmodelRoles:\n  default: ${projectSelector}\n  smol: provider/keep:low\n`,
		);
		const settings = await initReadOnly(bytes);
		expect(settings.getModelRoleStorage()).toBe("project");
		expect(settings.getModelRoleProvenance("default")).toBe("project");

		const setModel = vi.fn(async () => ({ switched: true }));
		const thinkingApplied = Promise.withResolvers<void>();
		// Mirrors ModelControls: `persist` writes the global default through the setting handle.
		const setThinkingLevel = vi.fn((level: unknown, persist?: boolean) => {
			try {
				if (persist) cfgDefaultThinkingLevel.set(settings, level as never);
			} finally {
				thinkingApplied.resolve();
			}
		});
		const showError = vi.fn();
		const roleCleared = Promise.withResolvers<void>();
		const showStatus = vi.fn((message: string) => {
			if (message.includes("role cleared")) roleCleared.resolve();
		});
		let captured: unknown;
		const controller = new SelectorController({
			ui: {
				requestRender: vi.fn(),
				setFocus: vi.fn(),
				showOverlay: vi.fn((component: unknown) => {
					captured = component;
					return { hide: vi.fn() };
				}),
				terminal: { rows: 40 },
			},
			editorContainer: { clear: vi.fn(), addChild: vi.fn(), children: [] },
			editor: {},
			settings,
			session: {
				model: projectModel,
				modelRegistry: {
					getAll: () => [projectModel, globalModel],
					getAvailable: () => [projectModel, globalModel],
					getError: () => undefined,
					refresh: async () => {},
					refreshProvider: async () => {},
					getDiscoverableProviders: () => [],
					getProviderDiscoveryState: () => undefined,
					authStorage: { hasAuth: () => false },
				},
				scopedModels: [{ model: projectModel }, { model: globalModel }],
				getContextUsage: () => undefined,
				setModel,
				setThinkingLevel,
			},
			statusLine: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			// The session here is idle, so the turn-end router lets the clear switch now.
			routeUserModelSwitch: vi.fn((): "apply" | "queued" | "cancelled" => "apply"),
			keybindings: { getKeys: () => [], getDisplayString: () => "" },
			showStatus,
			showError,
		} as unknown as InteractiveModeContext);

		controller.showModelSelector();
		const hub = captured as { handleInput(data: string): void; dispose(): void } | undefined;
		if (!hub) throw new Error("Expected model hub overlay to be shown");
		try {
			hub.handleInput("\x1b[A"); // All models → Roles.
			hub.handleInput("\n"); // Enter the role rows.
			hub.handleInput("\x7f"); // Backspace on DEFAULT to unassign.
			await roleCleared.promise;
			await thinkingApplied.promise;

			expect(setModel).toHaveBeenCalledWith(globalModel, "default", expect.objectContaining({ persist: false }));
			expect(setThinkingLevel).toHaveBeenCalledWith(AUTO_THINKING, false);
			expect(showError).not.toHaveBeenCalled();
			expect(settings.getProjectModelRole("default")).toBeUndefined();
			expect(settings.getModelRole("default")).toBe(globalSelector);
		} finally {
			hub.dispose();
		}

		await settings.flush();
		expect(fs.readFileSync(config, "utf8")).toBe(bytes);
		const project: unknown = YAML.parse(fs.readFileSync(projectConfig, "utf8"));
		if (!isRecord(project) || !isRecord(project.modelRoles)) throw new Error("Expected project modelRoles mapping");
		const reopened = await Settings.loadIsolated({ cwd, agentDir, configFiles: [] });
		expect({
			projectDefault: reopened.getProjectModelRole("default"),
			effectiveDefault: reopened.getModelRole("default"),
			smol: reopened.getProjectModelRole("smol"),
		}).toEqual({ projectDefault: undefined, effectiveDefault: globalSelector, smol: "provider/keep:low" });
		expect(project.autoResume).toBe(false);
	});
});

describe("/model effort persistence across project and global scopes", () => {
	const initialSelector = "anthropic/claude-sonnet-4-5";
	const pickedSelector = "anthropic/claude-opus-4-5";
	const reviewerSelector = "anthropic/claude-sonnet-4-5:high";
	let authStorage: AuthStorage | undefined;
	let hub: modelHubModule.ModelHubComponent | undefined;
	let sessions: AgentSession[];
	let loadedSettings: Settings[];

	beforeEach(() => {
		sessions = [];
		loadedSettings = [];
	});

	afterEach(async () => {
		hub?.dispose();
		hub = undefined;
		for (const session of sessions) await session.dispose();
		for (const settings of loadedSettings) settings.cancelPendingSaves();
		authStorage?.close();
		authStorage = undefined;
		vi.restoreAllMocks();
	});

	async function profile(kind: "personal" | "ifca") {
		setAgentDir(agentDir);
		setProjectDir(cwd);
		const bytes =
			"# managed global defaults\nmodelRoleStorage: project\ndefaultThinkingLevel: medium\n" +
			`modelRoles:\n  default: ${initialSelector}\n  reviewer: ${reviewerSelector}\n`;
		await Bun.write(config, bytes);
		const projectConfig = path.join(getProjectAgentDir(cwd), "config.yml");
		await Bun.write(projectConfig, `autoResume: false\nmodelRoles:\n  default: ${initialSelector}\n`);
		// Both profiles pin the effective fallback effort. IFCA additionally owns
		// the default role in an overlay, exercising the shadowed-project branch.
		const overlay = temp.join(`${kind}-overlay.yml`);
		const overlayBytes =
			"defaultThinkingLevel: medium\n" +
			(kind === "ifca" ? `modelRoles:\n  default: ${initialSelector}\n  reviewer: ${reviewerSelector}\n` : "");
		await Bun.write(overlay, overlayBytes);
		instance = await Settings.init({ cwd, agentDir, configFiles: [overlay] });
		const settings = instance;
		authStorage = await AuthStorage.create(temp.join("picker-auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		const registry = new ModelRegistry(authStorage, temp.join("models.yml"));
		const picked = registry.find("anthropic", "claude-opus-4-5");
		if (!picked) throw new Error("Expected bundled opus model");
		// Keep provider metadata discovery offline; model/effort setters and
		// their persistence are deliberately not mocked.
		vi.spyOn(registry, "refreshSelectedModelMetadata").mockImplementation(async model => model);

		async function startup(currentSettings: Settings): Promise<AgentSession> {
			const created = await createAgentSession({
				cwd,
				agentDir,
				authStorage,
				modelRegistry: registry,
				settings: currentSettings,
				sessionManager: SessionManager.inMemory(cwd),
				disableExtensionDiscovery: true,
				toolNames: [],
				restrictToolNames: true,
				enableIrc: false,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
			});
			sessions.push(created.session);
			return created.session;
		}

		const session = await startup(settings);
		expect(session.configuredThinkingLevel()).toBe(Effort.Medium);
		expect(await Bun.file(config).text()).toBe(bytes);
		expect(settings.getModelRoleProvenance("default")).toBe(kind === "ifca" ? "overlay" : "project");
		const testTheme = await getThemeByName("dark");
		if (!testTheme) throw new Error("Expected dark theme");
		setThemeInstance(testTheme);
		let callbacks: modelHubModule.ModelHubCallbacks | undefined;
		const Hub = modelHubModule.ModelHubComponent;
		vi.spyOn(modelHubModule, "ModelHubComponent").mockImplementation(function (
			...args: ConstructorParameters<typeof Hub>
		) {
			callbacks = args[4];
			hub = new Hub(...args);
			return hub;
		});
		const showError = vi.fn();
		const controller = new SelectorController({
			ui: {
				requestRender: vi.fn(),
				setFocus: vi.fn(),
				showOverlay: vi.fn(() => ({ hide: vi.fn() })),
				terminal: { rows: 40 },
			},
			editorContainer: { clear: vi.fn(), addChild: vi.fn(), children: [] },
			editor: {},
			settings,
			session,
			statusLine: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			routeUserModelSwitch: () => "apply",
			keybindings: { getKeys: () => [], getDisplayString: () => "" },
			showStatus: vi.fn(),
			showError,
		} as unknown as InteractiveModeContext);
		controller.showModelSelector();
		if (!callbacks) throw new Error("Expected real model hub callbacks");
		const assign = callbacks.onAssign;
		return {
			settings,
			session,
			bytes,
			projectConfig,
			async pick(role: string, effort: typeof AUTO_THINKING | Effort, scope: "project" | "global") {
				expect(await assign(picked, role, effort, pickedSelector, scope)).toBe(true);
				expect(showError).not.toHaveBeenCalled();
				await settings.flush();
			},
			async reload() {
				const reopened = await Settings.loadIsolated({ cwd, agentDir, configFiles: [overlay] });
				loadedSettings.push(reopened);
				return { settings: reopened, session: await startup(reopened) };
			},
			async expectOverlayUnchanged() {
				expect(await Bun.file(overlay).text()).toBe(overlayBytes);
			},
		};
	}

	it("personal project auto preserves global bytes and survives a fresh session under a medium overlay", async () => {
		const p = await profile("personal");
		await p.pick("default", AUTO_THINKING, "project");
		expect(p.session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		expect(await Bun.file(config).text()).toBe(p.bytes);
		const reopened = await p.reload();
		expect(reopened.settings.getProjectModelRole("default")).toBe(`${pickedSelector}:auto`);
		expect(reopened.session.model?.id).toBe("claude-opus-4-5");
		expect(reopened.session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		expect(reopened.settings.getModelRole("reviewer")).toBe(reviewerSelector);
		await p.expectOverlayUnchanged();
	});

	it("IFCA overlay-shadowed project auto persists locally without changing the global or effective overlay role", async () => {
		const p = await profile("ifca");
		await p.pick("default", AUTO_THINKING, "project");
		expect(p.session.model?.id).toBe("claude-sonnet-4-5");
		expect(await Bun.file(config).text()).toBe(p.bytes);
		const reopened = await p.reload();
		expect(reopened.settings.getProjectModelRole("default")).toBe(`${pickedSelector}:auto`);
		expect(reopened.settings.getModelRole("default")).toBe(initialSelector);
		expect(reopened.settings.getModelRoleProvenance("default")).toBe("overlay");
		expect(reopened.session.configuredThinkingLevel()).toBe(Effort.Medium);
		expect(reopened.settings.getModelRole("reviewer")).toBe(reviewerSelector);
		await p.expectOverlayUnchanged();
	});

	it("explicit global auto persists while settings and startup honestly retain the medium overlay", async () => {
		const p = await profile("personal");
		const projectBefore = await Bun.file(p.projectConfig).text();
		await p.pick("default", AUTO_THINKING, "global");
		const global: unknown = YAML.parse(await Bun.file(config).text());
		if (!isRecord(global) || !isRecord(global.modelRoles)) throw new Error("Expected global roles");
		expect(global.defaultThinkingLevel).toBe(AUTO_THINKING);
		expect(global.modelRoles.default).toBe(pickedSelector);
		expect(global.modelRoles.reviewer).toBe(reviewerSelector);
		expect(await Bun.file(p.projectConfig).text()).toBe(projectBefore);
		expect(createSettingsHost().get("defaultThinkingLevel")).toBe(Effort.Medium);
		expect(cfgDefaultThinkingLevel.provenance(p.settings)).toBe("overlay");
		const reopened = await p.reload();
		expect(reopened.session.configuredThinkingLevel()).toBe(Effort.Medium);
		expect(reopened.settings.getModelRole("default")).toBe(initialSelector);
		await p.expectOverlayUnchanged();
	});

	it("project reviewer auto and explicit effort leave the running default and global reviewer isolated", async () => {
		const p = await profile("personal");
		await p.pick("reviewer", AUTO_THINKING, "project");
		expect(await Bun.file(config).text()).toBe(p.bytes);
		expect(p.session.configuredThinkingLevel()).toBe(Effort.Medium);
		const auto = await p.reload();
		expect(auto.settings.getProjectModelRole("reviewer")).toBe(`${pickedSelector}:auto`);
		expect(auto.session.model?.id).toBe("claude-sonnet-4-5");
		expect(auto.session.configuredThinkingLevel()).toBe(Effort.Medium);
		await p.pick("reviewer", Effort.High, "project");
		expect(await Bun.file(config).text()).toBe(p.bytes);
		expect(p.session.model?.id).toBe("claude-sonnet-4-5");
		expect(p.session.configuredThinkingLevel()).toBe(Effort.Medium);
		const reopened = await p.reload();
		expect(reopened.settings.getProjectModelRole("reviewer")).toBe(`${pickedSelector}:high`);
		expect(reopened.settings.getModelRole("reviewer")).toBe(`${pickedSelector}:high`);
		expect(reopened.session.model?.id).toBe("claude-sonnet-4-5");
		expect(reopened.session.configuredThinkingLevel()).toBe(Effort.Medium);
		await p.expectOverlayUnchanged();
	});
});
