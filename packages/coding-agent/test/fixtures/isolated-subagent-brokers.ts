/**
 * Real omp process for `task/isolated-subagent-broker-release.test.ts`.
 *
 * Runs N isolated subagents concurrently: real rcopy workspaces, real
 * AgentSessions, only the model is scripted. Each subagent reads `proc://`,
 * which leases its workspace's project daemon broker (spawning a real
 * `__omp_worker_daemon_broker` child of this process) and subscribes the
 * session to service completions. Every subagent then waits on a gate until
 * the test writes to stdin, so the test can count all N brokers while they are
 * in use. The process stays alive after the subagents end, like a long-lived
 * parent session, until stdin closes.
 *
 * argv: <root> <count>. `HOME` must point inside <root>. Events are JSON lines on stdout.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { prepareIsolationContext, runIsolatedSubprocess } from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import * as natives from "@oh-my-pi/pi-natives";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const [root, countArg] = process.argv.slice(2);
const count = Number(countArg);
if (!root || !Number.isInteger(count) || count < 1) {
	throw new Error("isolated-subagent-brokers: expected <root> <count>");
}

function emit(event: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(event)}\n`);
}

// Under HOME so project discovery stops at the fake home instead of the real one.
const repo = path.join(root, "home", "repo");
await fs.mkdir(repo, { recursive: true });
await Bun.write(path.join(repo, "README.md"), "fixture\n");
for (const args of [
	["init", "-q"],
	["add", "README.md"],
	["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"],
]) {
	const git = Bun.spawnSync(["git", ...args], { cwd: repo, stderr: "pipe" });
	if (git.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${git.stderr.toString()}`);
}
const artifactsDir = path.join(root, "artifacts");
await fs.mkdir(artifactsDir, { recursive: true });

const gate = Promise.withResolvers<void>();
const stdinClosed = (async () => {
	for await (const _chunk of Bun.stdin.stream()) gate.resolve();
	gate.resolve();
})();

registerMockApi("test/isolated-subagent-brokers");
const authStorage = createInMemoryAuthStorage();
authStorage.keys.setRuntime("mock", "test-key");
const modelRegistry = new ModelRegistry(authStorage);
let waiting = 0;
const mock = createMockModel({
	handler: async context => {
		const results = context.messages.filter(message => message.role === "toolResult");
		const read = results.find(message => message.toolName === "read");
		if (!read) return { content: [{ type: "toolCall", name: "read", arguments: { path: "proc://" } }] };
		if (results.some(message => message.toolName === "yield")) return { content: ["done"] };
		emit({ event: "read", isError: read.isError });
		if (++waiting === count) emit({ event: "subagents-waiting" });
		await gate.promise;
		return { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: "done" } }] };
	},
});
const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
modelRegistry.getAvailable = kind => [mock, ...catalogAvailable(kind)];

const context = await prepareIsolationContext(repo);
emit({ event: "ready", pid: process.pid });

const results = await Promise.all(
	Array.from({ length: count }, (_, index) => {
		const id = `BrokerScope${index}`;
		const failure = (error: unknown): SingleResult => ({
			index,
			id,
			agent: "task",
			agentSource: "bundled",
			task: "list processes",
			exitCode: 1,
			output: "",
			stderr: "",
			truncated: false,
			durationMs: 0,
			tokens: 0,
			requests: 0,
			error: error instanceof Error ? error.message : String(error),
		});
		return runIsolatedSubprocess({
			baseOptions: {
				cwd: repo,
				artifactsDir,
				agent: { name: "task", description: "test", systemPrompt: "test", tools: ["read"], source: "bundled" },
				task: "list processes",
				index,
				id,
				modelOverride: "mock/mock-model",
				authStorage,
				modelRegistry,
				settings: Settings.isolated({
					"async.enabled": false,
					"compaction.enabled": false,
					"retry.enabled": false,
					"todo.enabled": false,
					"todo.reminders": false,
					"advisor.enabled": false,
					modelRoles: { default: "mock/mock-model" },
				}),
				keepAlive: false,
				enableLsp: false,
				enableMCP: false,
				enableIrc: false,
			},
			context,
			preferredBackend: natives.IsoBackendKind.Rcopy,
			agentId: id,
			mergeMode: "patch",
			artifactsDir,
			buildFailureResult: failure,
		}).catch(failure);
	}),
);
emit({
	event: "subagents-ended",
	results: results.map(result => ({ id: result.id, exitCode: result.exitCode, error: result.error })),
});

await stdinClosed;
process.exit(0);
