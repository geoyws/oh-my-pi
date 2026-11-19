/**
 * InteractiveMode plan review surfaces from line 6373: plan file reads, the
 * external editors, copy, save-and-quit, and the approval paths (execution-tier
 * model, autosave, dispatch). Reviews are opened through `handlePlanApproval`
 * with the overlay stubbed, or with the real overlay where its keys matter.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { setKeybindings } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import * as keybindingHints from "@oh-my-pi/pi-tui/chrome/keybinding-hints";
import type { PlanReviewOverlay } from "@oh-my-pi/pi-tui/overlays/plan-review-overlay";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import * as planAutosave from "@oh-my-pi/pi-coding-agent/plan-mode/plan-autosave";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as pathUtils from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import * as clipboard from "@oh-my-pi/pi-coding-agent/utils/clipboard";
import * as externalEditor from "@oh-my-pi/pi-coding-agent/utils/external-editor";
import { logger, TempDir } from "@oh-my-pi/pi-utils";

type ReviewOptions = NonNullable<Parameters<InteractiveMode["showPlanReview"]>[3]>;

describe("InteractiveMode plan review surfaces (lines 6373-7029)", () => {
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let tempDir: TempDir;
	let session: AgentSession;
	let mode: InteractiveMode;
	let warnings: string[];
	let statuses: string[];
	let errors: string[];

	function planPath(url: string): string {
		return resolveLocalUrlToPath(url, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
	}

	async function writePlan(url: string, content: string): Promise<void> {
		await Bun.write(planPath(url), content);
	}

	/** Open a review of `url` whose overlay answers `choice` (a label, or a pick by index into the labels). */
	async function review(
		url: string,
		choice: string | number | undefined,
		onOpen?: (options: ReviewOptions) => void | Promise<void>,
	): Promise<ReviewOptions> {
		let captured: ReviewOptions | undefined;
		spyOn(mode, "showPlanReview").mockImplementation(async (_content, _title, labels, options) => {
			captured = options;
			await onOpen?.(options ?? {});
			return typeof choice === "number" ? labels[choice] : choice;
		});
		await mode.handlePlanApproval({ planFilePath: url, title: "Ship", planExists: true });
		if (!captured) throw new Error("the review never opened");
		return captured;
	}

	/** Resolve once `ui.start()` runs: the external-editor flows restart the terminal last. */
	function terminalRestarted(): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		spyOn(mode.ui, "stop").mockImplementation(() => {});
		spyOn(mode.ui, "start").mockImplementation(() => resolve());
		return promise;
	}

	beforeAll(async () => {
		await initTheme();
		resetSettingsForTest();
		sharedDir = TempDir.createSync("@pi-im-r5601-review-shared-");
		await Settings.init({ inMemory: true, cwd: sharedDir.path() });
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-im-r5601-review-");
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		mode.planModeEnabled = true;
		warnings = [];
		statuses = [];
		errors = [];
		spyOn(mode, "showWarning").mockImplementation(message => void warnings.push(message));
		spyOn(mode, "showStatus").mockImplementation(message => void statuses.push(message));
		spyOn(mode, "showError").mockImplementation(message => void errors.push(message));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode.stop();
		await session.dispose();
		tempDir.removeSync();
		setKeybindings(KeybindingsManager.inMemory());
	});

	afterAll(() => {
		authStorage?.close();
		sharedDir?.removeSync();
		resetSettingsForTest();
	});

	describe("plan files", () => {
		it("surfaces a plan path that cannot be read as a file instead of treating it as missing", async () => {
			await fs.mkdir(planPath("local://dir-plan.md"), { recursive: true });
			const showReview = spyOn(mode, "showPlanReview");

			await expect(
				mode.handlePlanApproval({ planFilePath: "local://dir-plan.md", title: "Dir", planExists: true }),
			).rejects.toThrow();

			expect(errors).toEqual([]);
			expect(showReview).not.toHaveBeenCalled();
		});

		it.each([
			["the plan-mode file", "local://named.md"],
			["no recorded file, the session default", undefined],
		])("/plan asks before leaving a session whose only draft is another *-plan.md file (%s)", async (_label, url) => {
			mode.planModePlanFilePath = url;
			await writePlan("local://older-plan.md", "# Older\n");
			await writePlan("local://draft-plan.md", "# Draft\n\nsteps");
			await writePlan("local://notes.md", "# not a plan");
			const confirm = spyOn(mode, "showHookConfirm").mockResolvedValue(false);

			expect(await mode.handlePlanModeCommand()).toBe(false);

			expect(confirm).toHaveBeenCalledWith("Exit plan mode?", "This exits plan mode without approving a plan.");
			expect(mode.planModeEnabled).toBe(true);
		});

		it("still finds a *-plan.md draft whose modification time cannot be read", async () => {
			mode.planModePlanFilePath = "local://named.md";
			await writePlan("local://draft-plan.md", "# Draft\n\nsteps");
			spyOn(fs, "stat").mockRejectedValue(new Error("EACCES"));
			const confirm = spyOn(mode, "showHookConfirm").mockResolvedValue(false);

			expect(await mode.handlePlanModeCommand()).toBe(false);

			expect(confirm).toHaveBeenCalledTimes(1);
		});
	});

	describe("external plan editor", () => {
		const url = "local://edit-plan.md";

		beforeEach(async () => {
			await writePlan(url, "# Edit me\n");
			spyOn(externalEditor, "getEditorCommand").mockReturnValue("fake-editor");
		});

		async function openEditor(): Promise<void> {
			const restarted = terminalRestarted();
			const options = await review(url, undefined);
			options.onExternalEditor?.();
			await restarted;
		}

		it("writes the edited plan back and reports it", async () => {
			const open = spyOn(externalEditor, "openInEditor").mockResolvedValue("# Edited\n");

			await openEditor();

			expect(open).toHaveBeenCalledWith("fake-editor", "# Edit me\n", { extension: ".md", trimTrailingNewline: false });
			expect(await Bun.file(planPath(url)).text()).toBe("# Edited\n");
			expect(statuses).toEqual(["Plan updated in external editor."]);
		});

		it("leaves the plan alone when the editor is closed without saving", async () => {
			spyOn(externalEditor, "openInEditor").mockResolvedValue(null);

			await openEditor();

			expect(await Bun.file(planPath(url)).text()).toBe("# Edit me\n");
			expect(statuses).toEqual([]);
		});

		it("opens an extensionless plan as markdown", async () => {
			await writePlan("local://notes", "# Notes\n");
			const open = spyOn(externalEditor, "openInEditor").mockResolvedValue(null);
			const restarted = terminalRestarted();
			const options = await review("local://notes", undefined);
			options.onExternalEditor?.();
			await restarted;

			expect(open.mock.calls[0]?.[2]).toEqual({ extension: ".md", trimTrailingNewline: false });
		});

		it.each([
			["an Error", new Error("editor crashed"), "editor crashed"],
			["a non-Error", "editor gone", "editor gone"],
		])("warns and restarts the terminal when the editor fails with %s", async (_label, failure, detail) => {
			spyOn(externalEditor, "openInEditor").mockRejectedValue(failure);

			await openEditor();

			expect(warnings).toEqual([`Failed to open external editor: ${detail}`]);
		});

		it("reports a plan deleted while the review was open", async () => {
			const options = await review(url, undefined);
			await fs.rm(planPath(url));
			const open = spyOn(externalEditor, "openInEditor");

			options.onExternalEditor?.();
			await Bun.sleep(10);

			expect(errors).toEqual([`Plan file not found at ${url}`]);
			expect(open).not.toHaveBeenCalled();
		});

		it("warns when the plan path stopped being a readable file", async () => {
			const options = await review(url, undefined);
			await fs.rm(planPath(url));
			await fs.mkdir(planPath(url));
			const open = spyOn(externalEditor, "openInEditor");

			options.onExternalEditor?.();
			await Bun.sleep(10);

			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toStartWith("Failed to open external editor: ");
			expect(open).not.toHaveBeenCalled();
		});

		it("warns with the raw value when reading the plan fails with a non-Error", async () => {
			const options = await review(url, undefined);
			const realFile = Bun.file;
			spyOn(Bun, "file").mockImplementation(((target: string) =>
				target === planPath(url)
					? ({ text: () => Promise.reject("locked by another process") } as unknown as ReturnType<typeof realFile>)
					: realFile(target)) as typeof Bun.file);

			options.onExternalEditor?.();
			await Bun.sleep(10);

			expect(warnings).toEqual(["Failed to open external editor: locked by another process"]);
		});
	});

	describe("real review overlay", () => {
		let overlay: PlanReviewOverlay | undefined;

		beforeEach(() => {
			overlay = undefined;
			spyOn(mode.ui, "showOverlay").mockImplementation(component => {
				overlay = component as PlanReviewOverlay;
				return { hide: vi.fn() } as never;
			});
		});

		function open(): PlanReviewOverlay {
			void mode.showPlanReview("# Plan\n\nIntro\n\n## Rollout\n\nSteps\n", "Plan mode - next step", [
				"Approve and execute",
				"Refine plan",
			]);
			if (!overlay) throw new Error("the overlay was not shown");
			return overlay;
		}

		it.each([
			["an Error", new Error("no display"), "no display"],
			["a non-Error", "pbcopy missing", "pbcopy missing"],
		])("warns when copying the plan fails with %s", async (_label, failure, detail) => {
			spyOn(clipboard, "copyToClipboard").mockRejectedValue(failure);

			open().handleInput("c");
			await Bun.sleep(0);

			expect(warnings).toEqual([`Failed to copy plan to clipboard: ${detail}`]);
		});

		it("shows no editor hint when no external-editor key is bound", () => {
			const bound = KeybindingsManager.inMemory({ "app.editor.external": "ctrl+e" });
			mode.keybindings = bound;
			setKeybindings(bound);
			expect(open().render(120).join("\n")).toContain("editor");

			spyOn(keybindingHints, "appKey").mockReturnValue("");
			const unbound = open().render(120).join("\n");

			expect(unbound).not.toContain(" editor");
		});

		describe("annotation external editor", () => {
			beforeEach(() => {
				const keybindings = KeybindingsManager.inMemory({
					"app.editor.external": "ctrl+e",
					"tui.select.cancel": "ctrl+g",
				});
				mode.keybindings = keybindings;
				setKeybindings(keybindings);
			});

			/** Start an annotation on the Rollout section and press the external-editor key. */
			function annotateInEditor(view: PlanReviewOverlay): void {
				view.render(80);
				view.handleInput("\t");
				view.handleInput("a");
				for (const ch of "draft") view.handleInput(ch);
				view.handleInput("\x05");
			}

			it("warns when no editor is configured", async () => {
				spyOn(externalEditor, "getEditorCommand").mockReturnValue(undefined);
				const editor = spyOn(externalEditor, "openInEditor");

				annotateInEditor(open());
				await Bun.sleep(0);

				expect(warnings).toEqual(["No editor configured. Set $VISUAL or $EDITOR environment variable."]);
				expect(editor).not.toHaveBeenCalled();
			});

			it("keeps the typed draft when the editor is closed without saving", async () => {
				spyOn(externalEditor, "getEditorCommand").mockReturnValue("fake-editor");
				const open_ = spyOn(externalEditor, "openInEditor").mockResolvedValue(null);
				const restarted = terminalRestarted();
				const view = open();

				annotateInEditor(view);
				await restarted;

				expect(open_).toHaveBeenCalledWith("fake-editor", "draft", { extension: ".md" });
				expect(view.render(80).join("\n")).toContain("draft");
			});

			it.each([
				["an Error", new Error("editor crashed"), "editor crashed"],
				["a non-Error", "editor gone", "editor gone"],
			])("warns and restarts the terminal when the editor fails with %s", async (_label, failure, detail) => {
				spyOn(externalEditor, "getEditorCommand").mockReturnValue("fake-editor");
				spyOn(externalEditor, "openInEditor").mockRejectedValue(failure);
				const restarted = terminalRestarted();

				annotateInEditor(open());
				await restarted;

				expect(warnings).toEqual([`Failed to open external editor: ${detail}`]);
			});
		});
	});

	describe("save and quit", () => {
		const url = "local://save-plan.md";

		/** Answer the save-path prompt through the real overlay: Enter takes the suggested name. */
		function acceptSuggestedPath(): void {
			spyOn(mode, "showHookCustom").mockImplementation(async factory => {
				let result: unknown;
				const view = factory(mode.ui, undefined as never, undefined as never, value => {
					result = value;
				}) as { handleInput(data: string): void };
				view.handleInput("\r");
				return result as never;
			});
		}

		it("saves under the suggested name, leaves plan mode and starts a new session", async () => {
			await writePlan(url, "# Ship\n\nsteps");
			spyOn(session, "generateTitle").mockResolvedValue(undefined as never);
			acceptSuggestedPath();
			const clear = spyOn(mode, "handleClearCommand").mockResolvedValue(undefined as never);

			await review(url, "Save and quit");

			const saved = path.join(tempDir.path(), planAutosave.planSaveFileName("Ship"));
			expect(await Bun.file(saved).text()).toBe("# Ship\n\nsteps");
			expect(mode.planModeEnabled).toBe(false);
			expect(clear).toHaveBeenCalledTimes(1);
			expect(statuses.at(-1)).toStartWith("Saved plan to ");
		});

		it("does not ask the model for a file name when the plan has no text", async () => {
			await writePlan(url, "  \n\n");
			const title = spyOn(session, "generateTitle");
			spyOn(mode, "showHookCustom").mockResolvedValue(undefined as never);

			await review(url, "Save and quit");

			expect(title).not.toHaveBeenCalled();
		});

		it.each([
			["an Error", new Error("model offline"), "model offline"],
			["a non-Error", "quota", "quota"],
		])("logs a failed file-name suggestion (%s) and still asks for the path", async (_label, failure, detail) => {
			await writePlan(url, "# Ship\n\nsteps");
			spyOn(session, "generateTitle").mockRejectedValue(failure);
			const debug = spyOn(logger, "debug");
			const prompt = spyOn(mode, "showHookCustom").mockResolvedValue(undefined as never);

			await review(url, "Save and quit");
			await Bun.sleep(0);

			expect(prompt).toHaveBeenCalledTimes(1);
			expect(debug).toHaveBeenCalledWith("plan-save: filename generation failed", { error: detail });
		});

		it("does nothing when the path prompt is dismissed", async () => {
			await writePlan(url, "# Ship\n\nsteps");
			spyOn(session, "generateTitle").mockResolvedValue(undefined as never);
			spyOn(mode, "showHookCustom").mockResolvedValue(undefined as never);
			const clear = spyOn(mode, "handleClearCommand");

			await review(url, "Save and quit");

			expect(mode.planModeEnabled).toBe(true);
			expect(clear).not.toHaveBeenCalled();
			expect(errors).toEqual([]);
		});

		describe("failures after a path was chosen", () => {
			beforeEach(async () => {
				await writePlan(url, "# Ship\n\nsteps");
				spyOn(session, "generateTitle").mockResolvedValue(undefined as never);
				acceptSuggestedPath();
			});

			it.each([
				["an Error", new Error("outside the workspace"), "outside the workspace"],
				["a non-Error", "bad path", "bad path"],
			])("reports a path that cannot be resolved (%s)", async (_label, failure, detail) => {
				spyOn(pathUtils, "resolveToCwd").mockImplementation(() => {
					throw failure;
				});

				await review(url, "Save and quit");

				expect(errors).toEqual([`Invalid plan save path: ${detail}`]);
				expect(mode.planModeEnabled).toBe(true);
			});

			it.each([
				["an Error", new Error("disk full"), "disk full"],
				["a non-Error", "read-only", "read-only"],
			])("reports a plan that could not be written (%s) and stays in plan mode", async (_label, failure, detail) => {
				spyOn(Bun, "write").mockRejectedValue(failure);

				await review(url, "Save and quit");

				expect(errors).toHaveLength(1);
				expect(errors[0]).toStartWith("Failed to save plan to ");
				expect(errors[0]).toEndWith(`: ${detail}`);
				expect(mode.planModeEnabled).toBe(true);
			});

			it.each([
				["an Error", new Error("tools locked"), "tools locked"],
				["a non-Error", "state locked", "state locked"],
			])("reports a saved plan whose plan mode could not be left (%s)", async (_label, failure, detail) => {
				spyOn(session, "setPlanModeState").mockImplementation(() => {
					throw failure;
				});
				const clear = spyOn(mode, "handleClearCommand");

				await review(url, "Save and quit");

				expect(errors).toHaveLength(1);
				expect(errors[0]).toMatch(/^Saved plan to .+, but could not exit plan mode: /);
				expect(errors[0]).toEndWith(detail);
				expect(clear).not.toHaveBeenCalled();
			});

			it.each([
				["an Error", new Error("store closed"), "store closed"],
				["a non-Error", "session locked", "session locked"],
			])("reports a saved plan whose new session could not start (%s)", async (_label, failure, detail) => {
				spyOn(mode, "handleClearCommand").mockRejectedValue(failure);

				await review(url, "Save and quit");

				expect(mode.planModeEnabled).toBe(false);
				expect(errors).toHaveLength(1);
				expect(errors[0]).toMatch(/^Saved plan to .+, but could not start a new session: /);
				expect(errors[0]).toEndWith(detail);
			});
		});
	});

	describe("approval", () => {
		const url = "local://approve-plan.md";
		const tier = (role: string, id: string): { role: string; model: Model } => ({
			role,
			model: { id, name: "", provider: "test" } as unknown as Model,
		});

		let autosave: ReturnType<typeof spyOn<typeof planAutosave, "autosaveApprovedPlan">>;

		beforeEach(async () => {
			await writePlan(url, "# Approve\n\nsteps");
			autosave = spyOn(planAutosave, "autosaveApprovedPlan").mockResolvedValue(null);
		});

		it("restores the live non-MCP tools with read forced on when plan mode kept no snapshot", async () => {
			spyOn(session, "getEnabledToolNames").mockReturnValue(["grep", "mcp__srv__lookup"]);
			spyOn(session, "getMountedXdevToolNames").mockReturnValue(["xd_search", "mcp__srv__mounted"]);
			const restore = spyOn(session, "restoreNonMCPToolPresentation").mockResolvedValue(undefined as never);
			spyOn(session, "prompt").mockResolvedValue(true);

			await review(url, 2);

			expect(restore.mock.calls.at(-1)?.slice(0, 2)).toEqual([["grep", "read"], ["xd_search"]]);
		});

		it("carries the approved plan into the new session when local files live under the temp root", async () => {
			spyOn(session.sessionManager, "getArtifactsDir").mockReturnValue(null as never);
			await writePlan(url, "# Approve\n\nsteps");
			const oldPath = planPath(url);
			spyOn(session, "prompt").mockResolvedValue(true);

			try {
				await review(url, "Approve and execute");

				const newPath = planPath(url);
				expect(newPath).not.toBe(oldPath);
				expect(newPath).toContain(session.sessionManager.getSessionId());
				expect(await Bun.file(newPath).text()).toBe("# Approve\n\nsteps");
			} finally {
				await fs.rm(path.dirname(oldPath), { recursive: true, force: true });
				await fs.rm(path.dirname(planPath(url)), { recursive: true, force: true });
			}
		});

		it("warns about a failed autosave with its detail on one line, then still executes", async () => {
			autosave.mockRejectedValue("disk full\nretry later");
			const prompt = spyOn(session, "prompt").mockResolvedValue(true);

			await review(url, 2);

			expect(warnings).toEqual(["Failed to autosave plan: disk full retry later"]);
			expect(prompt).toHaveBeenCalledTimes(1);
		});

		it("reports an execution prompt failure other than a busy agent without queueing a follow-up", async () => {
			spyOn(session, "prompt").mockRejectedValue(new Error("provider down"));
			const followUp = spyOn(session, "followUp");

			await review(url, 2);

			expect(errors).toEqual(["Failed to finalize approved plan: provider down"]);
			expect(followUp).not.toHaveBeenCalled();
		});

		it("sizes the keep-context option without a context window when the model reports none", async () => {
			const model = session.model;
			Object.defineProperty(session, "model", {
				configurable: true,
				get: () => ({ ...model, contextWindow: undefined }),
			});
			const usage = spyOn(session, "getContextUsage").mockReturnValue(undefined);

			await review(url, undefined);

			expect(usage).toHaveBeenCalledWith();
		});

		describe("execution tier", () => {
			beforeEach(async () => {
				// A real entry records the pre-plan model, which the tier is compared against.
				mode.planModeEnabled = false;
				spyOn(session, "resolveRoleModelWithThinking").mockReturnValue({
					model: session.model,
					thinkingLevel: undefined,
					explicitThinkingLevel: false,
					warning: undefined,
				} as never);
				spyOn(session, "sendPlanModeContext").mockResolvedValue(undefined);
				await mode.handlePlanModeCommand();
				expect(mode.planModeEnabled).toBe(true);
				spyOn(session, "getRoleModelCycle").mockReturnValue({
					models: [tier("default", "m-default"), tier("slow", "m-slow")],
					currentIndex: 0,
				} as never);
				spyOn(session, "prompt").mockResolvedValue(true);
				spyOn(mode, "handleCompactCommand").mockImplementation(async (_a, _b, beforeFlush) => {
					await beforeFlush?.("ok");
					return "ok";
				});
				statuses.length = 0;
			});

			it("continues a compacted approval on the selected tier, naming an unnamed model by id", async () => {
				const apply = spyOn(session, "applyRoleModel").mockResolvedValue(undefined as never);

				await review(url, "Approve and compact context");

				expect(apply.mock.calls[0]?.[0]).toMatchObject({ role: "default" });
				expect(statuses).toContain("Continuing with default: m-default");
			});

			it.each([
				["an Error", new Error("no credentials"), "no credentials"],
				["a non-Error", "rate limited", "rate limited"],
			])("warns when the selected tier cannot be applied (%s)", async (_label, failure, detail) => {
				spyOn(session, "applyRoleModel").mockRejectedValue(failure);

				await review(url, "Approve and compact context");

				expect(warnings).toContain(`Could not switch to the default model: ${detail}`);
			});
		});
	});
});
