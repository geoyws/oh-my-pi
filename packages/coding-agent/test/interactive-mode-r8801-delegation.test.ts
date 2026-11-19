/**
 * InteractiveMode's public surface from line 8801 to the end of the file is a
 * facade: slash commands, selectors, key handlers and extension UI hooks all
 * route to one owned controller. These tests pin that routing contract — the
 * mode's own controller instance receives the caller's exact arguments and the
 * caller gets the controller's result back — so a refactor that drops an
 * argument, swaps a target or swallows a result fails here.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { BtwController } from "@oh-my-pi/pi-coding-agent/modes/controllers/btw-controller";
import { CleanseCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/cleanse-command-controller";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { OmfgController } from "@oh-my-pi/pi-coding-agent/modes/controllers/omfg-controller";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { TanCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/tan-command-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

type AnyMethod = (...args: unknown[]) => unknown;
type Proto = Record<string, AnyMethod>;

interface Route {
	/** InteractiveMode method under test. */
	method: string;
	/** Controller class whose prototype owns the target. */
	target: { prototype: object };
	/** Target method name on that controller. */
	via: string;
	/** Arguments the caller passes. */
	args: unknown[];
	/** Arguments the controller must receive (defaults to `args`). */
	expected?: unknown[];
	/** `sync` returns the controller result as-is; `async` resolves to it; `void` discards it. */
	result: "sync" | "async" | "void";
}

const msg = { role: "assistant", content: [{ type: "text", text: "hi" }] };
const reports = [{ provider: "anthropic" }];
const model = { provider: "anthropic", id: "claude-sonnet-4-5" };
const images = [{ type: "image", data: "AA==", mimeType: "image/png" }];
const factory = () => ({ render: () => [], invalidate() {} });

const ROUTES: Route[] = [
	// Transcript helpers
	{
		method: "showNewVersionNotification",
		target: UiHelpers,
		via: "showNewVersionNotification",
		args: ["99.0.0"],
		result: "void",
	},
	{ method: "clearEditor", target: UiHelpers, via: "clearEditor", args: [], result: "void" },
	{
		method: "flushPendingBashComponents",
		target: UiHelpers,
		via: "flushPendingBashComponents",
		args: [],
		result: "void",
	},
	{
		method: "truncateTranscriptFromMessage",
		target: UiHelpers,
		via: "truncateTranscriptFromMessage",
		args: [msg],
		result: "sync",
	},
	{ method: "findLastAssistantMessage", target: UiHelpers, via: "findLastAssistantMessage", args: [], result: "sync" },
	{ method: "extractAssistantText", target: UiHelpers, via: "extractAssistantText", args: [msg], result: "sync" },
	// Slash commands
	{
		method: "handleExportCommand",
		target: CommandController,
		via: "handleExportCommand",
		args: ["/export out.html"],
		result: "sync",
	},
	{ method: "handleTraceCommand", target: CommandController, via: "handleTraceCommand", args: [], result: "sync" },
	{ method: "handleDumpCommand", target: CommandController, via: "handleDumpCommand", args: [], result: "async" },
	{
		method: "handleDumpAllCommand",
		target: CommandController,
		via: "handleDumpAllCommand",
		args: [],
		result: "async",
	},
	{
		method: "handleDumpAnonCommand",
		target: CommandController,
		via: "handleDumpAnonCommand",
		args: [],
		result: "async",
	},
	{
		method: "handleAdvisorDumpCommand",
		target: CommandController,
		via: "handleAdvisorDumpCommand",
		args: [true],
		result: "sync",
	},
	{
		method: "handleDebugTranscriptCommand",
		target: CommandController,
		via: "handleDebugTranscriptCommand",
		args: [],
		result: "sync",
	},
	{ method: "handleShareCommand", target: CommandController, via: "handleShareCommand", args: [], result: "sync" },
	{ method: "handleSessionCommand", target: CommandController, via: "handleSessionCommand", args: [], result: "sync" },
	{
		method: "handleAdvisorStatusCommand",
		target: CommandController,
		via: "handleAdvisorStatusCommand",
		args: [],
		result: "sync",
	},
	{
		method: "handleJobsCommand",
		target: CommandController,
		via: "handleJobsCommand",
		args: [{ full: true }],
		result: "sync",
	},
	{
		method: "handleUsageCommand",
		target: CommandController,
		via: "handleUsageCommand",
		args: [reports],
		result: "sync",
	},
	{
		method: "handleChangelogCommand",
		target: CommandController,
		via: "handleChangelogCommand",
		args: ["full"],
		result: "void",
	},
	{
		method: "handleChangelogCommand",
		target: CommandController,
		via: "handleChangelogCommand",
		args: [],
		expected: [""],
		result: "void",
	},
	{ method: "handleHotkeysCommand", target: CommandController, via: "handleHotkeysCommand", args: [], result: "void" },
	{ method: "handleToolsCommand", target: CommandController, via: "handleToolsCommand", args: [], result: "void" },
	{ method: "handleContextCommand", target: CommandController, via: "handleContextCommand", args: [], result: "void" },
	{ method: "handleFreshCommand", target: CommandController, via: "handleFreshCommand", args: [], result: "sync" },
	{
		method: "handleResetContextCommand",
		target: CommandController,
		via: "handleResetContextCommand",
		args: [],
		result: "sync",
	},
	{
		method: "handleRenameCommand",
		target: CommandController,
		via: "handleRenameCommand",
		args: ["New title"],
		result: "sync",
	},
	{
		method: "handleMemoryCommand",
		target: CommandController,
		via: "handleMemoryCommand",
		args: ["/memory stats"],
		result: "sync",
	},
	{
		method: "handleBashCommand",
		target: CommandController,
		via: "handleBashCommand",
		args: ["ls", true],
		result: "sync",
	},
	{
		method: "handlePythonCommand",
		target: CommandController,
		via: "handlePythonCommand",
		args: ["1+1", false],
		result: "sync",
	},
	{
		method: "handleHandoffCommand",
		target: CommandController,
		via: "handleHandoffCommand",
		args: ["focus on tests"],
		result: "sync",
	},
	{
		method: "handleShakeCommand",
		target: CommandController,
		via: "handleShakeCommand",
		args: ["light"],
		result: "sync",
	},
	{
		method: "executeCompaction",
		target: CommandController,
		via: "executeCompaction",
		args: ["keep api notes", true],
		result: "sync",
	},
	{
		method: "openInBrowser",
		target: CommandController,
		via: "openInBrowser",
		args: ["https://example.com"],
		result: "void",
	},
	{
		method: "showCommandReport",
		target: CommandController,
		via: "showCommandReport",
		args: [{ title: "Report", body: factory() }],
		result: "void",
	},
	{ method: "dismissCommandReport", target: CommandController, via: "dismissCommandReport", args: [], result: "sync" },
	// Selectors
	{ method: "showDebugSelector", target: SelectorController, via: "showDebugSelector", args: [], result: "void" },
	{
		method: "showSettingsSelector",
		target: SelectorController,
		via: "showSettingsSelector",
		args: [],
		result: "void",
	},
	{
		method: "showUsageDashboard",
		target: SelectorController,
		via: "showUsageDashboard",
		args: [reports],
		result: "void",
	},
	{
		method: "showAdvisorConfigure",
		target: SelectorController,
		via: "showAdvisorConfigure",
		args: [],
		result: "void",
	},
	{ method: "showHistorySearch", target: SelectorController, via: "showHistorySearch", args: [], result: "void" },
	{
		method: "showExtensionsDashboard",
		target: SelectorController,
		via: "showExtensionsDashboard",
		args: [],
		result: "void",
	},
	{ method: "showAgentsDashboard", target: SelectorController, via: "showAgentsDashboard", args: [], result: "void" },
	{ method: "showGitUi", target: SelectorController, via: "showGitTui", args: ["HEAD~1"], result: "void" },
	{
		method: "switchSessionModel",
		target: SelectorController,
		via: "switchSessionModel",
		args: [model, "high"],
		result: "sync",
	},
	{
		method: "showPluginSelector",
		target: SelectorController,
		via: "showPluginSelector",
		args: ["install"],
		result: "void",
	},
	{
		method: "showUserMessageSelector",
		target: SelectorController,
		via: "showUserMessageSelector",
		args: [],
		result: "void",
	},
	{ method: "showCopySelector", target: SelectorController, via: "showCopySelector", args: [], result: "void" },
	{ method: "showTreeSelector", target: SelectorController, via: "showTreeSelector", args: [], result: "void" },
	{
		method: "showThinkingSelector",
		target: SelectorController,
		via: "showThinkingSelector",
		args: [],
		result: "void",
	},
	{
		method: "showSessionSelector",
		target: SelectorController,
		via: "showSessionSelector",
		args: ["claude", factory],
		result: "void",
	},
	{
		method: "handleResumeSession",
		target: SelectorController,
		via: "handleResumeSession",
		args: ["/tmp/s.jsonl", { fork: true }],
		result: "void",
	},
	{
		method: "handleSessionDeleteCommand",
		target: SelectorController,
		via: "handleSessionDeleteCommand",
		args: [],
		result: "sync",
	},
	{
		method: "showOAuthSelector",
		target: SelectorController,
		via: "showOAuthSelector",
		args: ["login", "anthropic"],
		result: "sync",
	},
	{
		method: "showSessionPinSelector",
		target: SelectorController,
		via: "showSessionPinSelector",
		args: [],
		result: "sync",
	},
	{
		method: "showResetUsageSelector",
		target: SelectorController,
		via: "showResetUsageSelector",
		args: [],
		result: "sync",
	},
	// Keys and input
	{ method: "handleCtrlD", target: InputController, via: "handleCtrlD", args: [], result: "void" },
	{ method: "handleCtrlZ", target: InputController, via: "handleCtrlZ", args: [], result: "void" },
	{ method: "handleDequeue", target: InputController, via: "handleDequeue", args: [], result: "void" },
	{ method: "handleImagePaste", target: InputController, via: "handleImagePaste", args: [], result: "sync" },
	{
		method: "handleImagePathPaste",
		target: InputController,
		via: "handleImagePathPaste",
		args: ["/tmp/a.png"],
		result: "sync",
	},
	{
		method: "handleQueueCommand",
		target: InputController,
		via: "handleQueueCommand",
		args: ["/compact", { text: "/compact" }],
		result: "sync",
	},
	{ method: "cycleThinkingLevel", target: InputController, via: "cycleThinkingLevel", args: [], result: "void" },
	{
		method: "toggleToolOutputExpansion",
		target: InputController,
		via: "toggleToolOutputExpansion",
		args: [],
		result: "void",
	},
	{ method: "setToolsExpanded", target: InputController, via: "setToolsExpanded", args: [true], result: "void" },
	{
		method: "toggleThinkingBlockVisibility",
		target: InputController,
		via: "toggleThinkingBlockVisibility",
		args: [],
		result: "void",
	},
	{ method: "openExternalEditor", target: InputController, via: "openExternalEditor", args: [], result: "void" },
	{
		method: "registerExtensionShortcuts",
		target: InputController,
		via: "registerExtensionShortcuts",
		args: [],
		result: "void",
	},
	// Side conversations
	{ method: "withBtwSessionMove", target: BtwController, via: "withSessionMove", args: [factory], result: "sync" },
	{ method: "handleBtwCommand", target: BtwController, via: "start", args: ["why?", images, "Why"], result: "sync" },
	{ method: "hasActiveBtw", target: BtwController, via: "hasActiveRequest", args: [], result: "sync" },
	{ method: "handleBtwEscape", target: BtwController, via: "handleEscape", args: [], result: "sync" },
	{ method: "canBranchBtw", target: BtwController, via: "canBranch", args: [], result: "sync" },
	{ method: "handlesBtwBranchKey", target: BtwController, via: "handlesBranchKey", args: [], result: "sync" },
	{ method: "handleBtwBranchKey", target: BtwController, via: "handleBranch", args: [], result: "sync" },
	{ method: "canCopyBtw", target: BtwController, via: "canCopy", args: [], result: "sync" },
	{ method: "handleBtwCopyKey", target: BtwController, via: "handleCopy", args: [], result: "sync" },
	{ method: "canFollowUpBtw", target: BtwController, via: "canFollowUp", args: [], result: "sync" },
	{ method: "handleBtwFollowUpKey", target: BtwController, via: "handleFollowUp", args: [], result: "sync" },
	{
		method: "handleTanCommand",
		target: TanCommandController,
		via: "start",
		args: ["refactor x", images],
		result: "sync",
	},
	{ method: "handleOmfgCommand", target: OmfgController, via: "start", args: ["it broke"], result: "sync" },
	{ method: "hasActiveOmfg", target: OmfgController, via: "hasActiveRequest", args: [], result: "sync" },
	{ method: "handleOmfgEscape", target: OmfgController, via: "handleEscape", args: [], result: "sync" },
	{ method: "handleCleanseCommand", target: CleanseCommandController, via: "start", args: ["--dry"], result: "sync" },
	{ method: "hasActiveCleanse", target: CleanseCommandController, via: "hasActiveRun", args: [], result: "sync" },
	{ method: "handleCleanseEscape", target: CleanseCommandController, via: "handleEscape", args: [], result: "sync" },
	// Extension UI
	{
		method: "showHookConfirm",
		target: ExtensionUiController,
		via: "showHookConfirm",
		args: ["Title", "Body", { timeout: 5 }],
		result: "sync",
	},
	{ method: "getToolUIContext", target: ExtensionUiController, via: "getToolUIContext", args: [], result: "sync" },
	{
		method: "emitCustomToolSessionEvent",
		target: ExtensionUiController,
		via: "emitCustomToolSessionEvent",
		args: ["switch", "/tmp/prev.jsonl"],
		result: "sync",
	},
	{
		method: "setHookWidget",
		target: ExtensionUiController,
		via: "setHookWidget",
		args: ["k", ["line"], { placement: "aboveEditor" }],
		result: "void",
	},
	{
		method: "setHookStatus",
		target: ExtensionUiController,
		via: "setHookStatus",
		args: ["k", "busy"],
		result: "void",
	},
	{
		method: "showHookSelector",
		target: ExtensionUiController,
		via: "showHookSelector",
		args: ["Pick", [{ label: "a", value: "a" }], { timeout: 5 }, {}],
		result: "sync",
	},
	{ method: "hideHookSelector", target: ExtensionUiController, via: "hideHookSelector", args: [], result: "void" },
	{
		method: "showHookInput",
		target: ExtensionUiController,
		via: "showHookInput",
		args: ["Name", "type here"],
		result: "sync",
	},
	{ method: "hideHookInput", target: ExtensionUiController, via: "hideHookInput", args: [], result: "void" },
	{
		method: "showHookEditor",
		target: ExtensionUiController,
		via: "showHookEditor",
		args: ["Edit", "prefill", {}, { promptStyle: true }],
		result: "sync",
	},
	{ method: "hideHookEditor", target: ExtensionUiController, via: "hideHookEditor", args: [], result: "void" },
	{
		method: "showHookNotify",
		target: ExtensionUiController,
		via: "showHookNotify",
		args: ["done", "warning"],
		result: "void",
	},
	{
		method: "showHookCustom",
		target: ExtensionUiController,
		via: "showHookCustom",
		args: [factory, { overlay: true }],
		result: "sync",
	},
	{
		method: "showExtensionError",
		target: ExtensionUiController,
		via: "showExtensionError",
		args: ["/ext/a.ts", "boom"],
		result: "void",
	},
	{
		method: "showToolError",
		target: ExtensionUiController,
		via: "showToolError",
		args: ["bash", "boom"],
		result: "void",
	},
];

describe("InteractiveMode facade routing (lines 8801-end)", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(async () => {
		await initTheme();
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-im-r8801-delegation-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, new EventBus());
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	for (const route of ROUTES) {
		const expected = route.expected ?? route.args;
		it(`${route.method}(${route.args.length} args) -> ${route.via}`, async () => {
			const sentinel = { route: route.method };
			let receiver: unknown;
			const spy = spyOn(route.target.prototype as Proto, route.via).mockImplementation(function (this: unknown) {
				receiver = this;
				return route.result === "async" ? Promise.resolve(sentinel) : sentinel;
			});

			// Route-table dispatch by method name; every name is a public InteractiveMode method.
			const facade: Proto = mode as unknown as Proto;
			const returned = facade[route.method](...route.args);

			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy.mock.calls[0]).toEqual(expected);
			// The mode's own controller handled it, not a stray instance.
			expect(receiver).toBeInstanceOf(route.target as unknown as new (...a: never[]) => unknown);
			if (route.result === "sync") expect(returned).toBe(sentinel);
			else if (route.result === "async") expect(await returned).toBe(sentinel);
			else expect(await returned).toBeUndefined();
		});
	}

	it("showAgentHub hands the selector the mode's observer registry and the caller's options", () => {
		const spy = spyOn(SelectorController.prototype, "showAgentHub").mockImplementation(() => {});
		const options = { initialAgentId: "a1" } as unknown as Parameters<InteractiveMode["showAgentHub"]>[0];

		mode.showAgentHub(options);

		expect(spy).toHaveBeenCalledTimes(1);
		const [registry, passed] = spy.mock.calls[0] as unknown[];
		expect(passed).toBe(options);
		// The registry the hub reads is the mode's live one: it can be reset per session.
		expect(registry && typeof registry === "object" && "resetSessions" in registry).toBe(true);
	});
});
