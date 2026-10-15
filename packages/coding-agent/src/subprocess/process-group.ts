/**
 * POSIX process-group signalling for subprocesses omp spawns `detached`.
 *
 * Every runtime omp owns and may have to hard-kill — the Python/managed
 * language kernels and the isolated JS eval worker — is spawned detached, so
 * the child calls `setsid()` and leads its own session and process group.
 * Signalling only the direct pid therefore leaves everything *it* spawned
 * behind, and those orphans keep pipes open (and CPU burning) for the rest of
 * the omp process lifetime (#7714). Callers must sweep the group as well.
 */

/**
 * True when `pid` is safe to use as a process-group target for `kill(2)`.
 *
 * `process.kill(-pid, …)` is a group signal, and the degenerate targets are
 * catastrophic rather than merely useless: `-0` signals *our own* process group
 * (omp would kill itself along with the whole terminal job) and `-1` signals
 * every process the user is permitted to signal. Both must be rejected before
 * the negation is applied.
 */
export function isSignalableProcessGroup(pid: number | undefined): pid is number {
	return typeof pid === "number" && Number.isInteger(pid) && pid > 1;
}

/**
 * Signal the whole process group led by `pid`, returning true when a signal was
 * actually delivered.
 *
 * Only valid for a child spawned `detached` (hence a group leader of its own).
 * A child sharing the parent's group would make `-pid` either meaningless or,
 * worse, aimed at omp itself — see {@link isSignalableProcessGroup}.
 *
 * Windows has no process groups, so this is a no-op there and callers keep
 * relying on the direct-PID kill.
 */
export function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): boolean {
	if (process.platform === "win32") return false;
	if (!isSignalableProcessGroup(pid)) return false;
	try {
		process.kill(-pid, signal);
		return true;
	} catch {
		// ESRCH: the group is already gone, which is the outcome we wanted anyway.
		// EPERM: not ours to signal. Neither is worth failing a shutdown over.
		return false;
	}
}
