/**
 * Stand-in for an omp process that owns a project daemon broker.
 *
 * Argv: `<projectDir> <runtimeDir> <idleGraceMs> [persist]`. Registers project
 * presence the way `main.ts` does, connects a broker client (spawning a real
 * detached `__omp_worker_daemon_broker`), optionally starts a persistent
 * daemon, then prints the broker pid and idles until it is killed. The test
 * SIGKILLs it so no postmortem runs: the presence file stays behind and the
 * broker is orphaned to ppid 1, exactly like an omp killed with `kill -9`.
 */
import { createDaemonBrokerClient } from "../../src/launch/client";
import { readLiveDaemonBrokerPid, registerDaemonProjectPresence } from "../../src/launch/presence";

const [projectDir, runtimeDir, rawGrace, mode] = process.argv.slice(2);
if (!projectDir || !runtimeDir || !rawGrace)
	throw new Error("usage: <projectDir> <runtimeDir> <idleGraceMs> [persist]");

await registerDaemonProjectPresence(projectDir, runtimeDir);
const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: Number(rawGrace) });
await client.request({ op: "ping" });
if (mode === "persist") {
	await client.request({
		op: "start",
		spec: {
			name: "owner-persistent",
			application: process.execPath,
			args: ["-e", "setInterval(() => {}, 1_000)"],
			env: {},
			cwd: projectDir,
			pty: false,
			restart: "no",
			persist: true,
			detached: false,
		},
	});
}
const brokerPid = await readLiveDaemonBrokerPid(runtimeDir);
if (brokerPid === undefined) throw new Error("daemon broker did not record a live pid");
process.stdout.write(`${brokerPid}\n`);
setInterval(() => {}, 60_000);
