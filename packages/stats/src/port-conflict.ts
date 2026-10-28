import * as crypto from "node:crypto";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $which, getStatsDashboardTokenPath, loadOrCreateCapabilityToken } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

const STATS_PROBE_TIMEOUT_MS = 500;
const PROCESS_EXIT_POLL_MS = 50;
const PROCESS_EXIT_POLLS = 10;
const STATS_RUNTIME_IMAGES: Record<string, true> = { bun: true, node: true, omp: true, "omp-stats": true };

interface PortHolder {
	pid: number;
	image: string;
	commandLine: string;
}

/** Header stamped on every dashboard response so reuse probes can identify us. */
export const STATS_DASHBOARD_HEADER = "x-omp-stats-dashboard";
/** Header recording the server's requested bind host so reuse cannot change its exposure scope. */
export const STATS_DASHBOARD_HOSTNAME_HEADER = "x-omp-stats-hostname";

/** Request header carrying the reuse probe's random challenge. */
export const STATS_DASHBOARD_CHALLENGE_HEADER = "x-omp-stats-challenge";
/** Response header answering the challenge with proof the server holds this user's capability. */
export const STATS_DASHBOARD_PROOF_HEADER = "x-omp-stats-proof";

/** Identity-header value for dashboards requiring the capability token, answering proof challenges and issuing per-listener launch secrets. */
export const STATS_DASHBOARD_SECURITY_VERSION = "6";

/** IPv4 loopback address shared by the dashboard server and reuse probe. */
export const STATS_DASHBOARD_HOSTNAME = "127.0.0.1";

/**
 * The numeric address a dashboard binds, keys its state by, signs and prints for `hostname`.
 * `localhost` may resolve to `::1` or `127.0.0.1`, so a link or exchange naming it could reach
 * another user's listener on the other family with the same port; it is pinned to `127.0.0.1`.
 */
export function canonicalStatsHostname(hostname: string): string {
	return hostname.toLowerCase() === "localhost" ? STATS_DASHBOARD_HOSTNAME : hostname;
}

const CHALLENGE_RE = /^[A-Za-z0-9_-]{22,128}$/;

/**
 * Proof that a dashboard holds the capability `token`, bound to the bind host and the port it
 * answers on: a relay that forwards the challenge to a genuine dashboard on another port gets a
 * proof for that port, which the probe rejects. The token itself never leaves the server.
 * Returns null for a malformed challenge.
 */
export function statsDashboardProof(token: string, hostname: string, port: number, challenge: string): string | null {
	if (!CHALLENGE_RE.test(challenge)) return null;
	return crypto
		.createHmac("sha256", token)
		.update(`omp-stats-dashboard-proof\n${hostname}\n${port}\n${challenge}`)
		.digest("base64url");
}

/** Body field of a credential-less `/api/launch` answer carrying a single-use nonce. */
export const STATS_LAUNCH_NONCE_FIELD = "nonce";

/**
 * HMAC a client presents to `/api/launch` for `nonce`, under the capability `token`, bound to the
 * bind host and port of the dashboard it means: a dashboard checks it against its own, so an
 * exchange relayed from any other address or port is refused. The token never travels.
 */
export function statsLaunchMac(token: string, hostname: string, port: number, nonce: string): string {
	return crypto
		.createHmac("sha256", token)
		.update(`omp-stats-launch\n${hostname}\n${port}\n${nonce}`)
		.digest("base64url");
}

/** The address a same-user client dials for a dashboard bound to `hostname` (wildcards map to loopback). */
function dashboardDialBase(hostname: string, port: number): string {
	const dialHostname = hostname === "0.0.0.0" ? STATS_DASHBOARD_HOSTNAME : hostname === "::" ? "::1" : hostname;
	return `http://${dialHostname.includes(":") ? `[${dialHostname}]` : dialHostname}:${port}`;
}

/**
 * The launch secret of the dashboard listening on `hostname:port`, obtained without sending the
 * capability: a credential-less `/api/launch` returns a single-use nonce, and the HMAC over it
 * (see {@link statsLaunchMac}) earns that listener's launch secret, which dies with the listener.
 */
export async function fetchStatsLaunchSecret(requestedHostname: string, port: number): Promise<string> {
	const hostname = canonicalStatsHostname(requestedHostname);
	const base = dashboardDialBase(hostname, port);
	const challenge = await fetch(`${base}/api/launch`, { signal: AbortSignal.timeout(STATS_PROBE_TIMEOUT_MS * 4) });
	const offered: unknown = await challenge.json().catch(() => null);
	const nonce =
		challenge.status === 401 && typeof offered === "object" && offered !== null
			? (offered as Record<string, unknown>)[STATS_LAUNCH_NONCE_FIELD]
			: undefined;
	if (typeof nonce !== "string" || nonce.length === 0) {
		throw new Error(`The stats dashboard at ${base} did not offer a launch credential.`);
	}
	const mac = statsLaunchMac(loadOrCreateCapabilityToken(getStatsDashboardTokenPath()), hostname, port, nonce);
	const response = await fetch(
		`${base}/api/launch?nonce=${encodeURIComponent(nonce)}&mac=${encodeURIComponent(mac)}`,
		{
			signal: AbortSignal.timeout(STATS_PROBE_TIMEOUT_MS * 4),
		},
	);
	const body: unknown = await response.json().catch(() => null);
	const launch = typeof body === "object" && body !== null ? (body as Record<string, unknown>).launch : undefined;
	if (!response.ok || typeof launch !== "string" || launch.length === 0) {
		throw new Error(`The stats dashboard at ${base} refused this user's launch request (HTTP ${response.status}).`);
	}
	return launch;
}

type StatsDashboardProbe = "reusable" | "replaceable" | "occupied" | "unreachable";

/**
 * Classify whatever listens on `port` without disclosing the capability token: the probe sends
 * only a random challenge, and a dashboard is reusable only when it answers with a valid proof.
 * An unauthenticated legacy dashboard (version 1–3, answering 200 without a token) is replaceable.
 */
async function probeStatsDashboard(port: number, hostname: string): Promise<StatsDashboardProbe> {
	const urlBase = dashboardDialBase(hostname, port);
	try {
		const challenge = crypto.randomBytes(24).toString("base64url");
		const response = await fetch(`${urlBase}/api/stats/models`, {
			signal: AbortSignal.timeout(STATS_PROBE_TIMEOUT_MS),
			headers: { [STATS_DASHBOARD_CHALLENGE_HEADER]: challenge },
		});
		const dashboardVersionHeader = response.headers.get(STATS_DASHBOARD_HEADER);
		const dashboardVersion = dashboardVersionHeader === null ? Number.NaN : Number(dashboardVersionHeader);
		const presentedProof = response.headers.get(STATS_DASHBOARD_PROOF_HEADER);
		const expectedProof = statsDashboardProof(
			loadOrCreateCapabilityToken(getStatsDashboardTokenPath()),
			hostname,
			port,
			challenge,
		);
		const proven =
			presentedProof !== null &&
			expectedProof !== null &&
			presentedProof.length === expectedProof.length &&
			crypto.timingSafeEqual(Buffer.from(presentedProof), Buffer.from(expectedProof));
		// Never replace a newer dashboard: an older CLI must not downgrade it.
		const replaceable =
			response.status === 200 &&
			Number.isSafeInteger(dashboardVersion) &&
			dashboardVersion > 0 &&
			dashboardVersion <= Number(STATS_DASHBOARD_SECURITY_VERSION);
		const reusable =
			proven &&
			dashboardVersionHeader === STATS_DASHBOARD_SECURITY_VERSION &&
			response.headers.get(STATS_DASHBOARD_HOSTNAME_HEADER) === hostname &&
			!response.headers.has("Access-Control-Allow-Origin");
		await response.body?.cancel();
		if (reusable) return "reusable";
		return replaceable ? "replaceable" : "occupied";
	} catch {
		return "unreachable";
	}
}

async function findLinuxPortHolder(port: number): Promise<PortHolder | null> {
	const socketInodes = new Set<string>();
	for (const tablePath of ["/proc/net/tcp", "/proc/net/tcp6"]) {
		let table: string;
		try {
			table = await Bun.file(tablePath).text();
		} catch {
			continue;
		}

		for (const line of table.split("\n").slice(1)) {
			const fields = line.trim().split(/\s+/);
			const localAddress = fields[1];
			const state = fields[3];
			const inode = fields[9];
			if (!localAddress || state !== "0A" || !inode) continue;
			const encodedPort = localAddress.slice(localAddress.lastIndexOf(":") + 1);
			if (Number.parseInt(encodedPort, 16) === port) socketInodes.add(inode);
		}
	}
	if (socketInodes.size === 0) return null;

	let processes: Dirent[];
	try {
		processes = await fs.readdir("/proc", { withFileTypes: true });
	} catch {
		return null;
	}

	for (const entry of processes) {
		if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
		const pid = Number.parseInt(entry.name, 10);
		let descriptors: string[];
		try {
			descriptors = await fs.readdir(`/proc/${pid}/fd`);
		} catch {
			continue;
		}

		let ownsSocket = false;
		for (const descriptor of descriptors) {
			try {
				const target = await fs.readlink(`/proc/${pid}/fd/${descriptor}`);
				const match = /^socket:\[(\d+)]$/.exec(target);
				if (match?.[1] && socketInodes.has(match[1])) {
					ownsSocket = true;
					break;
				}
			} catch {}
		}
		if (!ownsSocket) continue;

		let commandLine = "";
		try {
			const rawCommandLine = await Bun.file(`/proc/${pid}/cmdline`).text();
			commandLine = rawCommandLine.split("\0").filter(Boolean).join(" ");
		} catch {}

		try {
			const executable = await fs.readlink(`/proc/${pid}/exe`);
			return { pid, image: path.basename(executable), commandLine };
		} catch {
			const executable = commandLine.split(" ", 1)[0];
			return { pid, image: executable ? path.basename(executable) : "unknown", commandLine };
		}
	}
	return null;
}

async function findMacPortHolder(port: number): Promise<PortHolder | null> {
	const lsof = $which("lsof") ?? ((await Bun.file("/usr/sbin/lsof").exists()) ? "/usr/sbin/lsof" : null);
	if (!lsof) return null;

	const selector = `-iTCP:${port}`;
	const result = await $`${lsof} -nP ${selector} -sTCP:LISTEN -Fpc`.quiet().nothrow();
	if (result.exitCode !== 0) return null;

	let pid: number | null = null;
	let image = "unknown";
	for (const line of result.text().split("\n")) {
		if (line.startsWith("p")) {
			const parsed = Number.parseInt(line.slice(1), 10);
			pid = Number.isSafeInteger(parsed) ? parsed : null;
		} else if (line.startsWith("c") && pid !== null) {
			image = line.slice(1) || "unknown";
			break;
		}
	}
	if (pid === null) return null;

	const ps = $which("ps");
	if (!ps) return { pid, image, commandLine: "" };
	const processInfo = await $`${ps} -ww -p ${pid} -o command=`.quiet().nothrow();
	return { pid, image, commandLine: processInfo.exitCode === 0 ? processInfo.text().trim() : "" };
}

async function findWindowsPortHolder(port: number): Promise<PortHolder | null> {
	const netstat = $which("netstat");
	if (!netstat) return null;

	const result = await $`${netstat} -ano -p TCP`.quiet().nothrow();
	if (result.exitCode !== 0) return null;

	let pid: number | null = null;
	for (const line of result.text().split("\n")) {
		const fields = line.trim().split(/\s+/);
		if (fields[0]?.toUpperCase() !== "TCP" || fields[3]?.toUpperCase() !== "LISTENING") continue;
		const localAddress = fields[1];
		if (!localAddress || Number.parseInt(localAddress.slice(localAddress.lastIndexOf(":") + 1), 10) !== port) {
			continue;
		}
		const parsed = Number.parseInt(fields[4] ?? "", 10);
		if (Number.isSafeInteger(parsed)) {
			pid = parsed;
			break;
		}
	}
	if (pid === null) return null;

	let image = "unknown";
	const tasklist = $which("tasklist");
	if (tasklist) {
		const filter = `PID eq ${pid}`;
		const task = await $`${tasklist} /FI ${filter} /FO CSV /NH`.quiet().nothrow();
		if (task.exitCode === 0) {
			const imageMatch = /^"((?:[^"]|"")*)"/.exec(task.text().trim());
			image = imageMatch?.[1]?.replaceAll('""', '"') || "unknown";
		}
	}

	const powershell = $which("powershell") ?? $which("pwsh");
	if (!powershell) return { pid, image, commandLine: "" };
	const command = `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`;
	const processInfo = await $`${powershell} -NoProfile -NonInteractive -Command ${command}`.quiet().nothrow();
	return { pid, image, commandLine: processInfo.exitCode === 0 ? processInfo.text().trim() : "" };
}

async function findPortHolder(port: number): Promise<PortHolder | null> {
	if (process.platform === "linux") return findLinuxPortHolder(port);
	if (process.platform === "darwin") return findMacPortHolder(port);
	if (process.platform === "win32") return findWindowsPortHolder(port);
	return null;
}

async function terminatePortHolder(holder: PortHolder): Promise<void> {
	try {
		process.kill(holder.pid, "SIGTERM");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
		throw new Error(`Failed to stop ${holder.image} (PID ${holder.pid})`, { cause: error });
	}

	for (let attempt = 0; attempt < PROCESS_EXIT_POLLS; attempt++) {
		await Bun.sleep(PROCESS_EXIT_POLL_MS);
		try {
			process.kill(holder.pid, 0);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
			throw new Error(`Failed to inspect ${holder.image} (PID ${holder.pid})`, { cause: error });
		}
	}

	try {
		process.kill(holder.pid, "SIGKILL");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
		throw new Error(`Failed to kill ${holder.image} (PID ${holder.pid})`, { cause: error });
	}
	await Bun.sleep(PROCESS_EXIT_POLL_MS);
}

async function reclaimStatsPort(port: number, hasDashboardIdentity = false): Promise<"retry"> {
	const holder = await findPortHolder(port);
	if (!holder) {
		throw new Error(`Port ${port} is in use, but the listening process could not be identified.`);
	}
	if (holder.pid === process.pid) {
		throw new Error(`Port ${port} is held by the current process (${holder.image}, PID ${holder.pid}).`);
	}

	const normalizedImage = holder.image
		.toLowerCase()
		.replace(/\.exe$/, "")
		.replace(/ \(deleted\)$/, "");
	const normalizedCommand = holder.commandLine.toLowerCase().replaceAll("\\", "/");
	const hasStatsIdentity =
		normalizedImage === "omp-stats" ||
		/(?:^|[/"'\s])omp-stats(?:\.exe)?(?:["'\s]|$)/.test(normalizedCommand) ||
		/\/packages\/stats\/src\/index\.ts(?:["'\s]|$)/.test(normalizedCommand) ||
		(normalizedImage === "omp" && /(?:^|\s)stats(?:\s|$)/.test(normalizedCommand)) ||
		/(?:^|\/)omp(?:\.exe)?["'\s]+stats(?:["'\s]|$)/.test(normalizedCommand);
	if (!STATS_RUNTIME_IMAGES[normalizedImage] || (!hasStatsIdentity && !hasDashboardIdentity)) {
		throw new Error(
			`Port ${port} is in use by ${holder.image} (PID ${holder.pid}), which is not identifiable as an omp stats dashboard; refusing to stop it.`,
		);
	}

	await terminatePortHolder(holder);
	return "retry";
}

/**
 * Reuse a secure dashboard or reclaim an insecure HTTP dashboard before binding.
 * The preflight is needed on platforms that permit wildcard and loopback-specific
 * listeners to coexist on one port.
 */
export async function prepareStatsPort(port: number, hostname = STATS_DASHBOARD_HOSTNAME): Promise<"retry" | "reuse"> {
	if (port === 0) return "retry";
	const probe = await probeStatsDashboard(port, hostname);
	if (probe === "reusable") return "reuse";
	if (probe === "replaceable") return reclaimStatsPort(port, true);
	if (probe === "occupied") return reclaimStatsPort(port);
	return "retry";
}

/** Reuse or reclaim a listener found after the server bind reports EADDRINUSE. */
export async function recoverStatsPort(port: number, hostname = STATS_DASHBOARD_HOSTNAME): Promise<"retry" | "reuse"> {
	const probe = await probeStatsDashboard(port, hostname);
	if (probe === "reusable") return "reuse";
	return reclaimStatsPort(port, probe === "replaceable");
}
