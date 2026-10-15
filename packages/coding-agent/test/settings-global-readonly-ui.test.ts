import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { YAML } from "bun";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { webModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/special";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SettingPath } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { createPluginSettingsHost } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/settings-host";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import {
	ALL_SCENES,
	createSetupHost,
	runSetupWizard,
	type SetupSceneHost,
	selectSetupScenes,
} from "@oh-my-pi/pi-coding-agent/modes/setup";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { type SettingItem, SettingsList } from "@oh-my-pi/pi-tui";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { WebSearchTab } from "@oh-my-pi/pi-tui/setup/scenes/web-search";
import { getThemeByName, initTheme, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { AUTO_THINKING } from "@oh-my-pi/pi-tui/thinking";
import { getProjectAgentDir, isRecord, TempDir } from "@oh-my-pi/pi-utils";
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
		const firstStored = settings.get(first.id as SettingPath);
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
		expect(settings.get(first.id as SettingPath)).toEqual(firstStored);

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
		const toggleStored = settings.get(toggle.id as SettingPath);
		expect(() => selector.handleInput("\n")).not.toThrow();
		expect(list.getSelectedItem()?.currentValue).toBe(toggleValue);
		expect(settings.get(toggle.id as SettingPath)).toEqual(toggleStored);

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
		expect(settings.get("display.hideToolActivity")).toBe(false);
		expect(settings.get("hideThinkingBlock")).toBe(false);
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
		expect(settings.get("setupVersion")).toBe(0);
		await settings.flush();
		expect(fs.readFileSync(config, "utf8")).toBe(READ_ONLY_BYTES);
	});

	it("keeps a refused web-search choice on the provider tab without throwing", async () => {
		const settings = await initReadOnly();
		const webModels = (webModelManagerOptions().staticModels ?? []).map(model => buildModel(model));
		const ctx = {
			...setupContext(settings),
			session: { modelRegistry: { authStorage: { hasAuth: () => false }, getAll: () => webModels } },
		} as unknown as InteractiveModeContext;
		const finish = vi.fn();
		const host: SetupSceneHost = {
			ctx: createSetupHost(ctx),
			requestRender: () => {},
			finish,
			setFocus: () => {},
			restoreFocus: () => {},
		};
		const tab = new WebSearchTab(host);

		tab.handleInput("\x1b[B");
		expect(() => tab.handleInput("\n")).not.toThrow();
		expect(() => tab.render(80)).not.toThrow();

		expect(finish).not.toHaveBeenCalled();
		expect(settings.getModelRole("web")).toBeUndefined();
		expect(fs.existsSync(getProjectAgentDir(cwd))).toBe(false);
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
		// Mirrors ModelControls: `persist` writes the global default through Settings.set.
		const setThinkingLevel = vi.fn((level: unknown, persist?: boolean) => {
			try {
				if (persist) settings.set("defaultThinkingLevel", level as never);
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
		expect(project.modelRoles.default).toBeUndefined();
		expect(project.modelRoles.smol).toBe("provider/keep:low");
		expect(project.autoResume).toBe(false);
	});
});
