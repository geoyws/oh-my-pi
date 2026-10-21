import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { isEnoent, logger, postmortem } from "@oh-my-pi/pi-utils";
import { canonicalProjectDir, daemonRuntimeDir } from "./paths";

const CLIENTS_DIR = "clients";
const BROKER_PID_FILE = "broker.pid";
/**
 * Basename of the container holding per-project daemon scopes
 * (`<state>/run/daemons`). {@link pruneDeadDaemonRuntimeDirs} refuses to sweep
 * any other root so a runtime dir passed from outside the state tree cannot
 * turn the reclaim into an rm -rf of unrelated neighbours (issue #8721).
 */
const DAEMONS_DIR = "daemons";
/**
 * Name shape of a project daemon scope: the 16-hex wyhash of the project dir
 * produced by `getDaemonRuntimeDir`. Only entries matching this are pruned,
 * which excludes the machine-global `global` container and any foreign dir.
 */
const DAEMON_SCOPE_KEY = /^[0-9a-f]{16}$/;
/**
 * Grace before a dead daemon runtime dir becomes prune-eligible. Guards against
 * deleting a scope whose owning omp process is mid-startup (token written, broker
 * not yet spawned, presence not yet registered). The leak this reclaims is a
 * weeks-scale accumulation, so a few minutes of slack costs nothing.
 */
const DAEMON_RUNTIME_STALE_GRACE_MS = 5 * 60_000;

/** Handle keeping one omp process registered in a project daemon scope. */
export interface DaemonProjectPresence {
	close(): Promise<void>;
}

/**
 * Register this omp process so project daemons survive while it remains alive.
 *
 * The entry records the pid together with the process start-time token, so a
 * reader can tell this process apart from an unrelated one that later
 * recycles the pid. SIGKILL or a crash skips the postmortem that removes the
 * file; {@link hasLiveDaemonProjectPresence} drops it instead.
 */
export async function registerDaemonProjectPresence(
	projectDir: string,
	runtimeOverride?: string,
): Promise<DaemonProjectPresence> {
	const canonical = await canonicalProjectDir(projectDir);
	const runtimeDir = runtimeOverride ?? daemonRuntimeDir(canonical);
	const clientsDir = path.join(runtimeDir, CLIENTS_DIR);
	await fs.mkdir(clientsDir, { recursive: true, mode: 0o700 });
	const id = `${process.pid}-${crypto.randomUUID()}`;
	const presencePath = path.join(clientsDir, `${id}.json`);
	const startTime = Process.fromPid(process.pid)?.startTime;
	await Bun.write(presencePath, JSON.stringify({ pid: process.pid, startTime, id, projectDir: canonical }));
	// POSIX modes are meaningless on Windows; chmod there only costs another syscall.
	if (process.platform !== "win32") await fs.chmod(presencePath, 0o600);
	let closed = false;
	const close = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		cancelCleanup();
		await fs.rm(presencePath, { force: true });
	};
	const cancelCleanup = postmortem.register(`daemon-presence:${id}`, () => close());
	return { close };
}

/**
 * Whether the process that wrote a presence entry is still running. A dead pid
 * fails; so does a live pid whose start time differs from the recorded one —
 * the kernel recycled the pid for an unrelated process, which a pid-only check
 * would treat as the owner for as long as that process lives. Entries from
 * builds that predate the start-time field fall back to pid liveness alone.
 */
function isPresenceOwnerAlive(pid: number, startTime: unknown): boolean {
	const owner = Process.fromPid(pid);
	if (!owner || owner.status() !== ProcessStatus.Running) return false;
	return typeof startTime !== "number" || owner.startTime === startTime;
}

/**
 * Return whether a registered omp process in this runtime directory is still
 * alive, deleting entries whose owner is dead or whose pid was recycled.
 */
export async function hasLiveDaemonProjectPresence(runtimeDir: string): Promise<boolean> {
	const clientsDir = path.join(runtimeDir, CLIENTS_DIR);
	let entries: string[];
	try {
		entries = await fs.readdir(clientsDir);
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
	let live = false;
	for (const entry of entries) {
		const presencePath = path.join(clientsDir, entry);
		try {
			const decoded: unknown = await Bun.file(presencePath).json();
			if (
				typeof decoded !== "object" ||
				decoded === null ||
				!("pid" in decoded) ||
				typeof decoded.pid !== "number"
			) {
				await fs.rm(presencePath, { force: true });
				continue;
			}
			if (isPresenceOwnerAlive(decoded.pid, "startTime" in decoded ? decoded.startTime : undefined)) {
				live = true;
			} else {
				await fs.rm(presencePath, { force: true });
			}
		} catch (error) {
			if (!isEnoent(error)) await fs.rm(presencePath, { force: true });
		}
	}
	return live;
}

/** PID recorded in the runtime dir's broker lease when that broker process is still alive; undefined otherwise. */
export async function readLiveDaemonBrokerPid(runtimeDir: string): Promise<number | undefined> {
	let raw: unknown;
	try {
		raw = await Bun.file(path.join(runtimeDir, BROKER_PID_FILE)).json();
	} catch {
		return undefined; // Missing or malformed broker.pid => no owning broker.
	}
	if (typeof raw !== "object" || raw === null || !("pid" in raw) || typeof raw.pid !== "number") {
		return undefined;
	}
	try {
		process.kill(raw.pid, 0);
		return raw.pid;
	} catch {
		return undefined;
	}
}

/**
 * Remove sibling project daemon runtime directories whose broker is dead and
 * whose client-presence set is empty, reclaiming the disk that short-lived
 * project directories leave behind (issue #8674).
 *
 * Best-effort and non-throwing: a scope is deleted only when its `broker.pid`
 * is absent/dead, no live client presence remains, and it has been untouched
 * for {@link DAEMON_RUNTIME_STALE_GRACE_MS}. The caller's own `currentRuntimeDir`
 * is always skipped, and the sweep runs only inside the {@link DAEMONS_DIR}
 * container over entries named like a {@link DAEMON_SCOPE_KEY} — so a runtime
 * dir relocated elsewhere (e.g. the smoke test under `os.tmpdir()`) never
 * reclaims unrelated neighbours (issue #8721).
 */
export async function pruneDeadDaemonRuntimeDirs(currentRuntimeDir: string): Promise<void> {
	const root = path.dirname(currentRuntimeDir);
	if (path.basename(root) !== DAEMONS_DIR) return;
	const current = path.resolve(currentRuntimeDir);
	let entries: Dirent[];
	try {
		entries = await fs.readdir(root, { withFileTypes: true });
	} catch (error) {
		if (!isEnoent(error)) {
			logger.warn("Failed to scan daemon runtime root for pruning", {
				root,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return;
	}
	const now = Date.now();
	for (const entry of entries) {
		if (!entry.isDirectory() || !DAEMON_SCOPE_KEY.test(entry.name)) continue;
		const dir = path.join(root, entry.name);
		if (path.resolve(dir) === current) continue;
		try {
			const stat = await fs.stat(dir);
			if (now - stat.mtimeMs < DAEMON_RUNTIME_STALE_GRACE_MS) continue;
			if ((await readLiveDaemonBrokerPid(dir)) !== undefined) continue;
			if (await hasLiveDaemonProjectPresence(dir)) continue;
			await fs.rm(dir, { recursive: true, force: true });
		} catch (error) {
			if (isEnoent(error)) continue;
			logger.warn("Failed to prune dead daemon runtime dir", {
				dir,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}
