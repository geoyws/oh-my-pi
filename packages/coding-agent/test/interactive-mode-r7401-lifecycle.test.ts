/**
 * InteractiveMode from line 8227: shutdown, restart and the settled-boundary
 * shutdown request, the custom-editor swap, and the presentation surfaces
 * (deferred command panels, session info, jobs sheet, pinned errors, LSP
 * startup warnings).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LSP_STARTUP_EVENT_CHANNEL } from "@oh-my-pi/pi-coding-agent/lsp/startup-events";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as sessionWorktree from "@oh-my-pi/pi-coding-agent/session/session-worktree";
import { cfgStartupQuiet } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { cfgWorktreeOnExit } from "@oh-my-pi/pi-coding-agent/task/settings";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import * as natives from "@oh-my-pi/pi-natives";
import { Text } from "@oh-my-pi/pi-tui";
import { ChatBlock } from "@oh-my-pi/pi-tui/chrome/chat-block";
import * as jobsPanel from "@oh-my-pi/pi-tui/overlays/jobs-panel";
import { SessionInfoOverlay } from "@oh-my-pi/pi-tui/overlays/session-info-overlay";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { logger, postmortem, TempDir } from "@oh-my-pi/pi-utils";
import * as utils from "@oh-my-pi/pi-utils";

describe("InteractiveMode shutdown and presentation (lines 8227-8800)", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession;
	let mode: InteractiveMode;
	let eventBus: EventBus;
	let warnings: string[];
	let errors: string[];
	let stderr: string[];

	async function freshMode(): Promise<void> {
		if (mode) {
			mode.stop();
			await session.dispose();
		}
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		eventBus = new EventBus();
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, eventBus);
		mode.ui.requestRender = vi.fn();
		warnings = [];
		errors = [];
		stderr = [];
		spyOn(mode, "showWarning").mockImplementation(message => void warnings.push(message));
		spyOn(mode, "showStatus").mockImplementation(() => {});
		spyOn(mode, "showError").mockImplementation(message => void errors.push(message));
	}

	/** Stub everything a close touches outside the process: session disposal, the terminal and the exit itself. */
	function stubClose(): { quit: ReturnType<typeof spyOn> } {
		spyOn(session, "dispose").mockResolvedValue();
		spyOn(mode.ui.terminal, "drainInput").mockResolvedValue();
		spyOn(process.stderr, "write").mockImplementation(chunk => {
			stderr.push(String(chunk));
			return true;
		});
		return { quit: spyOn(postmortem, "quit").mockResolvedValue(undefined as never) };
	}

	/** Record one launch-owned worktree through `/wt`. */
	async function ownWorktree(): Promise<object> {
		const worktree = { path: "/tmp/wt-owned", branch: "wt/owned" };
		spyOn(CommandController.prototype, "handleWorktreeCommand").mockResolvedValue(worktree as never);
		await mode.handleWorktreeCommand("wt/owned");
		return worktree;
	}

	// bun's spyOn cannot wrap accessors yet: stub prototype getters by hand and restore them after each test.
	const stubbedGetters: Array<{ proto: object; prop: string; descriptor: PropertyDescriptor }> = [];
	function stubGetter(proto: object, prop: string, get: () => unknown): void {
		const descriptor = Object.getOwnPropertyDescriptor(proto, prop);
		if (!descriptor) throw new Error(`no accessor ${prop}`);
		stubbedGetters.push({ proto, prop, descriptor });
		Object.defineProperty(proto, prop, { ...descriptor, get });
	}

	beforeAll(async () => {
		await initTheme();
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-im-r7401-lifecycle-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(() => {
		for (const { proto, prop, descriptor } of stubbedGetters.splice(0).reverse()) {
			Object.defineProperty(proto, prop, descriptor);
		}
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	describe("shutdown", () => {
		it("closes once: a second call during the close is ignored", async () => {
			await freshMode();
			const { quit } = stubClose();

			await Promise.all([mode.shutdown(), mode.shutdown()]);

			expect(quit).toHaveBeenCalledTimes(1);
			expect(quit).toHaveBeenCalledWith(0);
		});

		it("prints worktree cleanup messages and the resume command for a session on disk", async () => {
			await freshMode();
			stubClose();
			spyOn(sessionWorktree, "removeExitWorktrees").mockResolvedValue(["Removed /tmp/wt-owned"]);
			spyOn(mode.sessionManager, "isSessionOnDisk").mockReturnValue(true);
			spyOn(mode.sessionManager, "getSessionFile").mockReturnValue("/s/session.jsonl");

			await mode.shutdown();

			const output = stderr.join("");
			expect(output).toContain("Removed /tmp/wt-owned");
			expect(output).toContain("Resume this session with");
			expect(output).toContain(mode.sessionManager.getSessionId());
		});

		it("an unattended close leaves owned worktrees alone", async () => {
			await freshMode();
			await ownWorktree();
			cfgWorktreeOnExit.set(mode.settings, "remove");
			stubClose();
			const plan = spyOn(sessionWorktree, "planWorktreeExit");
			const remove = spyOn(sessionWorktree, "removeExitWorktrees");

			await mode.shutdown({ unattended: true });

			expect(plan).not.toHaveBeenCalled();
			expect(remove).toHaveBeenCalledWith([]);
		});

		it.each([
			["an Error", new Error("abort hung"), "abort hung"],
			["a non-Error", "abort hung", "abort hung"],
		])("plans worktree exit after stopping the turn, warning on %s from the stop", async (_label, failure, message) => {
			await freshMode();
			const worktree = await ownWorktree();
			cfgWorktreeOnExit.set(mode.settings, "ask");
			stubClose();
			spyOn(session, "abort").mockRejectedValue(failure);
			const confirm = spyOn(mode, "showHookConfirm").mockResolvedValue(true);
			const plan = spyOn(sessionWorktree, "planWorktreeExit").mockImplementation(
				async (worktrees, policy, ask, warn) => {
					expect(worktrees).toEqual([worktree]);
					expect(policy).toBe("ask");
					expect(await ask("Remove worktree?", "wt/owned")).toBe(true);
					warn("kept wt/owned");
					return [];
				},
			);

			await mode.shutdown();

			expect(plan).toHaveBeenCalledTimes(1);
			expect(confirm).toHaveBeenCalledWith("Remove worktree?", "wt/owned");
			expect(warnings).toEqual([message, "kept wt/owned"]);
		});

		it("reports a non-Error teardown failure and stays open for a retry", async () => {
			await freshMode();
			const { quit } = stubClose();
			spyOn(session, "dispose").mockRejectedValue("disk full");

			await mode.shutdown();

			expect(errors).toEqual(["Could not close session: disk full"]);
			expect(mode.isShuttingDown).toBe(false);
			expect(quit).not.toHaveBeenCalled();
		});
	});

	describe("restart", () => {
		function stubRelaunch() {
			spyOn(postmortem, "cleanup").mockResolvedValue();
			spyOn(postmortem, "drainStdout").mockResolvedValue();
			return {
				exec: spyOn(natives, "execReplace").mockImplementation(() => undefined as never),
				spawn: spyOn(Bun, "spawn").mockReturnValue({ exited: Promise.resolve(3) } as never),
			};
		}

		it("relaunches once with the active profile; a second call during the close is ignored", async () => {
			await freshMode();
			const { quit } = stubClose();
			spyOn(utils, "getActiveProfile").mockReturnValue("work");
			const { exec, spawn } = stubRelaunch();

			await Promise.all([mode.restart(), mode.restart()]);

			const relaunch = (process.platform === "win32" ? spawn.mock.calls[0]?.[0] : exec.mock.calls[0]?.[0]) as string[];
			expect(relaunch.slice(-2)).toEqual(["--profile", "work"]);
			expect(spawn).toHaveBeenCalledTimes(1);
			expect(quit).toHaveBeenCalledWith(3);
		});

		it.each([
			["an Error", new Error("ENOEXEC"), "ENOEXEC"],
			["a non-Error", "ENOEXEC", "ENOEXEC"],
		])("falls back to spawning when exec fails with %s", async (_label, failure, detail) => {
			await freshMode();
			const { quit } = stubClose();
			const { exec, spawn } = stubRelaunch();
			exec.mockImplementation(() => {
				throw failure;
			});

			await mode.restart();

			if (process.platform !== "win32") expect(stderr.join("")).toContain(`Restart exec failed: ${detail}`);
			expect(spawn).toHaveBeenCalledTimes(1);
			expect(quit).toHaveBeenCalledWith(3);
		});

		it.each([
			["an Error", new Error("EAGAIN"), "EAGAIN"],
			["a non-Error", "EAGAIN", "EAGAIN"],
		])("exits 1 when the fallback spawn fails with %s", async (_label, failure, detail) => {
			await freshMode();
			const { quit } = stubClose();
			const { exec, spawn } = stubRelaunch();
			exec.mockImplementation(() => {
				throw new Error("ENOEXEC");
			});
			spawn.mockImplementation(() => {
				throw failure;
			});

			await mode.restart();

			expect(stderr.join("")).toContain(`Restart spawn failed: ${detail}`);
			expect(quit).toHaveBeenCalledWith(1);
		});

		it("spawns directly on Windows, where there is no exec", async () => {
			await freshMode();
			stubClose();
			const { exec, spawn } = stubRelaunch();
			const platform = Object.getOwnPropertyDescriptor(process, "platform");
			Object.defineProperty(process, "platform", { value: "win32", configurable: true });
			try {
				await mode.restart();
			} finally {
				if (platform) Object.defineProperty(process, "platform", platform);
			}

			expect(exec).not.toHaveBeenCalled();
			expect(spawn).toHaveBeenCalledTimes(1);
		});
	});

	describe("shutdown requests", () => {
		it("hasPendingSubmission tracks a submission accepted but not yet handed to the session", async () => {
			await freshMode();
			expect(mode.hasPendingSubmission()).toBe(false);

			mode.startPendingSubmission({ text: "hello" });

			expect(mode.hasPendingSubmission()).toBe(true);
		});

		it("does nothing until a shutdown is requested", async () => {
			await freshMode();
			const idle = spyOn(session, "waitForIdle");
			const shutdown = spyOn(mode, "shutdown").mockResolvedValue();

			await mode.checkShutdownRequested();

			expect(idle).not.toHaveBeenCalled();
			expect(shutdown).not.toHaveBeenCalled();
		});

		it("does nothing once a close is already under way", async () => {
			await freshMode();
			mode.shutdownRequested = true;
			stubGetter(InteractiveMode.prototype, "isShuttingDown", () => true);
			const idle = spyOn(session, "waitForIdle");

			await mode.checkShutdownRequested();

			expect(idle).not.toHaveBeenCalled();
		});

		it("waits out admitted submissions, then shuts down at a settled boundary", async () => {
			await freshMode();
			mode.shutdownRequested = true;
			const admitted = [true, false];
			stubGetter(AgentSession.prototype, "hasAdmittedSubmission", () => admitted.shift() ?? false);
			const idle = spyOn(session, "waitForIdle").mockResolvedValue();
			const drain = spyOn(session, "waitForAdmittedSubmissions").mockResolvedValue();
			const shutdown = spyOn(mode, "shutdown").mockResolvedValue();

			await mode.checkShutdownRequested();

			expect(idle).toHaveBeenCalledTimes(2);
			expect(drain).toHaveBeenCalledTimes(1);
			expect(shutdown).toHaveBeenCalledTimes(1);
		});

		it.each([
			["a close started meanwhile", () => {
				const shutting = [false, true];
				stubGetter(InteractiveMode.prototype, "isShuttingDown", () => shutting.shift() ?? true);
			}],
			["a submission is pending", () => void spyOn(mode, "hasPendingSubmission").mockReturnValue(true)],
			["a submission was admitted", () => {
				const admitted = [false, true];
				stubGetter(AgentSession.prototype, "hasAdmittedSubmission", () => admitted.shift() ?? true);
			}],
			["a turn is streaming", () => stubGetter(AgentSession.prototype, "isStreaming", () => true)],
			["messages are queued", () => stubGetter(AgentSession.prototype, "queuedMessageCount", () => 2)],
			["async work is pending", () => void spyOn(session, "hasPendingAsyncWork").mockReturnValue(true)],
		])("stays open when %s at the boundary", async (_label, arrange) => {
			await freshMode();
			mode.shutdownRequested = true;
			spyOn(session, "waitForIdle").mockResolvedValue();
			arrange();
			const shutdown = spyOn(mode, "shutdown").mockResolvedValue();

			await mode.checkShutdownRequested();

			expect(shutdown).not.toHaveBeenCalled();
		});

		it("requestShutdown flags the request and starts the boundary check at once", async () => {
			await freshMode();
			spyOn(session, "waitForIdle").mockResolvedValue();
			const shutdown = spyOn(mode, "shutdown").mockResolvedValue();

			mode.requestShutdown();
			await Bun.sleep(0);

			expect(mode.shutdownRequested).toBe(true);
			expect(shutdown).toHaveBeenCalledTimes(1);
		});

		it.each([
			["an Error", new Error("dispose failed"), "dispose failed"],
			["a non-Error", "dispose failed", "dispose failed"],
		])("requestShutdown reports %s from the close", async (_label, failure, detail) => {
			await freshMode();
			spyOn(session, "waitForIdle").mockResolvedValue();
			spyOn(mode, "shutdown").mockRejectedValue(failure);

			mode.requestShutdown();
			await Bun.sleep(0);

			expect(errors).toEqual([`Shutdown failed: ${detail}`]);
		});
	});

	describe("extension UI", () => {
		it("initializeHookRunner hands the context to the extension UI controller", async () => {
			await freshMode();
			const init = spyOn(ExtensionUiController.prototype, "initializeHookRunner").mockImplementation(() => {});
			const context = { id: "ui" } as never;

			mode.initializeHookRunner(context, true);

			expect(init).toHaveBeenCalledWith(context, true);
		});
	});

	describe("custom editor swap", () => {
		it("wires the new editor to this mode's terminal, settings, session and render loop", async () => {
			await freshMode();
			let repaint: (() => void) | undefined;
			spyOn(CustomEditor.prototype, "setShimmerRepaintHandler").mockImplementation(handler => {
				repaint = handler;
			});
			const componentRender = spyOn(mode.ui, "requestComponentRender").mockImplementation(() => {});
			const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
			const mention = spyOn(session, "findMentionableModel").mockImplementation(selector =>
				selector === "sonnet" ? model : undefined,
			);
			mode.skillCommands.set("skill:deploy", { filePath: "/skills/deploy/SKILL.md" } as never);

			mode.setEditorComponent(undefined);
			const editor = mode.editor;

			expect(editor.viewportRowsProvider?.()).toBe(mode.ui.terminal.rows);
			expect(typeof editor.magicKeywordsEnabled?.()).toBe("boolean");
			expect(typeof editor.placeholder?.()).toBe("string");
			// No turn has run, so there is no composer prediction yet.
			expect(editor.prediction?.()).toBeUndefined();
			expect(editor.composerState?.()).toBeDefined();
			expect(editor.skillFilePath?.("deploy")).toBe("/skills/deploy/SKILL.md");
			expect(editor.skillFilePath?.("missing")).toBeUndefined();
			expect(editor.modelMentionLabel?.("sonnet")).toEqual(expect.any(String));
			expect(editor.modelMentionLabel?.("nobody")).toBeUndefined();
			expect(mention).toHaveBeenCalledWith("nobody");
			expect(editor.modelMentionSelector?.("no-such-agent")).toBeUndefined();
			expect(editor.fileHyperlink?.("/repo/a.ts", "a.ts")).toContain("a.ts");

			const render = mode.ui.requestRender as ReturnType<typeof vi.fn>;
			render.mockClear();
			editor.onAutocompleteCancel?.();
			editor.onAutocompleteUpdate?.();
			expect(render.mock.calls).toEqual([[true], []]);

			repaint?.();
			expect(componentRender).toHaveBeenCalledWith(editor);

			editor.onToggleDictation?.();
			await Bun.sleep(0);
			expect(warnings).toContain("Speech-to-text is disabled. Enable it in settings: stt.enabled");
		});

		it("skips history storage when the mode has none and logs a slash-command refresh failure", async () => {
			await freshMode();
			mode.historyStorage = undefined;
			const history = spyOn(CustomEditor.prototype, "setHistoryStorage");
			spyOn(mode, "refreshSlashCommandState").mockRejectedValue(new Error("catalog busy"));
			const warn = spyOn(logger, "warn").mockImplementation(() => {});

			mode.setEditorComponent(undefined);
			await Bun.sleep(0);

			expect(history).not.toHaveBeenCalled();
			expect(warn).toHaveBeenCalledWith("Failed to refresh slash command state for custom editor", {
				error: "Error: catalog busy",
			});
		});
	});

	describe("command output deferral", () => {
		it("drops panels queued for an earlier session when a new one queues", async () => {
			await freshMode();
			stubGetter(AgentSession.prototype, "isStreaming", () => true);
			const ids = spyOn(mode.sessionManager, "getSessionId").mockReturnValue("s-1");
			const stale = new Text("stale panel");
			const fresh = new Text("fresh panel");

			mode.presentCommandOutput(stale);
			ids.mockReturnValue("s-2");
			mode.presentCommandOutput([fresh]);
			mode.flushPendingCommandOutput();

			expect(mode.chatContainer.children).toContain(fresh);
			expect(mode.chatContainer.children).not.toContain(stale);
		});

		it("discards queued panels when the session changed before the flush", async () => {
			await freshMode();
			stubGetter(AgentSession.prototype, "isStreaming", () => true);
			const ids = spyOn(mode.sessionManager, "getSessionId").mockReturnValue("s-1");
			const panel = new Text("panel");

			mode.presentCommandOutput(panel);
			ids.mockReturnValue("s-2");
			mode.flushPendingCommandOutput();

			expect(mode.chatContainer.children).not.toContain(panel);
			expect(mode.deferredCommandContainer.children).toEqual([]);
		});

		it("mounts a chat block into the chat host", async () => {
			await freshMode();
			const block = Object.create(ChatBlock.prototype) as ChatBlock;
			const mount = spyOn(ChatBlock.prototype, "mount").mockImplementation(() => {});

			mode.present(block);

			expect(mode.chatContainer.children).toContain(block);
			expect(mount).toHaveBeenCalledTimes(1);
			expect(mount.mock.calls[0]?.[0]).toBeDefined();
		});
	});

	describe("overlays", () => {
		it("session info replaces an open panel, takes focus and closes on Escape", async () => {
			await freshMode();
			const handles: Array<{ hide: ReturnType<typeof vi.fn> }> = [];
			const show = spyOn(mode.ui, "showOverlay").mockImplementation(() => {
				const handle = { hide: vi.fn() };
				handles.push(handle);
				return handle as never;
			});
			const focus = spyOn(mode.ui, "setFocus").mockImplementation(() => {});

			mode.showSessionInfo("first");
			mode.showSessionInfo("second");

			expect(handles[0]?.hide).toHaveBeenCalledTimes(1);
			const overlay = show.mock.calls[1]?.[0] as SessionInfoOverlay;
			expect(overlay).toBeInstanceOf(SessionInfoOverlay);
			expect(focus).toHaveBeenCalledWith(overlay);

			overlay.handleInput("\x1b");
			expect(handles[1]?.hide).toHaveBeenCalledTimes(1);
		});

		it("the jobs sheet warns when the session has no job tree", async () => {
			await freshMode();
			spyOn(session, "getAsyncJobTree").mockReturnValue(null);
			const show = spyOn(mode.ui, "showOverlay");

			mode.showJobsSheet();

			expect(warnings).toEqual(["Async background jobs are unavailable in this session."]);
			expect(show).not.toHaveBeenCalled();
		});

		it("the jobs sheet opens once, reads and cancels the session's jobs, refreshes and closes", async () => {
			await freshMode();
			vi.useFakeTimers();
			try {
				const tree = { running: [], recent: [] };
				const jobTree = spyOn(session, "getAsyncJobTree").mockReturnValueOnce(tree).mockReturnValueOnce(null);
				const inspect = spyOn(session, "inspectAsyncJob").mockReturnValue({ id: "j1" } as never);
				const cancel = spyOn(session, "cancelAsyncJob").mockReturnValue(true);
				let source: ConstructorParameters<typeof jobsPanel.JobsSheet>[0] | undefined;
				const sheet = { render: () => [], invalidate: () => {} };
				spyOn(jobsPanel, "JobsSheet").mockImplementation(function (deps: typeof source) {
					source = deps;
					return sheet;
				} as never);
				const handle = { hide: vi.fn() };
				const show = spyOn(mode.ui, "showOverlay").mockReturnValue(handle as never);
				spyOn(mode.ui, "setFocus").mockImplementation(() => {});

				mode.showJobsSheet();
				mode.showJobsSheet();

				expect(show).toHaveBeenCalledTimes(1);
				if (!source) throw new Error("expected a jobs source");
				expect(source.load()).toEqual({ running: [], recent: [] });
				jobTree.mockReturnValue(tree);
				expect(source.load()).toBe(tree);
				expect(source.inspect("j1")).toEqual({ id: "j1" });
				expect(inspect).toHaveBeenCalledWith("j1");

				const render = mode.ui.requestRender as ReturnType<typeof vi.fn>;
				render.mockClear();
				source.cancel?.("j1");
				expect(cancel).toHaveBeenCalledWith("j1");
				expect(render).toHaveBeenCalledTimes(1);

				vi.advanceTimersByTime(5_000);
				expect(render.mock.calls.length).toBeGreaterThan(1);

				source.close();
				expect(handle.hide).toHaveBeenCalledTimes(1);
				render.mockClear();
				vi.advanceTimersByTime(5_000);
				expect(render.mock.calls.length).toBeLessThanOrEqual(1);
			} finally {
				vi.useRealTimers();
			}
		});

		it("a focused subagent view opens the jobs sheet without Cancel", async () => {
			await freshMode();
			stubGetter(InteractiveMode.prototype, "focusedAgentId", () => "agent-1");
			spyOn(session, "getAsyncJobTree").mockReturnValue({ running: [], recent: [] } as never);
			let source: { cancel?: unknown } | undefined;
			spyOn(jobsPanel, "JobsSheet").mockImplementation(function (deps: typeof source) {
				source = deps;
				return { render: () => [], invalidate: () => {} };
			} as never);
			spyOn(mode.ui, "showOverlay").mockReturnValue({ hide: vi.fn() } as never);
			spyOn(mode.ui, "setFocus").mockImplementation(() => {});

			mode.showJobsSheet();

			expect(source).toBeDefined();
			expect(source?.cancel).toBeUndefined();
		});
	});

	describe("errors and warnings", () => {
		it("showError stops a running working row before reporting", async () => {
			await freshMode();
			(mode.showError as unknown as ReturnType<typeof spyOn>).mockRestore();
			const loader = { stop: vi.fn() };
			mode.loadingAnimation = loader as never;

			mode.showError("boom");

			expect(loader.stop).toHaveBeenCalledTimes(1);
			expect(mode.loadingAnimation).toBeUndefined();
		});

		it("a pinned error is dismissed by its banner and clearing an empty banner is a no-op", async () => {
			await freshMode();
			const render = mode.ui.requestRender as ReturnType<typeof vi.fn>;
			render.mockClear();
			mode.clearPinnedError();
			expect(render).not.toHaveBeenCalled();

			mode.showPinnedError("quota exhausted");
			const banner = mode.errorBannerContainer.children[0] as unknown as {
				handleNativeEvent(event: unknown): void;
			};
			banner.handleNativeEvent({ type: "action", act: "dismiss" });

			expect(mode.errorBannerContainer.children).toEqual([]);
		});

		it.each([
			[{ type: "failed", error: "spawn ENOENT" }, ["LSP startup failed: spawn ENOENT. It will retry lazily on write."]],
			[
				{ type: "completed", servers: [{ name: "tsserver", status: "error", error: "crashed" }] },
				["LSP startup failed for tsserver: crashed. It will retry lazily on write."],
			],
			[
				{ type: "completed", servers: [{ name: "gopls", status: "error" }] },
				["LSP startup failed for gopls. It will retry lazily on write."],
			],
			[
				{
					type: "completed",
					servers: [
						{ name: "tsserver", status: "error" },
						{ name: "gopls", status: "error" },
						{ name: "rust-analyzer", status: "ready" },
					],
				},
				["LSP startup failed for tsserver, gopls. It will retry lazily on write."],
			],
			[{ type: "completed", servers: [{ name: "tsserver", status: "ready" }] }, []],
		])("LSP startup event %j warns %j", async (event, expected) => {
			await freshMode();
			cfgStartupQuiet.set(mode.settings, false);

			eventBus.emit(LSP_STARTUP_EVENT_CHANNEL, event);

			expect(warnings).toEqual(expected);
		});
	});
});
