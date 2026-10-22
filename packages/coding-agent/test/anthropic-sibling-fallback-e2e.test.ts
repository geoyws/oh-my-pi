import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { getAgentDbPath, TempDir } from "@oh-my-pi/pi-utils";

// kb omp t-bb73c67f, end to end: the real `omp -p` against a local Anthropic
// stand-in. Account "gmail" answers every message with a wire 429
// `rate_limit_error`; account "unum" answers normally. A print run that starts
// on gmail must finish on unum with unum's reply.

const cliEntry = path.join(import.meta.dir, "..", "src", "cli.ts");
const HOUR_MS = 3_600_000;
const REPLY = "hello from the unum account";
const ACCESS = { gmail: "sk-ant-oat01-e2e-gmail", unum: "sk-ant-oat01-e2e-unum" } as const;
/**
 * A session id whose first-choice credential is the first stored one (gmail):
 * the pool starts each session at `xxHash32(sessionId) % accounts`
 * (packages/ai/src/auth/select.ts). The test asserts the first request really
 * went to gmail, so a change in that mapping fails loudly instead of skipping.
 */
const GMAIL_FIRST_SESSION_ID = (() => {
	for (let i = 0; ; i += 1) {
		const candidate = `anthropic-sibling-e2e-${i}`;
		if (Bun.hash.xxHash32(candidate) % 2 === 0) return candidate;
	}
})();

function sse(events: Array<Record<string, unknown>>): string {
	return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

const SUCCESS_STREAM = sse([
	{
		type: "message_start",
		message: {
			id: "msg_e2e",
			type: "message",
			role: "assistant",
			model: "claude-sonnet-4-5",
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 5, output_tokens: 0 },
		},
	},
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: REPLY } },
	{ type: "content_block_stop", index: 0 },
	{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 6 } },
	{ type: "message_stop" },
]);

function accountOf(request: Request): "gmail" | "unum" | "unknown" {
	const presented = `${request.headers.get("authorization") ?? ""} ${request.headers.get("x-api-key") ?? ""}`;
	if (presented.includes(ACCESS.gmail)) return "gmail";
	if (presented.includes(ACCESS.unum)) return "unum";
	return "unknown";
}

interface RunOutcome {
	/** Account behind each `/v1/messages` request, in arrival order. */
	messages: string[];
	/** Account behind each usage probe the stand-in answered. */
	usageProbes: string[];
	stdout: string;
	stderr: string;
	exitCode: number;
}

async function runOnce(): Promise<RunOutcome> {
	const messages: string[] = [];
	const usageProbes: string[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			const url = new URL(request.url);
			if (request.method === "POST" && url.pathname.endsWith("/v1/messages")) {
				const account = accountOf(request);
				messages.push(account);
				if (account === "unum") {
					return new Response(SUCCESS_STREAM, { headers: { "content-type": "text/event-stream" } });
				}
				return Response.json(
					{
						type: "error",
						error: {
							type: "rate_limit_error",
							message: "This request would exceed your account's rate limit. Please try again later.",
						},
					},
					{ status: 429, headers: { "retry-after": "3600", "anthropic-ratelimit-unified-status": "rejected" } },
				);
			}
			// Both accounts report headroom, so the first pick is the session hash
			// and the 429 alone has to move the run. Answering here also stops the
			// usage client falling through to production api.anthropic.com.
			if (url.pathname.endsWith("/api/oauth/usage")) {
				usageProbes.push(accountOf(request));
				return Response.json({
					five_hour: { utilization: 5, resets_at: new Date(Date.now() + 2 * HOUR_MS).toISOString() },
					seven_day: { utilization: 5, resets_at: new Date(Date.now() + 72 * HOUR_MS).toISOString() },
				});
			}
			return new Response("not found", { status: 404 });
		},
	});
	const agentDir = TempDir.createSync("@omp-anthropic-sibling-e2e-");
	try {
		await fs.writeFile(
			path.join(agentDir.path(), "models.yml"),
			["providers:", "  anthropic:", `    baseUrl: ${server.url.origin}`, ""].join("\n"),
		);
		const storage = await AuthStorage.create(getAgentDbPath(agentDir.path()));
		await storage.credentials.set(
			"anthropic",
			(["gmail", "unum"] as const).map(id => ({
				type: "oauth" as const,
				access: ACCESS[id],
				refresh: `refresh-${id}`,
				expires: Date.now() + 24 * HOUR_MS,
				accountId: `acct-${id}`,
				email: `${id}@example.com`,
			})),
		);
		storage.close();

		const child = Bun.spawn(
			[
				process.execPath,
				cliEntry,
				"-p",
				"--model",
				"anthropic/claude-sonnet-4-5",
				"--no-session",
				"--provider-session-id",
				GMAIL_FIRST_SESSION_ID,
				"Say hi.",
			],
			{
				cwd: agentDir.path(),
				env: {
					PATH: process.env.PATH ?? "/usr/bin:/bin",
					HOME: agentDir.path(),
					NO_COLOR: "1",
					PI_CODING_AGENT_DIR: agentDir.path(),
					// Hermetic: anything not bound for the stand-in dies on a dead proxy.
					HTTP_PROXY: "http://127.0.0.1:9",
					HTTPS_PROXY: "http://127.0.0.1:9",
					NO_PROXY: "127.0.0.1,localhost",
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { messages, usageProbes, stdout, stderr, exitCode };
	} finally {
		server.stop(true);
		await agentDir.remove();
	}
}

test("a print run that starts on the rate-limited account finishes on its sibling", async () => {
	const run = await runOnce();
	expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
	expect(run.stdout).toContain(REPLY);
	expect(run.messages.filter(account => account === "unknown")).toEqual([]);
	expect(run.usageProbes.filter(account => account === "unknown")).toEqual([]);
	// Starts on the rate-limited account (the session id pins that), takes one
	// 429, then the sibling; never back to the blocked account.
	expect(run.messages[0]).toBe("gmail");
	const switchedAt = run.messages.indexOf("unum");
	expect(switchedAt).toBeGreaterThan(0);
	expect(run.messages.slice(switchedAt)).not.toContain("gmail");
}, 120_000);
