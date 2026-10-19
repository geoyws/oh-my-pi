import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

// Real RPC dispatch, session queues and the before_user_message gate; only the
// model response is scripted. Messages starting with "refuse:" are refused with
// a safe notice (never echoing the text); anything else is admitted. The
// handler asserts the RPC ingress source so the test pins source threading.
const authStorage = await AuthStorage.create(path.join(process.cwd(), "auth.db"));
authStorage.keys.setRuntime("anthropic", "test-key");
const modelRegistry = new ModelRegistry(authStorage, path.join(process.cwd(), "models.yml"));
const sessionManager = SessionManager.inMemory(process.cwd());
const runtime = new ExtensionRuntime();
const extension = await loadExtensionFromFactory(
	pi => {
		pi.on("before_user_message", event => {
			if (event.source !== "rpc" && event.source !== "queued" && event.source !== "aside") {
				throw new Error(`unexpected before_user_message source ${event.source}`);
			}
			if (event.text.includes("FAKE-SECRET")) {
				return { refuse: true, notice: "RPC test refusal notice." };
			}
			return undefined;
		});
	},
	process.cwd(),
	new EventBus(),
	runtime,
	"refusal-hook",
);
const extensionRunner = new ExtensionRunner([extension], runtime, process.cwd(), sessionManager, modelRegistry);
const mock = createMockModel({ handler: { content: ["ok"] } });
const agent = new Agent({
	getApiKey: () => "test-key",
	initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
	streamFn: mock.stream,
});
const skillDir = path.join(path.dirname(import.meta.path), "refusal-skill");
const session = new AgentSession({
	agent,
	sessionManager,
	settings: Settings.isolated({ "compaction.enabled": false }),
	modelRegistry,
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
await runRpcMode(session);
