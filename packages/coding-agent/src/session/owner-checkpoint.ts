import { Process } from "@oh-my-pi/pi-natives";
import type { AgentSession } from "./agent-session";

interface OwnerIdentity {
	pid: number;
	startTime: number;
}

function readOwnerIdentity(): OwnerIdentity | undefined {
	const owner = Process.fromPid(process.pid);
	if (!owner || !Number.isFinite(owner.startTime)) return;
	return { pid: process.pid, startTime: owner.startTime };
}

/** Explicit owner request only. Never accepts a target PID or signals another process. */
export async function checkpointOwnerSession(
	session: AgentSession,
	close: () => Promise<void>,
	hasPendingSubmission: () => boolean,
	readIdentity: () => OwnerIdentity | undefined = readOwnerIdentity,
): Promise<void> {
	const idle = () =>
		!hasPendingSubmission() &&
		!session.isStreaming &&
		!session.isBashRunning &&
		!session.isEvalRunning &&
		!session.hasAdmittedSubmission &&
		session.queuedMessageCount === 0 &&
		!session.hasPendingAsyncWork() &&
		!session.isCompacting &&
		!session.isGeneratingHandoff;
	const owner = readIdentity();
	if (!owner || !idle())
		throw new Error("Checkpoint refused: this owner must be identifiable and idle; active work is untouched.");
	await session.sessionManager.ensureOnDisk({ preserveOnClose: true });
	await session.sessionManager.flush();
	if (!session.sessionManager.isSessionOnDisk())
		throw new Error("Checkpoint refused: no durable transcript to resume.");
	const current = readIdentity();
	if (!current || current.pid !== owner.pid || current.startTime !== owner.startTime || !idle()) {
		throw new Error("Checkpoint refused: owner identity or activity changed; session remains live.");
	}
	// No await between final owner/activity validation and the host's synchronous close latch.
	await close();
}
