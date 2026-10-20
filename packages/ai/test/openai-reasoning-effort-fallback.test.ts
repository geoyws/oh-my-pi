import { describe, expect, it } from "bun:test";
import { streamAzureOpenAIResponses } from "@oh-my-pi/pi-ai/providers/azure-openai-responses";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { resolveOpenAIEffortFallbackConstraints } from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { Context, FetchImpl, Model, ProviderSessionState } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

const testContext: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

function createChatSseResponse(): Response {
	const chunks = [
		{
			id: "chatcmpl-reasoning-fallback",
			object: "chat.completion.chunk",
			created: 0,
			model: "fallback-reasoner",
			choices: [{ index: 0, delta: { content: "ok" } }],
		},
		{
			id: "chatcmpl-reasoning-fallback",
			object: "chat.completion.chunk",
			created: 0,
			model: "fallback-reasoner",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		},
		"[DONE]",
	];
	return new Response(
		`${chunks.map(chunk => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}`).join("\n\n")}\n\n`,
		{
			status: 200,
			headers: { "content-type": "text/event-stream" },
		},
	);
}

function createResponsesSseResponse(id = "resp_reasoning_fallback"): Response {
	const events = [
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: `${id}_msg`, role: "assistant", content: [] },
		},
		{ type: "response.output_text.delta", delta: "ok" },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: { type: "message", id: `${id}_msg`, role: "assistant", content: [{ type: "output_text", text: "ok" }] },
		},
		{
			type: "response.completed",
			response: {
				id,
				status: "completed",
				usage: {
					input_tokens: 1,
					output_tokens: 1,
					total_tokens: 2,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		},
	];
	return new Response(`${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function invalidReasoningResponse(param: "reasoning_effort" | "reasoning.effort", value: string): Response {
	return new Response(
		JSON.stringify({
			error: {
				message: `invalid reasoning value: '${value}' (must be "high", "medium", "low", "max", or "none")`,
				type: "invalid_request_error",
				param,
			},
		}),
		{ status: 400, headers: { "content-type": "application/json" } },
	);
}

function camelCaseReasoningEffortResponse(): Response {
	const message = "field ReasoningEffort invalid, should be one of: low, medium, high, xhigh, none";
	return new Response(JSON.stringify({ error: { message, type: "invalid_request_error" } }), {
		status: 400,
		headers: { "content-type": "application/json" },
	});
}
function invalidMediumReasoningResponse(): Response {
	return new Response(
		JSON.stringify({
			error: {
				message: 'reasoning.effort: Invalid option: expected one of "high"|"low"|"minimal"|"none"',
				type: "invalid_request_error",
				param: "reasoning.effort",
			},
		}),
		{ status: 400, headers: { "content-type": "application/json" } },
	);
}

function pipeDelimitedReasoningEffortResponse(): Response {
	return new Response(
		JSON.stringify({
			error: {
				message: 'reasoning.effort: Invalid option: expected one of "xhigh"|"high"|"medium"|"low"|"minimal"|"none"',
				type: "invalid_request_error",
				param: "reasoning.effort",
			},
		}),
		{ status: 400, headers: { "content-type": "application/json" } },
	);
}

/**
 * cliproxy-style gateway rejection: the field is never named and the rejected
 * value comes before the verdict (`level "none" not supported, valid levels: …`).
 */
function unsupportedLevelResponse(value: string): Response {
	const message = `level "${value}" not supported, valid levels: low, medium, high, xhigh, max`;
	return new Response(JSON.stringify({ error: { message, type: "invalid_request_error" } }), {
		status: 400,
		headers: { "content-type": "application/json" },
	});
}

/**
 * GitHub Copilot-style rejection: the field is never named and the allowed
 * list is phrased as `Supported values are: …` (e.g. gpt-6-astra refusing
 * `reasoning.effort: "none"`).
 */
function copilotUnsupportedValueResponse(value: string, modelId: string): Response {
	const message =
		`Unsupported value: '${value}' is not supported with the '${modelId}' model. ` +
		`Supported values are: 'low', 'medium', 'high', 'xhigh', and 'max'.`;
	return new Response(JSON.stringify({ error: { message, type: "invalid_request_body" } }), {
		status: 400,
		headers: { "content-type": "application/json" },
	});
}

function summaryReasoningErrorResponse(): Response {
	return new Response(
		JSON.stringify({
			error: {
				message: "invalid reasoning.summary value: 'verbose'",
				type: "invalid_request_error",
				param: "reasoning.summary",
			},
		}),
		{ status: 400, headers: { "content-type": "application/json" } },
	);
}

/**
 * Rejection aimed at a sibling tier-valued field: the current reasoning
 * effort is quoted, but the verdict is about text verbosity. Must not
 * trigger a reasoning-effort retry.
 */
function unsupportedVerbosityResponse(): Response {
	const message = "Unsupported value: 'high' for text verbosity. Supported values are: 'low', 'medium'.";
	return new Response(JSON.stringify({ error: { message, type: "invalid_request_body" } }), {
		status: 400,
		headers: { "content-type": "application/json" },
	});
}

/**
 * Ninfer-style strict kwargs whitelist: the server rejects the
 * `chat_template_kwargs.reasoning_effort` spelling itself, not the value.
 */
function templateKwargRejectionResponse(): Response {
	return new Response(
		JSON.stringify({
			error: {
				message: "chat_template_kwargs.ReasoningEffort is not supported",
				type: "invalid_request_error",
				code: "unknown_parameter",
				param: "chat_template_kwargs.ReasoningEffort",
			},
		}),
		{ status: 400, headers: { "content-type": "application/json" } },
	);
}

function templateKwargValueRejectionResponse(): Response {
	return new Response(
		JSON.stringify({
			error: {
				message: "chat_template_kwargs.reasoning_effort: 'xhigh' is not supported, valid levels: low, medium, high",
				type: "invalid_request_error",
				param: "chat_template_kwargs.reasoning_effort",
			},
		}),
		{ status: 400, headers: { "content-type": "application/json" } },
	);
}

/** Local Qwen 3.8 model whose auto-compat routes effort onto the template kwarg. */
function createLocalQwenModel(provider: string, baseUrl: string): Model<"openai-completions"> {
	return buildModel({
		id: "qwen3.8-27b",
		name: "Qwen3.8 27B (local)",
		api: "openai-completions",
		provider,
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 32_768,
	});
}

function parseJsonBody(init: RequestInit | undefined): Record<string, unknown> {
	return JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
}

function createCompletionsModel(): Model<"openai-completions"> {
	return buildModel({
		id: "fallback-reasoner",
		name: "Fallback Reasoner",
		api: "openai-completions",
		provider: "custom",
		baseUrl: "https://proxy.example.test/v1",
		reasoning: true,
		compat: {
			thinkingFormat: "openai",
			supportsReasoningParams: true,
			supportsReasoningEffort: true,
		},
		thinking: {
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		},
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	});
}

/**
 * First-party OpenAI 5.6 model: disabled reasoning goes out as wire `none`
 * (`reasoning-disable-mode: none-effort`), unlike the default lowest-effort dialects.
 */
function createNoneEffortCompletionsModel(): Model<"openai-completions"> {
	return buildModel({
		id: "gpt-5.6-none-effort-test",
		name: "None Effort Test",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		compat: {
			thinkingFormat: "openai",
			supportsReasoningParams: true,
			supportsReasoningEffort: true,
		},
		thinking: {
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High],
		},
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	});
}

function createAzureAstraCompletionsModel(): Model<"openai-completions"> {
	return buildModel({
		id: "gpt-6-astra",
		name: "GPT-6 Astra",
		api: "openai-completions",
		provider: "azure",
		baseUrl: "https://resource.openai.azure.com/openai/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 128_000,
	});
}

function createResponsesModel(): Model<"openai-responses"> {
	return buildModel({
		id: "fallback-responses-reasoner",
		name: "Fallback Responses Reasoner",
		api: "openai-responses",
		provider: "custom-responses",
		baseUrl: "https://responses.example.test/v1",
		reasoning: true,
		compat: {
			supportsReasoningParams: true,
			supportsReasoningEffort: true,
		},
		thinking: {
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		},
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	});
}
function createMaxLadderResponsesModel(): Model<"openai-responses"> {
	return buildModel({
		id: "max-ladder-responses-reasoner",
		name: "Max Ladder Responses Reasoner",
		api: "openai-responses",
		provider: "custom-responses",
		baseUrl: "https://responses.example.test/v1",
		reasoning: true,
		compat: {
			supportsReasoningParams: true,
			supportsReasoningEffort: true,
		},
		thinking: {
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
		},
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	});
}

function createAzureResponsesModel(): Model<"azure-openai-responses"> {
	return buildModel({
		id: "gpt-5.2-test",
		name: "GPT 5.2 Test",
		api: "azure-openai-responses",
		provider: "azure",
		baseUrl: "https://azure.example.test/openai/v1",
		reasoning: true,
		compat: {
			supportsReasoningParams: true,
			supportsReasoningEffort: true,
		},
		thinking: {
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		},
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	});
}

type EffortParam = "reasoning_effort" | "reasoning.effort";

/** Fieldless-of-allowed-values rejection: resolves to the delete-effort (`null`) fallback. */
function rejectedReasoningEffortResponse(param: EffortParam, value: string, status: 400 | 422 = 400): Response {
	return new Response(
		JSON.stringify({
			error: {
				message: `invalid params, ${param} '${value}' is not supported`,
				type: "invalid_request_error",
				param,
			},
		}),
		{ status, headers: { "content-type": "application/json" } },
	);
}

/** Rejects `medium` while listing other tiers: resolves to a remap to `high`. */
function rejectedReasoningEffortWithAllowedResponse(param: EffortParam): Response {
	return new Response(
		JSON.stringify({
			error: {
				message: `${param} 'medium' is not supported, must be one of: low, high`,
				type: "invalid_request_error",
				param,
			},
		}),
		{ status: 400, headers: { "content-type": "application/json" } },
	);
}

/**
 * Declarative effort policy, the shape KDL `thinking-requires-effort` and
 * `thinking-effort-map` compile to: mandatory effort, and with `pinned`
 * every tier serializes to wire `medium`.
 */
function effortPolicyThinking(pinned: boolean) {
	return {
		mode: "effort" as const,
		efforts: [Effort.Low, Effort.Medium, Effort.High],
		requiresEffort: true,
		...(pinned && {
			effortMap: { [Effort.Low]: "medium", [Effort.Medium]: "medium", [Effort.High]: "medium" },
		}),
	};
}

function createEffortPolicyCompletionsModel(pinned: boolean): Model<"openai-completions"> {
	return buildModel({
		id: pinned ? "pinned-effort-chat" : "required-effort-chat",
		name: pinned ? "Pinned Effort Chat" : "Required Effort Chat",
		api: "openai-completions",
		provider: "custom",
		baseUrl: "https://proxy.example.test/v1",
		reasoning: true,
		compat: { thinkingFormat: "openai", supportsReasoningParams: true, supportsReasoningEffort: true },
		thinking: effortPolicyThinking(pinned),
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	});
}

function createEffortPolicyResponsesModel(pinned: boolean): Model<"openai-responses"> {
	return buildModel({
		id: pinned ? "pinned-effort-responses" : "required-effort-responses",
		name: pinned ? "Pinned Effort Responses" : "Required Effort Responses",
		api: "openai-responses",
		provider: "custom-responses",
		baseUrl: "https://responses.example.test/v1",
		reasoning: true,
		compat: { supportsReasoningParams: true, supportsReasoningEffort: true },
		thinking: effortPolicyThinking(pinned),
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	});
}

function createEffortPolicyAzureResponsesModel(pinned: boolean): Model<"azure-openai-responses"> {
	return buildModel({
		id: pinned ? "pinned-effort-azure" : "required-effort-azure",
		name: pinned ? "Pinned Effort Azure" : "Required Effort Azure",
		api: "azure-openai-responses",
		provider: "azure",
		baseUrl: "https://azure.example.test/openai/v1",
		reasoning: true,
		compat: { supportsReasoningParams: true, supportsReasoningEffort: true },
		thinking: effortPolicyThinking(pinned),
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	});
}

function responsesEffort(body: Record<string, unknown>): string | undefined {
	return (body.reasoning as { effort?: string } | undefined)?.effort;
}

describe("OpenAI reasoning effort fallback retry", () => {
	it("retries Chat Completions xhigh as provider max", async () => {
		const bodies: Record<string, unknown>[] = [];
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				const body = parseJsonBody(init);
				bodies.push(body);
				return bodies.length === 1
					? invalidReasoningResponse("reasoning_effort", "xhigh")
					: createChatSseResponse();
			},
			{ preconnect: fetch.preconnect },
		);

		const result = await streamOpenAICompletions(createCompletionsModel(), testContext, {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "xhigh",
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(bodies.map(body => body.reasoning_effort)).toEqual(["xhigh", "max"]);
	});

	it("retries CamelCase ReasoningEffort rejections with the nearest supported tier", async () => {
		const bodies: Record<string, unknown>[] = [];
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				const body = parseJsonBody(init);
				bodies.push(body);
				return bodies.length === 1 ? camelCaseReasoningEffortResponse() : createChatSseResponse();
			},
			{ preconnect: fetch.preconnect },
		);

		const result = await streamOpenAICompletions(createCompletionsModel(), testContext, {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "xhigh",
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(bodies.map(body => body.reasoning_effort)).toEqual(["xhigh", "high"]);
	});

	it("does not apply a cached enabled-effort fallback to tool-suppressed Azure Astra requests", async () => {
		const bodies: Record<string, unknown>[] = [];
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				const body = parseJsonBody(init);
				bodies.push(body);
				return bodies.length === 1 ? invalidReasoningResponse("reasoning_effort", "max") : createChatSseResponse();
			},
			{ preconnect: fetch.preconnect },
		);
		const providerSessionState = new Map<string, ProviderSessionState>();
		const model = createAzureAstraCompletionsModel();

		const first = await streamOpenAICompletions(model, testContext, {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "max",
			providerSessionState,
		}).result();
		expect(first.stopReason).toBe("stop");

		const second = await streamOpenAICompletions(
			model,
			{
				messages: testContext.messages,
				tools: [
					{
						name: "read",
						description: "Read a file",
						parameters: { type: "object", properties: {} },
					},
				],
			},
			{
				apiKey: "test-key",
				fetch: fetchMock,
				reasoning: "max",
				providerSessionState,
			},
		).result();

		expect(second.stopReason).toBe("stop");
		expect(bodies.map(body => body.reasoning_effort)).toEqual(["max", "high", "none"]);
		expect(bodies[2]!.tools).toHaveLength(1);
	});

	it("retries Responses xhigh as provider max and stores the successful fallback params", async () => {
		const bodies: Record<string, unknown>[] = [];
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				const body = parseJsonBody(init);
				bodies.push(body);
				return bodies.length === 1
					? invalidReasoningResponse("reasoning.effort", "xhigh")
					: createResponsesSseResponse();
			},
			{ preconnect: fetch.preconnect },
		);
		const providerSessionState = new Map<string, ProviderSessionState>();

		const result = await streamOpenAIResponses(createResponsesModel(), testContext, {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "xhigh",
			statefulResponses: true,
			sessionId: "reasoning-fallback-session",
			providerSessionState,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(bodies.map(body => (body.reasoning as { effort?: string } | undefined)?.effort)).toEqual(["xhigh", "max"]);
		const state = [...providerSessionState.values()][0] as unknown as {
			chains: Map<string, { lastParams?: { reasoning?: { effort?: string } } }>;
		};
		const chain = [...state.chains.values()][0]!;
		expect(chain.lastParams?.reasoning?.effort).toBe("max");
	});

	it("retries pipe-delimited reasoning.effort errors with the nearest supported tier", async () => {
		const bodies: Record<string, unknown>[] = [];
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				const body = parseJsonBody(init);
				bodies.push(body);
				return bodies.length === 1 ? pipeDelimitedReasoningEffortResponse() : createResponsesSseResponse();
			},
			{ preconnect: fetch.preconnect },
		);

		const result = await streamOpenAIResponses(createMaxLadderResponsesModel(), testContext, {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "max",
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(bodies.map(body => (body.reasoning as { effort?: string } | undefined)?.effort)).toEqual(["max", "xhigh"]);
	});

	it("retries medium as high when medium is missing and high is the closest upper tier", async () => {
		const bodies: Record<string, unknown>[] = [];
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				const body = parseJsonBody(init);
				bodies.push(body);
				return bodies.length === 1 ? invalidMediumReasoningResponse() : createResponsesSseResponse();
			},
			{ preconnect: fetch.preconnect },
		);

		const result = await streamOpenAIResponses(createResponsesModel(), testContext, {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "medium",
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(bodies.map(body => (body.reasoning as { effort?: string } | undefined)?.effort)).toEqual([
			"medium",
			"high",
		]);
	});

	it("retries Azure Responses xhigh as provider max", async () => {
		const bodies: Record<string, unknown>[] = [];
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				const body = parseJsonBody(init);
				bodies.push(body);
				return bodies.length === 1
					? invalidReasoningResponse("reasoning.effort", "xhigh")
					: createResponsesSseResponse();
			},
			{ preconnect: fetch.preconnect },
		);

		const result = await streamAzureOpenAIResponses(createAzureResponsesModel(), testContext, {
			apiKey: "test-key",
			fetch: fetchMock,
			azureBaseUrl: "https://azure.example.test/openai/v1",
			azureApiVersion: "v1",
			reasoning: "xhigh",
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(bodies.map(body => (body.reasoning as { effort?: string } | undefined)?.effort)).toEqual(["xhigh", "max"]);
	});

	it("clamps a rejected reasoning-off request to the lowest level the gateway allows", async () => {
		const bodies: Record<string, unknown>[] = [];
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				const body = parseJsonBody(init);
				bodies.push(body);
				return bodies.length === 1 ? unsupportedLevelResponse("none") : createResponsesSseResponse();
			},
			{ preconnect: fetch.preconnect },
		);

		const result = await streamOpenAIResponses(createMaxLadderResponsesModel(), testContext, {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "high",
			forceReasoningOff: true,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(bodies.map(body => (body.reasoning as { effort?: string } | undefined)?.effort)).toEqual(["none", "low"]);
	});

	it("clamps a Copilot Supported-values rejection of reasoning-off to the lowest allowed level", async () => {
		const bodies: Record<string, unknown>[] = [];
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				const body = parseJsonBody(init);
				bodies.push(body);
				return bodies.length === 1
					? copilotUnsupportedValueResponse("none", "gpt-6-astra")
					: createResponsesSseResponse();
			},
			{ preconnect: fetch.preconnect },
		);

		const result = await streamOpenAIResponses(createMaxLadderResponsesModel(), testContext, {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "high",
			forceReasoningOff: true,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(bodies.map(body => (body.reasoning as { effort?: string } | undefined)?.effort)).toEqual(["none", "low"]);
	});

	it("does not retry when the error param names another none-valued field", async () => {
		let attempts = 0;
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
				attempts += 1;
				const message = "Unsupported value: 'none' is not supported. Supported values are: 'auto', 'required'.";
				return new Response(
					JSON.stringify({ error: { message, param: "tool_choice", type: "invalid_request_error" } }),
					{ status: 400, headers: { "content-type": "application/json" } },
				);
			},
			{ preconnect: fetch.preconnect },
		);

		const result = await streamOpenAIResponses(createMaxLadderResponsesModel(), testContext, {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "high",
			forceReasoningOff: true,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(400);
		expect(attempts).toBe(1);
	});

	it("does not leak an explicit-disable fallback into later normal turns", async () => {
		const bodies: Record<string, unknown>[] = [];
		const providerSessionState = new Map<string, ProviderSessionState>();
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				const body = parseJsonBody(init);
				bodies.push(body);
				const effort = (body.reasoning as { effort?: string } | undefined)?.effort;
				if (effort === "none") return copilotUnsupportedValueResponse("none", "gpt-6-astra");
				return createResponsesSseResponse();
			},
			{ preconnect: fetch.preconnect },
		);

		const off = await streamOpenAIResponses(createMaxLadderResponsesModel(), testContext, {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "high",
			forceReasoningOff: true,
			providerSessionState,
		}).result();
		expect(off.stopReason).toBe("stop");

		const normal = await streamOpenAIResponses(createMaxLadderResponsesModel(), testContext, {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "high",
			providerSessionState,
		}).result();
		expect(normal.stopReason).toBe("stop");
		expect(bodies.map(body => (body.reasoning as { effort?: string } | undefined)?.effort)).toEqual([
			"none",
			"low",
			"high",
		]);
	});

	it("retries a disabled-with-effort none rejection at lowest without poisoning later turns", async () => {
		const bodies: Record<string, unknown>[] = [];
		const providerSessionState = new Map<string, ProviderSessionState>();
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				const body = parseJsonBody(init);
				bodies.push(body);
				if (body.reasoning_effort === "none") {
					const message =
						"Unsupported value: 'none' is not supported. Supported values are: 'low', 'medium', 'high'.";
					return new Response(JSON.stringify({ error: { message, type: "invalid_request_body" } }), {
						status: 400,
						headers: { "content-type": "application/json" },
					});
				}
				return createChatSseResponse();
			},
			{ preconnect: fetch.preconnect },
		);

		const disabled = await streamOpenAICompletions(createNoneEffortCompletionsModel(), testContext, {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "high",
			disableReasoning: true,
			providerSessionState,
		}).result();
		expect(disabled.stopReason).toBe("stop");

		const enabled = await streamOpenAICompletions(createNoneEffortCompletionsModel(), testContext, {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "high",
			providerSessionState,
		}).result();
		expect(enabled.stopReason).toBe("stop");
		// Explicit disable retries at the lowest allowed tier (not a field
		// delete), and nothing cached may strip the later enabled turn.
		expect(bodies.map(body => body.reasoning_effort)).toEqual(["none", "low", "high"]);
	});

	it("does not retry a Supported-values rejection aimed at another field", async () => {
		let attempts = 0;
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
				attempts += 1;
				return unsupportedVerbosityResponse();
			},
			{ preconnect: fetch.preconnect },
		);

		const result = await streamOpenAIResponses(createMaxLadderResponsesModel(), testContext, {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "high",
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(400);
		expect(attempts).toBe(1);
	});

	it("still remaps a fieldless levels-list rejection for a real effort tier", async () => {
		const bodies: Record<string, unknown>[] = [];
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
				const body = parseJsonBody(_init);
				bodies.push(body);
				return bodies.length === 1 ? unsupportedLevelResponse("xhigh") : createResponsesSseResponse();
			},
			{ preconnect: fetch.preconnect },
		);

		const result = await streamOpenAIResponses(createMaxLadderResponsesModel(), testContext, {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "xhigh",
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(bodies.map(body => (body.reasoning as { effort?: string } | undefined)?.effort)).toEqual(["xhigh", "max"]);
	});

	it("does not retry unrelated reasoning parameter errors", async () => {
		let attempts = 0;
		const fetchMock: FetchImpl = Object.assign(
			async (): Promise<Response> => {
				attempts += 1;
				return summaryReasoningErrorResponse();
			},
			{ preconnect: fetch.preconnect },
		);

		const result = await streamOpenAIResponses(createResponsesModel(), testContext, {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "xhigh",
			reasoningSummary: "auto",
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(400);
		expect(attempts).toBe(1);
	});

	it("strips a rejected chat_template_kwargs.reasoning_effort, keeps the top-level twin, and remembers it", async () => {
		const bodies: Record<string, unknown>[] = [];
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				const body = parseJsonBody(init);
				bodies.push(body);
				return bodies.length === 1 ? templateKwargRejectionResponse() : createChatSseResponse();
			},
			{ preconnect: fetch.preconnect },
		);
		const providerSessionState = new Map<string, ProviderSessionState>();
		const model = createLocalQwenModel("llama.cpp", "http://127.0.0.1:8080/v1");

		const first = await streamOpenAICompletions(model, testContext, {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "medium",
			providerSessionState,
		}).result();

		expect(first.stopReason).toBe("stop");
		expect(bodies).toHaveLength(2);
		// The qwen dialect twin-emits; the rejected kwarg must vanish while the
		// top-level field keeps the user's effort selection alive.
		expect(bodies[0]!.reasoning_effort).toBe("medium");
		expect(bodies[0]!.chat_template_kwargs).toEqual({ preserve_thinking: true, reasoning_effort: "medium" });
		expect(bodies[1]!.reasoning_effort).toBe("medium");
		expect(bodies[1]!.chat_template_kwargs).toEqual({ preserve_thinking: true });

		// Remembered per session: the next request pre-strips without a 400.
		const second = await streamOpenAICompletions(model, testContext, {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "medium",
			providerSessionState,
		}).result();
		expect(second.stopReason).toBe("stop");
		expect(bodies).toHaveLength(3);
		expect(bodies[2]!.reasoning_effort).toBe("medium");
		expect(bodies[2]!.chat_template_kwargs).toEqual({ preserve_thinking: true });
	});

	it("hoists the effort onto the top-level field when the kwargs-only dialect is rejected", async () => {
		const bodies: Record<string, unknown>[] = [];
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				const body = parseJsonBody(init);
				bodies.push(body);
				return bodies.length === 1 ? templateKwargRejectionResponse() : createChatSseResponse();
			},
			{ preconnect: fetch.preconnect },
		);
		const model = createLocalQwenModel("vllm", "http://127.0.0.1:8000/v1");

		const result = await streamOpenAICompletions(model, testContext, {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "medium",
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(bodies).toHaveLength(2);
		// vLLM dialect rides kwargs alone — nothing top-level on the first try.
		expect(bodies[0]!.reasoning_effort).toBeUndefined();
		expect(bodies[0]!.chat_template_kwargs).toEqual({
			preserve_thinking: true,
			enable_thinking: true,
			reasoning_effort: "medium",
		});
		expect(bodies[1]!.reasoning_effort).toBe("medium");
		expect(bodies[1]!.chat_template_kwargs).toEqual({ preserve_thinking: true, enable_thinking: true });
	});

	it("remaps a rejected kwargs effort value in both spellings when the error lists allowed levels", async () => {
		const bodies: Record<string, unknown>[] = [];
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				const body = parseJsonBody(init);
				bodies.push(body);
				return bodies.length === 1 ? templateKwargValueRejectionResponse() : createChatSseResponse();
			},
			{ preconnect: fetch.preconnect },
		);
		const model = createLocalQwenModel("llama.cpp", "http://127.0.0.1:8080/v1");

		const result = await streamOpenAICompletions(model, testContext, {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "xhigh",
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(bodies).toHaveLength(2);
		expect(bodies[0]!.reasoning_effort).toBe("xhigh");
		expect(bodies[1]!.reasoning_effort).toBe("high");
		// The kwargs twin must not keep the stale rejected value.
		expect(bodies[1]!.chat_template_kwargs).toEqual({ preserve_thinking: true, reasoning_effort: "high" });
	});
});

describe("OpenAI reasoning effort fallback under effort-preserving model policy", () => {
	it.each(["minimax-code", "minimax-code-cn"] as const)(
		"reads %s MiniMax M3.1's mandatory effort from the KDL rule tree",
		provider => {
			// Built through the catalog policy path: the classes/minimax.kdl
			// exact-model rule is the only source of the mandatory-effort fact.
			const model = buildModel({
				id: "MiniMax-M3.1-Flash-Preview",
				name: "MiniMax-M3.1-Flash-Preview",
				api: "anthropic-messages",
				provider,
				baseUrl: "https://api.minimax.io/anthropic",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
				contextWindow: 204_800,
				maxTokens: 131_072,
			});
			expect(model.thinking?.requiresEffort).toBe(true);
			// Its KDL effort map keeps distinct wire tiers, so it is not pinned.
			expect(resolveOpenAIEffortFallbackConstraints(model, undefined)).toEqual({
				requiresEffort: true,
				pinnedEffort: false,
			});
		},
	);

	it("derives a pin only when several tiers share one wire value", () => {
		expect(resolveOpenAIEffortFallbackConstraints({ thinking: effortPolicyThinking(true) }, undefined)).toEqual({
			requiresEffort: true,
			pinnedEffort: true,
		});
		expect(resolveOpenAIEffortFallbackConstraints({ thinking: effortPolicyThinking(false) }, undefined)).toEqual({
			requiresEffort: true,
			pinnedEffort: false,
		});
		// A lone tier is not a pin.
		expect(
			resolveOpenAIEffortFallbackConstraints(
				{ thinking: { mode: "effort", efforts: [Effort.Medium], effortMap: { [Effort.Medium]: "medium" } } },
				undefined,
			),
		).toEqual({ requiresEffort: false, pinnedEffort: false });
		// The compat effort map overrides the thinking map, as on the wire.
		expect(
			resolveOpenAIEffortFallbackConstraints(
				{ thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] } },
				{ reasoningEffortMap: { [Effort.Low]: "high", [Effort.High]: "high" } },
			),
		).toEqual({ requiresEffort: false, pinnedEffort: true });
	});

	it.each([400, 422] as const)(
		"surfaces a %d Chat Completions rejection for a required-effort model instead of dropping reasoning_effort",
		async status => {
			const bodies: Record<string, unknown>[] = [];
			const fetchMock: FetchImpl = Object.assign(
				async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
					bodies.push(parseJsonBody(init));
					return bodies.length === 1
						? rejectedReasoningEffortResponse("reasoning_effort", "medium", status)
						: createChatSseResponse();
				},
				{ preconnect: fetch.preconnect },
			);

			const result = await streamOpenAICompletions(createEffortPolicyCompletionsModel(false), testContext, {
				apiKey: "test-key",
				fetch: fetchMock,
				reasoning: "medium",
			}).result();

			expect(result.stopReason).toBe("error");
			expect(result.errorStatus).toBe(status);
			expect(bodies).toHaveLength(1);
			expect(bodies[0]!.reasoning_effort).toBe("medium");
		},
	);

	it("still remaps a required-effort model to another allowed tier", async () => {
		const bodies: Record<string, unknown>[] = [];
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				bodies.push(parseJsonBody(init));
				return bodies.length === 1
					? rejectedReasoningEffortWithAllowedResponse("reasoning_effort")
					: createChatSseResponse();
			},
			{ preconnect: fetch.preconnect },
		);

		const result = await streamOpenAICompletions(createEffortPolicyCompletionsModel(false), testContext, {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "medium",
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(bodies.map(body => body.reasoning_effort)).toEqual(["medium", "high"]);
	});

	it("surfaces a pinned-effort Chat Completions remap rejection without poisoning later turns", async () => {
		const model = createEffortPolicyCompletionsModel(true);
		const providerSessionState = new Map<string, ProviderSessionState>();
		const bodies: Record<string, unknown>[] = [];
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				bodies.push(parseJsonBody(init));
				return bodies.length === 1
					? rejectedReasoningEffortWithAllowedResponse("reasoning_effort")
					: createChatSseResponse();
			},
			{ preconnect: fetch.preconnect },
		);
		const options = { apiKey: "test-key", fetch: fetchMock, reasoning: "high", providerSessionState } as const;

		const rejected = await streamOpenAICompletions(model, testContext, options).result();
		expect(rejected.stopReason).toBe("error");
		expect(rejected.errorStatus).toBe(400);
		expect(bodies).toHaveLength(1);

		// A remembered remap would override the policy pin on later turns.
		const next = await streamOpenAICompletions(model, testContext, options).result();
		expect(next.stopReason).toBe("stop");
		expect(bodies.map(body => body.reasoning_effort)).toEqual(["medium", "medium"]);
	});

	it("still retries without reasoning_effort for models without the effort requirement", async () => {
		const model: Model<"openai-completions"> = buildModel({
			id: "optional-effort-chat",
			name: "Optional Effort Chat",
			api: "openai-completions",
			provider: "custom",
			baseUrl: "https://proxy.example.test/v1",
			reasoning: true,
			compat: { thinkingFormat: "openai", supportsReasoningParams: true, supportsReasoningEffort: true },
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High] },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		});
		expect(model.thinking?.requiresEffort).not.toBe(true);
		const bodies: Record<string, unknown>[] = [];
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				bodies.push(parseJsonBody(init));
				return bodies.length === 1
					? rejectedReasoningEffortResponse("reasoning_effort", "high")
					: createChatSseResponse();
			},
			{ preconnect: fetch.preconnect },
		);

		const result = await streamOpenAICompletions(model, testContext, {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "high",
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(bodies).toHaveLength(2);
		expect(bodies[0]!.reasoning_effort).toBe("high");
		expect(bodies[1]).not.toHaveProperty("reasoning_effort");
	});

	it.each([400, 422] as const)(
		"surfaces a %d Responses rejection for a required-effort model instead of dropping reasoning.effort",
		async status => {
			const bodies: Record<string, unknown>[] = [];
			const fetchMock: FetchImpl = Object.assign(
				async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
					bodies.push(parseJsonBody(init));
					return bodies.length === 1
						? rejectedReasoningEffortResponse("reasoning.effort", "medium", status)
						: createResponsesSseResponse();
				},
				{ preconnect: fetch.preconnect },
			);

			const result = await streamOpenAIResponses(createEffortPolicyResponsesModel(false), testContext, {
				apiKey: "test-key",
				fetch: fetchMock,
				reasoning: "medium",
			}).result();

			expect(result.stopReason).toBe("error");
			expect(result.errorStatus).toBe(status);
			expect(bodies.map(responsesEffort)).toEqual(["medium"]);
		},
	);

	it("surfaces a pinned-effort Responses remap rejection", async () => {
		const bodies: Record<string, unknown>[] = [];
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				bodies.push(parseJsonBody(init));
				return bodies.length === 1
					? rejectedReasoningEffortWithAllowedResponse("reasoning.effort")
					: createResponsesSseResponse();
			},
			{ preconnect: fetch.preconnect },
		);

		const result = await streamOpenAIResponses(createEffortPolicyResponsesModel(true), testContext, {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "high",
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(400);
		expect(bodies.map(responsesEffort)).toEqual(["medium"]);
	});

	it.each([400, 422] as const)(
		"surfaces a %d Azure Responses rejection for a required-effort model instead of dropping reasoning.effort",
		async status => {
			const bodies: Record<string, unknown>[] = [];
			const fetchMock: FetchImpl = Object.assign(
				async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
					bodies.push(parseJsonBody(init));
					return bodies.length === 1
						? rejectedReasoningEffortResponse("reasoning.effort", "medium", status)
						: createResponsesSseResponse();
				},
				{ preconnect: fetch.preconnect },
			);

			const result = await streamAzureOpenAIResponses(createEffortPolicyAzureResponsesModel(false), testContext, {
				apiKey: "test-key",
				fetch: fetchMock,
				azureBaseUrl: "https://azure.example.test/openai/v1",
				azureApiVersion: "v1",
				reasoning: "medium",
			}).result();

			expect(result.stopReason).toBe("error");
			expect(result.errorStatus).toBe(status);
			expect(bodies.map(responsesEffort)).toEqual(["medium"]);
		},
	);

	it("surfaces a pinned-effort Azure Responses remap rejection", async () => {
		const bodies: Record<string, unknown>[] = [];
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				bodies.push(parseJsonBody(init));
				return bodies.length === 1
					? rejectedReasoningEffortWithAllowedResponse("reasoning.effort")
					: createResponsesSseResponse();
			},
			{ preconnect: fetch.preconnect },
		);

		const result = await streamAzureOpenAIResponses(createEffortPolicyAzureResponsesModel(true), testContext, {
			apiKey: "test-key",
			fetch: fetchMock,
			azureBaseUrl: "https://azure.example.test/openai/v1",
			azureApiVersion: "v1",
			reasoning: "high",
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(400);
		expect(bodies.map(responsesEffort)).toEqual(["medium"]);
	});
});
