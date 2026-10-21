import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Api, AuthStorage, type Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { cfgModelRoles } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { hasNativeJudge } from "@oh-my-pi/pi-coding-agent/judgment";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";

import { cfgBashEnabled } from "@oh-my-pi/pi-coding-agent/exec/settings";
import { cfgFindEnabled, cfgGithubEnabled, cfgGrepEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";

// Tool-gating settings (`grep.enabled`, `*.enabled`, ...) must reconcile a live
// session's tools and prompt instead of waiting for the next session.
describe("settings-gated tools in a live session", () => {
	let registryDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-settings-gated-tools-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(registryDir, "models.yml"));
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose().catch(() => {});
	});

	afterAll(() => {
		authStorage.close();
		if (fs.existsSync(registryDir)) removeSyncWithRetries(registryDir);
	});

	async function startSession(settings: Settings, toolNames?: string[]): Promise<AgentSession> {
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			workspaceTree: { rootPath: registryDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			toolNames,
		});
		sessions.push(session);
		return session;
	}

	/** Lets the coalesced watch fire, then waits for the reconcile it queued on the registry lock. */
	async function settle(session: AgentSession): Promise<void> {
		await Promise.resolve();
		await session.runToolRegistryMutation(async () => {});
	}

	const GREP_POLICY = "NEVER shell `grep`/`rg`/`awk`";
	const SEMANTIC_POLICY = "semantic mode FIRST";

	it("removes and restores regex mode in the request tools and system prompt", async () => {
		const settings = Settings.isolated({});
		const session = await startSession(settings);
		expect(session.getActiveToolNames()).toContain("search");
		expect(session.systemPrompt.join("\n")).toContain(GREP_POLICY);
		const searchBefore = session.getToolByName("search");
		expect(searchBefore).toBeDefined();
		expect(JSON.stringify(toolWireSchema(searchBefore as never))).toContain('"pattern"');

		cfgGrepEnabled.set(settings, false);
		await settle(session);
		expect(session.getActiveToolNames()).not.toContain("grep");
		expect(session.getToolByName("grep")).toBeUndefined();
		// The merged tool stays (glob mode remains); only the regex mode leaves the schema.
		const searchAfter = session.getToolByName("search");
		expect(searchAfter).toBeDefined();
		expect(JSON.stringify(toolWireSchema(searchAfter as never))).not.toContain('"pattern"');
		// Regex guidance leaves the prompt with the mode; glob guidance stays.
		expect(session.systemPrompt.join("\n")).not.toContain(GREP_POLICY);
		expect(session.systemPrompt.join("\n")).toContain("glob mode");
		expect(session.getActiveToolNames()).toContain("read");

		cfgGrepEnabled.set(settings, true);
		await settle(session);
		expect(JSON.stringify(toolWireSchema(session.getToolByName("search") as never))).toContain('"pattern"');
		expect(session.systemPrompt.join("\n")).toContain(GREP_POLICY);
	});

	it("advertises semantic guidance only while semantic mode is available", async () => {
		// Seeded through `set`: isolated constructor overrides would pin the value.
		const settings = Settings.isolated({});
		cfgFindEnabled.set(settings, "off");
		const session = await startSession(settings);
		expect(session.getActiveToolNames()).toContain("search");
		expect(session.systemPrompt.join("\n")).not.toContain(SEMANTIC_POLICY);
		expect(session.getToolByName("search")?.description).not.toContain('mode: "semantic"');

		cfgFindEnabled.set(settings, "on");
		await settle(session);
		expect(session.systemPrompt.join("\n")).toContain(SEMANTIC_POLICY);

		cfgFindEnabled.set(settings, "off");
		await settle(session);
		expect(session.systemPrompt.join("\n")).not.toContain(SEMANTIC_POLICY);
	});

	it("refreshes the prompt when a judge-role change reverts semantic mode after a gate change", async () => {
		const jev = {
			id: "jev-preview",
			name: "JEV Preview",
			api: "typesafe",
			provider: "typesafe",
			baseUrl: "https://judge.example.test/",
			kind: "judge",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 4096,
		} as Model<Api>;
		const local = getBundledModel("local", "qwen2.5-1.5b");
		if (!local) throw new Error("Expected bundled local judge model");
		const available = spyOn(modelRegistry, "getAvailable").mockReturnValue([
			getBundledModel("openai", "gpt-4o-mini"),
			jev,
			local,
		] as Model<Api>[]);
		try {
			const settings = Settings.isolated({});
			cfgFindEnabled.set(settings, "off");
			cfgModelRoles.set(settings, { judge: "typesafe/jev-preview" });
			expect(hasNativeJudge(settings, modelRegistry)).toBe(true);
			const session = await startSession(settings);
			expect(session.systemPrompt.join("\n")).not.toContain(SEMANTIC_POLICY);

			// Gate change: `auto` + native judge turns semantic mode on.
			cfgFindEnabled.set(settings, "auto");
			await settle(session);
			expect(session.systemPrompt.join("\n")).toContain(SEMANTIC_POLICY);

			// Role change back to the modes the session started with: the prompt must follow the schema.
			cfgModelRoles.set(settings, { judge: `${local.provider}/${local.id}` });
			expect(hasNativeJudge(settings, modelRegistry)).toBe(false);
			await settle(session);
			expect(JSON.stringify(toolWireSchema(session.getToolByName("search") as never))).not.toContain('"query"');
			expect(session.systemPrompt.join("\n")).not.toContain(SEMANTIC_POLICY);
		} finally {
			available.mockRestore();
		}
	});

	it("never widens an explicit tool list", async () => {
		const settings = Settings.isolated({ "grep.enabled": false, "github.enabled": false });
		const session = await startSession(settings, ["read", "bash"]);
		const before = session.getActiveToolNames();
		expect(before).not.toContain("search");

		cfgGrepEnabled.set(settings, true);
		cfgGithubEnabled.set(settings, true);
		await settle(session);
		expect(session.getActiveToolNames()).toEqual(before);
		expect(session.getToolByName("search")).toBeUndefined();

		cfgBashEnabled.set(settings, false);
		await settle(session);
		expect(session.getActiveToolNames()).not.toContain("bash");
		expect(session.getActiveToolNames()).toContain("read");
	});
});
