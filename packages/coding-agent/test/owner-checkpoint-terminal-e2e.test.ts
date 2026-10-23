import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "../src/config/model-registry";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { cfgSessionIdleCheckpointMs } from "../src/session/settings";
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

	it.each(["shell", "Python"] as const)(
		"refuses /park without aborting a real foreground %s execution",
		async kind => {
			const quit = vi.spyOn(postmortem, "quit").mockResolvedValue();
			await mode.init({ suppressWelcomeIntro: true });
			void mode.getUserInput();
			await terminal.waitForRender();
			const releaseFile = path.join(dir.path(), "release-foreground");
			const ready = Promise.withResolvers<void>();
			const onChunk = (chunk: string) => {
				if (chunk.includes("owner-ready")) ready.resolve();
			};
			const execution =
				kind === "shell"
					? session.executeBash(
							"printf owner-ready; while [ ! -f " +
								JSON.stringify(releaseFile) +
								" ]; do sleep 0.01; done; printf owner-finished",
							onChunk,
							{ useUserShell: false },
						)
					: session.executePython(
							"import os, time\nprint('owner-ready', flush=True)\nwhile not os.path.exists(" +
								JSON.stringify(releaseFile) +
								"):\n    time.sleep(0.01)\nprint('owner-finished', flush=True)",
							onChunk,
						);
			try {
				await Promise.race([
					ready.promise,
					execution.then(result => {
						throw new Error("Foreground execution ended before readiness: " + result.output);
					}),
				]);
				expect(kind === "shell" ? session.isBashRunning : session.isEvalRunning).toBe(true);
				terminal.sendInput("/park");
				await terminal.waitForRender();
				terminal.sendInput("\r");
				await terminal.waitForRender(
					() =>
						mode.isShuttingDown ||
						terminal.getViewport().some(row => Bun.stripANSI(row).includes("Checkpoint refused")),
				);
				expect(mode.isShuttingDown).toBe(false);
				expect(quit).not.toHaveBeenCalled();
				expect(kind === "shell" ? session.isBashRunning : session.isEvalRunning).toBe(true);
				await Bun.write(releaseFile, "release");
				const result = await execution;
				expect(result.exitCode).toBe(0);
				expect(result.output).toContain("owner-finished");
			} finally {
				await Bun.write(releaseFile, "release");
				await execution;
			}
		},
		20_000,
	);

	it("keeps a resumed draft-only owner resumable after /park disposes and closes it", async () => {
		await manager.saveDraft("resumed draft");
		const file = manager.getSessionFile()!;
		const id = manager.getSessionId();
		await manager.close();
		await manager.setSessionFile(file);
		const quit = Promise.withResolvers<void>();
		vi.spyOn(postmortem, "quit").mockImplementation(async code => {
			expect(code).toBe(0);
			quit.resolve();
		});
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("resumed draft");
		terminal.sendInput("\x15");
		await terminal.waitForRender();
		terminal.sendInput("/park");
		await terminal.waitForRender();
		terminal.sendInput("\r");
		await quit.promise;
		expect(mode.isShuttingDown).toBe(true);
		expect(manager.isSessionOnDisk()).toBe(true);
		const reopened = await SessionManager.open(file);
		try {
			expect(reopened.getSessionId()).toBe(id);
			expect(reopened.getSessionFile()).toBe(file);
			await reopened.close();
			expect(reopened.isSessionOnDisk()).toBe(true);
		} finally {
			await reopened.close();
		}
	}, 15_000);

	describe("bounded idle retirement", () => {
		const IDLE_MS = 300;
		/** Long enough for several idle windows to elapse; the owner must still be live. */
		const SEVERAL_WINDOWS_MS = IDLE_MS * 4;

		async function startIdleOwner(): Promise<void> {
			cfgSessionIdleCheckpointMs.set(session.settings, IDLE_MS);
			await mode.init({ suppressWelcomeIntro: true });
			void mode.getUserInput();
			await terminal.waitForRender();
		}

		it("checkpoints an idle owner, exits through real teardown and prints its resume command", async () => {
			const quit = Promise.withResolvers<number>();
			vi.spyOn(postmortem, "quit").mockImplementation(async code => {
				quit.resolve(code ?? 0);
			});
			const stderr: string[] = [];
			vi.spyOn(process.stderr, "write").mockImplementation(chunk => {
				stderr.push(String(chunk));
				return true;
			});
			const started = Date.now();
			await startIdleOwner();
			const id = manager.getSessionId();
			expect(await quit.promise).toBe(0);
			expect(Date.now() - started).toBeGreaterThanOrEqual(IDLE_MS);
			expect(mode.isShuttingDown).toBe(true);
			expect(Bun.stripANSI(stderr.join(""))).toContain(`--resume ${id}`);
			expect(manager.isSessionOnDisk()).toBe(true);
			const resumed = await SessionManager.open(manager.getSessionFile()!);
			try {
				expect(resumed.getSessionId()).toBe(id);
			} finally {
				await resumed.close();
			}
		}, 15_000);

		it("keeps typing activity alive and never retires an owner with an unsent draft", async () => {
			const quit = vi.spyOn(postmortem, "quit").mockResolvedValue();
			await startIdleOwner();
			// Keystrokes inside the window postpone retirement; the draft they leave then blocks it.
			for (const key of "draft") {
				await Bun.sleep(IDLE_MS / 3);
				terminal.sendInput(key);
			}
			await Bun.sleep(SEVERAL_WINDOWS_MS);
			expect(mode.isShuttingDown).toBe(false);
			expect(quit).not.toHaveBeenCalled();
			expect(mode.editor.getText()).toBe("draft");
		}, 15_000);

		it("never retires an owner while a dialog awaits an answer", async () => {
			const quit = vi.spyOn(postmortem, "quit").mockResolvedValue();
			await startIdleOwner();
			const answer = mode.showHookConfirm("Keep going?", "A pending question must hold the session.");
			await terminal.waitForRender(() =>
				terminal.getViewport().some(row => Bun.stripANSI(row).includes("Keep going?")),
			);
			await Bun.sleep(SEVERAL_WINDOWS_MS);
			expect(mode.isShuttingDown).toBe(false);
			expect(quit).not.toHaveBeenCalled();
			terminal.sendInput("\x1b");
			await answer;
		}, 15_000);

		it("never retires an owner during a real foreground shell run", async () => {
			const quit = vi.spyOn(postmortem, "quit").mockResolvedValue();
			await startIdleOwner();
			const releaseFile = path.join(dir.path(), "release-idle");
			const ready = Promise.withResolvers<void>();
			const execution = session.executeBash(
				"printf idle-ready; while [ ! -f " +
					JSON.stringify(releaseFile) +
					" ]; do sleep 0.01; done; printf idle-finished",
				chunk => {
					if (chunk.includes("idle-ready")) ready.resolve();
				},
				{ useUserShell: false },
			);
			try {
				await ready.promise;
				await Bun.sleep(SEVERAL_WINDOWS_MS);
				expect(session.isBashRunning).toBe(true);
				expect(mode.isShuttingDown).toBe(false);
				expect(quit).not.toHaveBeenCalled();
			} finally {
				await Bun.write(releaseFile, "release");
			}
			const result = await execution;
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("idle-finished");
		}, 20_000);

		it("never arms when the bound is 0", async () => {
			const quit = vi.spyOn(postmortem, "quit").mockResolvedValue();
			cfgSessionIdleCheckpointMs.set(session.settings, 0);
			await mode.init({ suppressWelcomeIntro: true });
			void mode.getUserInput();
			await terminal.waitForRender();
			await Bun.sleep(SEVERAL_WINDOWS_MS);
			expect(mode.isShuttingDown).toBe(false);
			expect(quit).not.toHaveBeenCalled();
		}, 15_000);
	});
});
