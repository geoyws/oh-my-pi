import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { getEditorTheme } from "@oh-my-pi/pi-tui/theme/tui-adapters";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { runPrintMode } from "@oh-my-pi/pi-coding-agent/modes/print-mode";
import type { PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { UserMessageRefusedError } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

const ENTER = "\r";
const NOTICE = "Blocked: this message looks like it contains a secret. It was not sent or saved.";

async function createHarness(factory: ExtensionFactory) {
	const runtime = new ExtensionRuntime();
	const sessionManager = SessionManager.inMemory(process.cwd());
	const extension = await loadExtensionFromFactory(factory, process.cwd(), new EventBus(), runtime, "refusal-input");
	const runner = new ExtensionRunner([extension], runtime, process.cwd(), sessionManager, {} as ModelRegistry);
	const editor = new CustomEditor(getEditorTheme());
	const prompt = vi.fn(async (_text: string, _options?: PromptOptions) => true);
	const session = {
		extensionRunner: runner,
		isStreaming: true,
		isCompacting: false,
		queuedMessageCount: 0,
		prompt,
		followUp: vi.fn(async (_text: string, _images?: ImageContent[]) => {}),
		promptCustomMessage: vi.fn(async () => true),
		abort: vi.fn(async () => {}),
	};
	const ctx = {
		editor,
		session,
		viewSession: session,
		sessionManager,
		settings: Settings.isolated({}),
		keybindings: KeybindingsManager.inMemory(),
		dictationSpaceHold: vi.fn(),
		ui: {
			requestRender: vi.fn(),
			addInputListener: vi.fn(),
			addStartListener: vi.fn(),
			getFocused: () => editor,
			terminal: { write: vi.fn() },
		},
		compactionQueuedMessages: [],
		skillCommands: new Map(),
		fileSlashCommands: new Set<string>(),
		locallySubmittedUserSignatures: new Set<string>(),
		mcpTestEscapeHandlers: new Set<() => void>(),
		isBashMode: false,
		isPythonMode: false,
		lastSigintTime: 0,
		hasActiveBtw: () => false,
		hasActiveOmfg: () => false,
		hasActiveCleanse: () => false,
		dismissCommandReport: () => false,
		updateEditorBorderColor: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
		flushPendingBashComponents: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		handleClearCommand: vi.fn(),
		resetDisplayAfterAppearanceRefresh: vi.fn(),
		shutdown: vi.fn(async () => {}),
		clearEditor: () => editor.clearDraft(),
		withLocalSubmission: async <T>(_text: string, submit: () => Promise<T>) => submit(),
		isGuidedGoalInterviewActive: () => false,
	} as unknown as InteractiveModeContext;
	const helpers = new UiHelpers(ctx);
	ctx.queueCompactionMessage = (text, mode, images, options) =>
		helpers.queueCompactionMessage(text, mode, images, options);
	const controller = new InputController(ctx);
	ctx.handleQueueCommand = (message, detached) => controller.handleQueueCommand(message, detached);
	controller.setupKeyHandlers();
	controller.setupEditorSubmitHandler();
	const onSubmit = editor.onSubmit;
	let enterCompletion: Promise<void> | undefined;
	editor.onSubmit = text => {
		enterCompletion = Promise.resolve(onSubmit?.(text));
		return enterCompletion;
	};
	function pressEnter(): Promise<void> {
		enterCompletion = undefined;
		editor.handleInput(ENTER);
		if (!enterCompletion) throw new Error("The editor did not dispatch the submit key");
		return enterCompletion;
	}
	return { ctx, editor, session, prompt, pressEnter };
}

afterEach(() => vi.restoreAllMocks());

describe("interactive refusal restore", () => {
	it("Enter keeps the refused draft and never clobbers a newer draft", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const h = await createHarness(() => {});
		h.prompt.mockImplementationOnce(async () => {
			entered.resolve();
			await release.promise;
			throw new UserMessageRefusedError(NOTICE);
		});
		h.editor.setText("refused draft");
		const submitting = h.pressEnter();
		await entered.promise;
		// Typed while dispatch was pending: must survive alongside the refused text.
		h.editor.setText("newer draft");
		release.resolve();
		await submitting;

		expect(h.prompt.mock.calls).toEqual([
			["refused draft", { streamingBehavior: "steer", images: undefined, source: "interactive" }],
		]);
		expect(h.editor.getExpandedText()).toBe("refused draft\n\nnewer draft");
		expect(h.ctx.showError).toHaveBeenCalledWith(NOTICE);
	});

	it("a message queued during compaction and refused at flush comes back into the editor", async () => {
		const h = await createHarness(() => {});
		const refusedShown = Promise.withResolvers<void>();
		Object.assign(h.ctx, {
			isKnownSlashCommand: () => false,
			recordLocalSubmission: () => () => {},
			loopModeEnabled: false,
		});
		(h.ctx.showError as Mock<(message: string) => void>).mockImplementation(() => refusedShown.resolve());
		h.prompt.mockImplementationOnce(async () => {
			throw new UserMessageRefusedError(NOTICE);
		});
		const helpers = new UiHelpers(h.ctx);

		// /queue during compaction clears the composer into the queue.
		helpers.queueCompactionMessage("refused queued", "steer");
		expect(h.editor.getExpandedText()).toBe("");
		h.editor.setText("typed while compacting");
		await helpers.flushCompactionQueue({ willRetry: false });
		await refusedShown.promise;

		expect(h.ctx.showError).toHaveBeenCalledWith(NOTICE);
		expect(h.editor.getExpandedText()).toBe("refused queued\ntyped while compacting");
		// Final, not retried: the queue stays empty.
		expect(h.ctx.compactionQueuedMessages).toEqual([]);
	});
});

function makeAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "draft" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
		...overrides,
	};
}

describe("print-mode refusal", () => {
	let stderrOutput: string[];
	let stdoutOutput: string[];

	beforeEach(() => {
		stderrOutput = [];
		stdoutOutput = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
			stderrOutput.push(String(chunk));
			return true;
		});
		vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
		vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
			if (typeof args[0] === "string") stdoutOutput.push(args[0]);
			const last = args[args.length - 1];
			if (typeof last === "function") last();
			return true;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function createMockSession(prompt: Mock<(...args: unknown[]) => Promise<unknown>>): AgentSession {
		return {
			state: { messages: [] },
			getLastAssistantMessage: () => makeAssistantMessage(),
			settings: Settings.isolated(),
			sessionManager: {
				getHeader: () => undefined,
				buildSessionContext: () => ({ messages: [] }),
				getEntries: () => [],
				onPersistenceError: () => () => {},
				onPersistenceNotice: () => () => {},
			},
			extensionRunner: undefined,
			subscribe: () => () => {},
			prompt: prompt as never,
			disableStopTimeTodoReminders: () => {},
			prepareForHeadlessAdvisorDrain: () => {},
			setTextOutputCommitted: () => {},
			waitForAdvisorCatchup: async () => true,
			dispose: async () => {},
		} as unknown as AgentSession;
	}

	it("passes source print and surfaces only the notice on refusal", async () => {
		const prompt = vi.fn(async (..._args: unknown[]) => {
			throw new UserMessageRefusedError(NOTICE);
		});
		const session = createMockSession(prompt);
		const error = await runPrintMode(session, {
			mode: "text",
			initialMessage: "token FAKE-SECRET-NOT-REAL-0000",
		}).then(
			() => null,
			(error: unknown) => error,
		);
		expect(error).toBeInstanceOf(UserMessageRefusedError);
		expect((error as Error).message).toBe(NOTICE);
		expect(prompt.mock.calls[0]?.[1]).toMatchObject({ source: "print" });
		expect(stdoutOutput.join("")).not.toContain("FAKE-SECRET");
		expect(stderrOutput.join("")).not.toContain("FAKE-SECRET");
	});

	it("passes source print on a clean message", async () => {
		const prompt = vi.fn(async (..._args: unknown[]) => {});
		const session = createMockSession(prompt);
		expect(await runPrintMode(session, { mode: "text", initialMessage: "clean hello" })).toBe(0);
		expect(prompt.mock.calls[0]).toEqual(["clean hello", { images: undefined, source: "print" }]);
	});
});
