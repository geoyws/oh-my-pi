import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import * as path from "node:path";
import { SESSION_STICKY_CACHE_PREFIX } from "@oh-my-pi/pi-ai/auth/affinity";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { getAgentDbPath, TempDir } from "@oh-my-pi/pi-utils";

// kb omp t-a8d3543a, end to end: the real `omp -p --mode json` against local
// Anthropic and Z.AI stand-ins that simulate provider quota windows on the
// wall clock. Each stand-in is the oracle: it refuses inference with a wire 429
// usage limit while ANY of an account's windows is still exhausted, and its
// usage endpoint reports every window with its real reset. The suite proves
// that quota recovery compares every eligible account of the current model
// with the configured fallback, takes a usable candidate at once, and
// otherwise arms one real timer for the earliest candidate whose every
// limiting window has reset, refreshing usage at wake.
//
// Windows are anchored to T0, the first quota-relevant request the child
// makes (usage probe or inference), so CLI start-up time cannot eat a window.

const cliEntry = path.join(import.meta.dir, "..", "src", "cli.ts");
const HOUR_MS = 3_600_000;
const WEEK_MS = 7 * 24 * HOUR_MS;
const PRIMARY = "anthropic/claude-sonnet-4-5";
const FALLBACK = "zai/glm-4.6";
const PRIMARY_MODEL_ID = "claude-sonnet-4-5";
const FALLBACK_MODEL_ID = "glm-4.6";
/** Budget the `:medium` chain selector maps to on a budget-mode model. */
const MEDIUM_BUDGET_TOKENS = 8192;
/** Z.AI's Anthropic-compatible route prefix; the bundled base URL ends in it. */
const ZAI_PREFIX = "/api/anthropic";
/** Wall-clock budget for one child run unless a scenario sets its own. */
const DEFAULT_DEADLINE_MS = 45_000;
/** Announced wake stamps may truncate to whole seconds. */
const WAKE_EARLY_TOLERANCE_MS = 1_000;
/** A wake runs after its timer fires and a usage refresh completes. */
const WAKE_LATE_TOLERANCE_MS = 4_000;

type AccountName = "alpha" | "bravo" | "zulu";
type Provider = "anthropic" | "zai";
type WindowName = "fiveHour" | "sevenDay";

const WINDOW_DURATION_MS: Record<WindowName, number> = { fiveHour: 5 * HOUR_MS, sevenDay: WEEK_MS };

/**
 * Self-evidently fake bearers; no request ever leaves the local stand-in. The
 * Anthropic ones carry the `sk-ant-oat` marker the client keys OAuth mode on
 * (packages/ai/src/utils/anthropic-auth.ts `isOAuthToken`).
 */
const ACCOUNT: Record<AccountName, { provider: Provider; access: string; email: string; reply: string }> = {
	alpha: {
		provider: "anthropic",
		access: "fake-quota-e2e-alpha-sk-ant-oat",
		email: "alpha@quota-e2e.test",
		reply: "reply served by alpha",
	},
	bravo: {
		provider: "anthropic",
		access: "fake-quota-e2e-bravo-sk-ant-oat",
		email: "bravo@quota-e2e.test",
		reply: "reply served by bravo",
	},
	zulu: {
		provider: "zai",
		access: "fake-quota-e2e-zulu.secret",
		email: "zulu@quota-e2e.test",
		reply: "reply served by zulu",
	},
};

/**
 * A session id whose first-choice Anthropic credential is the first stored one
 * (alpha): the pool starts each session at `xxHash32(sessionId) % accounts`
 * (packages/ai/src/auth/select.ts).
 */
const ALPHA_FIRST_SESSION_ID = (() => {
	for (let i = 0; ; i += 1) {
		const candidate = `quota-recovery-e2e-${i}`;
		if (Bun.hash.xxHash32(candidate) % 2 === 0) return candidate;
	}
})();

interface AccountPlan {
	/** Offset from T0 (ms) until which each window stays exhausted; omitted windows have headroom. */
	exhaustedFor?: Partial<Record<WindowName, number>>;
	/** Provider-side change: from T0+atMs on, `window` stays exhausted until T0+untilMs. */
	movedReset?: { window: WindowName; atMs: number; untilMs: number };
}

interface Scenario {
	accounts: Partial<Record<AccountName, AccountPlan>>;
	/** Extra `retry.*` settings layered over the shared quota-recovery config. */
	retry?: Record<string, unknown>;
	deadlineMs?: number;
	/** Send SIGTERM to the child at T0+cancelAtMs. */
	cancelAtMs?: number;
}

interface InferenceRecord {
	account: AccountName | "unknown";
	model: string | undefined;
	at: number;
	served: boolean;
	body: Record<string, unknown>;
}

interface ProbeRecord {
	account: AccountName | "unknown";
	provider: Provider;
	at: number;
}

interface RunResult {
	t0: number | undefined;
	inference: InferenceRecord[];
	probes: ProbeRecord[];
	/** Requests to any other route (discovery, saved-reset routes, …). */
	other: Array<{ method: string; path: string }>;
	credentialIds: Partial<Record<AccountName, number>>;
	stdout: string;
	stderr: string;
	exitCode: number;
	timedOut: boolean;
	cancel?: { at: number; childWasRunning: boolean; exitedAt: number };
	/** Persisted session affinity per provider; `explicit` marks a user pin. */
	affinity: Array<{ provider: string; explicit: boolean }>;
}

function sse(events: Array<Record<string, unknown>>): string {
	return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function successStream(model: string, text: string): string {
	return sse([
		{
			type: "message_start",
			message: {
				id: `msg_quota_e2e_${model}`,
				type: "message",
				role: "assistant",
				model,
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 5, output_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 6 } },
		{ type: "message_stop" },
	]);
}

function accountOf(request: Request, provider: Provider): AccountName | "unknown" {
	const presented = `${request.headers.get("authorization") ?? ""} ${request.headers.get("x-api-key") ?? ""}`;
	for (const name of Object.keys(ACCOUNT) as AccountName[]) {
		if (ACCOUNT[name].provider === provider && presented.includes(ACCOUNT[name].access)) return name;
	}
	return "unknown";
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
	try {
		const parsed: unknown = await request.json();
		return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

async function runScenario(scenario: Scenario): Promise<RunResult> {
	const inference: InferenceRecord[] = [];
	const probes: ProbeRecord[] = [];
	const other: Array<{ method: string; path: string }> = [];
	// Object state, not a `let`: it is written from the server callback while
	// the runner awaits, so flow narrowing must not pin it to its initial value.
	const clock: { t0?: number } = {};
	const anchored = Promise.withResolvers<number>();
	const anchor = (now: number): number => {
		if (clock.t0 === undefined) {
			clock.t0 = now;
			anchored.resolve(now);
		}
		return clock.t0;
	};

	/** Absolute end of `window`'s exhaustion for `account`, or undefined when it never was. */
	const exhaustedUntil = (account: AccountName, window: WindowName, now: number): number | undefined => {
		const plan = scenario.accounts[account];
		const start = anchor(now);
		const moved = plan?.movedReset;
		if (moved && moved.window === window && now >= start + moved.atMs) return start + moved.untilMs;
		const offset = plan?.exhaustedFor?.[window];
		return offset === undefined ? undefined : start + offset;
	};
	const windowState = (account: AccountName, window: WindowName, now: number) => {
		const until = exhaustedUntil(account, window, now);
		if (until !== undefined && now < until) return { exhausted: true, resetsAt: until };
		return { exhausted: false, resetsAt: (until ?? now) + WINDOW_DURATION_MS[window] };
	};
	const activeResets = (account: AccountName, now: number): number[] =>
		(["fiveHour", "sevenDay"] as const)
			.map(window => windowState(account, window, now))
			.filter(state => state.exhausted)
			.map(state => state.resetsAt);

	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			const url = new URL(request.url);
			const now = Date.now();
			if (request.method === "POST" && url.pathname.endsWith("/v1/messages")) {
				const provider: Provider = url.pathname.startsWith(`${ZAI_PREFIX}/`) ? "zai" : "anthropic";
				const account = accountOf(request, provider);
				const body = await readJsonBody(request);
				const model = typeof body.model === "string" ? body.model : undefined;
				anchor(now);
				if (account === "unknown") {
					inference.push({ account, model, at: now, served: false, body });
					return Response.json(
						{ type: "error", error: { type: "authentication_error", message: "unknown credential" } },
						{ status: 401 },
					);
				}
				const resets = activeResets(account, now);
				if (resets.length === 0) {
					inference.push({ account, model, at: now, served: true, body });
					return new Response(successStream(model ?? "unknown", ACCOUNT[account].reply), {
						headers: { "content-type": "text/event-stream" },
					});
				}
				inference.push({ account, model, at: now, served: false, body });
				// The hint names the soonest window, as a provider reports the limit
				// that tripped; only the usage report shows every limiting window.
				const retryAfterSeconds = Math.max(1, Math.ceil((Math.min(...resets) - now) / 1000));
				return Response.json(
					{
						type: "error",
						error: {
							type: "rate_limit_error",
							message: "You have reached your usage limit for this plan window.",
						},
					},
					{
						status: 429,
						headers: {
							"retry-after": String(retryAfterSeconds),
							...(provider === "anthropic" ? { "anthropic-ratelimit-unified-status": "rejected" } : {}),
						},
					},
				);
			}
			if (request.method === "GET" && url.pathname === "/api/oauth/usage") {
				// Saved-reset discovery reuses this path with a query; refuse it so no
				// reset inventory exists and nothing falls through to the real host.
				if (url.search) return new Response("forbidden", { status: 403 });
				const account = accountOf(request, "anthropic");
				anchor(now);
				probes.push({ account, provider: "anthropic", at: now });
				if (account === "unknown") return new Response("unauthorized", { status: 401 });
				const bucket = (window: WindowName) => {
					const state = windowState(account, window, now);
					return { utilization: state.exhausted ? 100 : 10, resets_at: new Date(state.resetsAt).toISOString() };
				};
				return Response.json({ five_hour: bucket("fiveHour"), seven_day: bucket("sevenDay") });
			}
			if (request.method === "GET" && url.pathname === "/api/monitor/usage/quota/limit") {
				const account = accountOf(request, "zai");
				anchor(now);
				probes.push({ account, provider: "zai", at: now });
				if (account === "unknown") return new Response("unauthorized", { status: 401 });
				const limit = (window: WindowName) => {
					const state = windowState(account, window, now);
					const used = state.exhausted ? 1000 : 50;
					return {
						type: "TOKENS_LIMIT",
						unit: window === "fiveHour" ? 3 : 6,
						number: window === "fiveHour" ? 5 : 1,
						usage: 1000,
						currentValue: used,
						remaining: 1000 - used,
						percentage: used / 10,
						nextResetTime: state.resetsAt,
					};
				};
				return Response.json({
					success: true,
					code: 200,
					msg: "ok",
					data: { level: "pro", limits: [limit("fiveHour"), limit("sevenDay")] },
				});
			}
			other.push({ method: request.method, path: url.pathname });
			return new Response("not found", { status: 404 });
		},
	});

	const agentDir = TempDir.createSync("@omp-quota-recovery-e2e-");
	let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
	let deadline: Timer | undefined;
	try {
		const root = agentDir.path();
		await Bun.write(
			path.join(root, "models.yml"),
			[
				"providers:",
				"  anthropic:",
				`    baseUrl: ${server.url.origin}`,
				"  zai:",
				`    baseUrl: ${server.url.origin}${ZAI_PREFIX}`,
				"",
			].join("\n"),
		);
		// JSON is valid YAML; `config.yml` is the global settings layer.
		await Bun.write(
			path.join(root, "config.yml"),
			JSON.stringify({
				compaction: { enabled: false },
				retry: {
					enabled: true,
					maxRetries: 3,
					// Every wait past one second must come from the usage-reset path.
					maxDelayMs: 1_000,
					waitForUsageReset: true,
					modelFallback: true,
					usageAwareFallback: true,
					usageReservePolicy: "auto",
					fallbackChains: { [PRIMARY]: [`${FALLBACK}:medium`] },
					...scenario.retry,
				},
			}),
		);

		const storage = await AuthStorage.create(getAgentDbPath(root));
		const seeded = (Object.keys(scenario.accounts) as AccountName[]).sort();
		for (const provider of ["anthropic", "zai"] as const) {
			const names = seeded.filter(name => ACCOUNT[name].provider === provider);
			if (names.length === 0) continue;
			await storage.credentials.set(
				provider,
				names.map(name => ({
					type: "oauth" as const,
					access: ACCOUNT[name].access,
					refresh: `fake-refresh-${name}`,
					expires: Date.now() + 24 * HOUR_MS,
					accountId: `acct-${name}`,
					email: ACCOUNT[name].email,
				})),
			);
		}
		const credentialIds: Partial<Record<AccountName, number>> = {};
		for (const row of storage.credentials.list()) {
			const credential = row.credential;
			if (credential.type !== "oauth") continue;
			const name = seeded.find(candidate => ACCOUNT[candidate].access === credential.access);
			if (name) credentialIds[name] = row.id;
		}
		storage.close();
		expect(Object.keys(credentialIds).sort()).toEqual(seeded);

		const spawned = Bun.spawn(
			[
				process.execPath,
				cliEntry,
				"-p",
				"--mode",
				"json",
				"--model",
				PRIMARY,
				"--thinking",
				"high",
				"--no-session",
				"--provider-session-id",
				ALPHA_FIRST_SESSION_ID,
				"Say hi.",
			],
			{
				cwd: root,
				env: {
					PATH: process.env.PATH ?? "/usr/bin:/bin",
					HOME: root,
					XDG_CONFIG_HOME: path.join(root, "xdg-config"),
					XDG_DATA_HOME: path.join(root, "xdg-data"),
					XDG_STATE_HOME: path.join(root, "xdg-state"),
					XDG_CACHE_HOME: path.join(root, "xdg-cache"),
					NO_COLOR: "1",
					PI_CODING_AGENT_DIR: root,
					// Hermetic: anything not bound for the stand-in dies on a dead proxy.
					HTTP_PROXY: "http://127.0.0.1:9",
					HTTPS_PROXY: "http://127.0.0.1:9",
					NO_PROXY: "127.0.0.1,localhost",
				},
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		child = spawned;
		let timedOut = false;
		// Real wall-clock deadline on purpose: the child is a separate process
		// whose quota timers fake timers here cannot drive.
		deadline = setTimeout(() => {
			timedOut = true;
			spawned.kill("SIGKILL");
		}, scenario.deadlineMs ?? DEFAULT_DEADLINE_MS);

		const stdoutText = new Response(spawned.stdout).text();
		const stderrText = new Response(spawned.stderr).text();
		const exited = spawned.exited;
		const isRunning = (): boolean => spawned.exitCode === null && spawned.signalCode === null;

		let cancel: RunResult["cancel"];
		if (scenario.cancelAtMs !== undefined) {
			const t0 = await Promise.race([anchored.promise, exited.then(() => undefined)]);
			if (t0 !== undefined && isRunning()) {
				// A genuine delay: cancellation must land while the child's own
				// reset timer is pending, measured on the shared wall clock.
				const waitMs = t0 + scenario.cancelAtMs - Date.now();
				if (waitMs > 0) await Promise.race([Bun.sleep(waitMs), exited]);
				const childWasRunning = isRunning();
				const at = Date.now();
				spawned.kill("SIGTERM");
				await exited;
				cancel = { at, childWasRunning, exitedAt: Date.now() };
			}
		}

		const [stdout, stderr, exitCode] = await Promise.all([stdoutText, stderrText, exited]);
		// Read the session affinity rows the child persisted: the rows a later
		// process or a revived subagent restores.
		const affinity: RunResult["affinity"] = [];
		const db = new Database(getAgentDbPath(root), { readonly: true });
		try {
			const rows = db
				.query<{ key: string; value: string }, [string]>("SELECT key, value FROM cache WHERE key LIKE ? || '%'")
				.all(SESSION_STICKY_CACHE_PREFIX);
			for (const row of rows) {
				if (!row.value) continue;
				const provider = row.key.slice(SESSION_STICKY_CACHE_PREFIX.length).split(":")[0] ?? "";
				const parsed: unknown = JSON.parse(row.value);
				const explicit =
					typeof parsed === "object" && parsed !== null && "explicit" in parsed && parsed.explicit === true;
				affinity.push({ provider, explicit });
			}
		} finally {
			db.close();
		}
		return {
			t0: clock.t0,
			inference,
			probes,
			other,
			credentialIds,
			stdout,
			stderr,
			exitCode,
			timedOut,
			cancel,
			affinity,
		};
	} finally {
		clearTimeout(deadline);
		if (child && child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
			await child.exited;
		}
		server.stop(true);
		await agentDir.remove();
	}
}

/** Inference for the models under test; unrelated background calls are excluded. */
function turnRequests(run: RunResult): InferenceRecord[] {
	return run.inference.filter(record => record.model === PRIMARY_MODEL_ID || record.model === FALLBACK_MODEL_ID);
}

function servedBy(run: RunResult): Array<AccountName | "unknown"> {
	return turnRequests(run)
		.filter(record => record.served)
		.map(record => record.account);
}

function refusals(run: RunResult, account: AccountName): InferenceRecord[] {
	return turnRequests(run).filter(record => record.account === account && !record.served);
}

function diagnostics(run: RunResult): string {
	const t0 = run.t0 ?? 0;
	const requests = run.inference.map(
		record => `${record.account}:${record.model ?? "?"}@+${record.at - t0}ms:${record.served ? "served" : "refused"}`,
	);
	const probes = run.probes.map(probe => `${probe.account}@+${probe.at - t0}ms`);
	return [
		`exit=${run.exitCode} timedOut=${run.timedOut} t0=${run.t0 ?? "unset"}`,
		`inference=${requests.join(", ")}`,
		`probes(${run.probes.length})=${probes.join(", ")}`,
		`other=${run.other.map(entry => `${entry.method} ${entry.path}`).join(", ")}`,
		`stderr tail:\n${run.stderr.slice(-3000)}`,
		`stdout tail:\n${run.stdout.slice(-4000)}`,
	].join("\n");
}

const ISO_STAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/g;
const RECOVERY_REASON = /usage|quota|limit|exhaust|reset/i;

/**
 * Visible recovery output lines naming the `selector` (provider/model), the
 * `account` (credential id or email) and a quota reason. The session header
 * is excluded.
 */
function recoveryLines(run: RunResult, selector: string, account: AccountName): string[] {
	const credentialId = run.credentialIds[account];
	if (credentialId === undefined) return [];
	const accountRef = new RegExp(`(?:credential|account)[\\s_-]?(?:id)?[\\\\"'\\s:=#]*${credentialId}(?![0-9])`, "i");
	return run.stdout.split("\n").filter(line => {
		if (!line.includes(selector) || !RECOVERY_REASON.test(line)) return false;
		if (!accountRef.test(line) && !line.includes(ACCOUNT[account].email)) return false;
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			// Non-JSON output still counts as visible.
			return true;
		}
		return !(event !== null && typeof event === "object" && "type" in event && event.type === "session");
	});
}

/** Future ISO-8601 stamps per {@link recoveryLines} line; lines without one are dropped. */
function announcedWakes(run: RunResult, selector: string, account: AccountName): number[][] {
	const t0 = run.t0;
	if (t0 === undefined) return [];
	return recoveryLines(run, selector, account)
		.map(line =>
			[...line.matchAll(ISO_STAMP)].map(match => Date.parse(match[0])).filter(ms => Number.isFinite(ms) && ms > t0),
		)
		.filter(stamps => stamps.length > 0);
}

function expectWakeAnnounced(run: RunResult, selector: string, account: AccountName, wakeAtMs: number): void {
	const wakes = announcedWakes(run, selector, account);
	const announced = wakes.some(stamps =>
		stamps.some(ms => ms >= wakeAtMs - WAKE_EARLY_TOLERANCE_MS && ms <= wakeAtMs + WAKE_LATE_TOLERANCE_MS),
	);
	expect(
		announced,
		`no visible recovery line names ${selector}, ${account} (credential ${run.credentialIds[account]}), a quota reason and wake ${new Date(wakeAtMs).toISOString()}\n${diagnostics(run)}`,
	).toBe(true);
}

/** Shared invariants: hermetic, no saved-reset redemption, no spin on any account. */
function expectCleanRecovery(run: RunResult): void {
	const diag = diagnostics(run);
	expect(run.timedOut, diag).toBe(false);
	expect(run.t0, diag).toBeDefined();
	expect(
		run.inference.filter(record => record.account === "unknown"),
		diag,
	).toEqual([]);
	expect(
		run.probes.filter(probe => probe.account === "unknown"),
		diag,
	).toEqual([]);
	// Saved resets are redeemed only by POSTing an account route; recovery never does.
	expect(
		run.other.filter(entry => entry.method !== "GET"),
		diag,
	).toEqual([]);
	// An exhausted account may be discovered by one refused request; any second
	// refusal is an early or repeated attempt instead of a timed wake.
	for (const account of Object.keys(ACCOUNT) as AccountName[]) {
		expect(refusals(run, account).length, `${account} refused more than once\n${diag}`).toBeLessThanOrEqual(1);
	}
	// Recovery routes by automatic affinity: a user pin would switch off the
	// per-account reserve policy and follow revived subagents.
	expect(
		run.affinity.filter(entry => entry.explicit),
		diag,
	).toEqual([]);
}

function expectServedOnce(run: RunResult, account: AccountName): InferenceRecord {
	const diag = diagnostics(run);
	expect(run.exitCode, diag).toBe(0);
	expect(servedBy(run), diag).toEqual([account]);
	expect(run.stdout, diag).toContain(ACCOUNT[account].reply);
	const served = turnRequests(run).find(record => record.served);
	if (!served) throw new Error(`no served request\n${diag}`);
	return served;
}

function expectMediumFallbackEffort(record: InferenceRecord, run: RunResult): void {
	expect(record.model, diagnostics(run)).toBe(FALLBACK_MODEL_ID);
	expect(record.body.thinking, diagnostics(run)).toMatchObject({
		type: "enabled",
		budget_tokens: MEDIUM_BUDGET_TOKENS,
	});
}

test("an account whose later window still blocks loses to a sibling that is usable sooner", async () => {
	// alpha's 5-hour window resets first of anything (T0+2.5 s) but its 7-day
	// window holds it until T0+11 s; bravo is usable from T0+6 s. The earliest
	// usable candidate is bravo, not the earliest single window reset. Every
	// wait exceeds the transport's few-second in-request sibling unblock, so
	// the session-level quota planner owns the decision and announces it.
	const run = await runScenario({
		accounts: {
			alpha: { exhaustedFor: { fiveHour: 2_500, sevenDay: 11_000 } },
			bravo: { exhaustedFor: { fiveHour: 6_000 } },
		},
	});
	expectCleanRecovery(run);
	const t0 = run.t0 as number;
	const served = expectServedOnce(run, "bravo");
	expect(served.model, diagnostics(run)).toBe(PRIMARY_MODEL_ID);
	expect(served.at - t0, diagnostics(run)).toBeGreaterThanOrEqual(6_000);
	expect(served.at - t0, diagnostics(run)).toBeLessThan(11_000);
	expectWakeAnnounced(run, PRIMARY, "bravo", t0 + 6_000);
	// The planner's account choice persists as automatic affinity, not a user pin.
	expect(run.affinity, diagnostics(run)).toContainEqual({ provider: "anthropic", explicit: false });
	// No visible recovery line schedules alpha at its 5-hour reset alone.
	for (const stamps of announcedWakes(run, PRIMARY, "alpha")) {
		expect(Math.max(...stamps), diagnostics(run)).toBeGreaterThanOrEqual(t0 + 11_000 - WAKE_EARLY_TOLERANCE_MS);
	}
}, 90_000);

test("a sibling of the current model that resets before the fallback wins the wake", async () => {
	const run = await runScenario({
		accounts: {
			alpha: { exhaustedFor: { fiveHour: 60_000, sevenDay: 60_000 } },
			bravo: { exhaustedFor: { fiveHour: 3_000 } },
			zulu: { exhaustedFor: { fiveHour: 7_000 } },
		},
	});
	expectCleanRecovery(run);
	const t0 = run.t0 as number;
	const served = expectServedOnce(run, "bravo");
	expect(served.model, diagnostics(run)).toBe(PRIMARY_MODEL_ID);
	expect(served.at - t0, diagnostics(run)).toBeGreaterThanOrEqual(3_000);
	expect(served.at - t0, diagnostics(run)).toBeLessThan(7_000);
	expectWakeAnnounced(run, PRIMARY, "bravo", t0 + 3_000);
}, 90_000);

test("a fallback model that resets before every sibling wins the wake at its configured effort", async () => {
	const run = await runScenario({
		accounts: {
			alpha: { exhaustedFor: { fiveHour: 60_000, sevenDay: 60_000 } },
			bravo: { exhaustedFor: { fiveHour: 7_000 } },
			zulu: { exhaustedFor: { fiveHour: 3_000 } },
		},
	});
	expectCleanRecovery(run);
	const t0 = run.t0 as number;
	const served = expectServedOnce(run, "zulu");
	expectMediumFallbackEffort(served, run);
	expect(served.at - t0, diagnostics(run)).toBeGreaterThanOrEqual(3_000);
	expect(served.at - t0, diagnostics(run)).toBeLessThan(7_000);
	expectWakeAnnounced(run, FALLBACK, "zulu", t0 + 3_000);
}, 90_000);

test("an immediately usable fallback answers without waiting for any reset", async () => {
	const run = await runScenario({
		accounts: {
			alpha: { exhaustedFor: { fiveHour: 120_000, sevenDay: 120_000 } },
			bravo: { exhaustedFor: { fiveHour: 120_000, sevenDay: 120_000 } },
			zulu: {},
		},
	});
	expectCleanRecovery(run);
	const t0 = run.t0 as number;
	const served = expectServedOnce(run, "zulu");
	expectMediumFallbackEffort(served, run);
	// Generous for a loaded host, yet two orders of magnitude below the wait.
	expect(served.at - t0, diagnostics(run)).toBeLessThan(8_000);
	// The switch is recorded visibly with the selected model, account and reason.
	expect(recoveryLines(run, FALLBACK, "zulu").length, diagnostics(run)).toBeGreaterThan(0);
}, 90_000);

test("a real timer wakes the run and resumes on the account it armed for", async () => {
	const run = await runScenario({
		accounts: {
			alpha: { exhaustedFor: { fiveHour: 3_000 } },
			bravo: { exhaustedFor: { fiveHour: 60_000, sevenDay: 60_000 } },
			zulu: { exhaustedFor: { fiveHour: 60_000 } },
		},
	});
	expectCleanRecovery(run);
	const t0 = run.t0 as number;
	const served = expectServedOnce(run, "alpha");
	expect(served.model, diagnostics(run)).toBe(PRIMARY_MODEL_ID);
	expect(served.at - t0, diagnostics(run)).toBeGreaterThanOrEqual(3_000);
	expect(served.at - t0, diagnostics(run)).toBeLessThan(15_000);
	expectWakeAnnounced(run, PRIMARY, "alpha", t0 + 3_000);
}, 90_000);

test("a reset that moves before the wake is refreshed and re-armed without an early request", async () => {
	// The provider extends alpha's window at T0+2 s, from T0+3 s to T0+7 s.
	// The run armed for T0+3 s must refresh usage at wake, re-arm for T0+7 s,
	// and spend no retry on the extra wait (maxRetries is 1). The fallback in
	// the chain has no credential, so it is never eligible.
	const run = await runScenario({
		accounts: {
			alpha: {
				exhaustedFor: { fiveHour: 3_000 },
				movedReset: { window: "fiveHour", atMs: 2_000, untilMs: 7_000 },
			},
		},
		retry: { maxRetries: 1 },
	});
	expectCleanRecovery(run);
	const t0 = run.t0 as number;
	const served = expectServedOnce(run, "alpha");
	expect(served.at - t0, diagnostics(run)).toBeGreaterThanOrEqual(7_000);
	expect(served.at - t0, diagnostics(run)).toBeLessThan(15_000);
	expectWakeAnnounced(run, PRIMARY, "alpha", t0 + 7_000);
	// Waiting is timer-driven: a handful of refreshes, never a polling loop.
	const anthropicProbes = run.probes.filter(probe => probe.provider === "anthropic");
	expect(anthropicProbes.length, diagnostics(run)).toBeLessThanOrEqual(12);
}, 90_000);

test("terminating the child while it waits for a reset exits at once without another request", async () => {
	const run = await runScenario({
		accounts: { alpha: { exhaustedFor: { fiveHour: 120_000, sevenDay: 120_000 } } },
		cancelAtMs: 4_000,
		deadlineMs: 60_000,
	});
	const diag = diagnostics(run);
	expect(run.timedOut, diag).toBe(false);
	const cancel = run.cancel;
	if (!cancel) throw new Error(`child never reached the wait\n${diag}`);
	// Still alive four seconds in: it was waiting, not failing fast.
	expect(cancel.childWasRunning, diag).toBe(true);
	expect(run.exitCode, diag).toBe(143);
	expect(cancel.exitedAt - cancel.at, diag).toBeLessThan(10_000);
	expect(
		run.inference.filter(record => record.at >= cancel.at),
		diag,
	).toEqual([]);
	expect(servedBy(run), diag).toEqual([]);
	expect(refusals(run, "alpha").length, diag).toBeLessThanOrEqual(1);
	expect(
		run.other.filter(entry => entry.method !== "GET"),
		diag,
	).toEqual([]);
	expectWakeAnnounced(run, PRIMARY, "alpha", (run.t0 as number) + 120_000);
}, 90_000);
