/**
 * Issue #2600: Ctrl+C shutdown waits 30s on extension session_shutdown timeout.
 *
 * `ExtensionRunner.emit({ type: "session_shutdown" })` uses the generic
 * 30s extension handler timeout, so a single hung handler (in the wild:
 * `omp-discord-presence` waiting on a Discord IPC pipe that never replied)
 * holds Ctrl+C teardown hostage for the full window. `session_shutdown` is
 * fire-and-forget by contract — extensions can't observe the result — so it
 * MUST run on a tight, dedicated budget so dispose() returns quickly.
 *
 * Pins:
 *   1. Hung `session_shutdown` handlers settle within the short cap, not the
 *      generic timeout.
 *   2. The cap is independent of the generic handler timeout (raising one
 *      does not raise the other).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import {
	ExtensionRuntime,
	loadExtensionFromFactory,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import {
	EXTENSION_HANDLER_TIMEOUT_MS,
	ExtensionRunner,
	SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS,
	testSetExtensionHandlerTimeoutMs,
	testSetSessionShutdownHandlerTimeoutMs,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("issue #2600 - session_shutdown handler timeout", () => {
	let sharedTempDir: TempDir;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage;

	beforeAll(async () => {
		sharedTempDir = TempDir.createSync("@pi-issue-2600-shared-");
		authStorage = await AuthStorage.create(path.join(sharedTempDir.path(), "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		sharedTempDir.removeSync();
	});

	afterEach(() => {
		testSetExtensionHandlerTimeoutMs(EXTENSION_HANDLER_TIMEOUT_MS);
		testSetSessionShutdownHandlerTimeoutMs(SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS);
	});

	async function buildRunnerWithHangingShutdown(count = 1): Promise<{
		runner: ExtensionRunner;
		started: Set<number>;
		cleanup: () => void;
	}> {
		if (count < 1) throw new Error("count must be positive");
		const tempDir = TempDir.createSync("@pi-issue-2600-test-");
		const runtime = new ExtensionRuntime();
		const started = new Set<number>();
		const extensions = await Promise.all(
			Array.from({ length: count }, (_, index) =>
				loadExtensionFromFactory(
					pi => {
						pi.on("session_shutdown", async () => {
							started.add(index);
							await Promise.withResolvers<void>().promise;
						});
					},
					tempDir.path(),
					new EventBus(),
					runtime,
					`hang-session-shutdown-${index}`,
				),
			),
		);
		const sessionManager = SessionManager.inMemory();
		const runner = new ExtensionRunner(
			extensions,
			runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);
		return {
			runner,
			started,
			cleanup: () => tempDir.removeSync(),
		};
	}

	it("runs multiple session_shutdown handlers within one cap", async () => {
		const { runner, started, cleanup } = await buildRunnerWithHangingShutdown(4);
		try {
			testSetSessionShutdownHandlerTimeoutMs(100);

			const startedAt = performance.now();
			await runner.emit({ type: "session_shutdown" });
			const elapsedMs = performance.now() - startedAt;

			// Multiple hung shutdown handlers must share the cap. Sequential
			// dispatch would consume roughly count × cap and keep `/exit` slow.
			expect(started).toEqual(new Set([0, 1, 2, 3]));
			expect(elapsedMs).toBeGreaterThanOrEqual(75);
			expect(elapsedMs).toBeLessThan(350);
		} finally {
			cleanup();
		}
	});

	it("session_shutdown cap is independent from the generic handler cap", async () => {
		const { runner, started, cleanup } = await buildRunnerWithHangingShutdown();
		try {
			// Raise the *generic* timeout to a value the test would never
			// tolerate (10s) while leaving the shutdown cap at 50ms. If the
			// dispatcher pulls from the wrong knob the test wall-clock balloons.
			testSetExtensionHandlerTimeoutMs(10_000);
			testSetSessionShutdownHandlerTimeoutMs(50);

			const startedAt = performance.now();
			await runner.emit({ type: "session_shutdown" });
			const elapsedMs = performance.now() - startedAt;

			expect(started).toEqual(new Set([0]));
			expect(elapsedMs).toBeGreaterThanOrEqual(25);
			expect(elapsedMs).toBeLessThan(500);
		} finally {
			cleanup();
		}
	});
});
