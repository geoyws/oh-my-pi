import { afterEach, describe, expect, test, vi } from "bun:test";
import * as logger from "@oh-my-pi/pi-utils/logger";
import {
	countOpenFds,
	type ProcessSample,
	ProcessTelemetry,
	readProcessTelemetryEnv,
} from "@oh-my-pi/pi-utils/process-telemetry";

/**
 * Contract: one sampler per process writes role-tagged records.
 * - `proc.sample` (debug) on the first tick, then at most once per heartbeat.
 * - `proc.high-water` (warn) once per doubling mark crossed: RSS from 1 GiB, fds from 256.
 * - `proc.rss-limit` (error) once when the opt-in limit is exceeded, then terminate and stop.
 * Clock, timer and samplers are injected; nothing sleeps.
 */
const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

function harness(options: { heartbeatMs?: number; rssLimitBytes?: number } = {}) {
	let nowValue = 0;
	let current: ProcessSample = { rss: 100 * MIB, heapUsed: 10 * MIB, external: MIB, fds: 20 };
	let tick: (() => void) | undefined;
	let cancelled = 0;
	const terminate = vi.fn();
	const telemetry = new ProcessTelemetry({
		role: "launch",
		heartbeatMs: options.heartbeatMs ?? 60_000,
		rssLimitBytes: options.rssLimitBytes,
		sample: () => current,
		now: () => nowValue,
		schedule: cb => {
			tick = cb;
			return {};
		},
		cancel: () => {
			cancelled++;
			tick = undefined;
		},
		terminate,
	});
	telemetry.start();
	return {
		telemetry,
		terminate,
		cancelled: () => cancelled,
		fire(at: number, sample: Partial<ProcessSample> = {}): void {
			nowValue = at;
			current = { ...current, ...sample };
			if (!tick) throw new Error("no tick scheduled");
			tick();
		},
	};
}

function spies() {
	return {
		debug: vi.spyOn(logger, "debug").mockImplementation(() => {}),
		warn: vi.spyOn(logger, "warn").mockImplementation(() => {}),
		error: vi.spyOn(logger, "error").mockImplementation(() => {}),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("ProcessTelemetry", () => {
	test("heartbeat sample on the first tick, then only after heartbeatMs elapses, carrying the current role", () => {
		const log = spies();
		const h = harness({ heartbeatMs: 60_000 });
		h.fire(0);
		h.fire(30_000);
		h.fire(59_999);
		expect(log.debug).toHaveBeenCalledTimes(1);
		h.telemetry.setRole("launch:interactive");
		h.fire(60_000, { rss: 300 * MIB });
		expect(log.debug).toHaveBeenCalledTimes(2);
		expect(log.debug.mock.calls[1]).toEqual([
			"proc.sample",
			expect.objectContaining({ role: "launch:interactive", ppid: process.ppid, rssMiB: 300, fds: 20 }),
		]);
		expect(log.warn).not.toHaveBeenCalled();
	});

	test("RSS high-water fires once per doubling mark, reporting the highest mark crossed", () => {
		const log = spies();
		const h = harness();
		h.fire(0, { rss: GIB - 1 });
		expect(log.warn).not.toHaveBeenCalled();
		h.fire(1, { rss: GIB });
		h.fire(2, { rss: 1.9 * GIB });
		h.fire(3, { rss: 1.5 * GIB });
		// Jumping past several marks in one sample reports only the highest.
		h.fire(4, { rss: 9 * GIB });
		h.fire(5, { rss: 15 * GIB });
		const marks = log.warn.mock.calls.map(([, ctx]) => (ctx as { kind: string; markGiB: number }).markGiB);
		expect(marks).toEqual([1, 8]);
		expect(log.warn.mock.calls[1][1]).toMatchObject({ kind: "rss", role: "launch", peakRssMiB: 9 * 1024 });
	});

	test("fd high-water starts at 256 and doubles; an uncountable fd total never fires", () => {
		const log = spies();
		const h = harness();
		h.fire(0, { fds: 255 });
		h.fire(1, { fds: undefined });
		h.fire(2, { fds: 256 });
		h.fire(3, { fds: 300 });
		h.fire(4, { fds: 7200 });
		const marks = log.warn.mock.calls.map(([, ctx]) => (ctx as { markFds: number }).markFds);
		expect(marks).toEqual([256, 4096]);
	});

	test("opt-in RSS limit logs once, stops sampling and terminates; equal to the limit does not trip", () => {
		const log = spies();
		const h = harness({ rssLimitBytes: 512 * MIB });
		h.fire(0, { rss: 512 * MIB });
		expect(log.error).not.toHaveBeenCalled();
		h.fire(1, { rss: 600 * MIB });
		expect(log.error).toHaveBeenCalledTimes(1);
		expect(log.error.mock.calls[0]).toEqual([
			"proc.rss-limit",
			expect.objectContaining({ role: "launch", rssMiB: 600, limitMiB: 512 }),
		]);
		expect(h.terminate).toHaveBeenCalledTimes(1);
		expect(h.cancelled()).toBe(1);
	});

	test("no limit configured never terminates however large RSS grows", () => {
		const log = spies();
		const h = harness();
		h.fire(0, { rss: 64 * GIB });
		expect(log.error).not.toHaveBeenCalled();
		expect(h.terminate).not.toHaveBeenCalled();
	});

	test("a throwing sampler skips the tick without logging", () => {
		const log = spies();
		const telemetry = new ProcessTelemetry({
			role: "x",
			sample: () => {
				throw new Error("boom");
			},
			schedule: () => ({}),
		});
		telemetry.tick();
		expect(log.debug).not.toHaveBeenCalled();
	});
});

describe("readProcessTelemetryEnv", () => {
	test("defaults: on, 5 s interval, no limit", () => {
		expect(readProcessTelemetryEnv({})).toEqual({ enabled: true, intervalMs: 5000, rssLimitBytes: 0 });
	});

	test("disable flag spellings, interval floor and MiB limit", () => {
		for (const flag of ["0", "false", "OFF", "no"]) {
			expect(readProcessTelemetryEnv({ OMP_PROC_TELEMETRY: flag }).enabled).toBe(false);
		}
		expect(readProcessTelemetryEnv({ OMP_PROC_TELEMETRY: "1" }).enabled).toBe(true);
		expect(readProcessTelemetryEnv({ OMP_PROC_TELEMETRY_INTERVAL_MS: "200" }).intervalMs).toBe(1000);
		expect(readProcessTelemetryEnv({ OMP_PROC_TELEMETRY_INTERVAL_MS: "abc" }).intervalMs).toBe(5000);
		expect(readProcessTelemetryEnv({ OMP_PROC_RSS_LIMIT_MB: "2048" }).rssLimitBytes).toBe(2048 * MIB);
		expect(readProcessTelemetryEnv({ OMP_PROC_RSS_LIMIT_MB: "-5" }).rssLimitBytes).toBe(0);
	});
});

describe("countOpenFds", () => {
	test("counts directory entries minus the listing's own fd; a missing directory is undefined", () => {
		expect(countOpenFds(undefined)).toBeUndefined();
		expect(countOpenFds("/nonexistent/omp-fd-dir")).toBeUndefined();
		if (process.platform === "linux" || process.platform === "darwin") {
			const n = countOpenFds();
			expect(n).toBeGreaterThanOrEqual(3);
		}
	});
});
