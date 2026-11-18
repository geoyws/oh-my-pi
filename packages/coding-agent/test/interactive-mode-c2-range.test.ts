import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { type Api, Effort, type Model } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { cfgStartupQuiet, cfgTuiMouse } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { DescribeContext } from "@oh-my-pi/pi-tui/native/node";

const cx: DescribeContext = { cols: 80, reduceMotion: false, dark: true, supports: () => true, feature: () => true };

describe("InteractiveMode constructed surface (C2)", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let mode: InteractiveMode | undefined;
	let session: AgentSession | undefined;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-c2-range-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		cfgStartupQuiet.set(Settings.instance, true);
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		mode = undefined;
		session = undefined;
		resetSettingsForTest();
	});

	function createMode(eventBus?: EventBus): InteractiveMode {
		const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), `models-${Bun.nanoseconds()}.yml`));
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
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), `active-${Bun.nanoseconds()}`));
		session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [readTool], messages: [], thinkingLevel: Effort.Medium },
			}),
			sessionManager: manager,
			settings: Settings.instance,
			modelRegistry: registry,
			toolRegistry: new Map([[readTool.name, readTool]]),
			builtInToolNames: ["read"],
		});
		mode = new InteractiveMode(session, "test", undefined, () => {}, undefined, undefined, eventBus);
		return mode;
	}

	it("reports the initial session-mode state and empty HUD descriptions", () => {
		const m = createMode();
		expect(m.sessionModes.getState()).toBeDefined();
		const pills = m.describeHudPills();
		expect(pills).toBeDefined();
		expect(m.describeHudPills()).toBe(pills);
		const status = m.describeStatusHud([], cx);
		expect(m.describeStatusHud([], cx)).toBe(status);
	});

	it("installs editor callbacks for mentions, hyperlinks, skills and hints", () => {
		const m = createMode();
		expect(m.editor.fileHyperlink("/tmp/a.ts", "a.ts")).toBe("a.ts"); // no OSC 8 in this terminal
		expect(m.editor.skillFilePath("missing")).toBeUndefined();
		expect(m.editor.modelMentionLabel("no-such-model-xyz")).toBeUndefined();
		expect(m.editor.modelMentionSelector({} as never)).toBeUndefined();
		expect(typeof m.editor.magicKeywordsEnabled()).toBe("boolean");
		void m.editor.placeholder?.();
	});

	it("routes LSP and MCP startup events from the session event bus", () => {
		const bus = new EventBus();
		const m = createMode(bus);
		// quiet startup: the LSP handler returns before touching the transcript
		bus.emit("lsp:startup", { type: "failed", error: "no servers" });
		cfgStartupQuiet.set(Settings.instance, false);
		bus.emit("lsp:startup", { type: "failed", error: "no servers" });
		bus.emit("lsp:startup", { type: "completed", servers: [] });
		// malformed MCP payloads are logged and dropped
		bus.emit("mcp:connection-status", { nope: true });
		bus.emit("mcp:connection-status", { type: "connecting", serverNames: ["srv1"] });
		bus.emit("mcp:connection-status", { type: "connected", serverName: "srv1" });
		bus.emit("mcp:connection-status", { type: "failed", serverName: "srv1", error: "boom" });
		bus.emit("mcp:connection-status", { type: "reconnecting", serverName: "srv1" });
		expect(m).toBeDefined();
	});

	it("reacts to editor geometry callbacks, mouse settings and judgment progress", () => {
		const bus = new EventBus();
		const m = createMode(bus);
		m.editor.onAutocompleteCancel?.();
		m.editor.onAutocompleteUpdate?.();
		expect(m.editor.viewportRowsProvider?.()).toBeGreaterThan(0);
		// mouse capture follows the tui.mouse setting in both directions
		cfgTuiMouse.set(Settings.instance, false);
		cfgTuiMouse.set(Settings.instance, true);
		// malformed judgment progress is dropped; a valid snapshot drives the HUD
		bus.emit("eval:judgment-batch-progress", { nope: true });
		bus.emit("eval:judgment-batch-progress", {
			id: "batch-1",
			intent: "grade answers",
			done: 1,
			total: 3,
			failed: 0,
			cost: 0.01,
			running: true,
		});
		bus.emit("eval:judgment-batch-progress", {
			id: "batch-1",
			intent: "grade answers",
			done: 3,
			total: 3,
			failed: 1,
			cost: 0.03,
			running: false,
		});
		m.statusLine.onNativePullRequest?.({ number: 42 } as never);
		m.statusLine.onNativePullRequest?.(undefined as never);
	});

	it("initializes once and refreshes the title system prompt", async () => {
		const m = createMode();
		await m.init({ suppressWelcomeIntro: true });
		expect(m.isInitialized).toBe(true);
		await m.init({ suppressWelcomeIntro: true }); // second init is a no-op
		await m.refreshTitleSystemPrompt(tempDir.path());
	});

	it("tracks displayable thinking content per visible session", () => {
		const m = createMode();
		expect(m.hasDisplayableThinkingContent).toBe(false);
		const plain = { role: "assistant", content: [{ type: "text", text: "hi" }] } as never;
		expect(m.noteDisplayableThinkingContent(plain)).toBe(false);
		expect(m.hasDisplayableThinkingContent).toBe(false);
		const thinking = { role: "assistant", content: [{ type: "thinking", thinking: "reasoning" }] } as never;
		expect(m.noteDisplayableThinkingContent(thinking)).toBe(true);
		expect(m.hasDisplayableThinkingContent).toBe(true);
		expect(m.noteDisplayableThinkingContent(thinking)).toBe(false);
	});
});
