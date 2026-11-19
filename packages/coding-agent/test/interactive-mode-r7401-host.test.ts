/**
 * InteractiveMode behaviour from line 8112 that only exists after `init()`:
 * the `cfg://` approval prompt it registers, and the shared signal teardown a
 * close runs instead of a bare session dispose.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as cfgProtocol from "@oh-my-pi/pi-coding-agent/internal-urls/cfg-protocol";
import type { CfgApprovalHost, CfgChangeRequest } from "@oh-my-pi/pi-coding-agent/internal-urls/cfg-protocol";
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import {
	cfgAskTimeout,
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
import { closeSessionIndex } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";
import * as utils from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

type SelectorOptions = { initialIndex?: number; timeout?: number; signal?: AbortSignal; onTimeout?: () => void };

describe("InteractiveMode init-wired host surfaces (lines 8112-8435)", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let host: CfgApprovalHost | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-im-r7401-host-");
		spyOn(utils, "getConfigRootDir").mockReturnValue(tempDir.path());
		resetSettingsForTest();
		await initTheme();
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		const local = Settings.isolated();
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
			new Composer({ terminal: new VirtualTerminal(200, 60) }),
		);
		spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		host = undefined;
		spyOn(cfgProtocol, "setCfgApprovalHost").mockImplementation(registered => {
			host = registered ?? host;
		});
		await mode.init({ suppressWelcomeIntro: true });
	});

	afterEach(async () => {
		mode.stop();
		vi.restoreAllMocks();
		cfgProtocol.setCfgApprovalHost(null);
		await session.dispose();
		authStorage.close();
		AgentStorage.close();
		HistoryStorage.close();
		closeSessionIndex();
		closeModelCache();
		resetSettingsForTest();
		tempDir.removeSync();
	});

	describe("cfg:// change approval", () => {
		const request: CfgChangeRequest = { path: "advisor.enabled", previous: "false", value: "true", save: false };

		function answer(choice: string | undefined, onShown?: (title: string, options: SelectorOptions) => void) {
			return spyOn(ExtensionUiController.prototype, "showCollabAwareSelector").mockImplementation(
				async (title: string, _labels: unknown, options?: SelectorOptions) => {
					onShown?.(title, options ?? {});
					return choice;
				},
			);
		}

		function approve(change: CfgChangeRequest, signal?: AbortSignal) {
			if (!host) throw new Error("init did not register a cfg approval host");
			return host.approve(change, signal ? { signal } : undefined);
		}

		it.each([
			["Always for this session", "session"],
			["Allow once", "once"],
			["Deny", "deny"],
			[undefined, "deny"],
		] as const)("answering %s approves %s", async (choice, outcome) => {
			const selector = answer(choice);

			expect(await approve(request)).toBe(outcome);

			const [title, labels, options] = selector.mock.calls[0] ?? [];
			expect(title).toBe("⚙️ Your agent wants to change `advisor.enabled` for this session.\nfalse → true");
			expect(labels).toEqual(["Always for this session", "Allow once", "Deny"]);
			// A reflexive Enter lands on "Allow once", never the session-wide grant.
			expect((options as SelectorOptions).initialIndex).toBe(1);
		});

		it("asks to save with the shadowing warning when a higher layer overrides the saved value", async () => {
			const selector = answer("Allow once");

			await approve({ ...request, save: true, shadowedBy: "project config" });

			expect(selector.mock.calls[0]?.[0]).toBe(
				"💾 Your agent wants to save `advisor.enabled` to your config.\nfalse → true\n⚠️ Overridden by your project config: the saved value won't take effect here.",
			);
		});

		it("passes the ask.timeout deadline and reports an expired prompt as a timeout, whatever was highlighted", async () => {
			cfgAskTimeout.set(session.settings, 45);
			let seen: SelectorOptions | undefined;
			answer("Allow once", (_title, options) => {
				seen = options;
				options.onTimeout?.();
			});

			expect(await approve(request)).toBe("timeout");
			expect(seen?.timeout).toBe(45_000);
		});

		it("dismisses with the calling turn's abort as well as with the mode's lifetime", async () => {
			const signals: AbortSignal[] = [];
			answer("Allow once", (_title, options) => {
				if (options.signal) signals.push(options.signal);
			});
			const turn = new AbortController();

			await approve(request, turn.signal);
			await approve(request);

			const [withCaller, lifetimeOnly] = signals;
			expect(withCaller?.aborted).toBe(false);
			turn.abort();
			expect(withCaller?.aborted).toBe(true);
			expect(lifetimeOnly?.aborted).toBe(false);
			mode.stop();
			expect(lifetimeOnly?.aborted).toBe(true);
		});
	});

	describe("close", () => {
		it("runs the shared signal teardown, which saves the composer draft before disposing", async () => {
			spyOn(postmortem, "quit").mockResolvedValue(undefined as never);
			spyOn(mode.ui.terminal, "drainInput").mockResolvedValue();
			const saveDraft = spyOn(mode.sessionManager, "saveDraft");
			const dispose = spyOn(session, "dispose");
			const stderr: string[] = [];
			spyOn(process.stderr, "write").mockImplementation(chunk => {
				stderr.push(String(chunk));
				return true;
			});
			mode.editor.setText("half-written thought");

			await mode.shutdown();

			expect(saveDraft).toHaveBeenCalledWith("half-written thought");
			expect(dispose).toHaveBeenCalledTimes(1);
			expect(postmortem.quit).toHaveBeenCalledWith(0);
			// The saved draft materialized the session, so the close names how to resume it.
			expect(stderr.join("")).toContain(`--resume ${mode.sessionManager.getSessionId()}`);
		});
	});
});
