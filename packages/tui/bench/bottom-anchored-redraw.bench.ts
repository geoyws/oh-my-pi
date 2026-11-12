/**
 * Redraw cost of the representative bottom-anchored stream (t-d6c9e119): a
 * full screen over settled history, one finalized transcript line per step
 * under a ticking status line, through a real Composer into the kitty VT
 * engine on a virtual clock. Everything but the `*Ms` fields is
 * deterministic, so base and candidate runs compare byte for byte.
 *
 * Runs outside or inside a multiplexer alike: its session markers are cleared
 * and DEC 2026 is forced on, matching the in-process regression.
 *
 * Run: bun packages/tui/bench/bottom-anchored-redraw.bench.ts [steps]
 */
import { TERMINAL_MULTIPLEXER_ENV_KEYS } from "@oh-my-pi/pi-tui/terminal-multiplexer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { runStreamWorkload, STREAM_WORKLOAD, type StepMetrics } from "../test/helpers/bottom-anchored-chat";

for (const key of [...TERMINAL_MULTIPLEXER_ENV_KEYS, "TERM_PROGRAM", "PI_TUI_RESIZE_IN_PLACE", "PI_NO_SYNC_OUTPUT"]) {
	delete Bun.env[key];
}
Bun.env.PI_TUI_SYNC_OUTPUT = "1";
const steps = Number(process.argv[2] ?? STREAM_WORKLOAD.steps);
await initTheme();
const workload = { ...STREAM_WORKLOAD, steps };
const { rig, steps: measured } = await runStreamWorkload(workload);
rig.composer.stop();

const sum = (pick: (step: StepMetrics) => number): number => measured.reduce((total, step) => total + pick(step), 0);
const frameworkMs = measured.map(step => step.frameworkMs).sort((a, b) => a - b);
const percentile = (p: number): number =>
	frameworkMs[Math.min(frameworkMs.length - 1, Math.floor(p * frameworkMs.length))]!;

console.log(
	JSON.stringify(
		{
			workload,
			steps: measured.length,
			paints: sum(step => step.paints),
			renderCalls: sum(step => step.renderCalls),
			writes: sum(step => step.writes),
			bytes: sum(step => step.bytes),
			bytesPerStep: Number((sum(step => step.bytes) / measured.length).toFixed(1)),
			rowWrites: sum(step => step.rowWrites),
			rowWritesPerStep: Number((sum(step => step.rowWrites) / measured.length).toFixed(2)),
			historyRows: sum(step => step.historyRows),
			changedRows: sum(step => step.changedRows),
			// Row writes beyond what changed after the scroll plus the committed rows themselves.
			excessRowWrites: sum(step => Math.max(0, step.rowWrites - step.changedRows - step.historyRows)),
			eraseScrollback: sum(step => step.eraseScrollback),
			writesOutsideSync: sum(step => step.writesOutsideSync),
			frameworkMsMean: Number((sum(step => step.frameworkMs) / measured.length).toFixed(3)),
			frameworkMsP50: Number(percentile(0.5).toFixed(3)),
			frameworkMsP95: Number(percentile(0.95).toFixed(3)),
		},
		null,
		2,
	),
);
