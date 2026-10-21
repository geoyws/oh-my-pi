/**
 * Shared command execution utilities for hooks and custom tools.
 */
import { AsyncLocalStorage } from "node:async_hooks";
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
	/**
	 * Owning session: session dispose kills only entries with a matching
	 * owner. Defaults to the ambient `runWithExecOwner` scope; without
	 * either, only the postmortem process-exit teardown kills the child.
	 */
	sessionKey?: string;
}

/**
 * Ambient owner for `execCommand` children, mirroring `withFileMutationSession`:
 * entered per hook/tool/command invocation by the runner that owns the
 * handlers, so no caller has to thread a session id through for attribution
 * to work. An explicit {@link ExecOptions.sessionKey} wins over the ambient
 * scope. Work that escapes the invocation's async chain (un-awaited timers)
 * loses the scope and degrades to postmortem-only teardown.
 */
const execOwnerStorage = new AsyncLocalStorage<string>();

/**
 * Owners whose session has run its dispose-time `shutdownExecCommands(owner)`.
 * Work the disposing session still triggers after that single kill snapshot —
 * a `session_shutdown` handler past its 2s cap, a `tool_result` or `agent_end`
 * handler fired as the aborted turn settles — runs inside the owner scope, and
 * a `pi.exec` it starts would otherwise run unkilled until process exit. Such
 * calls are refused instead. Entering the scope never reopens an owner: only
 * {@link reopenExecOwner}, when a live session takes that id again.
 */
const closedExecOwners = new Set<string>();

export function runWithExecOwner<T>(owner: string | undefined, fn: () => T): T {
	return owner === undefined ? fn() : execOwnerStorage.run(owner, fn);
}

/** A live session (constructed for, or switched to, `owner`) may spawn under that id again. */
export function reopenExecOwner(owner: string): void {
	closedExecOwners.delete(owner);
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
 *
 * `owner` is the session the child runs for (explicit `sessionKey` or the
 * ambient `runWithExecOwner` scope). Session dispose kills only its own
 * entries, so a subagent finishing never kills another session's in-flight
 * hook/tool children; entries without an owner die only in the postmortem
 * process-exit teardown.
 */
interface LiveExecCommand {
	child: ptree.ChildProcess;
	settled: Promise<void>;
	owner: string | undefined;
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
 * TERM-then-KILL live `execCommand` groups and wait (bounded) for them to
 * exit. With an `owner`, only that session's entries are killed — this is
 * what session dispose calls, so finishing sessions never kill another
 * session's in-flight hook/extension/tool children. Without an `owner`
 * every live entry is killed: the postmortem SIGTERM/SIGHUP/exit teardown,
 * so signal-less children still die with the process instead of orphaning
 * to PID 1. Abandoned callers observe the kill as `killed: true`.
 */
export async function shutdownExecCommands(owner?: string, timeoutMs = EXEC_SHUTDOWN_WAIT_MS): Promise<void> {
	if (owner !== undefined) closedExecOwners.add(owner);
	const live =
		owner === undefined ? [...liveExecCommands] : [...liveExecCommands].filter(entry => entry.owner === owner);
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
	// Explicit `sessionKey` wins; otherwise the ambient `runWithExecOwner`
	// scope names the invoking session. Unowned entries die only in the
	// postmortem all-kill — never by another session's dispose.
	const owner = options?.sessionKey ?? execOwnerStorage.getStore();
	// The owner already ran its dispose kill: spawning now would escape it.
	if (owner !== undefined && closedExecOwners.has(owner)) return { stdout: "", stderr: "", code: -1, killed: true };
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
	const entry: LiveExecCommand = { child, settled, owner };
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
