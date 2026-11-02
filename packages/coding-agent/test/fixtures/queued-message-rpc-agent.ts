import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
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
// Only the first provider response is held; later prompts answer normally.
// Each held stream emits output before injecting or claiming steering, so an
// immediate pre-output steer cannot cancel/reissue the response under test.
const script = Bun.env.QUEUED_RPC_SCRIPT;
const mock = createMockModel({
	responses: [{ content: ["Started"] }],
	handler: { content: ["Handled queued request"] },
});
let firstCallPending = true;
const agent = new Agent({
	getApiKey: () => "test-key",
	initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
	streamFn: async (model, context, options): Promise<AssistantMessageEventStream> => {
		const first = firstCallPending;
		firstCallPending = false;
		if (!first || !script) return mock.stream(model, context, options);
		const signal = options?.signal;
		if (!signal) throw new Error("Queued-message fixture requires an abort signal");
		// This mock response is immediate: never await a held result before emitting output.
		const message = await mock.stream(model, context, options).result();
		const stream = new AssistantMessageEventStream();
		const afterOutput = async () => {
			if (script === "internal-steer") {
				await session.sendCustomMessage(
					{ customType: "test-internal-steer", content: "internal steer", display: true, attribution: "agent" },
					{ deliverAs: "steer" },
				);
			} else if (script === "live-steer" || script === "until-steer") {
				const live = options?.liveSteering;
				if (!live) throw new Error("Queued-message fixture requires a live steering channel");
				await live.wait(signal);
				if (signal.aborted) return;
				if (script === "live-steer") {
					(await live.claim(signal))?.accept();
				} else {
					signal.removeEventListener("abort", abort);
					stream.push({ type: "text_end", contentIndex: 0, content: "Started", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				}
			}
		};
		const unsubscribe = session.subscribe(event => {
			if (event.type !== "message_update" || event.assistantMessageEvent.type !== "text_delta") return;
			unsubscribe();
			// The run loop has consumed visible provider output before steering changes.
			void afterOutput().catch(error => {
				if (signal.aborted) return;
				signal.removeEventListener("abort", abort);
				stream.push({
					type: "error",
					reason: "error",
					error: { ...message, stopReason: "error", errorMessage: String(error) },
				});
			});
		});
		const abort = () => {
			unsubscribe();
			stream.push({ type: "error", reason: "aborted", error: { ...message, stopReason: "aborted" } });
		};
		if (signal.aborted) abort();
		else {
			signal.addEventListener("abort", abort, { once: true });
			stream.push({ type: "start", partial: message });
			stream.push({ type: "text_start", contentIndex: 0, partial: message });
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
