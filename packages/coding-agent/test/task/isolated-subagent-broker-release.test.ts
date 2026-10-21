// Real-process test — real timers are required (ts-no-test-timers exception): a real omp process
// (test/fixtures/isolated-subagent-brokers.ts) runs isolated subagents whose sessions spawn real
// `__omp_worker_daemon_broker` processes, and the property under test is that those OS processes
// exit on their own idle grace once the subagents end, while the parent omp process stays alive.
// Process exit can only be observed by polling the process table against a wall-clock deadline.
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { liveBrokerPids } from "../helpers/broker-processes";

const SUBAGENTS = 3;
/** Acceptance bound: brokers are back at baseline this long after the last subagent ends. */
const RELEASE_DEADLINE_MS = 30_000;
const EVENT_TIMEOUT_MS = 60_000;
const FIXTURE = path.join(import.meta.dir, "..", "fixtures", "isolated-subagent-brokers.ts");
const PACKAGE_ROOT = path.resolve(import.meta.dir, "..", "..");

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type FixtureEvent = { event: string } & Record<string, unknown>;

/** JSON-line events from the fixture's stdout, awaited by name. */
function fixtureEvents(stdout: ReadableStream<Uint8Array>): (name: string) => Promise<FixtureEvent> {
	const seen: FixtureEvent[] = [];
	const waiters = new Set<() => void>();
	let ended = false;
	void (async () => {
		const decoder = new TextDecoder();
		let buffered = "";
		for await (const chunk of stdout) {
			buffered += decoder.decode(chunk, { stream: true });
			for (let newline = buffered.indexOf("\n"); newline >= 0; newline = buffered.indexOf("\n")) {
				const line = buffered.slice(0, newline).trim();
				buffered = buffered.slice(newline + 1);
				if (line.startsWith("{")) seen.push(JSON.parse(line) as FixtureEvent);
			}
			for (const wake of waiters) wake();
		}
		ended = true;
		for (const wake of waiters) wake();
	})();
	return async name => {
		const deadline = Date.now() + EVENT_TIMEOUT_MS;
		for (;;) {
			const found = seen.find(event => event.event === name);
			if (found) return found;
			if (ended) throw new Error(`fixture exited before emitting ${name}`);
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new Error(`fixture did not emit ${name} within ${EVENT_TIMEOUT_MS}ms`);
			const { promise, resolve } = Promise.withResolvers<void>();
			waiters.add(resolve);
			const timer = setTimeout(resolve, remaining);
			await promise;
			clearTimeout(timer);
			waiters.delete(resolve);
		}
	};
}

function fixtureEnv(home: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined || key.startsWith("XDG_") || key.endsWith("_PROFILE")) continue;
		env[key] = value;
	}
	env.HOME = home;
	env.PI_CODING_AGENT_DIR = path.join(home, ".omp", "agent");
	env.PI_NO_TITLE = "1";
	return env;
}

describe("isolated subagent daemon brokers", () => {
	it(
		"return to the pre-run broker count within 30 s after the last isolated subagent ends",
		async () => {
			const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-subagent-brokers-")));
			const home = path.join(root, "home");
			await fs.mkdir(home, { recursive: true });
			cleanups.push(() => removeWithRetries(root));

			const child = Bun.spawn([process.execPath, FIXTURE, root, String(SUBAGENTS)], {
				cwd: PACKAGE_ROOT,
				env: fixtureEnv(home),
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			const spawned = new Set<number>();
			cleanups.push(async () => {
				child.kill("SIGKILL");
				await child.exited;
				// Never leave a broker behind when an assertion failed first.
				for (const pid of spawned) {
					try {
						process.kill(pid, "SIGKILL");
					} catch {}
				}
			});
			const next = fixtureEvents(child.stdout);
			const stderr = new Response(child.stderr).text();
			const diagnose = async (error: unknown): Promise<never> => {
				child.kill("SIGKILL");
				throw new Error(
					`${error instanceof Error ? error.message : String(error)}\nfixture stderr:\n${await stderr}`,
				);
			};

			const ready = await next("ready").catch(diagnose);
			const parentPid = ready.pid as number;
			const baseline = liveBrokerPids(parentPid).length;

			await next("subagents-waiting").catch(diagnose);
			const during = liveBrokerPids(parentPid);
			for (const pid of during) spawned.add(pid);
			// Every isolated workspace is its own project scope with its own broker.
			expect(during.length).toBe(baseline + SUBAGENTS);

			child.stdin.write("release\n");
			await child.stdin.flush();
			const ended = await next("subagents-ended").catch(diagnose);
			const endedAt = Date.now();
			expect(ended.results).toEqual(
				Array.from({ length: SUBAGENTS }, (_, index) => ({ id: `BrokerScope${index}`, exitCode: 0 })),
			);

			let remaining = liveBrokerPids(parentPid);
			while (remaining.length > baseline && Date.now() - endedAt < RELEASE_DEADLINE_MS) {
				await Bun.sleep(250);
				remaining = liveBrokerPids(parentPid);
			}
			const settledMs = Date.now() - endedAt;
			// The parent omp process is still alive: the brokers left on their own.
			expect(child.exitCode).toBeNull();
			expect(remaining.length).toBe(baseline);
			expect(settledMs).toBeLessThan(RELEASE_DEADLINE_MS);
		},
		EVENT_TIMEOUT_MS * 3,
	);
});
