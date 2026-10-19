/**
 * Production-Enter refusal recovery for slash ingress points: Editor.handleInput
 * with Enter on a real CustomEditor (which empties the composer before onSubmit)
 * through the real builtins into the real controllers. A refusal must merge the
 * refused line back into the composer ahead of any newer draft typed during the
 * await — or, for /tree, reopen the hook editor prefilled — and surface only
 * the handler's notice without persisting or sending anything.
 */
import { type Mock, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { BtwController } from "@oh-my-pi/pi-coding-agent/modes/controllers/btw-controller";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UserMessageRefusedError } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { BtwHistoryStore } from "@oh-my-pi/pi-coding-agent/session/btw-history";
import { cfgBranchSummaryEnabled } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { Container } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { getEditorTheme } from "@oh-my-pi/pi-tui/theme/tui-adapters";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const ENTER = "\r";
const SECRET = "token FAKE-SECRET-NOT-REAL-0000";
const NOTICE = "Blocked: this message looks like it contains a secret. It was not sent or saved.";
const newerImage: ImageContent = { type: "image", mimeType: "image/jpeg", data: "bmV3ZXI=" };

let settingsState: SettingsTestState | undefined;
beforeAll(async () => {
	await initTheme();
});
const tempDirs: string[] = [];
beforeEach(async () => {
	settingsState = beginSettingsTest();
	await Settings.init({ inMemory: true });
});
afterEach(async () => {
	vi.restoreAllMocks();
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function userNode(id: string, parentId: string | null, text: string): SessionTreeNode {
	const message: AgentMessage = { role: "user", content: text, timestamp: 1 };
	return { entry: { type: "message", id, parentId, timestamp: "2026-01-01T00:00:00Z", message }, children: [] };
}

interface ProductionHarness {
	ctx: InteractiveModeContext;
	editor: CustomEditor;
	session: Record<string, unknown>;
	showError: Mock<(message: string) => void>;
	pressEnter: () => Promise<void>;
	capturedTreeSelector: () => { handleInput(key: string): void };
}
async function createProductionHarness(sessionExtras: Record<string, unknown>): Promise<ProductionHarness> {
	const editor = new CustomEditor(getEditorTheme());
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-refused-prod-"));
	tempDirs.push(directory);
	const sessionManager = SessionManager.create(directory, directory);
	const showError = vi.fn();
	const session = {
		model: { provider: "anthropic", id: "claude-test" },
		isStreaming: false,
		isCompacting: false,
		isBashRunning: false,
		isEvalRunning: false,
		queuedMessageCount: 0,
		extensionRunner: undefined,
		customCommands: [],
		promptTemplates: [],
		prompt: vi.fn(async () => true),
		promptCustomMessage: vi.fn(async () => true),
		followUp: vi.fn(async () => {}),
		abort: vi.fn(async () => {}),
		runEphemeralTurn: vi.fn(async () => ({ replyText: "", assistantMessage: undefined })),
		compact: vi.fn(async () => "ok"),
		handoff: vi.fn(async () => null),
		navigateTree: vi.fn(async () => ({ cancelled: false })),
		abortBranchSummary: vi.fn(),
		...sessionExtras,
	};
	let treeSelector: { handleInput(key: string): void } | undefined;
	const ctx = {
		editor,
		session,
		viewSession: session,
		sessionManager,
		settings: Settings.isolated({}),
		keybindings: KeybindingsManager.inMemory(),
		ui: {
			requestRender: vi.fn(),
			requestComponentRender: vi.fn(),
			terminal: { rows: 40 },
			getFocused: () => editor,
			setFocus: vi.fn(),
		},
		btwContainer: new Container(),
		editorContainer: {
			children: [],
			clear: vi.fn(),
			addChild: vi.fn((child: unknown) => {
				treeSelector = child as { handleInput(key: string): void };
			}),
		},
		chatContainer: { addChild: vi.fn() },
		statusContainer: { addChild: vi.fn(), disposeChildren: vi.fn() },
		compactionQueuedMessages: [],
		skillCommands: new Map(),
		fileSlashCommands: new Set<string>(),
		locallySubmittedUserSignatures: new Set<string>(),
		isBashMode: false,
		isPythonMode: false,
		showStatus: vi.fn(),
		showError,
		showWarning: vi.fn(),
		showHookSelector: vi.fn(async () => "No summary"),
		showHookEditor: vi.fn(async () => undefined),
		updateEditorBorderColor: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
		renderOptimisticSkillMessage: vi.fn(),
		clearOptimisticSkillMessage: vi.fn(),
		optimisticSkillMessagePending: false,
		handleBashCommand: vi.fn(),
		handlePythonCommand: vi.fn(),
		handleBtwBranch: vi.fn(async () => {}),
		withLocalSubmission: async <T>(_text: string, submit: () => Promise<T>) => submit(),
		isGuidedGoalInterviewActive: () => false,
	} as unknown as InteractiveModeContext;
	const inputController = new InputController(ctx);
	inputController.setupEditorSubmitHandler();
	const btwController = new BtwController(ctx);
	const commandController = new CommandController(ctx);
	const selectorController = new SelectorController(ctx);
	Object.assign(ctx, {
		handleBtwCommand: (question: string) => btwController.start(question),
		handleCompactCommand: (...args: [string | undefined, ...unknown[]]) =>
			(commandController.handleCompactCommand as (...callArgs: unknown[]) => Promise<unknown>)(...args),
		handleHandoffCommand: (instructions?: string) => commandController.handleHandoffCommand(instructions),
		showTreeSelector: () => selectorController.showTreeSelector(),
	});
	const onSubmit = editor.onSubmit;
	let submitCompletion: Promise<void> | undefined;
	editor.onSubmit = text => {
		submitCompletion = Promise.resolve(onSubmit?.(text));
		return submitCompletion;
	};
	return {
		ctx,
		editor,
		session: session as Record<string, unknown>,
		showError,
		pressEnter: () => {
			submitCompletion = undefined;
			editor.handleInput(ENTER);
			if (!submitCompletion) throw new Error("Enter did not dispatch a submission");
			return submitCompletion;
		},
		capturedTreeSelector: () => {
			if (!treeSelector) throw new Error("Expected the tree selector to be shown");
			return treeSelector;
		},
	};
}

function refusingGate() {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const gate = vi.fn(async () => {
		entered.resolve();
		await release.promise;
		throw new UserMessageRefusedError(NOTICE);
	});
	return { gate, entered: entered.promise, release: () => release.resolve() };
}

describe("production Enter refusal recovery", () => {
	it("refused /btw merges the slash line back ahead of a newer draft", async () => {
		const { gate, entered, release } = refusingGate();
		const h = await createProductionHarness({ gateUserMessage: gate });

		editorSetText(h, `/btw side ${SECRET}?`);
		const submitting = h.pressEnter();
		await entered;
		h.editor.setText("newer draft");
		h.editor.pendingImages.push(newerImage);
		h.editor.pendingImageLinks.push(undefined);
		release();
		await submitting;

		expect(h.showError).toHaveBeenCalledWith(NOTICE);
		const restored = h.editor.getExpandedText();
		expect(restored).toContain(`/btw side ${SECRET}?`);
		expect(restored).toContain("newer draft");
		expect(h.editor.pendingImages).toEqual([newerImage]);
		expect(h.session["runEphemeralTurn"]).not.toHaveBeenCalled();
		const artifacts = h.ctx.sessionManager.getArtifactsDir();
		if (artifacts) {
			await expect(BtwHistoryStore.open(artifacts).then(store => store.getRecords())).resolves.toEqual([]);
		}
	});

	it("refused /compact merges the exact slash line back ahead of a newer draft", async () => {
		const { gate, entered, release } = refusingGate();
		const h = await createProductionHarness({ gateUserMessage: gate });
		h.ctx.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "first" }],
			timestamp: Date.now(),
		});
		h.ctx.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "second" }],
			api: "anthropic",
			provider: "anthropic",
			model: "claude-test",
			stopReason: "stop",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});

		editorSetText(h, `/compact focus ${SECRET}`);
		const submitting = h.pressEnter();
		await entered;
		h.editor.setText("newer draft");
		release();
		await submitting;

		expect(h.showError).toHaveBeenCalledWith(NOTICE);
		const restored = h.editor.getExpandedText();
		expect(restored).toContain(`/compact focus ${SECRET}`);
		expect(restored).toContain("newer draft");
		expect(h.session["compact"]).not.toHaveBeenCalled();
	});

	it("refused /handoff merges the exact slash line back ahead of a newer draft", async () => {
		const { gate, entered, release } = refusingGate();
		const h = await createProductionHarness({ gateUserMessage: gate });
		h.ctx.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "first" }],
			timestamp: Date.now(),
		});
		h.ctx.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "second" }],
			api: "anthropic",
			provider: "anthropic",
			model: "claude-test",
			stopReason: "stop",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});

		editorSetText(h, `/handoff focus ${SECRET}`);
		const submitting = h.pressEnter();
		await entered;
		h.editor.setText("newer draft");
		release();
		await submitting;

		expect(h.showError).toHaveBeenCalledWith(NOTICE);
		const restored = h.editor.getExpandedText();
		expect(restored).toContain(`/handoff focus ${SECRET}`);
		expect(restored).toContain("newer draft");
		expect(h.session["handoff"]).not.toHaveBeenCalled();
	});

	it("refused later queue item merges the remainder back ahead of a newer draft", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const prompt = vi.fn(async () => true);
		const followUp = vi.fn(async () => {
			entered.resolve();
			await release.promise;
			throw new UserMessageRefusedError(NOTICE);
		});
		const h = await createProductionHarness({ prompt, followUp });

		editorSetText(h, `=> 1. clean first\n2. bad ${SECRET}`);
		const submitting = h.pressEnter();
		await entered.promise;
		h.editor.setText("newer draft");
		h.editor.pendingImages.push(newerImage);
		h.editor.pendingImageLinks.push(undefined);
		release.resolve();
		await submitting;

		expect(prompt).toHaveBeenCalledTimes(1);
		expect(prompt).toHaveBeenCalledWith("clean first", expect.objectContaining({ source: "interactive" }));
		expect(followUp).toHaveBeenCalledTimes(1);
		expect(h.showError).toHaveBeenCalledWith(NOTICE);
		const restored = h.editor.getExpandedText();
		expect(restored).toContain(`=> bad ${SECRET}`);
		expect(restored).toContain("newer draft");
		expect(h.editor.pendingImages).toEqual([newerImage]);
	});

	it("refused /tree instructions reopen the hook editor prefilled and never navigate", async () => {
		cfgBranchSummaryEnabled.set(Settings.instance, true);
		const { gate, entered, release } = refusingGate();
		const h = await createProductionHarness({ gateUserMessage: gate });
		const root = userNode("root", null, "Root prompt");
		const getTree = vi.spyOn(h.ctx.sessionManager, "getTree").mockReturnValue([root]);
		vi.spyOn(h.ctx.sessionManager, "getLeafId").mockReturnValue("other-leaf");
		vi.spyOn(h.ctx.sessionManager, "getEntry").mockReturnValue(root.entry);
		const showHookSelector = vi.fn(async () => "Summarize with custom prompt");
		// The first answer carries the refused text; the reopen (prefilled with
		// it) is cancelled, returning to the tree selector. A mock that always
		// returns text would refuse forever and never settle.
		const showHookEditor = vi.fn(
			async (_title: string, _prefill?: string): Promise<string | undefined> => `custom ${SECRET}`,
		);
		showHookEditor.mockResolvedValueOnce(`custom ${SECRET}`).mockResolvedValueOnce(undefined);
		Object.assign(h.ctx, { showHookSelector, showHookEditor });

		editorSetText(h, "/tree");
		const submitting = h.pressEnter();
		// Pick the entry inside the production tree selector, then answer the
		// summary prompt with custom instructions.
		h.capturedTreeSelector().handleInput(ENTER);
		await entered;
		// The composer is modal-blocked by the hook editor here, so there is
		// no newer composer draft to race: the refused instructions themselves
		// must survive prefilled in the reopened editor.
		release();
		await submitting;
		// The tree flow detaches from the editor submission
		// (showTreeSelector returns void), so `submitting` settles before the
		// refusal is handled: pump microtasks until the reopened editor is
		// answered instead of asserting on a half-settled flow.
		for (let i = 0; i < 1000 && showHookEditor.mock.calls.length < 2; i++) await Promise.resolve();

		expect(h.showError).toHaveBeenCalledWith(NOTICE);
		expect(showHookEditor).toHaveBeenCalledTimes(2);
		expect(showHookEditor.mock.calls[1]?.[1]).toBe(`custom ${SECRET}`);
		expect(h.session["navigateTree"]).not.toHaveBeenCalled();
		getTree.mockRestore();
	});
});

function editorSetText(h: ProductionHarness, text: string): void {
	h.editor.setText(text);
}
