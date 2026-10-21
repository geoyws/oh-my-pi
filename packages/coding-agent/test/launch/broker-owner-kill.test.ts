// Integration test — real processes and real timers are required (ts-no-test-timers exception):
// the bug is a detached `__omp_worker_daemon_broker` outliving an omp that was SIGKILLed, which
// only exists across real process boundaries (presence file left behind, broker reparented to
// ppid 1). Broker exit is observed through the native process handle's `waitForExit`, not polling.
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Process } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createDaemonBrokerClient } from "../../src/launch/client";

const FIXTURE = path.join(import.meta.dir, "..", "fixtures", "daemon-broker-owner.ts");
const PACKAGE_ROOT = path.join(import.meta.dir, "..", "..");
const IDLE_GRACE_MS = 500;
/**
 * Acceptance bound: the broker's idle grace plus one presence check (which
 * re-arms after another grace when anything still looks live), plus slack for
 * process teardown on a loaded CI host.
 */
const EXIT_BUDGET_MS = IDLE_GRACE_MS * 2 + 4_000;

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Owner {
	ownerPid: number;
	brokerPid: number;
	projectDir: string;
	runtimeDir: string;
	presencePath: string;
	kill(): Promise<void>;
}

/** Spawn a real owner omp stand-in that starts a real broker, and return both pids. */
async function startOwner(mode?: "persist"): Promise<Owner> {
	const tempDir = TempDir.createSync("@omp-broker-owner-kill-");
	cleanups.push(() => tempDir.remove());
	const projectDir = path.join(tempDir.path(), "project");
	const runtimeDir = path.join(tempDir.path(), "runtime");
	await fs.mkdir(projectDir);
	const owner = Bun.spawn(
		[process.execPath, FIXTURE, projectDir, runtimeDir, String(IDLE_GRACE_MS), ...(mode ? [mode] : [])],
		{ cwd: PACKAGE_ROOT, stdin: "ignore", stdout: "pipe", stderr: "inherit" },
	);
	cleanups.push(() => {
		if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
	});
	const reader = owner.stdout.getReader();
	const decoder = new TextDecoder();
	let output = "";
	while (!output.includes("\n")) {
		const { value, done } = await reader.read();
		if (done) break;
		output += decoder.decode(value);
	}
	reader.releaseLock();
	const brokerPid = Number.parseInt(output.trim(), 10);
	if (!Number.isInteger(brokerPid)) throw new Error(`owner fixture failed to report a broker pid: ${output}`);
	cleanups.push(() => {
		Process.fromPid(brokerPid)?.killTree();
	});
	const clientsDir = path.join(runtimeDir, "clients");
	const [presenceFile] = await fs.readdir(clientsDir);
	if (!presenceFile) throw new Error("owner fixture registered no presence");
	return {
		ownerPid: owner.pid,
		brokerPid,
		projectDir,
		runtimeDir,
		presencePath: path.join(clientsDir, presenceFile),
		kill: async () => {
			// SIGKILL: no postmortem runs, so the presence file stays behind exactly as in the field.
			owner.kill("SIGKILL");
			await owner.exited;
		},
	};
}

/** Wait for the broker to exit; returns the elapsed ms, or undefined if it outlived the budget. */
async function brokerExitWithin(brokerPid: number, timeoutMs: number): Promise<number | undefined> {
	const broker = Process.fromPid(brokerPid);
	const started = performance.now();
	if (!broker) return 0;
	const exited = await broker.waitForExit({ timeoutMs });
	return exited ? performance.now() - started : undefined;
}

describe("daemon broker owned by a SIGKILLed omp", () => {
	it("exits within idle grace plus one presence check once its owner is gone", async () => {
		const owner = await startOwner();
		await owner.kill();

		const elapsed = await brokerExitWithin(owner.brokerPid, EXIT_BUDGET_MS);
		expect(elapsed).toBeDefined();
		// The dead owner's stale presence entry was dropped by the presence check.
		expect(await Bun.file(owner.presencePath).exists()).toBe(false);
	}, 30_000);

	it("exits when the dead owner's pid has been recycled by an unrelated live process", async () => {
		const owner = await startOwner();
		// Stand-in for the kernel handing the owner's pid to an unrelated long-lived process:
		// point the owner's presence entry at another live pid. A pid-only liveness check
		// sees it alive forever; pid plus process start time sees a different process.
		const stranger = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1_000)"], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		cleanups.push(() => {
			stranger.kill("SIGKILL");
		});
		const entry = (await Bun.file(owner.presencePath).json()) as Record<string, unknown>;
		await Bun.write(owner.presencePath, JSON.stringify({ ...entry, pid: stranger.pid }));
		await owner.kill();

		const elapsed = await brokerExitWithin(owner.brokerPid, EXIT_BUDGET_MS);
		expect(elapsed).toBeDefined();
		expect(await Bun.file(owner.presencePath).exists()).toBe(false);
		expect(stranger.exitCode).toBeNull();
	}, 30_000);

	it("keeps serving while a persistent daemon is live, even after its owner dies", async () => {
		const owner = await startOwner("persist");
		await owner.kill();

		// Several grace periods pass; the broker must still be alive for its persistent daemon.
		expect(await brokerExitWithin(owner.brokerPid, IDLE_GRACE_MS * 4)).toBeUndefined();

		const client = await createDaemonBrokerClient(owner.projectDir, {
			runtimeDir: owner.runtimeDir,
			idleGraceMs: IDLE_GRACE_MS,
		});
		try {
			const listed = await client.request({ op: "list" });
			expect(listed.op).toBe("list");
			if (listed.op === "list") {
				expect(listed.daemons.find(daemon => daemon.name === "owner-persistent")?.state).toBe("running");
			}
			await client.request({ op: "shutdown" });
		} finally {
			client.close();
		}
		expect(await brokerExitWithin(owner.brokerPid, EXIT_BUDGET_MS)).toBeDefined();
	}, 30_000);
});
