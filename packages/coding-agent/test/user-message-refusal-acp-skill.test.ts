import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { BeforeUserMessageEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AcpAgent } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-agent";
import { AgentSession, UserMessageRefusedError } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { AgentSideConnection } from "@oh-my-pi/pi-utils/acp";

const SECRET = "token FAKE-SECRET-NOT-REAL-0000";
const NOTICE = "Blocked: this message looks like it contains a secret. It was not sent or saved.";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

interface AcpSkillHarness {
	session: AgentSession;
	sessionManager: SessionManager;
	authStorage: AuthStorage;
	skillDir: string;
	streamCalls: number;
	contexts: Context[];
	dispose: () => Promise<void>;
}

async function createSession(): Promise<AcpSkillHarness> {
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.keys.setRuntime("openai", "openai-test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const sessionManager = SessionManager.inMemory();
	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		pi => {
			pi.on("before_user_message", (event: BeforeUserMessageEvent) => {
				if (event.text.includes("FAKE-SECRET")) return { refuse: true, notice: NOTICE };
				return undefined;
			});
		},
		process.cwd(),
		new EventBus(),
		runtime,
		"acp-skill-refusal",
	);
	const extensionRunner = new ExtensionRunner([extension], runtime, process.cwd(), sessionManager, modelRegistry);
	const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
	let streamCalls = 0;
	const contexts: Context[] = [];
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		convertToLlm,
		streamFn: (_model, context) => {
			contexts.push(context);
			streamCalls++;
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
	const skillDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-acp-skill-"));
	await Bun.write(
		path.join(skillDir, "SKILL.md"),
		"---\nname: reviewer\ndescription: Review code\n---\n\nReview the supplied code carefully.\n",
	);
	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
		toolRegistry: new Map<string, AgentTool>(),
		extensionRunner,
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
	});
	return {
		session,
		sessionManager,
		authStorage,
		skillDir,
		get streamCalls() {
			return streamCalls;
		},
		contexts,
		dispose: async () => {
			await session.dispose();
			authStorage.close();
			await fs.rm(skillDir, { recursive: true, force: true });
		},
	};
}

describe("ACP /skill: refusal", () => {
	let initial: AcpSkillHarness | undefined;
	let factorySession: AcpSkillHarness | undefined;
	let cwd: string | undefined;

	afterEach(async () => {
		vi.restoreAllMocks();
		await initial?.dispose();
		await factorySession?.dispose();
		if (cwd) await fs.rm(cwd, { recursive: true, force: true });
		initial = undefined;
		factorySession = undefined;
		cwd = undefined;
	});

	it("refused /skill: fails with only the notice and is never persisted", async () => {
		initial = await createSession();
		factorySession = await createSession();
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-acp-skill-cwd-"));
		const connection = {
			sessionUpdate: async () => {},
			signal: new AbortController().signal,
			closed: Promise.withResolvers<void>().promise,
		} as unknown as AgentSideConnection;
		const agent = new AcpAgent(
			connection,
			async () => ({ session: factorySession!.session, setToolUIContext: () => {} }),
			initial.session,
		);
		const { sessionId } = await agent.newSession({ cwd, mcpServers: [] });
		const entriesBefore = structuredClone(factorySession.sessionManager.getEntries());
		const error = await agent
			.prompt({ sessionId, prompt: [{ type: "text", text: `/skill:reviewer please use ${SECRET}` }] })
			.then(
				() => null,
				(error: unknown) => error,
			);
		expect(error).toBeInstanceOf(UserMessageRefusedError);
		expect((error as Error).message).toBe(NOTICE);
		expect(factorySession.streamCalls).toBe(0);
		expect(factorySession.sessionManager.getEntries()).toEqual(entriesBefore);
		expect(JSON.stringify(factorySession.sessionManager.getEntries())).not.toContain("FAKE-SECRET");
		expect(JSON.stringify(factorySession.session.agent.state.messages)).not.toContain("FAKE-SECRET");
		expect(JSON.stringify(factorySession.contexts)).not.toContain("FAKE-SECRET");
	});
});
