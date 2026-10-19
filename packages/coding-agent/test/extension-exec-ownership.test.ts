import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { reopenExecOwner, shutdownExecCommands, type ExecResult } from "@oh-my-pi/pi-coding-agent/exec/exec";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { emitSessionShutdownEvent, ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	ExtensionActions,
	ExtensionContextActions,
	ExtensionFactory,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { deleteFileWithFallback, writeFileWithFallback } from "@oh-my-pi/pi-coding-agent/tools/file-write-fallback";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

// `pi.exec` inside extension handlers carries no session id of its own: the
// dispatch site must name the owning session via `runWithExecOwner`, otherwise
// the child is registered unowned and no session's dispose can kill it (only
// the postmortem process-exit teardown). These tests prove every
// emit-dispatched event handler (including `session_shutdown`), every shortcut
// handler started through the real `InputController` path, every extension
// slash-command handler, and both file fallback trampolines attribute their
// `pi.exec` children to the owning session: that session's dispose (or the
// `shutdownExecCommands` it calls) kills and awaits them, while other
// sessions' children survive.
describe("extension exec ownership", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	// Runners whose fallback trampolines live in the process-wide seam until
	// disposed: every fallback test unregisters its own, and afterAll sweeps
	// stragglers so no handler outlives this file into another test file.
	const fallbackRunners: ExtensionRunner[] = [];

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-extension-exec-ownership-");
		authStorage = createInMemoryAuthStorage();
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(async () => {
		// Belt and suspenders: no TERM-ignoring child may outlive this file.
		await shutdownExecCommands();
		for (const runner of fallbackRunners.splice(0)) runner.disposeFileFallbacks();
		tempDir.removeSync();
	});

	// Drives `ExtensionRunner.initialize` with no-op stubs, mirroring what a mode
	// controller does after `createAgentSession` returns. Without this,
	// `registerFileWriteFallback` handlers never install: the runner binds them
	// to a live ctx inside `initialize`, not at extension-load time.
	function initializeRunnerForTest(runner: ExtensionRunner): void {
		const actions: ExtensionActions = {
			sendMessage: () => {},
			sendUserMessage: () => {},
			appendEntry: () => {},
			setLabel: () => {},
			getActiveTools: () => [],
			getAllTools: () => [],
			setActiveTools: async () => {},
			getCommands: () => [],
			setModel: async () => false,
			getThinkingLevel: () => undefined,
			setThinkingLevel: () => {},
			getSessionName: () => undefined,
			setSessionName: async () => {},
		};
		const contextActions: ExtensionContextActions = {
			getModel: () => undefined,
			isIdle: () => true,
			abort: () => {},
			hasPendingMessages: () => false,
			shutdown: () => {},
			getContextUsage: () => undefined,
			compact: async () => {},
			getSystemPrompt: () => [],
		};
		runner.initialize(actions, contextActions);
	}

	const live = (marker: string): number[] =>
		Bun.spawnSync(["pgrep", "-f", `[${marker[0]}]${marker.slice(1)}`])
			.stdout.toString()
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(Number)
			.filter(pid => Number.isInteger(pid) && pid > 0);

	async function waitLive(marker: string, timeoutMs = 10_000): Promise<void> {
		// NOTE: real-clock polling awaits a kernel condition (process liveness via
		// `pgrep`) with no event handle; signals only run on the real clock, so
		// fake timers cannot work here. Bounded; exits as soon as the condition holds.
		// Same justification as the `Bun.sleep` polls in `exec-command.test.ts`.
		const start = Date.now();
		while (live(marker).length === 0 && Date.now() - start < timeoutMs) await Bun.sleep(20);
	}

	function killSweep(...markers: string[]): void {
		for (const marker of markers) {
			for (const pid of live(marker)) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
			}
		}
	}

	function trapLoop(marker: string): [string, string[]] {
		return ["/bin/sh", ["-c", `sh -c 'trap "" TERM; while :; do sleep 0.2; done' ${marker} & wait`]];
	}

	async function makeRunner(name: string, factory: ExtensionFactory): Promise<ExtensionRunner> {
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(factory, tempDir.path(), new EventBus(), runtime, name);
		const sessionManager = SessionManager.inMemory(tempDir.path());
		return new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);
	}

	it("emit-dispatched handlers (incl. session_shutdown) own pi.exec per emitting session", async () => {
		if (process.platform === "win32") return;
		const tag = `${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
		const markerA = `EXTEXEC_EVA_${tag}`;
		const markerB = `EXTEXEC_EVB_${tag}`;
		const markerSd = `EXTEXEC_EVSD_${tag}`;
		let pendingA: Promise<ExecResult> | undefined;
		let pendingB: Promise<ExecResult> | undefined;
		let pendingSd: Promise<ExecResult> | undefined;
		const settled = { a: false, b: false, sd: false };
		const track = (key: keyof typeof settled, promise: Promise<ExecResult>): Promise<ExecResult> => {
			// Pre-attach: a kill settles while the test is still polling
			// pgrep, and must never surface as unhandledRejection.
			void promise.then(
				() => {
					settled[key] = true;
				},
				() => {
					settled[key] = true;
				},
			);
			return promise;
		};

		const runnerA = await makeRunner("ext-exec-a", pi => {
			pi.on("session_start", () => {
				const [command, args] = trapLoop(markerA);
				pendingA = track("a", pi.exec(command, args));
			});
			pi.on("session_shutdown", () => {
				const [command, args] = trapLoop(markerSd);
				pendingSd = track("sd", pi.exec(command, args));
			});
		});
		const runnerB = await makeRunner("ext-exec-b", pi => {
			pi.on("session_start", () => {
				const [command, args] = trapLoop(markerB);
				pendingB = track("b", pi.exec(command, args));
			});
		});
		const sidA = runnerA.sessionId;
		const sidB = runnerB.sessionId;
		expect(sidA).not.toBe(sidB);

		try {
			await runnerA.emit({ type: "session_start" });
			await runnerB.emit({ type: "session_start" });
			expect(pendingA).toBeDefined();
			expect(pendingB).toBeDefined();
			await waitLive(markerA);
			await waitLive(markerB);
			expect(live(markerA).length).toBeGreaterThan(0);
			expect(live(markerB).length).toBeGreaterThan(0);

			// session_shutdown runs through the same funnel, so the child its
			// handler starts is owned too. Dispose order: the emit, then the
			// owner's kill.
			expect(await emitSessionShutdownEvent(runnerA)).toBe(true);
			expect(pendingSd).toBeDefined();
			await waitLive(markerSd);

			// Disposing session A kills only A's handler children. The sleep is
			// a settle check, not a wait: a kill settles the call near-instantly
			// (real-clock escalation, no event handle to await), and fail-before
			// (unowned child) fails here instead of hanging on the awaits below.
			await shutdownExecCommands(sidA);
			await Bun.sleep(500);
			expect(settled.a).toBe(true);
			expect(settled.sd).toBe(true);
			expect((await pendingA!).killed).toBe(true);
			expect((await pendingSd!).killed).toBe(true);
			expect(live(markerA)).toEqual([]);
			expect(live(markerSd)).toEqual([]);
			// B is untouched: still alive and its call unsettled. A short
			// settle check, not a leak window: a wrongful kill would settle
			// it near-instantly, while the loop spins without the shutdown.
			expect(live(markerB).length).toBeGreaterThan(0);
			expect(settled.b).toBe(false);

			// The owner-less (postmortem) shutdown kills everything left.
			await shutdownExecCommands();
			expect((await pendingB!).killed).toBe(true);
			expect(live(markerB)).toEqual([]);
		} finally {
			await shutdownExecCommands();
			killSweep(markerA, markerB, markerSd);
		}
	}, 120_000);

	it("a disposed session's late handlers cannot spawn past its kill until the id is live again", async () => {
		if (process.platform === "win32") return;
		const tag = `${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
		const markerLate = `EXTEXEC_LATE_${tag}`;
		const markerEnd = `EXTEXEC_END_${tag}`;
		const gate = Promise.withResolvers<void>();
		let pendingLate: Promise<ExecResult> | undefined;
		const pendingEnd: Promise<ExecResult>[] = [];

		const runner = await makeRunner("ext-exec-late", pi => {
			pi.on("session_shutdown", async () => {
				// The git-status-then-exec shape: an awaited step that outlasts
				// the 2s handler cap, then a second exec after dispose's kill.
				await gate.promise;
				const [command, args] = trapLoop(markerLate);
				pendingLate = pi.exec(command, args);
				pendingLate.catch(() => {});
			});
			pi.on("agent_end", () => {
				const [command, args] = trapLoop(markerEnd);
				const pending = pi.exec(command, args);
				pending.catch(() => {});
				pendingEnd.push(pending);
			});
		});
		const sid = runner.sessionId;
		// One macrotask turn, not a clock wait: a refused call has settled by
		// then, while fail-before's spawned TERM-ignoring loop has not, so the
		// checks fail instead of hanging on the awaits after them.
		const nextTurn = async (): Promise<void> => {
			const turn = Promise.withResolvers<void>();
			setImmediate(turn.resolve);
			await turn.promise;
		};

		try {
			// Same ordering as a handler past its cap, without waiting the cap
			// out: the handler is still parked when dispose's one kill snapshot
			// for this owner runs, and only resumes afterwards.
			const emitted = emitSessionShutdownEvent(runner);
			await shutdownExecCommands(sid);
			gate.resolve();
			await emitted;
			expect(pendingLate).toBeDefined();
			await nextTurn();
			expect(Bun.peek.status(pendingLate!)).toBe("fulfilled");
			expect((await pendingLate!).killed).toBe(true);
			expect(live(markerLate)).toEqual([]);

			// A fresh handler entry the disposing session still fires (the
			// aborted turn's `agent_end`) does not reopen the owner either.
			await runner.emit({ type: "agent_end", messages: [] });
			expect(pendingEnd).toHaveLength(1);
			await nextTurn();
			expect(Bun.peek.status(pendingEnd[0])).toBe("fulfilled");
			expect((await pendingEnd[0]).killed).toBe(true);
			expect(live(markerEnd)).toEqual([]);

			// A live session taking the id again (revival, switch) spawns.
			reopenExecOwner(sid);
			await runner.emit({ type: "agent_end", messages: [] });
			expect(pendingEnd).toHaveLength(2);
			await waitLive(markerEnd);
			expect(live(markerEnd).length).toBeGreaterThan(0);
		} finally {
			gate.resolve();
			await shutdownExecCommands();
			killSweep(markerLate, markerEnd);
		}
	}, 120_000);

	it("shortcut handlers own pi.exec via the real input-controller path", async () => {
		if (process.platform === "win32") return;
		const tag = `${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
		const markerS = `EXTEXEC_SC_${tag}`;
		let pendingS: Promise<ExecResult> | undefined;
		let settledS = false;

		const runner = await makeRunner("ext-exec-shortcut", pi => {
			pi.registerShortcut("alt+j", {
				description: "ownership probe",
				handler: () => {
					const [command, args] = trapLoop(markerS);
					pendingS = pi.exec(command, args);
					void pendingS.then(
						() => {
							settledS = true;
						},
						() => {
							settledS = true;
						},
					);
				},
			});
		});
		const sid = runner.sessionId;

		const keyHandlers = new Map<string, () => void>();
		const controller = new InputController({
			session: { extensionRunner: runner },
			editor: {
				setCustomKeyHandler: (keyId: string, handler: () => void) => {
					keyHandlers.set(keyId, handler);
				},
			},
		} as unknown as InteractiveModeContext);
		try {
			controller.registerExtensionShortcuts();
			const shortcut = keyHandlers.get("alt+j");
			expect(shortcut).toBeDefined();
			shortcut!();
			expect(pendingS).toBeDefined();
			await waitLive(markerS);
			expect(live(markerS).length).toBeGreaterThan(0);

			await shutdownExecCommands(sid);
			// Settle check as above: fail-before (unowned child) fails here
			// instead of hanging on the `await` below.
			await Bun.sleep(500);
			expect(settledS).toBe(true);
			expect((await pendingS!).killed).toBe(true);
			expect(live(markerS)).toEqual([]);
		} finally {
			await shutdownExecCommands();
			killSweep(markerS);
		}
	}, 120_000);
	it("extension slash-command handlers own pi.exec (real session dispose kills it)", async () => {
		if (process.platform === "win32") return;
		const tag = `${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
		const markerCmd = `EXTEXEC_CMD_${tag}`;
		let pendingCmd: Promise<ExecResult> | undefined;
		let settledCmd = false;

		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.registerCommand("owncmd", {
					description: "ownership probe",
					handler: async () => {
						const [command, args] = trapLoop(markerCmd);
						pendingCmd = pi.exec(command, args);
						void pendingCmd.then(
							() => {
								settledCmd = true;
							},
							() => {
								settledCmd = true;
							},
						);
					},
				});
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"ext-exec-command",
		);
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const extensionRunner = new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic model to exist");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: createMockModel({ responses: [] }).stream,
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			extensionRunner,
		});
		try {
			// Public routing into #tryExecuteExtensionCommand: no private access.
			await session.prompt("/owncmd");
			expect(pendingCmd).toBeDefined();
			await waitLive(markerCmd);
			expect(live(markerCmd).length).toBeGreaterThan(0);
			// Real session dispose — not the bare shutdown helper — kills and
			// awaits the command's child. Settle check first so fail-before
			// (unowned child) fails here instead of hanging below.
			await session.dispose();
			await Bun.sleep(500);
			expect(settledCmd).toBe(true);
			expect((await pendingCmd!).killed).toBe(true);
			expect(live(markerCmd)).toEqual([]);
		} finally {
			await session.dispose().catch(() => {});
			await shutdownExecCommands();
			killSweep(markerCmd);
		}
	}, 120_000);

	it("file write fallback handlers own pi.exec", async () => {
		if (process.platform === "win32") return;
		// The fallback only runs on a real kernel EACCES, which never fires for root.
		if (process.getuid?.() === 0) return;
		const tag = `${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
		const markerW = `EXTEXEC_FBW_${tag}`;
		let pendingW: Promise<ExecResult> | undefined;
		let settledW = false;

		const runner = await makeRunner("ext-exec-write-fallback", pi => {
			pi.registerFileWriteFallback(async () => {
				const [command, args] = trapLoop(markerW);
				pendingW = pi.exec(command, args);
				void pendingW.then(
					() => {
						settledW = true;
					},
					() => {
						settledW = true;
					},
				);
				return true;
			});
		});
		fallbackRunners.push(runner);
		initializeRunnerForTest(runner);
		const sid = runner.sessionId;
		const lockedDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ext-exec-fb-"));
		try {
			// No write bit: creating a file here raises a real EACCES, which
			// diverts into the registered fallback.
			await fs.promises.chmod(lockedDir, 0o500);
			await writeFileWithFallback(path.join(lockedDir, "owned.txt"), "bytes");
			expect(pendingW).toBeDefined();
			await waitLive(markerW);
			expect(live(markerW).length).toBeGreaterThan(0);
			await shutdownExecCommands(sid);
			// Settle check so fail-before (unowned child) fails here instead
			// of hanging on the `await` below.
			await Bun.sleep(500);
			expect(settledW).toBe(true);
			expect((await pendingW!).killed).toBe(true);
			expect(live(markerW)).toEqual([]);
		} finally {
			runner.disposeFileFallbacks();
			await shutdownExecCommands();
			killSweep(markerW);
			await fs.promises.chmod(lockedDir, 0o700).catch(() => {});
			await fs.promises.rm(lockedDir, { recursive: true, force: true });
		}
	}, 120_000);

	it("file delete fallback handlers own pi.exec", async () => {
		if (process.platform === "win32") return;
		// Same EACCES precondition as the write path above.
		if (process.getuid?.() === 0) return;
		const tag = `${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
		const markerD = `EXTEXEC_FBD_${tag}`;
		let pendingD: Promise<ExecResult> | undefined;
		let settledD = false;

		const runner = await makeRunner("ext-exec-delete-fallback", pi => {
			pi.registerFileDeleteFallback(async () => {
				const [command, args] = trapLoop(markerD);
				pendingD = pi.exec(command, args);
				void pendingD.then(
					() => {
						settledD = true;
					},
					() => {
						settledD = true;
					},
				);
				return true;
			});
		});
		fallbackRunners.push(runner);
		initializeRunnerForTest(runner);
		const sid = runner.sessionId;
		const lockedDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ext-exec-fb-"));
		const victim = path.join(lockedDir, "victim.txt");
		try {
			await fs.promises.writeFile(victim, "bytes");
			// No write bit: unlinking raises a real EACCES, which diverts into
			// the registered delete fallback.
			await fs.promises.chmod(lockedDir, 0o500);
			await deleteFileWithFallback(victim);
			expect(pendingD).toBeDefined();
			await waitLive(markerD);
			expect(live(markerD).length).toBeGreaterThan(0);
			await shutdownExecCommands(sid);
			// Settle check so fail-before (unowned child) fails here instead
			// of hanging on the `await` below.
			await Bun.sleep(500);
			expect(settledD).toBe(true);
			expect((await pendingD!).killed).toBe(true);
			expect(live(markerD)).toEqual([]);
		} finally {
			runner.disposeFileFallbacks();
			await shutdownExecCommands();
			killSweep(markerD);
			await fs.promises.chmod(lockedDir, 0o700).catch(() => {});
			await fs.promises.rm(lockedDir, { recursive: true, force: true });
		}
	}, 120_000);
});
