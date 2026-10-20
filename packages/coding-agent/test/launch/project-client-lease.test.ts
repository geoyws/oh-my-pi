// Real-process test — real timers are required (ts-no-test-timers exception): the leases drive a
// real `__omp_worker_daemon_broker` child, and the properties under test are that the OS process
// exits on its own 3 s idle grace after the last lease goes, and stays up past that grace while a
// lease is held. Neither can be driven by fake timers; process exit is observable only by polling
// the process table against a wall-clock deadline.
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { findOpenIdaDatabase, releaseIdaDatabases } from "@oh-my-pi/pi-coding-agent/ida/client";
import { idaHostEndpoint } from "@oh-my-pi/pi-coding-agent/ida/protocol";
import {
	closeDaemonClients,
	daemonClientForProject,
	sharedProjectClientCount,
} from "@oh-my-pi/pi-coding-agent/launch/client";
import { canonicalProjectDir, daemonRuntimeDir } from "@oh-my-pi/pi-coding-agent/launch/paths";
import { readLiveDaemonBrokerPid } from "@oh-my-pi/pi-coding-agent/launch/presence";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { IpcServer } from "@oh-my-pi/pi-natives";
import { __resetDirsFromEnvForTests, removeWithRetries } from "@oh-my-pi/pi-utils";
import { processAlive } from "../helpers/broker-processes";

/** Broker idle grace (3 s) plus spawn/teardown slack. */
const BROKER_EXIT_DEADLINE_MS = 15_000;
/** Longer than the broker's 3 s idle grace: an unleased broker would have exited by then. */
const PAST_IDLE_GRACE_MS = 4_500;

let root: string;
let projectDir: string;
let savedHome: string | undefined;
let savedStateHome: string | undefined;
const brokerPids: number[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-client-lease-")));
	const home = path.join(root, "home");
	projectDir = path.join(home, "project");
	await fs.mkdir(projectDir, { recursive: true });
	savedHome = process.env.HOME;
	savedStateHome = process.env.XDG_STATE_HOME;
	process.env.HOME = home;
	// Daemon runtime dirs must land under the fake HOME.
	delete process.env.XDG_STATE_HOME;
	vi.spyOn(os, "homedir").mockReturnValue(home);
	__resetDirsFromEnvForTests();
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	await closeDaemonClients();
	for (const pid of brokerPids.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
	vi.restoreAllMocks();
	if (savedHome === undefined) delete process.env.HOME;
	else process.env.HOME = savedHome;
	if (savedStateHome !== undefined) process.env.XDG_STATE_HOME = savedStateHome;
	__resetDirsFromEnvForTests();
	await removeWithRetries(root);
});

async function exitsWithin(pid: number, deadlineMs: number): Promise<boolean> {
	const deadline = Date.now() + deadlineMs;
	while (processAlive(pid)) {
		if (Date.now() > deadline) return false;
		await Bun.sleep(200);
	}
	return true;
}

/** Pid of the project's live broker, tracked for cleanup. */
async function brokerPid(): Promise<number> {
	const pid = await readLiveDaemonBrokerPid(daemonRuntimeDir(await canonicalProjectDir(projectDir)));
	if (pid === undefined) throw new Error("no live broker for the test project");
	if (!brokerPids.includes(pid)) brokerPids.push(pid);
	return pid;
}

describe("project daemon broker client leases", () => {
	it("keeps one shared connection while any lease is held and lets the broker exit after the last release", async () => {
		const first = await daemonClientForProject(projectDir);
		const second = await daemonClientForProject(projectDir);
		await first.request({ op: "ping" });
		const pid = await brokerPid();
		expect(sharedProjectClientCount()).toBe(1);

		const retained = second.retain();
		first.release();
		second.release();
		// A released lease is dead even while its connection lives on for others.
		await expect(first.request({ op: "ping" })).rejects.toThrow("released");
		expect(sharedProjectClientCount()).toBe(1);
		expect((await retained.request({ op: "ping" })).op).toBe("ping");

		retained.release();
		retained.release();
		expect(sharedProjectClientCount()).toBe(0);
		expect(await exitsWithin(pid, BROKER_EXIT_DEADLINE_MS)).toBe(true);

		// The next user reconnects through a fresh broker.
		using again = await daemonClientForProject(projectDir);
		expect((await again.request({ op: "ping" })).op).toBe("ping");
		expect(await brokerPid()).not.toBe(pid);
	}, 60_000);

	it("does not cache a failed connection setup; the next acquire retries", async () => {
		// A file where the daemon runtime root belongs makes token setup fail (ENOTDIR, even as root).
		const runtimeRoot = path.dirname(daemonRuntimeDir(await canonicalProjectDir(projectDir)));
		await fs.mkdir(path.dirname(runtimeRoot), { recursive: true });
		await Bun.write(runtimeRoot, "not a directory");

		await expect(daemonClientForProject(projectDir)).rejects.toThrow();
		expect(sharedProjectClientCount()).toBe(0);

		await fs.rm(runtimeRoot);
		using lease = await daemonClientForProject(projectDir);
		expect((await lease.request({ op: "ping" })).op).toBe("ping");
		expect(sharedProjectClientCount()).toBe(1);
		await brokerPid();
	}, 60_000);

	it("hands an acquire that races the last release a fresh, working connection", async () => {
		const first = await daemonClientForProject(projectDir);
		await first.request({ op: "ping" });
		await brokerPid();

		// The acquire is still resolving the project dir when the last lease goes, so the old
		// connection closes under it; it must not be handed that closed connection.
		const racing = daemonClientForProject(projectDir);
		first.release();
		expect(sharedProjectClientCount()).toBe(0);
		using second = await racing;
		expect(sharedProjectClientCount()).toBe(1);
		await expect(first.request({ op: "ping" })).rejects.toThrow("released");
		expect((await second.request({ op: "ping" })).op).toBe("ping");
		await brokerPid();
	}, 60_000);
});

/** A tool session whose dispose callbacks the test runs, like `AgentSession.dispose()`. */
function disposableSession(cwd: string): { session: ToolSession; dispose(): void } {
	const callbacks = new Set<() => void>();
	const session = {
		cwd,
		registerDisposeCallback: (callback: () => void) => {
			callbacks.add(callback);
			return () => callbacks.delete(callback);
		},
	} as unknown as ToolSession;
	return {
		session,
		dispose: () => {
			for (const callback of callbacks) callback();
			callbacks.clear();
		},
	};
}

describe("IDA database broker leases", () => {
	// Real broker; the IDA host is an in-process stand-in speaking the host socket protocol,
	// because a real host needs an IDA Pro installation the gate image does not have.
	it("holds the project broker per using session and releases it when the last such session is disposed", async () => {
		const name = "omp.ida.lease-test";
		const canonical = await canonicalProjectDir(projectDir);
		const status = {
			id: "lease-test",
			ref: "lease-test",
			idbPath: path.join(root, "lease-test.i64"),
			info: { module: "lease-test", format: "ELF", arch: "x86_64", bitness: 64 },
			state: "open",
			busy: false,
			lastUsed: Date.now(),
			current: null,
			dirty: false,
		};
		const host = await IpcServer.listen(
			idaHostEndpoint(daemonRuntimeDir(canonical), name),
			{ framing: "lines" },
			connection => {
				connection.start(
					line => {
						const request = JSON.parse(line) as { id: number; op: string };
						const result = request.op === "flush" ? { saved: false } : status;
						connection.send(JSON.stringify({ id: request.id, ok: true, result }));
					},
					() => {},
				);
			},
		);
		cleanups.push(async () => {
			await releaseIdaDatabases();
			await host.close();
		});

		// Start the broker under a short-lived lease, as a tool call would.
		const starter = await daemonClientForProject(projectDir);
		await starter.request({ op: "ping" });
		const pid = await brokerPid();

		const first = disposableSession(projectDir);
		const second = disposableSession(projectDir);
		const db = await findOpenIdaDatabase(first.session, name);
		expect(db?.status.state).toBe("open");
		expect(await findOpenIdaDatabase(second.session, name)).toBe(db);
		starter.release();
		// Only the database's per-session leases hold the connection now.
		expect(sharedProjectClientCount()).toBe(1);

		first.dispose();
		expect(sharedProjectClientCount()).toBe(1);
		await Bun.sleep(PAST_IDLE_GRACE_MS);
		// A session still using the database keeps its broker (and host) up.
		expect(processAlive(pid)).toBe(true);
		expect(db?.connected).toBe(true);

		second.dispose();
		expect(sharedProjectClientCount()).toBe(0);
		expect(await exitsWithin(pid, BROKER_EXIT_DEADLINE_MS)).toBe(true);
	}, 60_000);
});
