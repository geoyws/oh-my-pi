import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockHandler, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

// Real RPC dispatch and session queues; only the external model response is scripted.
const authStorage = await AuthStorage.create(path.join(process.cwd(), "auth.db"));
authStorage.keys.setRuntime("anthropic", "test-key");
const modelRegistry = new ModelRegistry(authStorage, path.join(process.cwd(), "models.yml"));
// The first turn stays in flight long enough for a test to send a second prompt
// while streaming and promote it — the delay dwarfs a local RPC round trip.
const started: MockResponse = { content: ["Started"], delayMs: 1000 };
// QUEUED_RPC_SCRIPT varies only the first model call:
// - "internal-steer": queues a non-user steer after consumed provider output, then holds until abort.
// - "live-steer": the provider claims the first user steer into the streaming response,
//   as a live-steering provider (Codex `response.steer`) does.
// - "hold": streams until aborted, for tests whose queueing outlasts the default delay.
const firstCall: Record<string, MockHandler> = {
	hold: { content: ["Started"], delayMs: 60_000 },
	"internal-steer": { content: ["Started"] },
	"live-steer": async (_context, options) => {
		const live = options?.liveSteering;
		const signal = options?.signal;
		if (live && signal) {
			await live.wait(signal);
			(await live.claim(signal))?.accept();
		}
		return started;
	},
};
const mock = createMockModel({
	responses: [firstCall[Bun.env.QUEUED_RPC_SCRIPT ?? ""] ?? started],
	handler: { content: ["Handled queued request"] },
});
let internalSteerPending = Bun.env.QUEUED_RPC_SCRIPT === "internal-steer";
const agent = new Agent({
	getApiKey: () => "test-key",
	initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
	streamFn: async (model, context, options): Promise<AssistantMessageEventStream> => {
		if (!internalSteerPending) return mock.stream(model, context, options);
		internalSteerPending = false;
		const signal = options?.signal;
		if (!signal) throw new Error("Internal-steer fixture requires an abort signal");
		const message = await mock.stream(model, context, options).result();
		const stream = new AssistantMessageEventStream();
		const unsubscribe = session.subscribe(event => {
			if (event.type !== "message_update" || event.assistantMessageEvent.type !== "text_delta") return;
			unsubscribe();
			// A queued immediate steer may cancel/reissue a response with no consumed output.
			void session.sendCustomMessage(
				{ customType: "test-internal-steer", content: "internal steer", display: true, attribution: "agent" },
				{ deliverAs: "steer" },
			);
		});
		const abort = () => {
			unsubscribe();
			stream.push({ type: "error", reason: "aborted", error: { ...message, stopReason: "aborted" } });
		};
		if (signal.aborted) abort();
		else {
			signal.addEventListener("abort", abort, { once: true });
			stream.push({ type: "start", partial: message });
			stream.push({ type: "text_delta", contentIndex: 0, delta: "Started", partial: message });
		}
		return stream;
	},
});
const session = new AgentSession({
	agent,
	sessionManager: SessionManager.inMemory(process.cwd()),
	settings: Settings.isolated({ "compaction.enabled": false }),
	modelRegistry,
});
await runRpcMode(session);
