import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { BeforeUserMessageEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * kb omp t-70e36c50: a prompt refused by `before_user_message` must never
 * reach prompt history (history.db or up-arrow recall), on any submit path,
 * typed or pasted. An admitted prompt still lands and is recalled.
 */
const MARKER = "FAKE-SECRET-NOT-REAL";
const SECRET = `use token ${MARKER}-0000 please`;

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

describe("refused prompts never reach prompt history", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let controller: InputController;
	let history: HistoryStorage;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-refusal-history-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		HistoryStorage.close();
		history = HistoryStorage.open(path.join(tempDir.path(), "history.db"));

		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("openai", "openai-test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const sessionManager = SessionManager.inMemory();
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("before_user_message", (event: BeforeUserMessageEvent) =>
					event.text.includes(MARKER) ? { refuse: true, notice: "Blocked: secret." } : undefined,
				);
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"refusal-history-test",
		);
		const extensionRunner = new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: () => {
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "Done." }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: zeroUsage,
					stopReason: "stop",
					timestamp: Date.now(),
				};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry: new Map(),
			extensionRunner,
		});
		mode = new InteractiveMode(session, "test");
		controller = new InputController(mode);
		controller.setupEditorSubmitHandler();
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		HistoryStorage.close();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	/** Lets the turn finish and every pending history admission land or drop. */
	async function settle(): Promise<void> {
		await session.waitForIdle();
		await mode.editor.whenHistorySettled();
	}

	function storedPrompts(): string[] {
		return history.getRecent(100).map(entry => entry.prompt);
	}

	/** Up-arrow from an empty composer: the most recent recalled entry. */
	function recallLatest(): string {
		mode.editor.setText("");
		mode.editor.handleInput("\x1b[A");
		const recalled = mode.editor.getText();
		mode.editor.setText("");
		return recalled;
	}

	it("Enter: a typed refused prompt leaves no history row; an admitted one lands and is recalled", async () => {
		await mode.editor.onSubmit?.(SECRET);
		await settle();
		expect(storedPrompts().filter(p => p.includes(MARKER))).toEqual([]);
		expect(recallLatest()).not.toContain(MARKER);

		await mode.editor.onSubmit?.("an ordinary admitted prompt");
		await settle();
		expect(storedPrompts()).toContain("an ordinary admitted prompt");
		expect(recallLatest()).toBe("an ordinary admitted prompt");
	});

	it("Enter: a pasted refused prompt leaves no history row", async () => {
		// The real Enter key: the editor expands the paste and calls onSubmit itself.
		// init() lifts the composer's bootstrap submit gate; this harness skips init().
		mode.editor.disableSubmit = false;
		const submit = mode.editor.onSubmit;
		let submitted: unknown;
		mode.editor.onSubmit = text => {
			submitted = submit?.(text);
		};
		mode.editor.handleInput(`\x1b[200~${SECRET}\nsecond line of the paste\x1b[201~`);
		mode.editor.handleInput("\r");
		expect(submitted).toBeInstanceOf(Promise);
		await submitted;
		await settle();
		expect(storedPrompts().filter(p => p.includes(MARKER))).toEqual([]);
		expect(recallLatest()).not.toContain(MARKER);
	});

	it("Ctrl+Enter follow-up: a refused prompt leaves no history row; an admitted one lands", async () => {
		mode.editor.setText(SECRET);
		await controller.handleFollowUp();
		await settle();
		expect(storedPrompts().filter(p => p.includes(MARKER))).toEqual([]);
		expect(recallLatest()).not.toContain(MARKER);

		mode.editor.setText("an admitted follow-up");
		await controller.handleFollowUp();
		await settle();
		expect(storedPrompts()).toContain("an admitted follow-up");
		expect(recallLatest()).toBe("an admitted follow-up");
	});

	it("! shell command: a refused command leaves no history row", async () => {
		await mode.editor.onSubmit?.(`!echo ${SECRET}`);
		await settle();
		expect(storedPrompts().filter(p => p.includes(MARKER))).toEqual([]);
		expect(recallLatest()).not.toContain(MARKER);
	});

	it("handled slash command: a refused argument leaves no history row", async () => {
		await mode.editor.onSubmit?.(`/goal ship with ${SECRET}`);
		await settle();
		expect(storedPrompts().filter(p => p.includes(MARKER))).toEqual([]);
		expect(recallLatest()).not.toContain(MARKER);
	});
});
