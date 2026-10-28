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

/**
 * Read the capability token stored at `filePath`, creating it when it is
 * missing, malformed, or unsafe (a symlink, owned by another user, or
 * readable by group/other). A token that may have been exposed is replaced,
 * never reused. The file is created with mode 0600 and its parent with 0700.
 * Concurrent creators converge on whichever file was written first.
 */
export function loadOrCreateCapabilityToken(filePath: string): string {
	const existing = readPrivateToken(filePath);
	if (existing) return existing;
	fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
	try {
		fs.unlinkSync(filePath);
	} catch {}
	const token = crypto.randomBytes(32).toString("base64url");
	try {
		const fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
		try {
			fs.writeSync(fd, `${token}\n`);
		} finally {
			fs.closeSync(fd);
		}
		return token;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		// Another process created it between our unlink and open; adopt its token.
		const winner = readPrivateToken(filePath);
		if (winner) return winner;
		throw new Error(`Capability token file ${filePath} is not a private file owned by this user`);
	}
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
