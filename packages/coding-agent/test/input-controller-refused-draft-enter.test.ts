/**
 * Refusals on the production Enter path (Editor.handleInput with Enter on a
 * real CustomEditor, which empties the composer before onSubmit runs) must
 * merge the refused submission back alongside a newer draft typed during
 * dispatch — text AND images — never clobbering it.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UserMessageRefusedError, type PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { BlobPutOptions, BlobPutResult } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getEditorTheme } from "@oh-my-pi/pi-tui/theme/tui-adapters";

const ENTER = "\r";
const SECRET = "token FAKE-SECRET-NOT-REAL-0000";
const NOTICE = "Blocked: this message looks like it contains a secret. It was not sent or saved.";
const refusedImage: ImageContent = { type: "image", mimeType: "image/png", data: "cmVmdXNlZA==" };
const newerImage: ImageContent = { type: "image", mimeType: "image/jpeg", data: "bmV3ZXI=" };

const cleanupDirs: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
});

async function createSkillCommands(): Promise<{ commands: Map<string, Skill>; dir: string }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-refused-enter-skill-"));
	cleanupDirs.push(dir);
	await fs.writeFile(
		path.join(dir, "SKILL.md"),
		"---\nname: reviewer\ndescription: Review code\n---\n\nReview the supplied code carefully.\n",
	);
	const skill: Skill = {
		name: "reviewer",
		description: "Review code",
		filePath: path.join(dir, "SKILL.md"),
		baseDir: dir,
		source: "test",
	};
	return { commands: new Map([["skill:reviewer", skill]]), dir };
}

function createContext(options: {
	editor: CustomEditor;
	skillCommands: Map<string, Skill>;
	promptCustomMessage: (message: unknown, opts: unknown) => Promise<boolean>;
	prompt: (text: string, opts?: PromptOptions) => Promise<boolean>;
	gateUserMessage?: (text: string) => Promise<void>;
}) {
	const sessionManager = SessionManager.inMemory(process.cwd());
	vi.spyOn(sessionManager, "putBlob").mockImplementation(async (data: Buffer): Promise<BlobPutResult> => {
		const hash = new Bun.CryptoHasher("sha256").update(data).digest("hex");
		return { hash, path: `blob:${hash}`, displayPath: `blob:${hash}.bin`, ref: `blob:sha256:${hash}` };
	});
	const showError = vi.fn();
	const session = {
		extensionRunner: undefined,
		isStreaming: false,
		isCompacting: false,
		isBashRunning: false,
		isEvalRunning: false,
		queuedMessageCount: 0,
		prompt: vi.fn(options.prompt),
		promptCustomMessage: vi.fn(options.promptCustomMessage),
		followUp: vi.fn(async () => {}),
		abort: vi.fn(async () => {}),
		gateUserMessage: options.gateUserMessage !== undefined ? vi.fn(options.gateUserMessage) : vi.fn(async () => {}),
	};
	const ctx = {
		editor: options.editor,
		session,
		viewSession: session,
		sessionManager,
		settings: Settings.isolated({}),
		keybindings: KeybindingsManager.inMemory(),
		ui: {
			requestRender: vi.fn(),
			addInputListener: vi.fn(),
			addStartListener: vi.fn(),
			getFocused: () => options.editor,
		},
		compactionQueuedMessages: [],
		skillCommands: options.skillCommands,
		fileSlashCommands: new Set<string>(),
		locallySubmittedUserSignatures: new Set<string>(),
		isBashMode: false,
		isPythonMode: false,
		showStatus: vi.fn(),
		showError,
		showWarning: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
		renderOptimisticSkillMessage: vi.fn(),
		clearOptimisticSkillMessage: vi.fn(),
		optimisticSkillMessagePending: false,
		handleBashCommand: vi.fn(),
		handlePythonCommand: vi.fn(),
		withLocalSubmission: async <T>(_text: string, submit: () => Promise<T>) => submit(),
		isGuidedGoalInterviewActive: () => false,
	} as unknown as InteractiveModeContext;
	const controller = new InputController(ctx);
	controller.setupEditorSubmitHandler();
	// Production drive: the real Editor clears the composer inside #submitValue
	// before onSubmit runs, so a direct onSubmit call would hide draft-loss bugs.
	const onSubmit = options.editor.onSubmit;
	let submitCompletion: Promise<void> | undefined;
	options.editor.onSubmit = text => {
		submitCompletion = Promise.resolve(onSubmit?.(text));
		return submitCompletion;
	};
	function pressEnter(): Promise<void> {
		submitCompletion = undefined;
		options.editor.handleInput(ENTER);
		if (!submitCompletion) throw new Error("Enter did not dispatch a submission");
		return submitCompletion;
	}
	return { ctx, session, showError, pressEnter, controller };
}

describe("refused interactive submissions preserve a newer draft", () => {
	it("Enter /skill: refusal merges text and images ahead of a newer draft", async () => {
		const editor = new CustomEditor(getEditorTheme());
		const { commands } = await createSkillCommands();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { session, showError, pressEnter } = createContext({
			editor,
			skillCommands: commands,
			promptCustomMessage: (async () => {
				entered.resolve();
				await release.promise;
				throw new UserMessageRefusedError(NOTICE);
			}) as (message: unknown, opts: unknown) => Promise<boolean>,
			prompt: async () => true,
		});

		editor.setText(`/skill:reviewer please use ${SECRET} [Image #1]`);
		editor.pendingImages.push(refusedImage);
		editor.pendingImageLinks.push(undefined);
		const submitting = pressEnter();
		await entered.promise;
		// Typed after Enter detached the draft, while dispatch was pending.
		editor.setText("newer draft");
		editor.pendingImages.push(newerImage);
		editor.pendingImageLinks.push(undefined);
		release.resolve();
		await submitting;

		expect(session.promptCustomMessage).toHaveBeenCalledTimes(1);
		expect(showError).toHaveBeenCalledWith(NOTICE);
		const restored = editor.getExpandedText();
		expect(restored).toContain(`/skill:reviewer please use ${SECRET}`);
		expect(restored).toContain("newer draft");
		expect(editor.pendingImages).toEqual([newerImage, refusedImage]);
	});

	it("Enter ! refusal merges the full line back ahead of a newer draft", async () => {
		const editor = new CustomEditor(getEditorTheme());
		const { commands } = await createSkillCommands();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { ctx, showError, pressEnter } = createContext({
			editor,
			skillCommands: commands,
			promptCustomMessage: async () => true,
			prompt: async () => true,
			gateUserMessage: async () => {
				entered.resolve();
				await release.promise;
				throw new UserMessageRefusedError(NOTICE);
			},
		});

		editor.setText(`!echo ${SECRET}`);
		const submitting = pressEnter();
		await entered.promise;
		// Typed into the emptied composer while the gate awaited.
		editor.setText("newer draft");
		editor.pendingImages.push(newerImage);
		editor.pendingImageLinks.push(undefined);
		release.resolve();
		await submitting;

		expect(ctx.handleBashCommand).not.toHaveBeenCalled();
		expect(showError).toHaveBeenCalledWith(NOTICE);
		const restored = editor.getExpandedText();
		expect(restored).toContain(`!echo ${SECRET}`);
		expect(restored).toContain("newer draft");
		expect(editor.pendingImages).toEqual([newerImage]);
	});

	it("Enter $ refusal merges the full line back ahead of a newer draft", async () => {
		const editor = new CustomEditor(getEditorTheme());
		const { commands } = await createSkillCommands();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { ctx, showError, pressEnter } = createContext({
			editor,
			skillCommands: commands,
			promptCustomMessage: async () => true,
			prompt: async () => true,
			gateUserMessage: async () => {
				entered.resolve();
				await release.promise;
				throw new UserMessageRefusedError(NOTICE);
			},
		});

		editor.setText(`$ print('${SECRET}')`);
		const submitting = pressEnter();
		await entered.promise;
		editor.setText("newer draft");
		editor.pendingImages.push(newerImage);
		editor.pendingImageLinks.push(undefined);
		release.resolve();
		await submitting;

		expect(ctx.handlePythonCommand).not.toHaveBeenCalled();
		expect(showError).toHaveBeenCalledWith(NOTICE);
		const restored = editor.getExpandedText();
		expect(restored).toContain(`$ print('${SECRET}')`);
		expect(restored).toContain("newer draft");
		expect(editor.pendingImages).toEqual([newerImage]);
	});

	it("refused /queue follow-up merges text and images ahead of a newer draft", async () => {
		const editor = new CustomEditor(getEditorTheme());
		const { commands } = await createSkillCommands();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { session, showError, pressEnter } = createContext({
			editor,
			skillCommands: commands,
			promptCustomMessage: async () => true,
			prompt: async () => {
				entered.resolve();
				await release.promise;
				throw new UserMessageRefusedError(NOTICE);
			},
		});

		editor.setText(`=> queued ${SECRET} [Image #1]`);
		editor.pendingImages.push(refusedImage);
		editor.pendingImageLinks.push(undefined);
		const submitting = pressEnter();
		await entered.promise;
		// Typed after the queue submission detached the draft.
		editor.setText("newer draft");
		editor.pendingImages.push(newerImage);
		editor.pendingImageLinks.push(undefined);
		release.resolve();
		await submitting;

		expect(session.prompt).toHaveBeenCalledTimes(1);
		expect(showError).toHaveBeenCalledWith(NOTICE);
		const restored = editor.getExpandedText();
		expect(restored).toContain(`queued ${SECRET}`);
		expect(restored).toContain("newer draft");
		expect(editor.pendingImages).toEqual([newerImage, refusedImage]);
	});

	it("enumerated /queue refusal merges the remainder ahead of a newer draft", async () => {
		const editor = new CustomEditor(getEditorTheme());
		const { commands } = await createSkillCommands();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { session, showError, pressEnter } = createContext({
			editor,
			skillCommands: commands,
			promptCustomMessage: async () => true,
			prompt: async () => true,
		});
		// The second enumerated item travels via followUp, not prompt.
		session.followUp.mockImplementation(async () => {
			entered.resolve();
			await release.promise;
			throw new UserMessageRefusedError(NOTICE);
		});

		editor.setText(`=>\n1. clean first\n2. bad ${SECRET}`);
		const submitting = pressEnter();
		await entered.promise;
		// Typed while the refused second item was in flight (the first sent).
		editor.setText("newer draft");
		editor.pendingImages.push(newerImage);
		editor.pendingImageLinks.push(undefined);
		release.resolve();
		await submitting;

		expect(session.prompt).toHaveBeenCalledTimes(1);
		expect(session.prompt).toHaveBeenCalledWith("clean first", expect.objectContaining({ source: "interactive" }));
		expect(session.followUp).toHaveBeenCalledTimes(1);
		expect(showError).toHaveBeenCalledWith(NOTICE);
		const restored = editor.getExpandedText();
		expect(restored).toContain(`=> bad ${SECRET}`);
		expect(restored).toContain("newer draft");
		expect(editor.pendingImages).toEqual([newerImage]);
	});
});
