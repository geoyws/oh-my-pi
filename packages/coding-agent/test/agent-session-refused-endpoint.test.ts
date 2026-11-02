import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";

// The two shapes a refused model endpoint reaches the session in: Bun's raw
// fetch rejection (openai-compatible transports) and the rewritten sentence
// AnthropicConnectionError / networkFailureMessage produce.
const REFUSED_ERRORS = [
	"ECONNREFUSED: Unable to connect. Is the computer able to access the url?",
	"Couldn't connect to api.anthropic.com (connection refused). Check that the server is running and reachable.",
];

/**
 * Contract: a session created with `failFastOnRefusedEndpoint` (the CLI sets it
 * for `omp -p`) ends the turn on a refused model-endpoint connection instead
 * of scheduling automatic retries; every retry would re-run the transport's
 * own retry ladder against an endpoint that is not answering (an egress
 * sandbox denying the host, or no server listening), so `omp -p` hung for
 * minutes. Sessions without the flag keep retrying as before.
 */
describe("AgentSession refused-endpoint fail-fast", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-refused-endpoint-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	function createSession(errorMessage: string, failFastOnRefusedEndpoint: boolean) {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const mock = createMockModel({ handler: () => ({ throw: errorMessage }) });
		const requests: string[] = [];
		const agent = new Agent({
			getApiKey: () => "anthropic-test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, options) => {
				requests.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.maxRetries": 3,
			"retry.baseDelayMs": 5,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const created = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			failFastOnRefusedEndpoint,
		});
		const retryStarts: AgentSessionEvent[] = [];
		created.subscribe(event => {
			if (event.type === "auto_retry_start") retryStarts.push(event);
		});
		return { session: created, requests, retryStarts };
	}

	for (const errorMessage of REFUSED_ERRORS) {
		it(`ends the turn without retrying when fail-fast is on: ${errorMessage.slice(0, 40)}`, async () => {
			const run = createSession(errorMessage, true);
			session = run.session;
			mockSchedulerWaitWithClock();

			await session.prompt("hi");
			await session.waitForIdle();

			expect(run.requests).toHaveLength(1);
			expect(run.retryStarts).toHaveLength(0);
			const last = session.agent.state.messages.at(-1) as AssistantMessage;
			expect(last.role).toBe("assistant");
			expect(last.stopReason).toBe("error");
			expect(last.errorMessage).toContain(errorMessage);
			expect(session.isRetrying).toBe(false);
		});

		it(`keeps retrying when fail-fast is off: ${errorMessage.slice(0, 40)}`, async () => {
			const run = createSession(errorMessage, false);
			session = run.session;
			mockSchedulerWaitWithClock();

			await session.prompt("hi");
			await session.waitForIdle();

			// Initial attempt plus retry.maxRetries retries.
			expect(run.requests).toHaveLength(4);
			expect(run.retryStarts).toHaveLength(3);
			expect(session.isRetrying).toBe(false);
		});
	}

	it("still retries a transient error that is not a refused connection when fail-fast is on", async () => {
		const run = createSession("Network error: socket hang up", true);
		session = run.session;
		mockSchedulerWaitWithClock();

		await session.prompt("hi");
		await session.waitForIdle();

		expect(run.requests).toHaveLength(4);
		expect(run.retryStarts).toHaveLength(3);
	});
});
