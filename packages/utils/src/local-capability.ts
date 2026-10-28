/**
 * Per-user capability tokens for loopback servers (browser relay, stats
 * dashboard).
 *
 * Binding to 127.0.0.1 keeps a listener off the network, but every local OS
 * user can still connect to it, and a web page can reach it through DNS
 * rebinding. A random token kept in a file only this user can read closes
 * both: other users cannot read the file, and a rebinding page never learns
 * the token. Servers also refuse Host headers that name a domain (see
 * {@link isRebindingSafeHost}).
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** 32 random bytes, base64url without padding. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * True when `filePath` is a regular file (not a symlink) owned by this user
 * and unreadable by group and other. Windows has no POSIX owner/mode bits, so
 * there only the file type is checked.
 */
function isPrivateFile(stat: fs.Stats): boolean {
	if (!stat.isFile()) return false;
	if (process.platform === "win32") return true;
	const uid = process.getuid?.();
	if (uid !== undefined && stat.uid !== uid) return false;
	return (stat.mode & 0o077) === 0;
}

function readPrivateToken(filePath: string): string | null {
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(filePath);
	} catch {
		return null;
	}
	if (!isPrivateFile(stat)) return null;
	try {
		const token = fs.readFileSync(filePath, "utf8").trim();
		return TOKEN_RE.test(token) ? token : null;
	} catch {
		return null;
	}
}

/** A creation lock older than this belongs to a crashed creator and is broken. */
const LOCK_STALE_MS = 10_000;
/** How long a creator waits for another to publish before giving up. */
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 10;

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` holding an exclusive `<filePath>.lock` (O_EXCL create), so only one
 * process at a time decides whether to replace the token file. A lock left by a
 * crashed creator is broken once it is older than {@link LOCK_STALE_MS}.
 */
function withCreationLock<T>(filePath: string, fn: () => T): T {
	const lockPath = `${filePath}.lock`;
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		let fd: number;
		try {
			fd = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			try {
				if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(lockPath);
			} catch {}
			if (Date.now() > deadline) throw new Error(`Timed out waiting for capability token lock ${lockPath}`);
			sleepSync(LOCK_POLL_MS);
			continue;
		}
		fs.closeSync(fd);
		try {
			return fn();
		} finally {
			try {
				fs.unlinkSync(lockPath);
			} catch {}
		}
	}
}

/**
 * Read the capability token stored at `filePath`, creating it when it is
 * missing, malformed, or unsafe (a symlink, owned by another user, or
 * readable by group/other). A token that may have been exposed is replaced,
 * never reused. The file is created with mode 0600 and its parent with 0700.
 *
 * Creation is serialized by a lock and re-checks the file under it, so
 * concurrent first users converge on one token instead of one replacing
 * another's; the token is written to a private temp file and renamed into
 * place, so readers never see a partially written file.
 */
export function loadOrCreateCapabilityToken(filePath: string): string {
	const existing = readPrivateToken(filePath);
	if (existing) return existing;
	fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
	return withCreationLock(filePath, () => {
		const winner = readPrivateToken(filePath);
		if (winner) return winner;
		const token = crypto.randomBytes(32).toString("base64url");
		const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
		const fd = fs.openSync(tempPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
		try {
			fs.writeSync(fd, `${token}\n`);
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		try {
			// rename replaces a missing, malformed or unsafe file (a symlink itself, never its target).
			fs.renameSync(tempPath, filePath);
		} catch (err) {
			try {
				fs.unlinkSync(tempPath);
			} catch {}
			throw err;
		}
		return token;
	});
}

/** Constant-time comparison of a presented token against the expected one. */
export function capabilityTokenMatches(expected: string, presented: string | null | undefined): boolean {
	if (!presented) return false;
	const a = Buffer.from(expected);
	const b = Buffer.from(presented);
	return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * True when a request's Host header cannot be the product of DNS rebinding:
 * it names `localhost` or an IP literal. A rebinding attack needs a domain
 * name the attacker controls, so any other hostname is refused. A missing or
 * unparseable Host is refused too.
 */
export function isRebindingSafeHost(hostHeader: string | null | undefined): boolean {
	const raw = hostHeader?.trim();
	if (!raw || /[\s/\\@#?]/.test(raw)) return false;
	let hostname: string;
	try {
		hostname = new URL(`http://${raw}`).hostname.toLowerCase();
	} catch {
		return false;
	}
	if (hostname === "localhost") return true;
	if (hostname.startsWith("[") && hostname.endsWith("]")) return true;
	return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}
