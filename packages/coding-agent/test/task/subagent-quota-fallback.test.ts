/**
 * A task subagent whose role model answers a usage-limit error (a
 * subscription-quota 429 with a multi-day retry-after, or a 402 billing cap)
 * must walk `retry.fallbackChains` exactly like the main loop: the next rung
 * answers and the task succeeds instead of exiting on the first error.
 */
import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, type MockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const MOCK_API_SOURCE = "test/subagent-quota-fallback";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
const QUOTA_429 = {
	message:
		"429 Subscription quota exhausted. Your usage window resets at 2026-10-19T00:00:00Z. retry-after-ms=310373000",
};
// An xAI-shaped 402 billing cap whose wording alone is not usage-limit text
// (no "exhausted"/"insufficient"), so only the HTTP 402 billing-cap arm
// (packages/ai/src/error/rate-limit.ts is402BillingCapBody) classifies it as
// a usage limit. Drop the status and it classifies as nothing.
const BILLING_CAP_402 = {
	status: 402,
	message: '{"code":"Payment Required","error":"Add credits at https://console.x.ai to continue."}',
};
// An informative non-quota 402: never a usage limit.
const SUBSCRIPTION_REQUIRED_402 = {
	status: 402,
	message: '{"code":"Forbidden","error":"A subscription is required for this endpoint."}',
};

let savedEnv: Record<string, string | undefined> = {};
let root: string;

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
		return;
	}
	process.env[key] = value;
	Bun.env[key] = value;
}

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-subagent-quota-"));
	const home = path.join(root, "home");
	await fs.mkdir(home, { recursive: true });
	restoreEnvValue("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	registerMockApi(MOCK_API_SOURCE);
});

afterEach(async () => {
	await AgentLifecycleManager.global().dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	AgentStorage.close();
	closeModelCache();
	await removeWithRetries(root);
});

const MUSE = "muse-code/muse-spark-1.3-contributor:medium";
const GLM = "zhipu-coding-plan/glm-5.3:high";
const GROK = "cursor/grok-4.7-medium:medium";
const OPUS = "anthropic/claude-opus-5-5:medium";

/**
 * Spawns a `task` subagent through the real executor and session on the
 * `task` role model, which answers every request with `error`. Mirrors
 * the reported config: the model's own chain names glm then grok, and the
 * `task` role chain (installed as the child's `subagent:<id>` chain) starts
 * with opus. `suppressed` selectors start on a sibling-recorded cooldown in
 * the shared registry, as when an earlier child's walk already found them
 * exhausted. `fallbackOn` is `retry.fallbackOn`; `"usage-limit"` makes the
 * walk depend on the error classifying as a usage limit.
 */
async function runQuotaExhaustedTaskSubagent(
	suppressed: readonly string[],
	error: { message: string; status?: number } = QUOTA_429,
	fallbackOn: "any" | "usage-limit" = "any",
) {
	const cwd = path.join(root, "home", "work");
	const artifactsDir = path.join(root, "artifacts");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(artifactsDir, { recursive: true });

	const authStorage = createInMemoryAuthStorage();
	const yieldOrAnswer =
		(data: string): MockModel["fallback"] =>
		context => {
			if (!(context.tools ?? []).some(tool => tool.name === "yield")) return { content: ["label"] };
			if (context.messages.at(-1)?.role === "toolResult") return { content: ["ok"] };
			return { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data } }] };
		};
	const muse = createMockModel({
		provider: "muse-code",
		id: "muse-spark-1.3-contributor",
		reasoning: true,
		handler: { stopReason: "error", errorMessage: error.message, errorStatus: error.status },
	});
	const glm = createMockModel({
		provider: "zhipu-coding-plan",
		id: "glm-5.3",
		reasoning: true,
		handler: yieldOrAnswer("answered by glm"),
	});
	const grok = createMockModel({
		provider: "cursor",
		id: "grok-4.7-medium",
		reasoning: true,
		handler: yieldOrAnswer("answered by grok"),
	});
	const opus = createMockModel({
		provider: "anthropic",
		id: "claude-opus-5-5",
		reasoning: true,
		handler: yieldOrAnswer("answered by opus"),
	});
	const mocks: Model<Api>[] = [muse, glm, grok, opus];
	for (const model of mocks) authStorage.keys.setRuntime(model.provider, "FAKE-SECRET-NOT-REAL");

	const modelRegistry = new ModelRegistry(authStorage);
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [...mocks, ...catalogAvailable(kind)]);
	const catalogAll = modelRegistry.getAll.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAll").mockImplementation(kind => [...mocks, ...catalogAll(kind)]);
	const catalogFind = modelRegistry.find.bind(modelRegistry);
	vi.spyOn(modelRegistry, "find").mockImplementation(
		(provider, id) =>
			mocks.find(model => model.provider === provider && model.id === id) ?? catalogFind(provider, id),
	);
	const cooldownUntil = Date.now() + 24 * 60 * 60 * 1000;
	for (const selector of suppressed) modelRegistry.suppressSelector(selector, cooldownUntil);

	try {
		const result = await runSubprocess({
			cwd,
			artifactsDir,
			agent: { name: "task", description: "test", systemPrompt: "test", tools: ["read"], source: "bundled" },
			task: "report",
			index: 0,
			id: "QuotaFallback",
			// What spawn hands the executor for `task.agentModelOverrides.task: "@task"`.
			modelOverride: [MUSE],
			modelRole: "task",
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"todo.enabled": false,
				"todo.reminders": false,
				"advisor.enabled": false,
				"retry.baseDelayMs": 1,
				"retry.fallbackOn": fallbackOn,
				modelRoles: { default: OPUS, task: MUSE },
				"retry.fallbackChains": {
					"muse-code/muse-spark-1.3-contributor": [GLM, GROK],
					task: [OPUS, GLM, MUSE, GROK],
				},
			}),
			enableLsp: false,
			enableMCP: false,
			enableIrc: false,
		});
		return { result, muse, glm, grok, opus };
	} finally {
		authStorage.close();
	}
}

it("walks the model's own chain when the task role model is quota-exhausted with a multi-day retry-after", async () => {
	const { result, muse, glm, opus } = await runQuotaExhaustedTaskSubagent([]);

	expect(muse.calls.length).toBeGreaterThan(0);
	expect(glm.calls.length).toBeGreaterThan(0);
	expect(opus.calls).toHaveLength(0);
	expect(result.exitCode).toBe(0);
	expect(result.output).toContain("answered by glm");
}, 20_000);

it("falls through to the subagent's role chain when every model-keyed rung is unusable", async () => {
	const { result, muse, glm, grok, opus } = await runQuotaExhaustedTaskSubagent([GLM, GROK]);

	expect(muse.calls.length).toBeGreaterThan(0);
	expect(glm.calls).toHaveLength(0);
	expect(grok.calls).toHaveLength(0);
	expect(opus.calls.length).toBeGreaterThan(0);
	expect(result.exitCode).toBe(0);
	expect(result.output).toContain("answered by opus");
}, 20_000);

// `retry.fallbackOn: usage-limit` admits only usage-limit errors to the walk,
// so the 402 status must classify the billing cap for the child to reach opus.
it("falls through to the subagent's role chain when the task role model dies on a 402 billing cap", async () => {
	const { result, muse, glm, grok, opus } = await runQuotaExhaustedTaskSubagent(
		[GLM, GROK],
		BILLING_CAP_402,
		"usage-limit",
	);

	expect(muse.calls.length).toBeGreaterThan(0);
	expect(glm.calls).toHaveLength(0);
	expect(grok.calls).toHaveLength(0);
	expect(opus.calls.length).toBeGreaterThan(0);
	expect(result.exitCode).toBe(0);
	expect(result.output).toContain("answered by opus");
}, 20_000);

it("does not walk to the role chain on a non-quota 402 when only usage limits fall back", async () => {
	const { result, opus } = await runQuotaExhaustedTaskSubagent([GLM, GROK], SUBSCRIPTION_REQUIRED_402, "usage-limit");

	expect(opus.calls).toHaveLength(0);
	expect(result.exitCode).not.toBe(0);
}, 20_000);
