import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import {
	ExtensionRunner,
	EXTENSION_HANDLER_TIMEOUT_MS,
	testSetExtensionHandlerTimeoutMs,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	BeforeUserMessageEvent,
	ExtensionAPI,
	ExtensionFactory,
	UserMessageSource,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import {
	AgentSession,
	UserMessageRefusedError,
	type AgentSessionEvent,
} from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm, SKILL_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { submitInteractiveInput } from "@oh-my-pi/pi-coding-agent/main";
import { tryRunRpcSkillCommand } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { restoreRefusedDraft } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/draft";
import type { DroppedPrompt } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { getEditorTheme } from "@oh-my-pi/pi-tui/theme/tui-adapters";

const SECRET = "token FAKE-SECRET-NOT-REAL-0000";
const NOTICE = "Blocked: this message looks like it contains a secret. It was not sent or saved.";
const FALLBACK_NOTICE = "An extension refused to send this message.";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

/** Late-registration API captured by the delivery-recheck test's factory. */
const lateApi: { current: Pick<ExtensionAPI, "on"> | undefined } = { current: undefined };

function lateApiCurrent(): Pick<ExtensionAPI, "on"> | undefined {
	return lateApi.current;
}

interface RefusalHarness {
	session: AgentSession;
	sessionManager: SessionManager;
	authStorage: AuthStorage;
	seenSources: UserMessageSource[];
	notices: string[];
	streamCalls: number;
	contexts: Context[];
	toolEntered: Promise<void> | undefined;
	releaseTool: (() => void) | undefined;
	skillDir: string | undefined;
	dispose: () => Promise<void>;
}

async function createHarness(options?: {
	factory?: ExtensionFactory;
	withSlowTool?: boolean;
	withSkill?: boolean;
}): Promise<RefusalHarness> {
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.keys.setRuntime("openai", "openai-test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const sessionManager = SessionManager.inMemory();
	const runtime = new ExtensionRuntime();
	const seenSources: UserMessageSource[] = [];
	const extension = await loadExtensionFromFactory(
		options?.factory ??
			(pi => {
				pi.on("before_user_message", (event: BeforeUserMessageEvent) => {
					seenSources.push(event.source);
					if (event.text.includes("FAKE-SECRET")) return { refuse: true, notice: NOTICE };
					return undefined;
				});
			}),
		process.cwd(),
		new EventBus(),
		runtime,
		"refusal-test",
	);
	const extensionRunner = new ExtensionRunner([extension], runtime, process.cwd(), sessionManager, modelRegistry);
	const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;

	let streamCalls = 0;
	const contexts: Context[] = [];
	const toolGate = Promise.withResolvers<void>();
	const toolRelease = Promise.withResolvers<void>();
	const slowTool: AgentTool = {
		name: "slow",
		label: "Slow",
		description: "Blocks until released",
		parameters: type({}),
		execute: async () => {
			toolGate.resolve();
			await toolRelease.promise;
			return { content: [{ type: "text", text: "SLOW_DONE" }] };
		},
	};
	const tools = options?.withSlowTool === true ? [slowTool] : [];
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools, messages: [] },
		convertToLlm,
		streamFn: (_model, context) => {
			contexts.push(context);
			const call = streamCalls++;
			const isToolCall = options?.withSlowTool === true && call === 0;
			const message: AssistantMessage = isToolCall
				? {
						role: "assistant",
						content: [{ type: "toolCall", id: "tc-0", name: "slow", arguments: {} }],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: zeroUsage,
						stopReason: "toolUse",
						timestamp: Date.now(),
					}
				: {
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
				stream.push({ type: "done", reason: isToolCall ? "toolUse" : "stop", message });
			});
			return stream;
		},
	});
	const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
	settings.setModelRole("default", `${model.provider}/${model.id}`);
	const skillDir =
		options?.withSkill === true ? await fs.mkdtemp(path.join(os.tmpdir(), "omp-refusal-skill-")) : undefined;
	if (skillDir) {
		await Bun.write(
			path.join(skillDir, "SKILL.md"),
			"---\nname: reviewer\ndescription: Review code\n---\n\nReview the supplied code carefully.\n",
		);
	}
	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
		extensionRunner,
		...(skillDir
			? {
					skills: [
						{
							name: "reviewer",
							description: "Review code",
							filePath: path.join(skillDir, "SKILL.md"),
							baseDir: skillDir,
							source: "project",
						},
					],
					skillsSettings: { enableSkillCommands: true },
				}
			: {}),
	});
	const notices: string[] = [];
	const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "notice") notices.push(event.message);
	});
	return {
		session,
		sessionManager,
		authStorage,
		seenSources,
		notices,
		get streamCalls() {
			return streamCalls;
		},
		contexts,
		toolEntered: options?.withSlowTool === true ? toolGate.promise : undefined,
		releaseTool: options?.withSlowTool === true ? () => toolRelease.resolve() : undefined,
		skillDir,
		dispose: async () => {
			unsubscribe();
			toolRelease.resolve();
			await session.dispose();
			authStorage.close();
			if (skillDir) await fs.rm(skillDir, { recursive: true, force: true });
		},
	};
}

/** Places the fake secret must never appear after a refusal. */
function leakedEverywhere(harness: RefusalHarness, marker: string): string[] {
	const leaks: string[] = [];
	if (JSON.stringify(harness.sessionManager.getEntries()).includes(marker)) leaks.push("jsonl");
	if (JSON.stringify(harness.session.agent.state.messages).includes(marker)) leaks.push("state");
	if (JSON.stringify(harness.contexts).includes(marker)) leaks.push("provider-context");
	if (harness.notices.some(notice => notice.includes(marker))) leaks.push("notice");
	return leaks;
}

describe("before_user_message refusal", () => {
	let harness: RefusalHarness | undefined;

	afterEach(async () => {
		vi.restoreAllMocks();
		await harness?.dispose();
		harness = undefined;
	});

	it("refused prompt is never sent, never persisted, and surfaces only the notice", async () => {
		harness = await createHarness();
		const entriesBefore = structuredClone(harness.sessionManager.getEntries());
		const error = await harness.session.prompt(`please use ${SECRET}`, { source: "interactive" }).then(
			() => null,
			(error: unknown) => error,
		);
		expect(error).toBeInstanceOf(UserMessageRefusedError);
		expect((error as UserMessageRefusedError).message).toBe(NOTICE);
		expect((error as UserMessageRefusedError).notice).toBe(NOTICE);
		expect(harness.streamCalls).toBe(0);
		expect(harness.sessionManager.getEntries()).toEqual(entriesBefore);
		expect(leakedEverywhere(harness, "FAKE-SECRET")).toEqual([]);
		expect(harness.seenSources).toEqual(["interactive"]);
	});

	it("clean prompt sends normally", async () => {
		harness = await createHarness();
		expect(await harness.session.prompt("hello clean", { source: "interactive" })).toBe(true);
		expect(harness.streamCalls).toBe(1);
		expect(JSON.stringify(harness.sessionManager.getEntries())).toContain("hello clean");
	});

	it("refused steer, followUp and sendUserMessage never reach the queue", async () => {
		harness = await createHarness();
		const entriesBefore = structuredClone(harness.sessionManager.getEntries());
		await expect(
			harness.session.followUp(`later ${SECRET}`, undefined, { source: "interactive" }),
		).rejects.toBeInstanceOf(UserMessageRefusedError);
		await expect(harness.session.steer(`now ${SECRET}`, undefined, { source: "interactive" })).rejects.toBeInstanceOf(
			UserMessageRefusedError,
		);
		await expect(harness.session.sendUserMessage(`programmatic ${SECRET}`)).rejects.toBeInstanceOf(
			UserMessageRefusedError,
		);
		await expect(
			harness.session.sendUserMessage(`queued ${SECRET}`, { deliverAs: "followUp" }),
		).rejects.toBeInstanceOf(UserMessageRefusedError);
		expect(harness.streamCalls).toBe(0);
		expect(harness.sessionManager.getEntries()).toEqual(entriesBefore);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		expect(leakedEverywhere(harness, "FAKE-SECRET")).toEqual([]);
	});

	it("first refusal wins; later handlers are skipped", async () => {
		const secondCalled: string[] = [];
		harness = await createHarness({
			factory: pi => {
				pi.on("before_user_message", () => ({ refuse: true, notice: "first notice" }));
				pi.on("before_user_message", event => {
					secondCalled.push(event.text);
					return { refuse: true, notice: "second notice" };
				});
			},
		});
		const error = await harness.session.prompt("anything", { source: "interactive" }).then(
			() => null,
			(error: unknown) => error,
		);
		expect(error).toBeInstanceOf(UserMessageRefusedError);
		expect((error as UserMessageRefusedError).message).toBe("first notice");
		expect(secondCalled).toEqual([]);
		expect(harness.streamCalls).toBe(0);
	});

	it("throwing handler refuses fail-closed with the fallback notice", async () => {
		harness = await createHarness({
			factory: pi => {
				pi.on("before_user_message", () => {
					throw new Error("scanner exploded");
				});
			},
		});
		const entriesBefore = structuredClone(harness.sessionManager.getEntries());
		const error = await harness.session.prompt(`please use ${SECRET}`, { source: "interactive" }).then(
			() => null,
			(error: unknown) => error,
		);
		expect(error).toBeInstanceOf(UserMessageRefusedError);
		expect((error as UserMessageRefusedError).message).toBe(FALLBACK_NOTICE);
		expect(harness.streamCalls).toBe(0);
		expect(harness.sessionManager.getEntries()).toEqual(entriesBefore);
		expect(leakedEverywhere(harness, "FAKE-SECRET")).toEqual([]);
	});

	it("timed-out handler refuses fail-closed", async () => {
		testSetExtensionHandlerTimeoutMs(50);
		try {
			harness = await createHarness({
				factory: pi => {
					pi.on("before_user_message", async () => {
						await Promise.withResolvers<undefined>().promise;
						return undefined;
					});
				},
			});
			const error = await harness.session.prompt("hello?", { source: "interactive" }).then(
				() => null,
				(error: unknown) => error,
			);
			expect(error).toBeInstanceOf(UserMessageRefusedError);
			expect((error as UserMessageRefusedError).message).toBe(FALLBACK_NOTICE);
			expect(harness.streamCalls).toBe(0);
		} finally {
			testSetExtensionHandlerTimeoutMs(EXTENSION_HANDLER_TIMEOUT_MS);
		}
	});

	it("messages queued before registration face the delivery recheck", async () => {
		lateApi.current = undefined;
		harness = await createHarness({
			factory: pi => {
				lateApi.current = pi;
			},
			withSlowTool: true,
		});
		const run = harness.session.prompt("first");
		await harness.toolEntered;
		// No handlers yet: all three enqueue without a submission-time gate.
		await harness.session.prompt(`follow-up ${SECRET} follow`, { streamingBehavior: "followUp" });
		await harness.session.steer(`steered ${SECRET} steer`);
		await harness.session.sendUserMessage(`aside ${SECRET} aside`, { deliverAs: "aside" });
		// Late registration, then let the run drain.
		lateApiCurrent()?.on("before_user_message", (event: BeforeUserMessageEvent) => {
			if (event.text.includes("FAKE-SECRET")) return { refuse: true, notice: NOTICE };
			return undefined;
		});
		harness.releaseTool?.();
		await run;
		await harness.session.waitForIdle();
		expect(leakedEverywhere(harness, "FAKE-SECRET")).toEqual([]);
		expect(harness.notices.filter(notice => notice === NOTICE)).toHaveLength(3);
		// The clean first turn still completed.
		expect(JSON.stringify(harness.contexts).includes("first")).toBe(true);
	});

	it("acp source: refused at the session layer, clean sends", async () => {
		harness = await createHarness();
		await expect(harness.session.prompt(`acp ${SECRET}`, { source: "acp" })).rejects.toBeInstanceOf(
			UserMessageRefusedError,
		);
		expect(harness.streamCalls).toBe(0);
		expect(leakedEverywhere(harness, "FAKE-SECRET")).toEqual([]);
		expect(harness.seenSources).toEqual(["acp"]);
		expect(await harness.session.prompt("acp clean", { source: "acp" })).toBe(true);
		expect(harness.streamCalls).toBe(1);
	});

	it("print source: refused at the session layer, clean sends", async () => {
		harness = await createHarness();
		await expect(harness.session.prompt(`print ${SECRET}`, { source: "print" })).rejects.toBeInstanceOf(
			UserMessageRefusedError,
		);
		expect(harness.streamCalls).toBe(0);
		expect(leakedEverywhere(harness, "FAKE-SECRET")).toEqual([]);
		expect(harness.seenSources).toEqual(["print"]);
		expect(await harness.session.prompt("print clean", { source: "print" })).toBe(true);
		expect(harness.streamCalls).toBe(1);
	});

	it("refused user skill expansion is never persisted or sent", async () => {
		harness = await createHarness({ withSkill: true });
		const entriesBefore = structuredClone(harness.sessionManager.getEntries());
		const error = await harness.session
			.promptCustomMessage(
				{
					customType: SKILL_PROMPT_MESSAGE_TYPE,
					content: `Review the supplied code carefully.\n\n${SECRET}`,
					display: true,
					details: { name: "reviewer", path: "reviewer/SKILL.md", args: `please use ${SECRET}` },
					attribution: "user",
				},
				{ streamingBehavior: "steer", source: "interactive" },
			)
			.then(
				() => null,
				(error: unknown) => error,
			);
		expect(error).toBeInstanceOf(UserMessageRefusedError);
		expect((error as UserMessageRefusedError).message).toBe(NOTICE);
		expect(harness.streamCalls).toBe(0);
		expect(harness.sessionManager.getEntries()).toEqual(entriesBefore);
		expect(leakedEverywhere(harness, "FAKE-SECRET")).toEqual([]);
	});

	it("refuses on the raw invocation even when the rendered text is clean", async () => {
		harness = await createHarness({ withSkill: true });
		const entriesBefore = structuredClone(harness.sessionManager.getEntries());
		await expect(
			harness.session.promptCustomMessage(
				{
					customType: SKILL_PROMPT_MESSAGE_TYPE,
					content: "Review the supplied code carefully.",
					display: true,
					details: { name: "reviewer", path: "reviewer/SKILL.md", args: `please use ${SECRET}` },
					attribution: "user",
				},
				{ streamingBehavior: "steer", source: "interactive" },
			),
		).rejects.toBeInstanceOf(UserMessageRefusedError);
		expect(harness.streamCalls).toBe(0);
		expect(harness.sessionManager.getEntries()).toEqual(entriesBefore);
		expect(leakedEverywhere(harness, "FAKE-SECRET")).toEqual([]);
	});

	it("clean user skill expansion sends normally", async () => {
		harness = await createHarness({ withSkill: true });
		expect(
			await harness.session.promptCustomMessage(
				{
					customType: SKILL_PROMPT_MESSAGE_TYPE,
					content: "Review the supplied code carefully.",
					display: true,
					details: { name: "reviewer", path: "reviewer/SKILL.md", args: "clean request" },
					attribution: "user",
				},
				{ streamingBehavior: "steer", source: "interactive" },
			),
		).toBe(true);
		expect(harness.streamCalls).toBe(1);
	});

	it("interactive /skill: refusal hands the raw invocation back for editing", async () => {
		harness = await createHarness({ withSkill: true });
		const skillDir = harness.skillDir;
		if (!skillDir) throw new Error("Expected skill directory");
		const editor = new CustomEditor(getEditorTheme());
		const skill: Skill = {
			name: "reviewer",
			description: "Review code",
			filePath: path.join(skillDir, "SKILL.md"),
			baseDir: skillDir,
			source: "project",
		};
		const showError = vi.fn();
		const restoreRefusedPrompt = vi.fn((prompt: DroppedPrompt) =>
			restoreRefusedDraft(editor, prompt.text, prompt.images, prompt.imageLinks),
		);
		const entriesBefore = structuredClone(harness.sessionManager.getEntries());
		await submitInteractiveInput(
			{
				markPendingSubmissionStarted: () => true,
				finishPendingSubmission: () => {},
				showError,
				checkShutdownRequested: async () => {},
				skillCommands: new Map([["skill:reviewer", skill]]),
				optimisticSkillMessagePending: false,
				renderOptimisticSkillMessage: () => {},
				clearOptimisticSkillMessage: () => {},
				restoreRefusedPrompt,
			},
			harness.session,
			{
				text: `/skill:reviewer please use ${SECRET}`,
				images: undefined,
				imageLinks: undefined,
				cancelled: false,
				started: true,
			},
		);
		expect(restoreRefusedPrompt).toHaveBeenCalledWith({
			text: `/skill:reviewer please use ${SECRET}`,
			images: undefined,
			imageLinks: undefined,
		});
		expect(editor.getExpandedText()).toBe(`/skill:reviewer please use ${SECRET}`);
		expect(showError).toHaveBeenCalledWith(NOTICE);
		expect(harness.streamCalls).toBe(0);
		expect(harness.sessionManager.getEntries()).toEqual(entriesBefore);
		expect(leakedEverywhere(harness, "FAKE-SECRET")).toEqual([]);
	});

	it("RPC /skill: refusal rejects with only the notice", async () => {
		harness = await createHarness({ withSkill: true });
		const entriesBefore = structuredClone(harness.sessionManager.getEntries());
		const error = await tryRunRpcSkillCommand(harness.session, `/skill:reviewer please use ${SECRET}`).then(
			() => null,
			(error: unknown) => error,
		);
		expect(error).toBeInstanceOf(UserMessageRefusedError);
		expect((error as UserMessageRefusedError).message).toBe(NOTICE);
		expect(harness.streamCalls).toBe(0);
		expect(harness.sessionManager.getEntries()).toEqual(entriesBefore);
		expect(leakedEverywhere(harness, "FAKE-SECRET")).toEqual([]);
		expect(harness.seenSources).toContain("rpc");
	});
});
