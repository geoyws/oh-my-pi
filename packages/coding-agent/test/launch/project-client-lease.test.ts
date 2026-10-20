// Real-process test — real timers are required (ts-no-test-timers exception): the leases drive a
// real `__omp_worker_daemon_broker` child, and the property under test is that the OS process exits
// on its own idle grace after the last lease goes. Process exit is observable only by polling the
// process table against a wall-clock deadline.
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	closeDaemonClients,
	daemonClientForProject,
	sharedProjectClientCount,
} from "@oh-my-pi/pi-coding-agent/launch/client";
import { daemonRuntimeDir } from "@oh-my-pi/pi-coding-agent/launch/paths";
import { readLiveDaemonBrokerPid } from "@oh-my-pi/pi-coding-agent/launch/presence";
import { __resetDirsFromEnvForTests, removeWithRetries } from "@oh-my-pi/pi-utils";
import { processAlive } from "../helpers/broker-processes";

/** Broker idle grace (3 s) plus spawn/teardown slack. */
const BROKER_EXIT_DEADLINE_MS = 15_000;

let root: string;
let savedHome: string | undefined;
const brokerPids: number[] = [];

beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-client-lease-")));
	const home = path.join(root, "home");
	await fs.mkdir(home, { recursive: true });
	savedHome = process.env.HOME;
	process.env.HOME = home;
	vi.spyOn(os, "homedir").mockReturnValue(home);
	__resetDirsFromEnvForTests();
});

afterEach(async () => {
	await closeDaemonClients();
	for (const pid of brokerPids.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
	vi.restoreAllMocks();
	if (savedHome === undefined) delete process.env.HOME;
	else process.env.HOME = savedHome;
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

describe("project daemon broker client leases", () => {
	it("keeps one shared connection while any lease is held and lets the broker exit after the last release", async () => {
		const projectDir = path.join(root, "home", "project");
		await fs.mkdir(projectDir);

		const first = await daemonClientForProject(projectDir);
		const second = await daemonClientForProject(projectDir);
		await first.request({ op: "ping" });
		const brokerPid = await readLiveDaemonBrokerPid(daemonRuntimeDir(first.projectDir));
		expect(brokerPid).toBeNumber();
		brokerPids.push(brokerPid!);
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
		expect(await exitsWithin(brokerPid!, BROKER_EXIT_DEADLINE_MS)).toBe(true);

		// The next user reconnects through a fresh broker.
		using again = await daemonClientForProject(projectDir);
		expect((await again.request({ op: "ping" })).op).toBe("ping");
		const nextPid = await readLiveDaemonBrokerPid(daemonRuntimeDir(again.projectDir));
		if (nextPid !== undefined) brokerPids.push(nextPid);
		expect(nextPid).not.toBe(brokerPid);
	}, 60_000);
});
