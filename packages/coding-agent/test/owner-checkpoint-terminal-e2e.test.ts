import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "../src/config/model-registry";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

describe("owner checkpoint terminal flow", () => {
	let dir: TempDir;
	let auth: AuthStorage;
	let session: AgentSession;
	let manager: SessionManager;
	let mode: InteractiveMode;
	let terminal: VirtualTerminal;
	beforeAll(() => initTheme());
	beforeEach(async () => {
		resetSettingsForTest();
		dir = TempDir.createSync("@omp-owner-park-e2e-");
		await Settings.init({ inMemory: true, cwd: dir.path() });
		auth = await AuthStorage.create(":memory:");
		const registry = new ModelRegistry(auth);
		const model = registry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		manager = SessionManager.create(dir.path(), path.join(dir.path(), "sessions"));
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["test"], tools: [], messages: [] } }),
			sessionManager: manager,
			settings: Settings.isolated(),
			modelRegistry: registry,
		});
		terminal = new VirtualTerminal(120, 32);
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			() => {},
			undefined,
			undefined,
			undefined,
			new Composer({ terminal }),
		);
	});
	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		vi.restoreAllMocks();
		auth?.close();
		dir?.removeSync();
		resetSettingsForTest();
	});
	it("accepts /park through terminal input and resumes its durable session after real teardown", async () => {
		const quit = Promise.withResolvers<void>();
		// Only stop at the process-exit boundary; input dispatch, checkpoint and disposal run for real.
		vi.spyOn(postmortem, "quit").mockImplementation(async code => {
			expect(code).toBe(0);
			quit.resolve();
		});
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await terminal.waitForRender();
		const id = manager.getSessionId();
		terminal.sendInput("/park");
		await terminal.waitForRender();
		terminal.sendInput("\r");
		await quit.promise;
		expect(mode.isShuttingDown).toBe(true);
		expect(manager.isSessionOnDisk()).toBe(true);
		const resumed = await SessionManager.open(manager.getSessionFile()!);
		try {
			expect(resumed.getSessionId()).toBe(id);
		} finally {
			await resumed.close();
		}
	}, 15_000);
	it("refuses /park while a turn is streaming and leaves the terminal session live", async () => {
		const quit = vi.spyOn(postmortem, "quit").mockResolvedValue();
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await terminal.waitForRender();
		session.agent.state.isStreaming = true;
		try {
			terminal.sendInput("/park");
			await terminal.waitForRender();
			terminal.sendInput("\r");
			await terminal.waitForRender(() =>
				terminal.getViewport().some(row => Bun.stripANSI(row).includes("Checkpoint refused")),
			);
			expect(mode.isShuttingDown).toBe(false);
			expect(quit).not.toHaveBeenCalled();
			expect(session.isStreaming).toBe(true);
		} finally {
			session.agent.state.isStreaming = false;
		}
	}, 15_000);
});
