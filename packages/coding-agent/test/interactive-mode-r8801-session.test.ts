/**
 * InteractiveMode behaviour from line 8801 to the end that is more than a
 * hand-off: vibe-mode guards on session transitions, worktree auto-creation,
 * push-to-talk dictation, screen recording, live-mode gating, /btw branching,
 * Ctrl+L appearance refresh, report sizing and the TODO HUD reveal.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgGoalEnabled } from "@oh-my-pi/pi-coding-agent/goals/settings";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { LiveCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/live-command-controller";
import { MCPCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/mcp-command-controller";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { SSHCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/ssh-command-controller";
import { InteractiveMode, shouldEnterPlanModeOnStartup } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import {
	cfgMarketplaceAutoUpdate,
	cfgStartupChangelogMode,
	cfgStartupCheckUpdate,
	cfgStartupSetupWizard,
	cfgStartupShowSplash,
} from "@oh-my-pi/pi-coding-agent/modes/settings";
import { cfgPlanDefaultOnStartup, cfgPlanEnabled } from "@oh-my-pi/pi-coding-agent/plan-mode/settings";
import * as providerSetup from "@oh-my-pi/pi-coding-agent/modes/setup";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { closeSessionIndex } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as sessionWorktree from "@oh-my-pi/pi-coding-agent/session/session-worktree";
import { SessionRecorder } from "@oh-my-pi/pi-coding-agent/stream/recording";
import { StreamRedactor } from "@oh-my-pi/pi-coding-agent/stream/redactor";
import * as stt from "@oh-my-pi/pi-coding-agent/stt";
import { STTController, type STTControllerDependencies } from "@oh-my-pi/pi-coding-agent/stt";
import { cfgSttEnabled } from "@oh-my-pi/pi-coding-agent/stt/settings";
import { cfgWorktreeOnExit, cfgWorktreeOnStart } from "@oh-my-pi/pi-coding-agent/task/settings";
import { TODO_HUD_STATE_CUSTOM_TYPE, USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { vocalizer } from "@oh-my-pi/pi-coding-agent/tts/vocalizer";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import * as themeModule from "@oh-my-pi/pi-tui/theme";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { logger, postmortem, TempDir } from "@oh-my-pi/pi-utils";
import * as utils from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const assistant = {
	role: "assistant",
	content: [{ type: "text", text: "answer" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 1,
} as never;

describe("InteractiveMode session commands and capture surfaces (lines 8801-end)", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession;
	let mode: InteractiveMode;
	let warnings: string[];
	let statuses: string[];
	let errors: string[];

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
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, new EventBus());
	}

	function captureMessages(): void {
		warnings = [];
		statuses = [];
		errors = [];
		spyOn(mode, "showWarning").mockImplementation(message => void warnings.push(message));
		spyOn(mode, "showStatus").mockImplementation(message => void statuses.push(message));
		spyOn(mode, "showError").mockImplementation(message => void errors.push(message));
	}

	beforeAll(async () => {
		await initTheme();
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-im-r8801-session-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	// bun's spyOn cannot wrap accessors yet: stub prototype getters by hand and restore them after each test.
	const stubbedGetters: Array<{ proto: object; prop: string; descriptor: PropertyDescriptor }> = [];
	function stubGetter(proto: object, prop: string, get: () => unknown): void {
		const descriptor = Object.getOwnPropertyDescriptor(proto, prop);
		if (!descriptor) throw new Error(`no accessor ${prop}`);
		stubbedGetters.push({ proto, prop, descriptor });
		Object.defineProperty(proto, prop, { ...descriptor, get });
	}

	afterEach(() => {
		for (const { proto, prop, descriptor } of stubbedGetters.splice(0).reverse()) {
			Object.defineProperty(proto, prop, descriptor);
		}
		vi.restoreAllMocks();
		vi.useRealTimers();
		cfgSttEnabled.set(settings, false);
	});

	afterAll(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	describe("vibe mode blocks session transitions", () => {
		it.each([
			["handleClearCommand", "handleClearCommand", []],
			["handleDeleteCommand", "handleDeleteCommand", []],
			["handleForkCommand", "handleForkCommand", []],
			["handleMoveCommand", "handleMoveCommand", ["/elsewhere"]],
			["handleWorktreeCommand", "handleWorktreeCommand", ["wt/x"]],
		] as const)("%s warns and leaves the session alone", async (method, via, args) => {
			await freshMode();
			captureMessages();
			const target = spyOn(CommandController.prototype, via).mockResolvedValue(undefined as never);
			mode.vibeModeEnabled = true;

			await (mode[method] as (...a: unknown[]) => Promise<void>)(...args);

			expect(warnings).toEqual(["Exit vibe mode first."]);
			expect(target).not.toHaveBeenCalled();
			mode.vibeModeEnabled = false;
		});

		it("/delete outside vibe mode tears down side conversations first, then deletes", async () => {
			await freshMode();
			const order: string[] = [];
			spyOn(mode, "prepareSessionSwitch").mockImplementation(async () => void order.push("prepare"));
			spyOn(CommandController.prototype, "handleDeleteCommand").mockImplementation(
				async () => void order.push("delete"),
			);

			await mode.handleDeleteCommand();

			expect(order).toEqual(["prepare", "delete"]);
		});

		it("/move outside vibe mode moves to the requested path", async () => {
			await freshMode();
			const move = spyOn(CommandController.prototype, "handleMoveCommand").mockResolvedValue();

			await mode.handleMoveCommand("/srv/project");

			expect(move).toHaveBeenCalledWith("/srv/project");
		});

		it("/new keeps the plan-mode default untouched when the clear did not start a new session", async () => {
			await freshMode();
			cfgPlanEnabled.set(session.settings, true);
			cfgPlanDefaultOnStartup.set(session.settings, true);
			// Precondition: a launch into this empty session would enter plan mode, so only the
			// unchanged-session guard keeps /new from doing so here.
			expect(shouldEnterPlanModeOnStartup(mode.sessionManager, session.settings)).toBe(true);
			const clear = spyOn(CommandController.prototype, "handleClearCommand").mockResolvedValue();
			const before = mode.sessionManager.getSessionId();

			await mode.handleNewCommand();

			expect(clear).toHaveBeenCalledTimes(1);
			expect(mode.sessionManager.getSessionId()).toBe(before);
			expect(mode.planModeEnabled).toBe(false);
		});
	});

	describe("worktrees", () => {
		it("records a worktree /wt created so exit offers to clean it up, and ignores a declined one", async () => {
			await freshMode();
			const worktree = { path: "/tmp/wt-a", branch: "wt/a" } as never;
			const created = spyOn(CommandController.prototype, "handleWorktreeCommand")
				.mockResolvedValueOnce(undefined as never)
				.mockResolvedValueOnce(worktree);

			await mode.handleWorktreeCommand("wt/none");
			await mode.handleWorktreeCommand("wt/a", { keepChanges: true });

			expect(created.mock.calls).toEqual([
				["wt/none", undefined],
				["wt/a", { keepChanges: true }],
			]);

			// Exit plans cleanup over exactly the worktrees this launch recorded.
			cfgWorktreeOnExit.set(mode.settings, "remove");
			const plan = spyOn(sessionWorktree, "planWorktreeExit").mockResolvedValue([]);
			spyOn(sessionWorktree, "removeExitWorktrees").mockResolvedValue([]);
			spyOn(session, "abort").mockResolvedValue();
			spyOn(session, "dispose").mockResolvedValue();
			spyOn(mode.ui.terminal, "drainInput").mockResolvedValue();
			const quit = spyOn(postmortem, "quit").mockResolvedValue(undefined as never);

			await mode.shutdown();

			expect(plan).toHaveBeenCalledTimes(1);
			expect(plan.mock.calls[0]?.[0]).toEqual([worktree]);
			expect(plan.mock.calls[0]?.[1]).toBe("remove");
			expect(quit).toHaveBeenCalledWith(0);
		});

		it("does nothing at launch when worktree.onStart is off", async () => {
			await freshMode();
			cfgWorktreeOnStart.set(mode.settings, "off");
			const wt = spyOn(mode, "handleWorktreeCommand");

			await mode.maybeAutoCreateWorktree();

			expect(wt).not.toHaveBeenCalled();
		});

		it("does nothing outside a git checkout", async () => {
			await freshMode();
			cfgWorktreeOnStart.set(mode.settings, "create");
			const wt = spyOn(mode, "handleWorktreeCommand");

			await mode.maybeAutoCreateWorktree();

			expect(wt).not.toHaveBeenCalled();
		});

		describe("inside a git checkout with a commit", () => {
			let repo: string;
			beforeAll(async () => {
				repo = path.join(tempDir.path(), "repo");
				fs.mkdirSync(repo, { recursive: true });
				const git = (...args: string[]) =>
					Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });
				git("init", "-q");
				fs.writeFileSync(path.join(repo, "a.txt"), "a");
				git("add", "a.txt");
				git("commit", "-q", "-m", "init");
			});

			it("asks first under 'ask' and creates nothing when declined", async () => {
				await freshMode();
				spyOn(mode.sessionManager, "getCwd").mockReturnValue(repo);
				cfgWorktreeOnStart.set(mode.settings, "ask");
				const confirm = spyOn(mode, "showHookConfirm").mockResolvedValue(false);
				const wt = spyOn(mode, "handleWorktreeCommand").mockResolvedValue();

				await mode.maybeAutoCreateWorktree();

				expect(confirm).toHaveBeenCalledWith(
					"Create a worktree for this session?",
					"Work happens on a new wt/* branch; this checkout stays untouched.",
				);
				expect(wt).not.toHaveBeenCalled();
			});

			it("creates a clean worktree once 'ask' is accepted, and without asking under 'create'", async () => {
				await freshMode();
				spyOn(mode.sessionManager, "getCwd").mockReturnValue(repo);
				const confirm = spyOn(mode, "showHookConfirm").mockResolvedValue(true);
				const wt = spyOn(mode, "handleWorktreeCommand").mockResolvedValue();

				cfgWorktreeOnStart.set(mode.settings, "ask");
				await mode.maybeAutoCreateWorktree();
				cfgWorktreeOnStart.set(mode.settings, "create");
				await mode.maybeAutoCreateWorktree();

				expect(confirm).toHaveBeenCalledTimes(1);
				expect(wt.mock.calls).toEqual([
					[undefined, { keepChanges: false }],
					[undefined, { keepChanges: false }],
				]);
			});

			it("turns a failure into a warning so startup continues", async () => {
				await freshMode();
				captureMessages();
				spyOn(mode.sessionManager, "getCwd").mockReturnValue(repo);
				cfgWorktreeOnStart.set(mode.settings, "create");
				spyOn(mode, "handleWorktreeCommand")
					.mockRejectedValueOnce(new Error("branch exists"))
					.mockRejectedValueOnce("disk full");

				await mode.maybeAutoCreateWorktree();
				await mode.maybeAutoCreateWorktree();

				expect(warnings).toEqual(["Worktree not created: branch exists", "Worktree not created: disk full"]);
			});
		});
	});

	describe("push-to-talk dictation", () => {
		it("refuses while speech-to-text is disabled", async () => {
			await freshMode();
			captureMessages();
			const toggle = spyOn(STTController.prototype, "toggle");

			await mode.handleSTTToggle();

			expect(warnings).toEqual(["Speech-to-text is disabled. Enable it in settings: stt.enabled"]);
			expect(toggle).not.toHaveBeenCalled();
		});

		it("refuses while live mode owns the microphone", async () => {
			await freshMode();
			captureMessages();
			cfgSttEnabled.set(settings, true);
			stubGetter(LiveCommandController.prototype, "active", () => true);
			const toggle = spyOn(STTController.prototype, "toggle");

			await mode.handleSTTToggle();

			expect(warnings).toEqual(["End live mode before using push-to-talk speech input."]);
			expect(toggle).not.toHaveBeenCalled();
		});

		it("toggles dictation into the editor, ducking speech and swapping the cursor through the capture", async () => {
			await freshMode();
			captureMessages();
			cfgSttEnabled.set(settings, true);
			const duck = spyOn(vocalizer, "duck").mockImplementation(() => {});
			const unduck = spyOn(vocalizer, "unduck").mockImplementation(() => {});
			let callbacks: Parameters<STTController["toggle"]>[1] | undefined;
			const toggle = spyOn(STTController.prototype, "toggle").mockImplementation(async (target, options) => {
				expect(target).toBe(mode.editor);
				callbacks = options;
			});

			await mode.handleSTTToggle();
			expect(toggle).toHaveBeenCalledTimes(1);
			const cb = callbacks!;

			cb.showWarning("mic busy");
			cb.showStatus("listening");
			cb.onStateChange("recording");
			expect(mode.editor.getUseTerminalCursor()).toBe(false);
			cb.onStateChange("recording");
			cb.onStateChange("transcribing");
			cb.onStateChange("idle");

			expect(warnings).toEqual(["mic busy"]);
			expect(statuses).toEqual(["listening"]);
			expect(duck).toHaveBeenCalledTimes(2);
			expect(unduck).toHaveBeenCalledTimes(2);
		});

		it("space-hold dictation follows the stt.enabled setting and starts/stops a capture into its target", async () => {
			await freshMode();
			const start = spyOn(STTController.prototype, "start").mockResolvedValue();
			const stop = spyOn(STTController.prototype, "stop").mockResolvedValue();
			const hold = mode.dictationSpaceHold(mode.editor);

			expect(hold.enabled()).toBe(false);
			cfgSttEnabled.set(settings, true);
			expect(hold.enabled()).toBe(true);

			hold.onStart();
			hold.onEnd();

			expect(start).toHaveBeenCalledTimes(1);
			expect(start.mock.calls[0]![0]).toBe(mode.editor);
			expect(stop).toHaveBeenCalledTimes(1);
		});

		it("the composer mic stops a running capture, ignores clicks while transcribing and starts when idle", async () => {
			await freshMode();
			cfgSttEnabled.set(settings, true);
			let state: "idle" | "recording" | "transcribing" = "idle";
			stubGetter(STTController.prototype, "state", () => state);
			const start = spyOn(STTController.prototype, "start").mockResolvedValue();
			const stop = spyOn(STTController.prototype, "stop").mockResolvedValue();
			// The mic re-renders once when the start begins and once when it settles.
			const settled = Promise.withResolvers<void>();
			let renders = 0;
			spyOn(mode.ui, "requestRender").mockImplementation(() => {
				if (++renders === 2) settled.resolve();
			});

			mode.editor.onToggleDictation?.();
			await settled.promise;
			expect(start).toHaveBeenCalledTimes(1);
			expect(start.mock.calls[0]![1]).toMatchObject({ manualSubmit: true });

			state = "recording";
			mode.editor.onToggleDictation?.();
			expect(stop).toHaveBeenCalledTimes(1);

			state = "transcribing";
			mode.editor.onToggleDictation?.();
			expect(start).toHaveBeenCalledTimes(1);
			expect(stop).toHaveBeenCalledTimes(1);
		});

		it("a second mic click while the capture is still starting cancels the start", async () => {
			await freshMode();
			cfgSttEnabled.set(settings, true);
			const begun = Promise.withResolvers<void>();
			spyOn(STTController.prototype, "start").mockReturnValue(begun.promise);
			const stop = spyOn(STTController.prototype, "stop").mockResolvedValue();

			mode.editor.onToggleDictation?.();
			mode.editor.onToggleDictation?.();
			begun.resolve();

			expect(stop).toHaveBeenCalledTimes(1);
		});

		it("the composer mic does nothing when no controller can be made", async () => {
			await freshMode();
			captureMessages();
			const start = spyOn(STTController.prototype, "start");

			mode.editor.onToggleDictation?.();

			expect(start).not.toHaveBeenCalled();
			expect(warnings).toEqual(["Speech-to-text is disabled. Enable it in settings: stt.enabled"]);
		});

		it("builds one dictation controller per mode, bound to this session's settings, models and live session id", async () => {
			await freshMode();
			cfgSttEnabled.set(settings, true);
			const built: STTControllerDependencies[] = [];
			const fake = {
				toggle: vi.fn(async () => {}),
				start: vi.fn(async () => {}),
				dispose: vi.fn(),
				state: "idle",
			};
			spyOn(stt, "STTController").mockImplementation(function (deps: STTControllerDependencies) {
				built.push(deps);
				return fake;
			} as never);

			await mode.handleSTTToggle();
			mode.dictationSpaceHold(mode.editor).onStart();

			expect(built).toHaveLength(1);
			expect(fake.toggle).toHaveBeenCalledTimes(1);
			expect(fake.start).toHaveBeenCalledTimes(1);
			const deps = built[0];
			if (!deps) throw new Error("expected dependency object");
			expect(deps.settings).toBe(mode.settings);
			expect(deps.registry).toBe(session.modelRegistry);
			expect(deps.getSessionId?.()).toBe(session.sessionId);
		});
	});

	describe("live mode gating", () => {
		it("refuses to start live mode, local or remote, while a dictation capture is active", async () => {
			await freshMode();
			captureMessages();
			cfgSttEnabled.set(settings, true);
			spyOn(STTController.prototype, "toggle").mockResolvedValue();
			await mode.handleSTTToggle();
			stubGetter(STTController.prototype, "state", () => "recording");
			const local = spyOn(LiveCommandController.prototype, "handleCommand").mockResolvedValue();
			const remote = spyOn(LiveCommandController.prototype, "startRemote");
			const blocker = "Finish the current speech-to-text capture before starting live mode.";

			await mode.handleLiveCommand();
			await expect(mode.startRemoteLive({} as never)).rejects.toThrow(blocker);

			expect(warnings).toEqual([blocker]);
			expect(local).not.toHaveBeenCalled();
			expect(remote).not.toHaveBeenCalled();
		});

		it("starts a remote live session once an idle dictation controller is out of the way", async () => {
			await freshMode();
			cfgSttEnabled.set(settings, true);
			spyOn(STTController.prototype, "toggle").mockResolvedValue();
			await mode.handleSTTToggle();
			stubGetter(STTController.prototype, "state", () => "idle");
			const live = { id: "live-1" } as never;
			const options = { label: "peer" } as never;
			const remote = spyOn(LiveCommandController.prototype, "startRemote").mockResolvedValue(live);

			expect(await mode.startRemoteLive(options)).toBe(live);
			expect(remote).toHaveBeenCalledWith(options);
		});
	});

	describe("/record", () => {
		function fakeRecorder(elapsedMs = 65_000) {
			return {
				path: "/tmp/rec/session.omprec",
				elapsedMs,
				stop: vi.fn(async () => {}),
			} as unknown as SessionRecorder;
		}

		it("starts a recording titled by the session, then stops it and reports where it was saved", async () => {
			await freshMode();
			captureMessages();
			await mode.sessionManager.setSessionName("Demo run", "user");
			spyOn(StreamRedactor, "load").mockResolvedValue({} as never);
			const recorder = fakeRecorder();
			const start = spyOn(SessionRecorder, "start").mockResolvedValue(recorder);
			const setRecording = spyOn(mode.statusLine, "setRecording");

			await mode.toggleRecording();
			expect(start.mock.calls[0]![0]).toMatchObject({ title: "Demo run", tui: mode.ui });
			expect(statuses).toEqual(["Recording to /tmp/rec/session.omprec · /record again to stop"]);

			await mode.toggleRecording();

			expect(recorder.stop).toHaveBeenCalledTimes(1);
			expect(setRecording.mock.calls).toEqual([[true], [false]]);
			expect(statuses[1]).toStartWith("Saved ");
			expect(statuses[1]).toContain("recording to /tmp/rec/session.omprec · replay: omp play · share: omp clip");
		});

		it("titles an unnamed session by its directory and ignores a second /record while starting", async () => {
			await freshMode();
			spyOn(mode.sessionManager, "getSessionName").mockReturnValue(undefined);
			spyOn(StreamRedactor, "load").mockResolvedValue({} as never);
			const { promise, resolve } = Promise.withResolvers<SessionRecorder>();
			const start = spyOn(SessionRecorder, "start").mockReturnValue(promise);

			// The start flag is raised synchronously, so a second /record arriving during the start is a no-op.
			const first = mode.toggleRecording();
			await mode.toggleRecording();
			resolve(fakeRecorder());
			await first;

			expect(start).toHaveBeenCalledTimes(1);
			expect(start.mock.calls[0]![0]).toMatchObject({ title: path.basename(mode.sessionManager.getCwd()) });
			await mode.toggleRecording();
		});

		it("reports a recording that cannot start", async () => {
			await freshMode();
			captureMessages();
			spyOn(StreamRedactor, "load").mockResolvedValue({} as never);
			spyOn(SessionRecorder, "start").mockRejectedValueOnce(new Error("no tty")).mockRejectedValueOnce("denied");

			await mode.toggleRecording();
			await mode.toggleRecording();

			expect(errors).toEqual(["Could not start recording: no tty", "Could not start recording: denied"]);
		});
	});

	describe("/btw branch", () => {
		it.each([
			[{ cancelled: true }, { status: "/btw branch cancelled" }],
			[{ cancelled: false, sessionFile: "/s/2026-branch.jsonl" }, { status: "Branched /btw to 2026-branch.jsonl" }],
			[{ cancelled: false }, { status: "Branched /btw" }],
		])("branchFromBtw %o reports %o", async (result, expected) => {
			await freshMode();
			captureMessages();
			const branch = spyOn(session, "branchFromBtw").mockResolvedValue(result as never);
			const render = spyOn(mode, "renderInitialMessages").mockResolvedValue();

			await mode.handleBtwBranch("why?", assistant, "leaf-1", "sess-1");

			expect(branch).toHaveBeenCalledWith("why?", assistant, "leaf-1", "sess-1", undefined);
			expect(statuses).toEqual([expected.status]);
			expect(render).toHaveBeenCalledTimes(result.cancelled ? 0 : 1);
		});

		it("surfaces a branch failure", async () => {
			await freshMode();
			captureMessages();
			spyOn(session, "branchFromBtw").mockRejectedValueOnce(new Error("no leaf")).mockRejectedValueOnce("gone");

			await mode.handleBtwBranch("q", assistant, "l", "s");
			await mode.handleBtwBranch("q", assistant, "l", "s");

			expect(errors).toEqual(["Cannot branch /btw: no leaf", "Cannot branch /btw: gone"]);
		});
	});

	describe("guided goal interview flag", () => {
		it("is active during the interview and yields once a goal is running or paused", async () => {
			await freshMode();
			cfgGoalEnabled.set(session.settings, true);
			spyOn(session, "prompt").mockResolvedValue(undefined as never);
			spyOn(session, "setActiveToolsByName").mockResolvedValue(undefined as never);
			expect(mode.isGuidedGoalInterviewActive()).toBe(false);

			expect(await mode.handleGuidedGoalCommand("ship it")).toBe(true);
			expect(mode.isGuidedGoalInterviewActive()).toBe(true);

			mode.goalModeEnabled = true;
			expect(mode.isGuidedGoalInterviewActive()).toBe(false);
			mode.goalModeEnabled = false;
			mode.goalModePaused = true;
			expect(mode.isGuidedGoalInterviewActive()).toBe(false);
			mode.goalModePaused = false;
		});
	});

	describe("display", () => {
		it("Ctrl+L replays the display at once and keeps only an appearance probe the terminal accepted", async () => {
			// The probe is observed through init's appearance listener: a kept request turns the next
			// appearance change into a committed theme replay ({}), a cleared one does not (undefined).
			const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
			const local = Settings.isolated();
			spyOn(utils, "getConfigRootDir").mockReturnValue(tempDir.path());
			cfgStartupCheckUpdate.override(local, false);
			cfgStartupChangelogMode.override(local, "hidden");
			cfgStartupSetupWizard.override(local, false);
			cfgStartupShowSplash.override(local, false);
			cfgMarketplaceAutoUpdate.override(local, "off");
			const initSession = new AgentSession({
				agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
				sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
				settings: local,
				modelRegistry,
			});
			const inited = new InteractiveMode(
				initSession,
				"test",
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				new Composer({ terminal: new VirtualTerminal(200, 60) }),
			);
			try {
				spyOn(inited.statusLine, "watchBranch").mockImplementation(() => {});
				let onAppearance: ((appearance: string, token?: unknown) => void) | undefined;
				spyOn(inited.ui.terminal, "onAppearanceChange").mockImplementation(callback => {
					onAppearance = callback as typeof onAppearance;
				});
				await inited.init({ suppressWelcomeIntro: true });
				if (!onAppearance) throw new Error("init did not subscribe to appearance changes");
				const committed = spyOn(themeModule, "onTerminalAppearanceChange").mockImplementation(() => {});
				const reset = spyOn(inited.ui, "resetDisplay").mockImplementation(() => {});
				const probe = vi.fn((token?: unknown): unknown => token);
				Object.defineProperty(inited.ui.terminal, "refreshAppearance", { value: probe, configurable: true });

				// Accepted: the request is kept, so its reply commits a replay.
				inited.resetDisplayAfterAppearanceRefresh();
				onAppearance("dark", probe.mock.calls[0]?.[0]);
				// Rejected: the request is dropped, so even its own token commits nothing.
				probe.mockImplementation(() => undefined);
				inited.resetDisplayAfterAppearanceRefresh();
				onAppearance("dark", probe.mock.calls[1]?.[0]);
				// Unsupported probe: a request left pending from an accepted probe is dropped too.
				probe.mockImplementation((token?: unknown) => token);
				inited.resetDisplayAfterAppearanceRefresh();
				Object.defineProperty(inited.ui.terminal, "refreshAppearance", { value: undefined, configurable: true });
				inited.resetDisplayAfterAppearanceRefresh();
				onAppearance("light", undefined);

				expect(committed.mock.calls).toEqual([
					["dark", {}],
					["dark", undefined],
					["light", undefined],
				]);
				expect(reset).toHaveBeenCalledTimes(4);
			} finally {
				inited.stop();
				await initSession.dispose();
				AgentStorage.close();
				HistoryStorage.close();
				closeSessionIndex();
			}
		});

		it("sizes the command report to the rows above the chrome below it", async () => {
			await freshMode();
			Object.defineProperty(mode.ui.terminal, "rows", { get: () => 40, configurable: true });
			const below = spyOn(mode.composer, "rowsBelow").mockReturnValueOnce(undefined).mockReturnValueOnce(6);

			expect(mode.commandReportRows()).toBeUndefined();
			expect(mode.commandReportRows()).toBe(34);
			expect(below).toHaveBeenCalledWith(mode.reportContainer);
		});

		it("resetObserverRegistry clears the registry and re-binds the main session file, or none in memory", async () => {
			await freshMode();
			const hub = spyOn(SelectorController.prototype, "showAgentHub").mockImplementation(() => {});
			mode.showAgentHub();
			const registry = hub.mock.calls[0]?.[0] as unknown as {
				resetSessions(): void;
				setMainSession(file: string | undefined): void;
			};
			const reset = spyOn(registry, "resetSessions");
			const setMain = spyOn(registry, "setMainSession");
			const file = spyOn(mode.sessionManager, "getSessionFile").mockReturnValueOnce(undefined);
			file.mockReturnValueOnce("/s/main.jsonl");

			mode.resetObserverRegistry();
			mode.resetObserverRegistry();

			expect(reset).toHaveBeenCalledTimes(2);
			expect(setMain.mock.calls).toEqual([[undefined], ["/s/main.jsonl"]]);
		});
	});

	describe("command controllers created per call", () => {
		it("/mcp and /ssh each run a fresh controller on the full command text", async () => {
			await freshMode();
			const mcp = spyOn(MCPCommandController.prototype, "handle").mockResolvedValue();
			const ssh = spyOn(SSHCommandController.prototype, "handle").mockResolvedValue();

			await mode.handleMCPCommand("/mcp list");
			await mode.handleSSHCommand("/ssh add box");

			expect(mcp).toHaveBeenCalledWith("/mcp list");
			expect(ssh).toHaveBeenCalledWith("/ssh add box");
		});

		it("/setup runs the provider wizard against this mode", async () => {
			await freshMode();
			const wizard = spyOn(providerSetup, "runProviderSetupWizard").mockResolvedValue();

			await mode.showProviderSetup();

			expect(wizard).toHaveBeenCalledWith(mode);
		});
	});

	describe("TODO HUD reveal", () => {
		const phases = [{ name: "Todos", tasks: [{ content: "ship", status: "completed" }] }] as never;

		it("logs instead of throwing when persisting the reveal of a durable snapshot fails", async () => {
			await freshMode();
			mode.sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
			mode.setTodos(phases);
			const append = spyOn(mode.sessionManager, "appendCustomEntry").mockImplementation(() => {
				throw new Error("disk full");
			});
			const warn = spyOn(logger, "warn").mockImplementation(() => {});

			mode.setTodoExpanded(true);

			expect(append.mock.calls[0]![0]).toBe(TODO_HUD_STATE_CUSTOM_TYPE);
			expect(warn).toHaveBeenCalledWith("Failed to persist TODO HUD reveal", expect.anything());
			expect(mode.todoExpanded).toBe(true);
		});

		it("persists the reveal once the snapshot lands while in-flight messages settle", async () => {
			await freshMode();
			mode.setTodos(phases);
			spyOn(session, "settleInFlightMessagePersistence").mockImplementation(async () => {
				mode.sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: mode.todoPhases });
			});
			const revealed = Promise.withResolvers<unknown>();
			const manager = mode.sessionManager;
			const appendReal = manager.appendCustomEntry.bind(manager);
			spyOn(manager, "appendCustomEntry").mockImplementation((type, data) => {
				if (type === TODO_HUD_STATE_CUSTOM_TYPE) revealed.resolve(data);
				return appendReal(type, data);
			});

			mode.setTodoExpanded(true);

			expect(await revealed.promise).toMatchObject({ visibility: "revealed" });
		});

		it("logs when settling in-flight persistence fails before a deferred reveal", async () => {
			await freshMode();
			spyOn(session, "settleInFlightMessagePersistence").mockRejectedValue(new Error("io"));
			const warned = Promise.withResolvers<void>();
			const warn = spyOn(logger, "warn").mockImplementation(() => warned.resolve());

			mode.setTodoExpanded(true);
			await warned.promise;

			expect(warn).toHaveBeenCalledWith("Failed to persist TODO HUD reveal", expect.anything());
		});
	});
});
