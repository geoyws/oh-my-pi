/**
 * A real `InteractiveMode` over a real `AgentSession` (fake `read` tool, in-memory
 * settings, temp session dir), for tests that drive the mode's own surface rather
 * than a controller through `createInteractiveModeContext`.
 *
 * Call once per `describe`: it installs the lifecycle hooks (theme, settings reset,
 * temp dir, auth key; stop/dispose/cleanup after each test, restoring timers, mocks
 * and the process project dir) and returns the factory plus the current temp dir.
 * Startup output is quiet by default; a test flips `cfgStartupQuiet` to observe it.
 *
 * ```ts
 * const harness = useConstructedInteractiveMode("@pi-c3-range-");
 * it("…", async () => {
 * 	const m = harness.createMode();
 * 	await m.init({ suppressWelcomeIntro: true });
 * });
 * ```
 */
import { afterEach, beforeAll, beforeEach, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { type Api, Effort, type Model } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { cfgStartupQuiet } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { getProjectDir, setProjectDir, TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import type { ExtensionRunner } from "../../src/extensibility/extensions/runner";
import { InteractiveMode } from "../../src/modes/interactive-mode";
import type { StartupChangelogSelection } from "../../src/utils/changelog";

export interface ConstructedModeOptions {
	lspServers?: Array<{ name: string; status: "ready"; fileTypes: string[] }>;
	mcpManager?: MCPManager;
	startupChangelog?: StartupChangelogSelection;
	messages?: AgentMessage[];
	/** Runs on the session before InteractiveMode is constructed around it. */
	beforeMode?: (session: AgentSession) => void;
	/** Builds the session's extension runner over its manager and registry. */
	extensionRunner?: (manager: SessionManager, registry: ModelRegistry) => ExtensionRunner;
	/** Supplies the session's vibe tool set (vibe mode refuses to enter without one). */
	createVibeTools?: () => AgentTool[];
}

export interface ConstructedModeHarness {
	createMode(eventBus?: EventBus, extra?: ConstructedModeOptions): InteractiveMode;
	/** The current test's temp dir (session dir, settings cwd). */
	tempDir(): TempDir;
	/** The current test's auth storage. */
	authStorage(): AuthStorage;
	/** The process project dir before this test; afterEach restores it. */
	projectDir(): string;
}

export function useConstructedInteractiveMode(tempPrefix: string): ConstructedModeHarness {
	let tempDir: TempDir | undefined;
	let authStorage: AuthStorage | undefined;
	let mode: InteractiveMode | undefined;
	let session: AgentSession | undefined;
	// cwd-change tests move the process project dir into temp dirs they then remove
	let projectDir = "";

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		projectDir = getProjectDir();
		resetSettingsForTest();
		tempDir = TempDir.createSync(tempPrefix);
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		cfgStartupQuiet.set(Settings.instance, true);
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
	});

	afterEach(async () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		mode = undefined;
		session = undefined;
		resetSettingsForTest();
		setProjectDir(projectDir);
	});

	function createMode(eventBus?: EventBus, extra?: ConstructedModeOptions): InteractiveMode {
		const dir = tempDir!.path();
		const registry = new ModelRegistry(authStorage!, path.join(dir, `models-${Bun.nanoseconds()}.yml`));
		const model = registry.find("anthropic", "claude-sonnet-4-5") as Model<Api>;
		const readTool: AgentTool = {
			name: "read",
			label: "read",
			description: "Fake read",
			parameters: type({}),
			async execute() {
				return { content: [{ type: "text" as const, text: "ok" }] };
			},
		};
		const manager = SessionManager.create(dir, path.join(dir, `active-${Bun.nanoseconds()}`));
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [readTool],
					messages: extra?.messages ?? [],
					thinkingLevel: Effort.Medium,
				},
			}),
			sessionManager: manager,
			settings: Settings.instance,
			modelRegistry: registry,
			toolRegistry: new Map([[readTool.name, readTool]]),
			builtInToolNames: ["read"],
			extensionRunner: extra?.extensionRunner?.(manager, registry),
			createVibeTools: extra?.createVibeTools,
		});
		extra?.beforeMode?.(session);
		mode = new InteractiveMode(
			session,
			"test",
			extra?.startupChangelog,
			() => {},
			extra?.lspServers,
			extra?.mcpManager,
			eventBus,
		);
		return mode;
	}

	return {
		createMode,
		tempDir: () => tempDir!,
		authStorage: () => authStorage!,
		projectDir: () => projectDir,
	};
}
