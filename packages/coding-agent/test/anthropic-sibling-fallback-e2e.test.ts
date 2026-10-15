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
	stdout: string;
	stderr: string;
	exitCode: number;
}

async function runOnce(): Promise<RunOutcome> {
	const messages: string[] = [];
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
			// Usage and any other probe: unknown to this stand-in.
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
			[process.execPath, cliEntry, "-p", "--model", "anthropic/claude-sonnet-4-5", "--no-session", "Say hi."],
			{
				cwd: agentDir.path(),
				env: {
					PATH: process.env.PATH ?? "/usr/bin:/bin",
					HOME: agentDir.path(),
					NO_COLOR: "1",
					PI_CODING_AGENT_DIR: agentDir.path(),
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
		return { messages, stdout, stderr, exitCode };
	} finally {
		server.stop(true);
		await agentDir.remove();
	}
}

test("a print run that starts on the rate-limited account finishes on its sibling", async () => {
	// The first account a fresh session picks is ranked per session id; retry
	// with fresh agent dirs until a run starts on gmail (p(miss 8x) = 2^-8).
	let outcome: RunOutcome | undefined;
	for (let attempt = 0; attempt < 8; attempt += 1) {
		const run = await runOnce();
		expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
		expect(run.stdout).toContain(REPLY);
		if (run.messages[0] === "gmail") {
			outcome = run;
			break;
		}
	}
	if (!outcome) throw new Error("no run started on the rate-limited account in 8 attempts");
	expect(outcome.messages.filter(account => account === "unknown")).toEqual([]);
	// One rate-limited attempt, then the sibling; never back to the blocked account.
	expect(outcome.messages.indexOf("unum")).toBeGreaterThan(0);
	expect(outcome.messages.slice(outcome.messages.indexOf("unum"))).not.toContain("gmail");
}, 900_000);
