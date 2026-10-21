import { DAEMON_BROKER_WORKER_ARG } from "@oh-my-pi/pi-coding-agent/launch/protocol";

interface ProcessRow {
	pid: number;
	ppid: number;
	stat: string;
	args: string;
}

/** Every process on the host, read from `ps` (whose own command line never contains the broker selector). */
function processTable(): ProcessRow[] {
	const ps = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,stat=,args="], { stderr: "pipe" });
	if (ps.exitCode !== 0) throw new Error(`ps failed: ${ps.stderr.toString()}`);
	return ps.stdout
		.toString()
		.split("\n")
		.flatMap(line => {
			const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
			return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), stat: match[3], args: match[4] }] : [];
		});
}

/** Live (non-zombie) `__omp_worker_daemon_broker` processes spawned by `parentPid`. */
export function liveBrokerPids(parentPid: number): number[] {
	return processTable()
		.filter(row => row.ppid === parentPid && !row.stat.startsWith("Z") && row.args.includes(DAEMON_BROKER_WORKER_ARG))
		.map(row => row.pid);
}

/** Whether `pid` is still a running (non-zombie) process. */
export function processAlive(pid: number): boolean {
	return processTable().some(row => row.pid === pid && !row.stat.startsWith("Z"));
}
