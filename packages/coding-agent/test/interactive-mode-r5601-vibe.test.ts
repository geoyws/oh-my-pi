/**
 * InteractiveMode `/vibe` from line 7091: entry refusals, prompt dispatch while
 * a turn streams or with images, races where another mode starts while the
 * first prompt is still gated, failed skill prompts, and the worker count on exit.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { VIBE_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/tools/vibe";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

function stubTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: type({ value: "string" }),
		strict: true,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	};
}

const image: ImageContent = { type: "image", data: "aGk=", mimeType: "image/png" };

describe("InteractiveMode /vibe (lines 7091-7301)", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession;
	let mode: InteractiveMode;
	let warnings: string[];
	let statuses: string[];

	const vibeEntries = () =>
		session.sessionManager.getEntries().filter(entry => entry.type === "mode_change" && entry.mode === "vibe").length;

	async function registerSkill(name: string, body: string): Promise<string> {
		const filePath = path.join(tempDir.path(), `${name}.md`);
		await Bun.write(filePath, `---\nname: ${name}\n---\n${body}\n`);
		const skill: Skill = { name, description: "", filePath, baseDir: tempDir.path(), source: "test" };
		mode.skillCommands.set(`skill:${name}`, skill);
		return filePath;
	}

	function streaming(value: boolean): void {
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => value });
	}

	beforeAll(async () => {
		await initTheme();
		tempDir = TempDir.createSync("@pi-im-r5601-vibe-");
		authStorage = createInMemoryAuthStorage();
		modelRegistry = new ModelRegistry(authStorage);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		VibeSessionRegistry.resetGlobalForTests();
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		const registryTools = [stubTool("read"), stubTool("todo")];
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({}),
			modelRegistry,
			toolRegistry: new Map(registryTools.map(tool => [tool.name, tool])),
			builtInToolNames: registryTools.map(tool => tool.name),
			createVibeTools: () => VIBE_TOOL_NAMES.map(stubTool),
		});
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, new EventBus());
		warnings = [];
		statuses = [];
		spyOn(mode, "showWarning").mockImplementation(message => void warnings.push(message));
		spyOn(mode, "showStatus").mockImplementation(message => void statuses.push(message));
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		VibeSessionRegistry.resetGlobalForTests();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	it.each([
		["active", "goalModeEnabled"],
		["paused", "goalModePaused"],
	] as const)("refuses while a goal is %s", async (_label, flag) => {
		mode[flag] = true;
		const activate = spyOn(session, "activateVibeTools");

		expect(await mode.handleVibeModeCommand("go")).toBe(false);

		expect(warnings).toEqual(["Exit goal mode first."]);
		expect(mode.vibeModeEnabled).toBe(false);
		expect(activate).not.toHaveBeenCalled();
	});

	describe("prompt dispatch", () => {
		let prompt: ReturnType<typeof spyOn<AgentSession, "prompt">>;

		beforeEach(() => {
			prompt = spyOn(session, "prompt").mockResolvedValue(true);
		});

		it.each([
			["with its images", { images: [image] }, [image]],
			["without images", { images: [] }, undefined],
			["with no input", undefined, undefined],
		])("steers the first prompt into a streaming turn %s", async (_label, input, images) => {
			streaming(true);
			const context = spyOn(session, "sendVibeModeContext").mockResolvedValue(undefined as never);

			expect(await mode.handleVibeModeCommand("go", input)).toBe(true);

			expect(mode.vibeModeEnabled).toBe(true);
			expect(context).toHaveBeenCalledWith({ deliverAs: "steer" });
			expect(prompt).toHaveBeenCalledWith("go", { streamingBehavior: "steer", images });
		});

		it("steers the first prompt with its images when no input waiter is armed", async () => {
			expect(await mode.handleVibeModeCommand("go", { images: [image] })).toBe(true);

			expect(prompt).toHaveBeenCalledWith("go", { streamingBehavior: "steer", images: [image] });
		});

		it("a second /vibe whose prompt clears its gate after vibe started runs in that vibe, without a second entry", async () => {
			const firstGate = Promise.withResolvers<void>();
			const secondGate = Promise.withResolvers<void>();
			spyOn(session, "gateUserMessage")
				.mockImplementationOnce(() => firstGate.promise as never)
				.mockImplementationOnce(() => secondGate.promise as never);

			const first = mode.handleVibeModeCommand("one");
			const second = mode.handleVibeModeCommand("two");
			firstGate.resolve();
			expect(await first).toBe(true);
			expect(mode.vibeModeEnabled).toBe(true);

			secondGate.resolve();
			expect(await second).toBe(true);

			expect(mode.vibeModeEnabled).toBe(true);
			expect(vibeEntries()).toBe(1);
			expect(prompt.mock.calls.map(call => call[0])).toEqual(["one", "two"]);
		});

		it.each([
			["plan mode", "planModePaused", "Plan mode is paused"],
			["a goal", "goalModeEnabled", "Exit goal mode first."],
		] as const)("does not enter vibe when %s started while the first prompt was gated", async (_label, flag, warning) => {
			const gate = Promise.withResolvers<void>();
			spyOn(session, "gateUserMessage").mockImplementation(() => gate.promise as never);
			const activate = spyOn(session, "activateVibeTools");

			const pending = mode.handleVibeModeCommand("go");
			await Bun.sleep(0);
			mode[flag] = true;
			gate.resolve();
			await pending;

			expect(mode.vibeModeEnabled).toBe(false);
			expect(activate).not.toHaveBeenCalled();
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain(warning);
		});
	});

	it("a failed skill prompt does not block the skill queued behind it", async () => {
		const gate = Promise.withResolvers<void>();
		const activate = session.activateVibeTools.bind(session);
		spyOn(session, "activateVibeTools").mockImplementation(async tools => {
			await gate.promise;
			return activate(tools);
		});
		const missing = await registerSkill("gone-skill", "Gone body.");
		await registerSkill("next-skill", "Next body.");
		await fs.unlink(missing);
		const dispatched: string[] = [];
		spyOn(session, "promptCustomMessage").mockImplementation(async message => {
			dispatched.push(typeof message.content === "string" ? message.content : "");
			return true;
		});

		const first = mode.handleVibeModeCommand("/skill:gone-skill a");
		const second = mode.handleVibeModeCommand("/skill:next-skill b");
		gate.resolve();

		await expect(first).rejects.toThrow();
		expect(await second).toBe(true);
		expect(dispatched).toHaveLength(1);
		expect(dispatched[0]).toContain("Next body.");
	});

	it.each([
		[1, "Vibe mode disabled. Killed 1 worker session."],
		[2, "Vibe mode disabled. Killed 2 worker sessions."],
	])("reports %i killed worker(s) on exit", async (killed, status) => {
		expect(await mode.handleVibeModeCommand()).toBe(false);
		expect(mode.vibeModeEnabled).toBe(true);
		spyOn(VibeSessionRegistry.global(), "killAll").mockResolvedValue(killed);

		expect(await mode.handleVibeModeCommand()).toBe(false);

		expect(mode.vibeModeEnabled).toBe(false);
		expect(statuses.at(-1)).toBe(status);
	});
});
