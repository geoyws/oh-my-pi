/**
 * A refused `/skill:` on interactive Enter (preserveDraft=false) and a refused
 * `/queue` follow-up must merge back alongside a newer draft typed during
 * dispatch — text AND images — never clobbering it. These tests drive the
 * production Enter/`handleQueueCommand` paths with a real CustomEditor.
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
import type { BlobPutResult } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getEditorTheme } from "@oh-my-pi/pi-tui/theme/tui-adapters";

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
	};
	const ctx = {
		editor: options.editor,
		session,
		viewSession: session,
		sessionManager,
		settings: Settings.isolated({}),
		keybindings: KeybindingsManager.inMemory(),
		ui: { requestRender: vi.fn() },
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
	return { ctx, session, showError };
}

describe("refused interactive submissions preserve a newer draft", () => {
	it("Enter /skill: refusal merges text and images ahead of a newer draft", async () => {
		const editor = new CustomEditor(getEditorTheme());
		const { commands } = await createSkillCommands();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { ctx, session, showError } = createContext({
			editor,
			skillCommands: commands,
			promptCustomMessage: (async () => {
				entered.resolve();
				await release.promise;
				throw new UserMessageRefusedError(NOTICE);
			}) as (message: unknown, opts: unknown) => Promise<boolean>,
			prompt: async () => true,
		});

		const invocation = `/skill:reviewer please use ${SECRET} [Image #1]`;
		editor.pendingImages.push(refusedImage);
		editor.pendingImageLinks.push(undefined);
		const submitting = ctx.editor.onSubmit?.(invocation);
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

	it("refused /queue follow-up merges text and images ahead of a newer draft", async () => {
		const editor = new CustomEditor(getEditorTheme());
		const { commands } = await createSkillCommands();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { ctx, session, showError } = createContext({
			editor,
			skillCommands: commands,
			promptCustomMessage: async () => true,
			prompt: async () => {
				entered.resolve();
				await release.promise;
				throw new UserMessageRefusedError(NOTICE);
			},
		});
		const controller = new InputController(ctx);

		editor.pendingImages.push(refusedImage);
		editor.pendingImageLinks.push(undefined);
		const submitted = `queued ${SECRET}`;
		const queueing = controller.handleQueueCommand(submitted);
		await entered.promise;
		// Typed after the queue submission detached the draft.
		editor.setText("newer draft");
		editor.pendingImages.push(newerImage);
		editor.pendingImageLinks.push(undefined);
		release.resolve();
		await queueing;

		expect(session.prompt).toHaveBeenCalledTimes(1);
		expect(showError).toHaveBeenCalledWith(NOTICE);
		const restored = editor.getExpandedText();
		expect(restored).toContain(submitted);
		expect(restored).toContain("newer draft");
		expect(editor.pendingImages).toEqual([newerImage, refusedImage]);
	});
});
