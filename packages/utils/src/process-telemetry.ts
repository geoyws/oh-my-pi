/**
 * Per-process memory and file-descriptor telemetry.
 *
 * Every omp bun process (the CLI command and each `__omp_worker_*` subprocess)
 * samples its own RSS, JS heap, external memory and open fd count on one
 * unref'd timer and writes role-tagged records to its own log file. When the
 * OS kills a runaway process (macOS jetsam leaves only a pid), the log names
 * which omp role that pid was and how fast it grew.
 *
 * Records:
 * - `proc.sample` (debug), at most once per `heartbeatMs`.
 * - `proc.high-water` (warn, flushed at once by the logger) the first time RSS
 *   reaches 1, 2, 4, 8 … GiB or the fd count reaches 256, 512, 1024 ….
 * - `proc.rss-limit` (error), only with the opt-in `OMP_PROC_RSS_LIMIT_MB`,
 *   after which the process sends itself SIGTERM so its normal shutdown runs.
 *
 * Environment (read once at start; worker processes load no settings and
 * inherit the parent's env):
 * - `OMP_PROC_TELEMETRY=0` disables sampling.
 * - `OMP_PROC_TELEMETRY_INTERVAL_MS` sampling interval, minimum 1000, default 5000.
 * - `OMP_PROC_RSS_LIMIT_MB` opt-in RSS limit in MiB; unset or 0 means off.
 */
import * as fs from "node:fs";
import * as logger from "./logger";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
export const DEFAULT_SAMPLE_INTERVAL_MS = 5_000;
export const MIN_SAMPLE_INTERVAL_MS = 1_000;
export const DEFAULT_HEARTBEAT_MS = 60_000;
/** First RSS high-water mark; later marks double. */
export const RSS_FIRST_MARK_BYTES = GIB;
/** First fd high-water mark; later marks double. */
export const FD_FIRST_MARK = 256;

/** One measurement of the current process. */
export interface ProcessSample {
	rss: number;
	heapUsed: number;
	external: number;
	/** Open file descriptors, or undefined where they cannot be counted. */
	fds: number | undefined;
}

interface TelemetryTimer {
	unref?(): void;
}

export interface ProcessTelemetryOptions {
	/** What this process is: the CLI command/mode or the worker selector. */
	role: string;
	intervalMs?: number;
	heartbeatMs?: number;
	/** Opt-in RSS limit in bytes; 0 or undefined disables it. */
	rssLimitBytes?: number;
	/** Injectable for tests. Default: process.memoryUsage and an fd directory count. */
	sample?: () => ProcessSample;
	/** Monotonic clock; injectable for tests. Default `performance.now`. */
	now?: () => number;
	/** Timer source; injectable for tests. Default `setInterval`. */
	schedule?: (cb: () => void, ms: number) => TelemetryTimer;
	/** Cancels the timer `schedule` returned. Default `clearInterval`. */
	cancel?: (timer: TelemetryTimer) => void;
	/** Called once after `proc.rss-limit` is logged. Default: SIGTERM to self. */
	terminate?: () => void;
}

/** Directory listing this process's own fds, or undefined on platforms without one. */
function fdDirectory(): string | undefined {
	if (process.platform === "linux") return "/proc/self/fd";
	if (process.platform === "darwin") return "/dev/fd";
	return undefined;
}

/** Open fd count of this process; the listing's own directory fd is excluded. */
export function countOpenFds(dir: string | undefined = fdDirectory()): number | undefined {
	if (!dir) return undefined;
	try {
		return Math.max(0, fs.readdirSync(dir).length - 1);
	} catch {
		return undefined;
	}
}

function defaultSample(): ProcessSample {
	const usage = process.memoryUsage();
	return { rss: usage.rss, heapUsed: usage.heapUsed, external: usage.external, fds: countOpenFds() };
}

/** Smallest doubling of `first` strictly above `value`. */
function nextMark(value: number, first: number): number {
	let mark = first;
	while (value >= mark) mark *= 2;
	return mark;
}

export class ProcessTelemetry {
	#role: string;
	readonly #intervalMs: number;
	readonly #heartbeatMs: number;
	readonly #rssLimitBytes: number;
	readonly #sample: () => ProcessSample;
	readonly #now: () => number;
	readonly #schedule: (cb: () => void, ms: number) => TelemetryTimer;
	readonly #cancel: (timer: TelemetryTimer) => void;
	readonly #terminate: () => void;
	#timer: TelemetryTimer | undefined;
	#lastHeartbeat: number | undefined;
	#nextRssMark = RSS_FIRST_MARK_BYTES;
	#nextFdMark = FD_FIRST_MARK;
	#limitTripped = false;
	#peakRss = 0;

	constructor(options: ProcessTelemetryOptions) {
		this.#role = options.role;
		this.#intervalMs = Math.max(MIN_SAMPLE_INTERVAL_MS, options.intervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS);
		this.#heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
		this.#rssLimitBytes = options.rssLimitBytes ?? 0;
		this.#sample = options.sample ?? defaultSample;
		this.#now = options.now ?? (() => performance.now());
		this.#schedule = options.schedule ?? ((cb, ms) => setInterval(cb, ms));
		this.#cancel = options.cancel ?? (timer => clearInterval(timer as NodeJS.Timeout));
		this.#terminate = options.terminate ?? (() => process.kill(process.pid, "SIGTERM"));
	}

	get role(): string {
		return this.#role;
	}

	/** Refine the role once it is known (e.g. the launch mode after argument parsing). */
	setRole(role: string): void {
		this.#role = role;
	}

	start(): void {
		if (this.#timer) return;
		this.#timer = this.#schedule(() => this.tick(), this.#intervalMs);
		this.#timer.unref?.();
	}

	stop(): void {
		if (!this.#timer) return;
		this.#cancel(this.#timer);
		this.#timer = undefined;
	}

	/** Take one sample and write whichever records it calls for. */
	tick(): void {
		let sample: ProcessSample;
		try {
			sample = this.#sample();
		} catch {
			return;
		}
		this.#peakRss = Math.max(this.#peakRss, sample.rss);
		const context = this.#context(sample);
		const now = this.#now();
		if (this.#lastHeartbeat === undefined || now - this.#lastHeartbeat >= this.#heartbeatMs) {
			this.#lastHeartbeat = now;
			logger.debug("proc.sample", context);
		}
		if (sample.rss >= this.#nextRssMark) {
			const mark = nextMark(sample.rss, RSS_FIRST_MARK_BYTES) / 2;
			this.#nextRssMark = mark * 2;
			logger.warn("proc.high-water", { ...context, kind: "rss", markGiB: mark / GIB });
		}
		if (sample.fds !== undefined && sample.fds >= this.#nextFdMark) {
			const mark = nextMark(sample.fds, FD_FIRST_MARK) / 2;
			this.#nextFdMark = mark * 2;
			logger.warn("proc.high-water", { ...context, kind: "fds", markFds: mark });
		}
		if (this.#rssLimitBytes > 0 && sample.rss > this.#rssLimitBytes && !this.#limitTripped) {
			this.#limitTripped = true;
			logger.error("proc.rss-limit", { ...context, limitMiB: Math.round(this.#rssLimitBytes / MIB) });
			this.stop();
			this.#terminate();
		}
	}

	#context(sample: ProcessSample): Record<string, unknown> {
		return {
			role: this.#role,
			ppid: process.ppid,
			rssMiB: Math.round(sample.rss / MIB),
			peakRssMiB: Math.round(this.#peakRss / MIB),
			heapUsedMiB: Math.round(sample.heapUsed / MIB),
			externalMiB: Math.round(sample.external / MIB),
			fds: sample.fds,
		};
	}
}

/** Parsed environment controls; see the module comment. */
export interface ProcessTelemetryEnv {
	enabled: boolean;
	intervalMs: number;
	rssLimitBytes: number;
}

export function readProcessTelemetryEnv(env: Record<string, string | undefined> = process.env): ProcessTelemetryEnv {
	const flag = env.OMP_PROC_TELEMETRY?.trim().toLowerCase();
	const enabled = !(flag === "0" || flag === "false" || flag === "off" || flag === "no");
	const interval = Number(env.OMP_PROC_TELEMETRY_INTERVAL_MS);
	const intervalMs =
		Number.isFinite(interval) && interval > 0
			? Math.max(MIN_SAMPLE_INTERVAL_MS, Math.floor(interval))
			: DEFAULT_SAMPLE_INTERVAL_MS;
	const limit = Number(env.OMP_PROC_RSS_LIMIT_MB);
	const rssLimitBytes = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) * MIB : 0;
	return { enabled, intervalMs, rssLimitBytes };
}

let active: ProcessTelemetry | undefined;

/**
 * Start this process's sampler once (later calls only refine the role).
 * Returns undefined when disabled by `OMP_PROC_TELEMETRY=0`.
 */
export function startProcessTelemetry(role: string): ProcessTelemetry | undefined {
	if (active) {
		active.setRole(role);
		return active;
	}
	const env = readProcessTelemetryEnv();
	if (!env.enabled) return undefined;
	active = new ProcessTelemetry({ role, intervalMs: env.intervalMs, rssLimitBytes: env.rssLimitBytes });
	active.start();
	return active;
}

/** Refine the running sampler's role; a no-op when none runs. */
export function setProcessTelemetryRole(role: string): void {
	active?.setRole(role);
}
