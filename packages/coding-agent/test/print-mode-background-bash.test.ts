/**
 * Print mode must not end a run while a bash call it started is still running
 * in the background (kb omp t-ace558ff). A call that outlives the
 * auto-background threshold moves to a background job; its result has to
 * reach the model as an async-result follow-up before print mode prints the
 * final message and disposes the session. Headless reviewers otherwise end on
 * "waiting for bg_N" and lose their verdict.
 */
import { afterEach, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Context } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { releaseShellSessions } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { runPrintMode } from "@oh-my-pi/pi-coding-agent/modes/print-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { TempDir } from "@oh-my-pi/pi-utils";

afterEach(() => {
	vi.restoreAllMocks();
	AsyncJobManager.resetForTests();
});

const MARKER = "bg-output-marker-7d1f";

function contextText(context: Context): string {
	return context.messages
		.flatMap(message => {
			if (typeof message.content === "string") return [message.content];
			return message.content.flatMap(part => (part.type === "text" ? [part.text] : []));
		})
		.join("\n");
}

it.skipIf(process.platform === "win32")(
	"delivers an auto-backgrounded bash result to the model before printing the final message",
	async () => {
		const dir = TempDir.createSync("@pi-print-background-bash-");
		const auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
		const output: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
			if (typeof args[0] === "string") output.push(args[0]);
			const callback = args.at(-1);
			if (typeof callback === "function") callback();
			return true;
		});
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		const model = createMockModel({
			responses: [
				{
					content: [{ type: "toolCall", name: "bash", arguments: { command: `sleep 1; echo ${MARKER}` } }],
				},
				// The model yields while the command runs in the background.
				{ content: ["Waiting for the background job to finish."] },
			],
			// The async-result follow-up turn: report whether the job output arrived.
			handler: context => ({ content: [contextText(context).includes(MARKER) ? "SAW OUTPUT" : "NO OUTPUT"] }),
		});
		auth.keys.setRuntime(model.provider, "test-key");

		const manager = new AsyncJobManager({});
		AsyncJobManager.setInstance(manager);
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"bashInterceptor.enabled": false,
			"bash.autoBackground.enabled": true,
			"bash.autoBackground.thresholdMs": 100,
		});
		const toolSession: ToolSession = {
			cwd: dir.path(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionId: () => dir.path(),
			getSessionSpawns: () => "*",
			getAgentId: () => "PrintMain",
			asyncJobManager: manager,
			settings,
		};
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [new BashTool(toolSession)], messages: [] },
				convertToLlm,
				streamFn: model.stream,
			}),
			sessionManager: SessionManager.inMemory(dir.path()),
			settings,
			modelRegistry: new ModelRegistry(auth, path.join(dir.path(), "models.yml")),
			agentId: "PrintMain",
			asyncJobManager: manager,
		});
		try {
			const code = await runPrintMode(session, { mode: "text", initialMessage: "Run the command and report it" });
			expect(code).toBe(0);
			expect(output.join("")).toBe("SAW OUTPUT\n");
			expect(model.calls).toHaveLength(3);
		} finally {
			await session.dispose();
			await manager.dispose();
			releaseShellSessions(dir.path());
			auth.close();
			await dir.remove();
		}
	},
	15_000,
);
