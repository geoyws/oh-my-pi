// Integration test with real timers (ts-no-test-timers exception): agent-core polls the
// steering queue on a wall-clock cadence while an interruptible tool runs, and that poll
// is the path under test. The wait's own first progress update marks it as blocking.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WaitTool } from "@oh-my-pi/pi-coding-agent/tools/wait";
import { TempDir } from "@oh-my-pi/pi-utils";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

describe("wait on a running background job", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-wait-steer-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("openai", "openai-test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage.close();
		tempDir.removeSync();
		AsyncJobManager.resetForTests();
	});

	it.each(["immediate", "wait"] as const)(
		"a steer queued while waiting wakes the wait and reaches the next model turn (interruptMode %s)",
		async interruptMode => {
			const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
			const contexts: Context[] = [];
			const nextCall = Promise.withResolvers<void>();
			const waitBlocking = Promise.withResolvers<void>();
			const job = Promise.withResolvers<string>();
			const manager = new AsyncJobManager({});
			const settings = Settings.isolated({
				"compaction.enabled": false,
				"todo.enabled": false,
				"launch.enabled": false,
				interruptMode,
			});
			settings.setModelRole("default", `${model.provider}/${model.id}`);
			const wait = new WaitTool({
				cwd: tempDir.path(),
				settings,
				asyncJobManager: manager,
				getAgentId: () => "Main",
			} as ToolSession);
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [wait], messages: [] },
				convertToLlm,
				streamFn: (_model, context) => {
					contexts.push(context);
					const first = contexts.length === 1;
					if (contexts.length === 2) nextCall.resolve();
					const message: AssistantMessage = {
						role: "assistant",
						content: first
							? [{ type: "toolCall", id: "wait-1", name: "wait", arguments: {} }]
							: [{ type: "text", text: "Acknowledged." }],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: zeroUsage,
						stopReason: first ? "toolUse" : "stop",
						timestamp: Date.now(),
					};
					const stream = new AssistantMessageEventStream();
					queueMicrotask(() => {
						stream.push({ type: "start", partial: message });
						stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
					});
					return stream;
				},
			});
			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(tempDir.path()),
				settings,
				modelRegistry: new ModelRegistry(authStorage),
				toolRegistry: new Map([[wait.name, wait as unknown as AgentTool]]),
				agentId: "Main",
				asyncJobManager: manager,
			});
			session.subscribe(event => {
				if (event.type === "tool_execution_update" && event.toolName === "wait") waitBlocking.resolve();
			});
			manager.register("bash", "watcher", () => job.promise, { ownerId: "Main" });
			const run = session.prompt("go");
			try {
				await waitBlocking.promise;
				expect(contexts).toHaveLength(1);
				// The interactive editor's Enter-while-streaming path. A steer left queued behind the
				// wait never reaches a second model call, so the test times out instead.
				await session.prompt("STEER_DURING_WAIT", { streamingBehavior: "steer", source: "interactive" });
				await nextCall.promise;
				expect(JSON.stringify(contexts[1]?.messages)).toContain("STEER_DURING_WAIT");
				expect(JSON.stringify(contexts[1]?.messages)).toContain("Wait interrupted by message.");
				expect(manager.getRunningJobs({ ownerId: "Main" })).toHaveLength(1);
			} finally {
				job.resolve("WATCHER_DONE");
				await run;
				await session.settleAsyncWork();
			}
		},
		5_000,
	);
});
