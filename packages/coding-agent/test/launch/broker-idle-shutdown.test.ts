// Integration test — real timers are required (ts-no-test-timers exception): this drives the actual
// cross-process daemon broker, a real child process and the unix-socket RPC, none of which fake timers
// control. Shutdown is observed by awaiting the broker's own run() promise; its resolution IS the signal.
//
// Startup is pinned, not raced: a registered project presence keeps the broker from idling out
// before the test's client is connected, however loaded the host is. Without it a 100 ms startup
// grace raced the in-process client's connect-and-send and lost under load (omp t-4b5fa3d6).
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { IpcConnection } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient } from "../../src/launch/client";
import { daemonBrokerEndpoint } from "../../src/launch/paths";
import { registerDaemonProjectPresence } from "../../src/launch/presence";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

/**
 * Start an in-process broker and resolve once it listens. `finished` settles when it shuts down;
 * it is wrapped because an async function returning a promise would adopt it and wait for shutdown.
 */
async function startBroker(
	projectDir: string,
	runtimeDir: string,
	idleGraceMs: number,
): Promise<{ finished: Promise<void> }> {
	const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
	const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
	const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = String(idleGraceMs);
	const listening = Promise.withResolvers<void>();
	const finished = startDaemonBrokerFromEnvironment({ onListening: () => listening.resolve() });
	restoreEnv(DAEMON_PROJECT_DIR_ENV, previousProjectDir);
	restoreEnv(DAEMON_RUNTIME_DIR_ENV, previousRuntimeDir);
	restoreEnv(DAEMON_IDLE_GRACE_ENV, previousGrace);
	const first = await Promise.race([listening.promise.then(() => "listening"), finished.then(() => "finished")]);
	if (first !== "listening") throw new Error("broker finished before it listened");
	return { finished };
}

/** A raw connection that has sent nothing, recording what the broker answers and when it closes. */
async function silentConnection(runtimeDir: string) {
	const socket = await IpcConnection.connect(daemonBrokerEndpoint(runtimeDir), { framing: "lines", timeoutMs: 5_000 });
	const lines: string[] = [];
	let nextLine = Promise.withResolvers<string>();
	const closed = Promise.withResolvers<void>();
	socket.start(
		line => {
			lines.push(line);
			nextLine.resolve(line);
			nextLine = Promise.withResolvers<string>();
		},
		() => closed.resolve(),
	);
	return {
		socket,
		closed: closed.promise,
		request(token: string, id: string): Promise<string> {
			const answer = nextLine.promise;
			socket.send(JSON.stringify({ id, token, operation: { op: "ping" } }));
			return answer;
		},
	};
}

async function scope(tempDir: TempDir) {
	const projectDir = path.join(tempDir.path(), "project");
	const runtimeDir = path.join(tempDir.path(), "runtime");
	await fs.mkdir(projectDir);
	return { projectDir, runtimeDir };
}

describe("daemon broker idle shutdown", () => {
	it("shuts down after its last persistent daemon exits with no clients", async () => {
		using tempDir = TempDir.createSync("@omp-launch-idle-");
		const { projectDir, runtimeDir } = await scope(tempDir);
		const previousTitle = process.title;
		// Create the client (writes broker.token) before starting the broker, which reads that token.
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 100 });
		const presence = await registerDaemonProjectPresence(projectDir, runtimeDir);
		const { finished: broker } = await startBroker(projectDir, runtimeDir, 100);
		try {
			// A persistent daemon that outlives the first idle-shutdown timer (100ms) and then
			// self-exits (~300ms). restart:"no" so its exit is terminal.
			const started = await client.request({
				op: "start",
				spec: {
					name: "persistent-temp",
					application: process.execPath,
					args: ["-e", "setTimeout(() => {}, 300)"],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: true,
					detached: false,
				},
			});
			expect(started.op).toBe("start");

			// Disconnect the final client and drop the presence. The broker keeps the persistent
			// daemon alive, so the idle timer this arms fires while the daemon is still live and
			// returns without rearming.
			client.close();
			await presence.close();

			// When the daemon self-exits, terminal settlement must rearm idle shutdown; the broker
			// then releases its lease and run() resolves. Before that fix nothing rearmed, so this
			// await never resolved and the test timed out.
			await broker;
		} finally {
			await presence.close();
			process.title = previousTitle;
		}
	}, 30_000);

	it("keeps a connection whose first request is still unread through the idle grace", async () => {
		using tempDir = TempDir.createSync("@omp-launch-idle-");
		const { projectDir, runtimeDir } = await scope(tempDir);
		const previousTitle = process.title;
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 20 });
		const presence = await registerDaemonProjectPresence(projectDir, runtimeDir);
		const { finished: broker } = await startBroker(projectDir, runtimeDir, 20);
		try {
			expect((await client.request({ op: "ping" })).op).toBe("ping");
			await presence.close();
			const pending = await silentConnection(runtimeDir);
			// A round trip on the authenticated client after the silent one connected: the broker
			// has accepted the silent connection before it answers.
			expect((await client.request({ op: "ping" })).op).toBe("ping");
			// The last authenticated client leaves; only the unread connection remains.
			client.close();

			// Before the fix the broker shut down here and destroyed the connection. Ten idle graces
			// of real time: the broker's own setTimeout runs against the platform clock, and "nothing
			// happened" has no event to await. The wait only bounds how long a regression gets to shut
			// the broker down; the fixed broker passes regardless of load.
			const outcome = await Promise.race([
				broker.then(() => "shut down"),
				pending.closed.then(() => "connection closed"),
				Bun.sleep(200).then(() => "still serving"),
			]);
			expect(outcome).toBe("still serving");

			const token = (await Bun.file(path.join(runtimeDir, "broker.token")).text()).trim();
			const answer = JSON.parse(await pending.request(token, "late-first-request"));
			expect(answer).toMatchObject({ id: "late-first-request", ok: true, result: { op: "ping" } });

			// Once that client leaves, the broker idles out as usual.
			pending.socket.destroy();
			await broker;
		} finally {
			await presence.close();
			process.title = previousTitle;
		}
	}, 30_000);

	it("does not wait on a connection whose first request fails authentication", async () => {
		using tempDir = TempDir.createSync("@omp-launch-idle-");
		const { projectDir, runtimeDir } = await scope(tempDir);
		const previousTitle = process.title;
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 20 });
		const presence = await registerDaemonProjectPresence(projectDir, runtimeDir);
		const { finished: broker } = await startBroker(projectDir, runtimeDir, 20);
		try {
			expect((await client.request({ op: "ping" })).op).toBe("ping");
			await presence.close();
			const pending = await silentConnection(runtimeDir);
			expect((await client.request({ op: "ping" })).op).toBe("ping");
			client.close();

			const answer = JSON.parse(await pending.request("wrong-token", "bad-auth"));
			expect(answer).toMatchObject({ id: "bad-auth", ok: false, error: "Daemon broker authentication failed" });
			// The connection stays open, yet it is no client: the broker idles out and closes it.
			await broker;
			await pending.closed;
		} finally {
			await presence.close();
			process.title = previousTitle;
		}
	}, 30_000);

	it("shuts down after its last client leaves with no daemons, even while an omp in the project lives", async () => {
		using tempDir = TempDir.createSync("@omp-launch-idle-");
		const { projectDir, runtimeDir } = await scope(tempDir);
		const previousTitle = process.title;
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 20 });
		const presence = await registerDaemonProjectPresence(projectDir, runtimeDir);
		const { finished: broker } = await startBroker(projectDir, runtimeDir, 20);
		try {
			expect((await client.request({ op: "ping" })).op).toBe("ping");
			client.close();
			// Presence stays registered for the whole wait. Before the fix the broker re-armed on it
			// forever and this await never resolved (omp t-b6bee738).
			await broker;
		} finally {
			await presence.close();
			process.title = previousTitle;
		}
	}, 30_000);

	it("stays up for a live session daemon while an omp in the project lives", async () => {
		using tempDir = TempDir.createSync("@omp-launch-idle-");
		const { projectDir, runtimeDir } = await scope(tempDir);
		const previousTitle = process.title;
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 20 });
		const presence = await registerDaemonProjectPresence(projectDir, runtimeDir);
		const { finished: broker } = await startBroker(projectDir, runtimeDir, 20);
		try {
			const started = await client.request({
				op: "start",
				spec: {
					name: "session-daemon",
					application: process.execPath,
					args: ["-e", "setTimeout(() => {}, 60_000)"],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			expect(started.op).toBe("start");
			client.close();

			// Ten idle graces of real time: "nothing happened" has no event to await.
			const outcome = await Promise.race([broker.then(() => "shut down"), Bun.sleep(200).then(() => "still serving")]);
			expect(outcome).toBe("still serving");

			// Once the project's last omp leaves, the broker stops the daemon and idles out.
			await presence.close();
			await broker;
		} finally {
			await presence.close();
			process.title = previousTitle;
		}
	}, 30_000);
});
