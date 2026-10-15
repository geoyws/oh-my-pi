import { YAML } from "bun";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { setCfgApprovalHost } from "@oh-my-pi/pi-coding-agent/internal-urls/cfg-protocol";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import {
	cfgMarketplaceAutoUpdate,
	cfgStartupChangelogMode,
	cfgStartupCheckUpdate,
	cfgStartupSetupWizard,
	cfgStartupShowSplash,
} from "@oh-my-pi/pi-coding-agent/modes/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { resetSessionIndexForTests } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	__resetAutoQaConsentForTests,
	resolveAutoQaConsent,
} from "@oh-my-pi/pi-coding-agent/tools/report-tool-issue";
import { cfgDevAutoqa, cfgDevAutoqaConsent, cfgTodoRemindersMax } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { getKeybindings, type KeybindingsManager, setKeybindings } from "@oh-my-pi/pi-tui/keybindings";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { setAgentDir, setProjectDir, TempDir } from "@oh-my-pi/pi-utils";
import * as utils from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

// Deliberately non-concurrent: init owns process-global settings and consent registration.
describe("InteractiveMode Auto-QA consent production adapter", () => {
	const preferences = { dev: { autoqa: false }, todo: { remindersMax: 7 } };
	let state: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;
	let configPath: string;
	let persistent: Settings | undefined;
	let local: Settings;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;
	let mode: InteractiveMode | undefined;
	let keybindings: KeybindingsManager;
	let pending: Promise<boolean>[];

	beforeEach(async () => {
		state = beginSettingsTest();
		keybindings = getKeybindings();
		pending = [];
		__resetAutoQaConsentForTests();
		tempDir = TempDir.createSync("@pi-autoqa-consent-");
		agentDir = tempDir.join("agent");
		projectDir = tempDir.join("project");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.mkdir(projectDir, { recursive: true });
		// Exclude inherited config overlays and PI_* runtime settings in this process only.
		for (const key of new Set([...Object.keys(process.env), ...Object.keys(Bun.env)])) {
			if (key.startsWith("PI_")) {
				delete process.env[key];
				delete Bun.env[key];
			}
		}
		setAgentDir(agentDir);
		setProjectDir(projectDir);
		spyOn(utils, "getConfigRootDir").mockReturnValue(agentDir);
		configPath = path.join(agentDir, "config.yml");
		await fs.writeFile(configPath, YAML.stringify(preferences));
		await initTheme();
		persistent = await Settings.init({ cwd: projectDir, agentDir });
		local = Settings.isolated();
		cfgStartupCheckUpdate.override(local, false);
		cfgStartupChangelogMode.override(local, "hidden");
		cfgStartupSetupWizard.override(local, false);
		cfgStartupShowSplash.override(local, false);
		cfgMarketplaceAutoUpdate.override(local, "off");
		authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(projectDir, tempDir.join("sessions")),
			settings: local,
			modelRegistry,
		});
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			new Composer({ terminal: new VirtualTerminal(200, 60) }),
		);
		spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		spyOn(mode, "showHookConfirm").mockResolvedValue(true);
		// init registers the actual private adapter against disk-backed Settings.instance.
		await mode.init({ suppressWelcomeIntro: true });
	});

	afterEach(async () => {
		// Settle even a prompt left open by a failed assertion before resetting globals.
		if (mode?.hookSelector) mode.hookSelector.handleInput("\x1b");
		await Promise.all(pending);
		mode?.stop();
		mode = undefined;
		setCfgApprovalHost(null);
		__resetAutoQaConsentForTests();
		await session?.dispose();
		session = undefined;
		authStorage?.close();
		authStorage = undefined;
		await persistent?.flush();
		persistent = undefined;
		AgentStorage.close();
		HistoryStorage.close();
		resetSessionIndexForTests();
		closeModelCache();
		restoreSettingsTestState(state);
		state = undefined;
		setKeybindings(keybindings);
		await tempDir?.remove();
	});

	function resolve(settings = local): Promise<boolean> {
		const result = resolveAutoQaConsent(settings);
		pending.push(result);
		return result;
	}

	function selector() {
		const presented = mode?.hookSelector;
		expect(presented).toBeDefined();
		if (!presented) throw new Error("Auto-QA consent selector was not presented");
		return presented;
	}

	async function assertPersisted(consent: "unset" | "denied" | "granted"): Promise<void> {
		expect(cfgDevAutoqaConsent.get(local)).toBe(consent);
		expect(cfgDevAutoqaConsent.get(Settings.instance)).toBe(consent);
		await Settings.instance.flush();
		const disk = YAML.parse(await fs.readFile(configPath, "utf8"));
		if (consent === "unset") {
			expect(disk.dev).not.toHaveProperty("autoqaConsent");
			expect(disk.dev).toEqual(preferences.dev);
		} else {
			expect(disk.dev).toEqual({ ...preferences.dev, autoqaConsent: consent });
		}
		expect(disk.todo).toEqual(preferences.todo);
		const reopened = await Settings.loadIsolated({ cwd: projectDir, agentDir });
		expect(cfgDevAutoqaConsent.get(reopened)).toBe(consent);
		expect(cfgDevAutoqa.get(reopened)).toBe(preferences.dev.autoqa);
		expect(cfgTodoRemindersMax.get(reopened)).toBe(preferences.todo.remindersMax);
		await reopened.flush();
	}

	async function assertNoReprompt(expected: boolean): Promise<void> {
		// A fresh caller cannot mask a missing write to the registered singleton.
		const result = resolve(Settings.isolated());
		const unexpected = mode?.hookSelector;
		if (unexpected) unexpected.handleInput("\x1b");
		expect(await result).toBe(expected);
		expect(unexpected).toBeUndefined();
	}

	it("Escape leaves consent absent on disk and reopening, and the next call prompts again", async () => {
		const first = resolve();
		const firstSelector = selector();
		firstSelector.handleInput("\x1b");
		expect(await first).toBe(false);
		expect(mode?.hookSelector).toBeUndefined();
		await assertPersisted("unset");

		const second = resolve();
		const secondSelector = selector();
		expect(secondSelector).not.toBe(firstSelector);
		secondSelector.handleInput("\x1b");
		expect(await second).toBe(false);
		await assertPersisted("unset");
	}, 60_000);

	it("Down then Enter records No as denied and does not prompt again", async () => {
		const answer = resolve();
		const presented = selector();
		presented.handleInput("\x1b[B");
		presented.handleInput("\r");
		expect(await answer).toBe(false);
		expect(mode?.hookSelector).toBeUndefined();
		await assertPersisted("denied");
		await assertNoReprompt(false);
	}, 60_000);

	it("Enter records Yes as granted and does not prompt again", async () => {
		const answer = resolve();
		selector().handleInput("\r");
		expect(await answer).toBe(true);
		expect(mode?.hookSelector).toBeUndefined();
		await assertPersisted("granted");
		await assertNoReprompt(true);
	}, 60_000);
});
