import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import type { OAuthCredential, UsageProvider } from "@oh-my-pi/pi-ai";
import * as oauth from "@oh-my-pi/pi-ai/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/oauth/types";
import { claudeUsageProvider } from "@oh-my-pi/pi-ai/usage/claude";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";

// kb omp t-bb73c67f: with two Claude OAuth accounts, OMP kept routing to the
// exhausted one (wire 429 `rate_limit_error`) while its sibling had capacity.

const HOUR_MS = 3_600_000;

describe("Anthropic sibling account routing", () => {
	let authStorage: AuthStorage;
	const exhausted = new Set<string>();

	const claudeUsage: UsageProvider = {
		id: "anthropic",
		async fetchUsage(params) {
			const accountId = params.credential.accountId ?? "unknown";
			const used = exhausted.has(accountId) ? 100 : 5;
			return {
				provider: "anthropic",
				fetchedAt: Date.now(),
				limits: [
					{
						id: "anthropic:5h",
						label: "Claude 5 Hour",
						scope: { provider: "anthropic", accountId, windowId: "5h", shared: true },
						window: { id: "5h", label: "5 Hour", durationMs: 5 * HOUR_MS, resetsAt: Date.now() + 2 * HOUR_MS },
						amount: { unit: "percent", used, limit: 100 },
						status: used >= 100 ? "exhausted" : "ok",
					},
				],
				metadata: { accountId, email: `${accountId}@example.com` },
			};
		},
	};

	const account = (id: string): OAuthCredential => ({
		type: "oauth",
		access: `access-${id}`,
		refresh: `refresh-${id}`,
		expires: Date.now() + HOUR_MS,
		accountId: id,
		email: `${id}@example.com`,
	});

	beforeEach(async () => {
		exhausted.clear();
		authStorage = await AuthStorage.create(":memory:", {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage : undefined),
		});
		vi.spyOn(oauth, "refreshOAuthToken").mockImplementation(async (_provider, credential) => credential);
		vi.spyOn(oauth, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
			const credential = credentials.anthropic as OAuthCredentials | undefined;
			return credential ? { apiKey: credential.access, newCredentials: credential } : null;
		});
		await authStorage.credentials.set("anthropic", [account("gmail"), account("unum")]);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		authStorage.close();
	});

	test("a new session never starts on the account whose usage report is exhausted", async () => {
		exhausted.add("gmail");
		// Usage is read on ranking; give every fresh session id a chance to land on gmail.
		for (let i = 0; i < 24; i += 1) {
			expect(await authStorage.keys.get("anthropic", `fresh-session-${i}`)).toBe("access-unum");
		}
	});

	test("a usage-limit 429 on the sticky account moves the session to its sibling", async () => {
		let sessionId = "";
		for (let i = 0; i < 64 && !sessionId; i += 1) {
			if ((await authStorage.keys.get("anthropic", `sticky-${i}`)) === "access-gmail") sessionId = `sticky-${i}`;
		}
		expect(sessionId).not.toBe("");
		// Stickiness holds while the account is usable (prompt-cache affinity).
		expect(await authStorage.keys.get("anthropic", sessionId)).toBe("access-gmail");

		exhausted.add("gmail");
		// The options turn recovery passes after a 429 `rate_limit_error` with retry-after.
		const result = await authStorage.limits.markReached("anthropic", sessionId, {
			retryAfterMs: HOUR_MS,
			providerTimed: true,
			modelId: "claude-sonnet-4-5",
		});
		expect(result.switched).toBe(true);
		expect(await authStorage.keys.get("anthropic", sessionId)).toBe("access-unum");
		// And the move sticks: the session does not drift back while gmail is blocked.
		expect(await authStorage.keys.get("anthropic", sessionId)).toBe("access-unum");
	});
});

// The same ranking through the real Claude usage parser and request path, so
// a usage report is attributed to an account only by the bearer that fetched
// it (the stored-usage-identity hypothesis), not by a test-built account id.
describe("Anthropic ranking from real Claude usage responses", () => {
	test("the account whose /api/oauth/usage says 100% is never a new session's first pick", async () => {
		const usageCalls: string[] = [];
		const usageFetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const request = input instanceof Request ? input : new Request(input.toString(), init);
			const bearer = request.headers.get("authorization") ?? "";
			if (!new URL(request.url).pathname.endsWith("/api/oauth/usage")) return new Response("{}", { status: 404 });
			usageCalls.push(bearer.includes("access-gmail") ? "gmail" : bearer.includes("access-unum") ? "unum" : "?");
			const fiveHour = bearer.includes("access-gmail") ? 100 : 5;
			return Response.json({
				five_hour: { utilization: fiveHour, resets_at: new Date(Date.now() + 2 * HOUR_MS).toISOString() },
				seven_day: { utilization: 20, resets_at: new Date(Date.now() + 72 * HOUR_MS).toISOString() },
			});
		}) as typeof fetch;
		const storage = await AuthStorage.create(":memory:", {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsageProvider : undefined),
			usageFetch,
		});
		try {
			vi.spyOn(oauth, "refreshOAuthToken").mockImplementation(async (_provider, credential) => credential);
			vi.spyOn(oauth, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
				const credential = credentials.anthropic as OAuthCredentials | undefined;
				return credential ? { apiKey: credential.access, newCredentials: credential } : null;
			});
			// Identities as stored by real logins: distinct accounts and orgs.
			await storage.credentials.set(
				"anthropic",
				(["gmail", "unum"] as const).map(id => ({
					type: "oauth" as const,
					access: `access-${id}`,
					refresh: `refresh-${id}`,
					expires: Date.now() + HOUR_MS,
					accountId: `account-${id}`,
					email: `${id}@example.com`,
					orgId: `org-${id}`,
				})),
			);
			for (let i = 0; i < 24; i += 1) {
				expect(await storage.keys.get("anthropic", `real-usage-session-${i}`)).toBe("access-unum");
			}
			// Both accounts were measured through their own bearer.
			expect(new Set(usageCalls)).toEqual(new Set(["gmail", "unum"]));
		} finally {
			vi.restoreAllMocks();
			storage.close();
		}
	});
});
