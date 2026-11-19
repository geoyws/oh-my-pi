/**
 * InteractiveMode vim wiring from line 6563: toggling `tui.vimMode` on a live
 * session, the mode surfaces it drives (status segment, cursor shape), and
 * Visual-mode yanks routed to the clipboard. Runs against an initialized mode
 * so the live settings listener is armed.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import {
	cfgMarketplaceAutoUpdate,
	cfgStartupChangelogMode,
	cfgStartupCheckUpdate,
	cfgStartupSetupWizard,
	cfgStartupShowSplash,
	cfgTuiVimMode,
} from "@oh-my-pi/pi-coding-agent/modes/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { closeSessionIndex } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as clipboard from "@oh-my-pi/pi-coding-agent/utils/clipboard";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

describe("InteractiveMode vim wiring (lines 6563-6621)", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let local: Settings;
	let mode: InteractiveMode;

	/** Flip `tui.vimMode` the way `/settings` does: the global the editor reads, and the session's live store. */
	async function setVim(enabled: boolean): Promise<void> {
		cfgTuiVimMode.set(settings, enabled);
		cfgTuiVimMode.set(local, enabled);
		await Bun.sleep(0);
	}

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-im-r5601-vim-");
		resetSettingsForTest();
		await initTheme();
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		local = Settings.isolated();
		cfgStartupCheckUpdate.override(local, false);
		cfgStartupChangelogMode.override(local, "hidden");
		cfgStartupSetupWizard.override(local, false);
		cfgStartupShowSplash.override(local, false);
		cfgMarketplaceAutoUpdate.override(local, "off");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.join("sessions")),
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
			new Composer({ terminal: new VirtualTerminal(160, 40) }),
		);
		spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		await mode.init({ suppressWelcomeIntro: true });
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

	it("turning vim on mid-session lands in Insert and surfaces each mode switch; off restores the plain editor", async () => {
		const vimStatus = spyOn(mode.statusLine, "setVimStatus");
		mode.ui.terminal.setCursorShape ??= () => {};
		const cursor = spyOn(mode.ui.terminal, "setCursorShape");

		await setVim(true);
		expect(mode.editor.vimEnabled).toBe(true);
		expect(vimStatus.mock.calls.at(-1)?.[0]).toMatchObject({ mode: "insert", pending: "" });
		expect(cursor.mock.calls.at(-1)).toEqual(["bar"]);

		mode.editor.handleInput("\x1b");
		expect(mode.editor.vimMode).toBe("normal");
		expect(vimStatus.mock.calls.at(-1)?.[0]).toMatchObject({ mode: "normal" });
		expect(cursor.mock.calls.at(-1)).toEqual(["block"]);

		await setVim(false);
		expect(mode.editor.vimEnabled).toBe(false);
		expect(vimStatus.mock.calls.at(-1)?.[0]).toBeUndefined();
		expect(cursor.mock.calls.at(-1)).toEqual(["default"]);
	});

	it("copies a yank to the system clipboard", async () => {
		const copy = spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);

		mode.editor.onYank?.("yanked line");
		await Bun.sleep(0);

		expect(copy).toHaveBeenCalledWith("yanked line");
	});

	it.each([
		["an Error", new Error("no display"), "no display"],
		["a non-Error", "pbcopy missing", "pbcopy missing"],
	])("only logs a yank the clipboard rejects (%s): the register still holds it", async (_label, failure, detail) => {
		spyOn(clipboard, "copyToClipboard").mockRejectedValue(failure);
		const debug = spyOn(logger, "debug");
		const warn = spyOn(mode, "showWarning");

		mode.editor.onYank?.("yanked line");
		await Bun.sleep(0);

		expect(debug).toHaveBeenCalledWith("Vim yank clipboard copy failed", { error: detail });
		expect(warn).not.toHaveBeenCalled();
	});
});
