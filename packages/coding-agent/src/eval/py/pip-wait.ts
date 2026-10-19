/**
 * Host-owned eval-timeout pause for the Python `%pip` magic.
 *
 * The cell and the `%pip` magic share one interpreter, so any pause signal the
 * kernel *sends* could equally be sent by cell code; the runtime status
 * channel therefore never carries timeout authority. Instead the magic asks
 * the host to wait on the pip process it just spawned. The host pauses the
 * watchdog only after it has verified, from the OS process table, that the pid
 * is a live direct child of this execution's kernel, runs the kernel's own
 * executable, and was started as `<python> -m pip`. The pause then lasts
 * exactly as long as that process does. This binds the pause to a real pip
 * process, not to the `%pip` magic: cell code that starts its own
 * `<python> -m pip` child and posts this request also pauses the deadline
 * for that process's lifetime, the same exposure as a `%pip` install that
 * hangs.
 *
 * Fails closed: without a kernel pid, a `ps` binary (Windows), or a matching
 * process, nothing is paused and the install counts against the cell timeout.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { type EvalTimeoutControlSink, withBridgeTimeoutPause } from "../bridge-timeout";

/** Reserved bridge name; never resolved as a session tool. */
export const PIP_WAIT_BRIDGE_NAME = "__omp_pip_wait__";

const PIP_EXIT_POLL_MS = 100;

interface ProcessRow {
	ppid: number;
	comm: string;
	args: string;
}

async function readProcessRow(pid: number): Promise<ProcessRow | undefined> {
	const run = async (field: string): Promise<string | undefined> => {
		const proc = Bun.spawn(["ps", "-o", `${field}=`, "-p", String(pid)], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
		});
		const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		if (code !== 0) return undefined;
		const value = text.trim();
		return value ? value : undefined;
	};
	try {
		const [ppid, comm, args] = await Promise.all([run("ppid"), run("comm"), run("args")]);
		if (ppid === undefined || comm === undefined || args === undefined) return undefined;
		const parsed = Number(ppid);
		if (!Number.isSafeInteger(parsed)) return undefined;
		return { ppid: parsed, comm, args };
	} catch {
		// No `ps` (Windows) or spawn failure: fail closed.
		return undefined;
	}
}

/** True when `pid` is a `<kernel python> -m pip` direct child of `kernelPid`. */
export async function isKernelPipChild(pid: number, kernelPid: number): Promise<boolean> {
	const [child, kernel] = await Promise.all([readProcessRow(pid), readProcessRow(kernelPid)]);
	if (!child || !kernel) return false;
	if (child.ppid !== kernelPid) return false;
	if (child.comm !== kernel.comm) return false;
	return /^\S+\s+-m\s+pip(?:\s|$)/.test(child.args);
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		// ESRCH: exited and reaped. EPERM: the pid now belongs to another owner,
		// so the verified pip process is gone either way.
		return false;
	}
}

async function waitForExit(pid: number, signal: AbortSignal | undefined): Promise<void> {
	while (processAlive(pid) && !signal?.aborted) {
		await Bun.sleep(PIP_EXIT_POLL_MS);
	}
}

export interface PipWaitOptions {
	kernelPid: number | undefined;
	onTimeoutControl: EvalTimeoutControlSink | undefined;
	signal: AbortSignal | undefined;
}

/**
 * Pause the eval watchdog while the verified pip child runs. Returns whether
 * a pause was applied; an unverifiable request is refused without pausing.
 */
export async function waitForPipChild(args: unknown, options: PipWaitOptions): Promise<{ paused: boolean }> {
	const pid =
		args && typeof args === "object" && !Array.isArray(args) && "pid" in args && typeof args.pid === "number"
			? args.pid
			: undefined;
	const { kernelPid, onTimeoutControl, signal } = options;
	if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0 || kernelPid === undefined || !onTimeoutControl) {
		return { paused: false };
	}
	if (signal?.aborted || !(await isKernelPipChild(pid, kernelPid))) {
		logger.debug("eval %pip wait refused: pid is not a verified kernel pip child", { pid, kernelPid });
		return { paused: false };
	}
	await withBridgeTimeoutPause(onTimeoutControl, () => waitForExit(pid, signal));
	return { paused: true };
}
