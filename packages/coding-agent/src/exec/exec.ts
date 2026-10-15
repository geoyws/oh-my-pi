/**
 * Shared command execution utilities for hooks and custom tools.
 */
import { postmortem, ptree } from "@oh-my-pi/pi-utils";

/**
 * Options for executing shell commands.
 */
export interface ExecOptions {
	/** AbortSignal to cancel the command */
	signal?: AbortSignal;
	/** Timeout in milliseconds */
	timeout?: number;
	/** Working directory */
	cwd?: string;
}

/**
 * Result of executing a shell command.
 */
export interface ExecResult {
	stdout: string;
	stderr: string;
	/** Process exit code; `-1` when execution was aborted or no exit code was available. */
	code: number;
	/** True when the process was killed by `timeout` or `signal`. */
	killed: boolean;
}

/**
 * Live detached `execCommand` children by process group.
 *
 * Every `execCommand` child runs detached (its own session/process group) so
 * abort/timeout signals the whole group, not just the direct child. The
 * trade-off is that the kernel's SIGHUP-on-terminal-close path no longer
 * reaches these children, and callers often pass no signal at all (session
 * shutdown hooks, status hooks). Without tracking, such a child would be
 * reparented to PID 1 and outlive omp. Each entry resolves when its call
 * settles — which, on abort, is after the whole-group TERM→KILL escalation —
 * so awaiting the entries means the recorded groups are dead.
 */
interface LiveExecCommand {
	child: ptree.ChildProcess;
	settled: Promise<void>;
}
const liveExecCommands = new Set<LiveExecCommand>();

/**
 * Upper bound on how long dispose/postmortem teardown waits for a killed
 * `execCommand` group to exit. Group termination itself is graceful-first
 * (TERM, then KILL after ~1s for a TERM-ignoring group); an unkillable group
 * must not stall process exit. The timer is unref'd so it never keeps the
 * process alive on its own.
 */
const EXEC_SHUTDOWN_WAIT_MS = 2_500;

let execCleanupRegistered = false;

function ensureExecCleanupRegistered(): void {
	if (execCleanupRegistered) return;
	execCleanupRegistered = true;
	postmortem.register("exec-commands", () => shutdownExecCommands());
}

function execShutdownDeadline(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(resolve, ms);
	timer.unref?.();
	return promise;
}

/**
 * TERM-then-KILL every live `execCommand` group and wait (bounded) for the
 * groups to exit. Runs from the postmortem SIGTERM/SIGHUP/exit teardown and
 * from session dispose, so hook/extension/custom-tool children with no signal
 * of their own still die with the session instead of orphaning to PID 1.
 * Abandoned callers observe the kill as `killed: true`.
 */
export async function shutdownExecCommands(timeoutMs = EXEC_SHUTDOWN_WAIT_MS): Promise<void> {
	const live = [...liveExecCommands];
	if (live.length === 0) return;
	for (const { child } of live) {
		try {
			child.kill(new ptree.AbortError("exec command disposed", ""));
		} catch {}
	}
	await Promise.race([Promise.allSettled(live.map(entry => entry.settled)), execShutdownDeadline(timeoutMs)]);
}

/**
 * Execute a shell command and return stdout/stderr/code.
 * Supports timeout and abort signal.
 */
export async function execCommand(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
): Promise<ExecResult> {
	ensureExecCleanupRegistered();
	// Spawned (not `ptree.exec`) so the child handle can join the live-group
	// registry below; the wait options match `ptree.exec` exactly.
	const child = ptree.spawn([command, ...args], {
		cwd,
		signal: options?.signal,
		timeout: options?.timeout,
		stderr: "full",
		// Own process group (setsid) on POSIX so abort/timeout signals the
		// whole group (TERM→KILL escalation in `ChildProcess.kill`), not just
		// the direct child — grandchildren must not outlive the call.
		// Windows has no process groups; the retained-handle tree kill applies.
		...(process.platform === "win32" ? {} : { detached: true }),
	});
	let markSettled!: () => void;
	const settled = new Promise<void>(resolve => {
		markSettled = resolve;
	});
	const entry: LiveExecCommand = { child, settled };
	liveExecCommands.add(entry);
	// Pre-handle the exit rejection: a kill can settle `#exited` while
	// `wait()` below is still blocked on pipe EOF (a live grandchild holding
	// the pipe), and a rejection with no attached handler fires
	// `unhandledRejection` even though `wait()` observes it a tick later.
	// This mirrors the pre-attached catch in `attachSignal`/`attachTimeout`.
	child.exited.catch(() => {});
	try {
		const result = await child.wait({
			allowNonZero: true,
			allowAbort: true,
			stderr: "full",
		});
		const killed = Boolean(result.exitError?.aborted);
		return {
			stdout: result.stdout,
			stderr: result.stderr,
			code: killed ? -1 : (result.exitCode ?? -1),
			killed,
		};
	} finally {
		// Resolve only once `wait()` returns: on a kill that is after the
		// whole-group TERM→KILL escalation, so awaiting `settled` means the
		// recorded group is dead. The entry leaves the registry here, not
		// when the caller stops awaiting — an abandoned call's group stays
		// covered by `shutdownExecCommands` until its own wait completes.
		liveExecCommands.delete(entry);
		markSettled();
	}
}
