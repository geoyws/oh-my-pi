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
import { cfgStartupQuiet } from "@oh-my-pi/pi-coding-agent/modes/settings";
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

	function createMode(): InteractiveMode {
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
		mode = new InteractiveMode(session, "test");
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
