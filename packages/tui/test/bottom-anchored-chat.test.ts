import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import {
	CURSOR_MARKER,
	type TerminalFramePlan,
	type TerminalFrameProvider,
	TUI,
	type TuiPaint,
} from "@oh-my-pi/pi-tui";
import * as capabilities from "@oh-my-pi/pi-tui/terminal-capabilities";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import {
	activeGrid,
	type ChatRig,
	createChatRig,
	ledger,
	measureStep,
	RecordingTerminal,
	runStreamWorkload,
	type StepMetrics,
	screenShowsPaint,
} from "./helpers/bottom-anchored-chat";
import { EDITOR_TEXT, plain, RowsBlock, rowsContaining, scanTerminalBytes } from "./helpers/chat-surface";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";

// t-d6c9e119: a bottom-anchored chat must keep every transcript row reachable
// exactly once (native scrollback + screen), keep the editor on the bottom row
// once the screen is full, leave a reader who scrolled up undisturbed while
// output streams, and commit history without repainting the unchanged screen.

withoutTerminalMultiplexer();

beforeAll(async () => {
	await initTheme();
});

beforeEach(() => {
	// Synchronized output on, as on every terminal the app detects or probes
	// into it, so each paint must arrive inside one DEC 2026 bracket.
	spyOn(capabilities, "shouldEnableSynchronizedOutputByDefault").mockReturnValue(true);
	spyOn(capabilities, "synchronizedOutputUserOverride").mockReturnValue(null);
});

afterEach(() => {
	vi.restoreAllMocks();
});

const TOKEN = /\b(?:QZ[A-Z]\d{4})\b/;

function lastPaint(rig: ChatRig): TuiPaint {
	const paint = rig.paints.at(-1);
	if (paint === undefined) throw new Error("no paint reached the terminal");
	return paint;
}

/**
 * The screen-full surface contract: the transcript ledger is complete, in
 * order and unduplicated; exactly one editor exists in the whole buffer and it
 * owns the bottom row with the cursor on its input row; the screen is the
 * frame the renderer says it painted.
 */
function expectFullSurface(rig: ChatRig, label: string): void {
	const { terminal } = rig;
	expect(ledger(terminal, TOKEN), `${label}: transcript ledger`).toEqual(rig.emitted);
	const grid = activeGrid(terminal);
	expect(rowsContaining(grid, EDITOR_TEXT), `${label}: editor row`).toEqual([terminal.rows - 1]);
	expect(ledger(terminal, new RegExp(EDITOR_TEXT)), `${label}: editor copies in the buffer`).toHaveLength(1);
	expect(terminal.getCursor().row, `${label}: cursor row`).toBe(terminal.rows - 2);
	expect(screenShowsPaint(lastPaint(rig), grid), `${label}: screen matches the painted frame`).toBe(true);
}

/** An ordinary update: atomic and never destructive to native history. */
async function ordinaryStep(rig: ChatRig, label: string, mutate: () => void): Promise<StepMetrics> {
	const metrics = await measureStep(rig, mutate);
	expect(metrics.eraseScrollback, `${label}: ED3 on an ordinary update`).toBe(0);
	expect(metrics.writesOutsideSync, `${label}: cells written outside a synchronized update`).toBe(0);
	return metrics;
}

/** Bounded viewport under rows of history still visible on screen, as a short live tail leaves it. */
class ShortViewportProvider implements TerminalFrameProvider {
	#history: readonly string[];
	#id = 1;
	readonly viewport = ["live-0", `${EDITOR_TEXT}${CURSOR_MARKER}`];

	constructor(history: readonly string[]) {
		this.#history = history;
	}

	renderFrame(): TerminalFramePlan {
		return {
			history: this.#history.length > 0 ? { id: this.#id, rows: this.#history } : undefined,
			viewport: this.viewport,
		};
	}

	acknowledgeHistory(id: number): void {
		if (id !== this.#id) return;
		this.#id++;
		this.#history = [];
	}
}

describe("bottom-anchored chat rendering (t-d6c9e119)", () => {
	it("streams below settled history, holds a scrolled-up reader still, and follows again at the tail", async () => {
		const rig = createChatRig({ columns: 100, rows: 30, settled: 50, prefix: "QZS" });
		try {
			await rig.scheduler.settle(rig.terminal);
			expectFullSurface(rig, "first paint");
			for (let step = 0; step < 12; step++) {
				await ordinaryStep(rig, `stream ${step}`, () => rig.addLines(1));
				expectFullSurface(rig, `stream ${step}`);
			}

			rig.terminal.scrollLines(-12);
			const held = rig.terminal.getViewport().map(plain);
			const position = rig.terminal.getBufferPosition();
			expect(position.viewportY).toBeLessThan(position.baseY);
			for (let step = 0; step < 10; step++) {
				await ordinaryStep(rig, `scrolled-up ${step}`, () => rig.addLines(1));
				// Output keeps landing below; the rows the reader is looking at do not move.
				expect(rig.terminal.getViewport().map(plain), `scrolled-up ${step}: reader viewport`).toEqual(held);
				expect(rig.terminal.getBufferPosition().viewportY, `scrolled-up ${step}: reader offset`).toBe(
					position.viewportY,
				);
				expect(ledger(rig.terminal, TOKEN), `scrolled-up ${step}: ledger`).toEqual(rig.emitted);
			}

			rig.terminal.scrollLines(rig.terminal.getBufferPosition().baseY);
			expect(rig.terminal.isNativeViewportAtBottom()).toBe(true);
			for (let step = 0; step < 3; step++) {
				await ordinaryStep(rig, `back at tail ${step}`, () => rig.addLines(1));
				expect(rig.terminal.isNativeViewportAtBottom(), `back at tail ${step}: follows output`).toBe(true);
				expectFullSurface(rig, `back at tail ${step}`);
				expect(rig.terminal.getViewport().map(plain)).toContain(rig.emitted.at(-1)!);
			}

			// A running tool's preview grows, then collapses to its result and settles.
			const tool = new RowsBlock("TOOL", 2, true);
			const toolRows = (): string[] => ledger(rig.terminal, /\bTOOL-\d+\b/);
			await ordinaryStep(rig, "tool starts", () => rig.transcript.addChild(tool));
			expect(toolRows()).toEqual(["TOOL-0", "TOOL-1"]);
			expectFullSurface(rig, "tool starts");
			await ordinaryStep(rig, "tool grows", () => {
				tool.rows = 14;
			});
			expect(toolRows()).toEqual(Array.from({ length: 14 }, (_, index) => `TOOL-${index}`));
			expectFullSurface(rig, "tool grows");
			await ordinaryStep(rig, "tool collapses", () => {
				tool.rows = 3;
			});
			expect(toolRows(), "no stale preview rows survive the collapse").toEqual(["TOOL-0", "TOOL-1", "TOOL-2"]);
			expectFullSurface(rig, "tool collapses");
			await ordinaryStep(rig, "tool settles", () => {
				tool.live = false;
			});
			for (let step = 0; step < 20; step++) {
				await ordinaryStep(rig, `after tool ${step}`, () => rig.addLines(1));
				expectFullSurface(rig, `after tool ${step}`);
			}
			expect(toolRows()).toEqual(["TOOL-0", "TOOL-1", "TOOL-2"]);
		} finally {
			rig.composer.stop();
		}
	});

	it("keeps a bottom overlay from moving a short viewport or the history above it", async () => {
		const rows = 24;
		const terminal = new RecordingTerminal(80, rows, 1000);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		const history = Array.from({ length: 6 }, (_, index) => `hist-${index}`);
		tui.setFrameProvider(new ShortViewportProvider(history));
		tui.start();
		try {
			await scheduler.settle(terminal);
			const resting = activeGrid(terminal);
			expect(resting.slice(0, 8)).toEqual([...history, "live-0", EDITOR_TEXT]);
			terminal.takeWrites();

			const panel = new RowsBlock("OVERLAY", 4);
			const handle = tui.showOverlay(panel, {
				anchor: "bottom-center",
				width: "100%",
				maxHeight: "100%",
				margin: 0,
			});
			await scheduler.settle(terminal);
			let grid = activeGrid(terminal);
			expect(grid.slice(0, 8), "open: history and live rows stay where they were").toEqual(resting.slice(0, 8));
			expect(rowsContaining(grid, "OVERLAY-"), "open: panel on the bottom rows").toEqual([20, 21, 22, 23]);

			panel.rows = 8;
			tui.requestRender();
			await scheduler.settle(terminal);
			grid = activeGrid(terminal);
			expect(grid.slice(0, 8), "update: history and live rows stay where they were").toEqual(resting.slice(0, 8));
			expect(rowsContaining(grid, "OVERLAY-"), "update: panel on the bottom rows").toEqual([
				16, 17, 18, 19, 20, 21, 22, 23,
			]);

			handle.hide();
			await scheduler.settle(terminal);
			expect(activeGrid(terminal), "close: the screen returns to its resting frame").toEqual(resting);
			expect(terminal.getCursor().row, "close: cursor back on the editor row").toBe(7);
			expect(ledger(terminal, /\bhist-\d\b/), "history rows reachable exactly once").toEqual(history);
			const scan = scanTerminalBytes(terminal.takeWrites().join(""), rows);
			expect(scan.eraseScrollback).toBe(0);
			expect(scan.writesOutsideSync).toBe(0);
		} finally {
			tui.stop();
		}
	});

	for (const chrome of ["self-clearing HUD", "expanded editor draft"] as const) {
		it(`keeps every transcript row reachable while a ${chrome} displaces the live tail`, async () => {
			const rig = createChatRig({
				columns: 100,
				rows: 30,
				settled: 60,
				prefix: "QZH",
				selfClearingHud: chrome === "self-clearing HUD",
			});
			const block = chrome === "self-clearing HUD" ? rig.hud : rig.draft;
			const chromeRows = (): string[] => ledger(rig.terminal, new RegExp(`\\b${block.label}-\\d+\\b`));
			try {
				await rig.scheduler.settle(rig.terminal);
				expectFullSurface(rig, "resting");

				await ordinaryStep(rig, "chrome grows", () => {
					block.rows = 8;
				});
				// Rows pushed off the top by the taller chrome must be in scrollback,
				// not held live behind the chrome where no reader can reach them.
				expectFullSurface(rig, "chrome grows");
				expect(chromeRows()).toEqual(Array.from({ length: 8 }, (_, index) => `${block.label}-${index}`));
				for (let step = 0; step < 6; step++) {
					await ordinaryStep(rig, `stream under chrome ${step}`, () => rig.addLines(1));
					expectFullSurface(rig, `stream under chrome ${step}`);
				}

				await ordinaryStep(rig, "chrome clears", () => {
					block.rows = 0;
				});
				expectFullSurface(rig, "chrome clears");
				expect(chromeRows(), "no chrome rows leak into history").toEqual([]);
				await ordinaryStep(rig, "next output", () => rig.addLines(1));
				expectFullSurface(rig, "next output");
			} finally {
				rig.composer.stop();
			}
		});
	}

	it("keeps the editor on the bottom row when promoted idle chrome goes away", async () => {
		const rows = 30;
		const shell = Array.from({ length: 12 }, (_, index) => `shell${index}`);
		const rig = createChatRig({ columns: 100, rows, settled: 0, prefix: "QZP", shell });
		const history = (): string[] =>
			rig.terminal
				.getScrollBuffer()
				.map(plain)
				.filter(row => /^(?:shell\d+|QZP\d{4})$/.test(row));
		try {
			await rig.scheduler.settle(rig.terminal);
			rig.composer.setRunActive(true);
			rig.hud.rows = 7;
			for (let step = 0; step < 55; step++) {
				rig.addLines(2);
				rig.composer.ui.requestRender();
				await rig.scheduler.settle(rig.terminal);
			}
			rig.composer.setRunActive(false);
			// The extension widget outlives the turn and settles into the floor.
			await rig.scheduler.advance(rig.terminal, 300);
			expect(history()).toEqual([...shell, ...rig.emitted]);
			expect(ledger(rig.terminal, /\bHUD-\d\b/)).toHaveLength(7);
			expectFullSurface(rig, "promoted widget");

			rig.hud.rows = 0;
			rig.composer.ui.requestRender();
			await rig.scheduler.advance(rig.terminal, 300);
			expectFullSurface(rig, "widget removed");
			expect(history()).toEqual([...shell, ...rig.emitted]);
			expect(ledger(rig.terminal, /\bHUD-\d\b/)).toEqual([]);
			for (let frame = 0; frame < 3; frame++) {
				rig.composer.ui.requestRender();
				await rig.scheduler.advance(rig.terminal, 300);
				expectFullSurface(rig, `idle frame ${frame}`);
			}
			await ordinaryStep(rig, "next output", () => rig.addLines(1));
			expectFullSurface(rig, "next output");
			expect(history()).toEqual([...shell, ...rig.emitted]);
		} finally {
			rig.composer.stop();
		}
	});

	it("keeps the ledger and the bottom editor across width and height resizes mid-stream", async () => {
		const rig = createChatRig({ columns: 100, rows: 30, settled: 50, prefix: "QZR" });
		try {
			await rig.scheduler.settle(rig.terminal);
			for (let step = 0; step < 10; step++) await ordinaryStep(rig, `stream ${step}`, () => rig.addLines(1));
			for (const [columns, rows] of [
				[84, 24],
				[120, 36],
				[120, 28],
			] as const) {
				const label = `${columns}x${rows}`;
				rig.terminal.resize(columns, rows);
				await rig.scheduler.advance(rig.terminal, 300);
				expectFullSurface(rig, `${label} settled`);
				for (let step = 0; step < 5; step++) {
					await ordinaryStep(rig, `${label} stream ${step}`, () => rig.addLines(1));
					expectFullSurface(rig, `${label} stream ${step}`);
				}
			}
		} finally {
			rig.composer.stop();
		}
	});

	it("evicts only the oldest rows when a long session overflows the scrollback cap", async () => {
		const cap = 1000;
		const rig = createChatRig({ columns: 100, rows: 30, scrollback: cap, settled: 40, prefix: "QZL" });
		try {
			await rig.scheduler.settle(rig.terminal);
			for (let step = 0; step < 130; step++) {
				await ordinaryStep(rig, `stream ${step}`, () => rig.addLines(10));
			}
			// Each line plus its separator takes two rows: 1340 lines is 2680 rows, far past the cap.
			const reachable = ledger(rig.terminal, TOKEN);
			expect(reachable.length).toBeGreaterThanOrEqual(500);
			expect(reachable).toEqual(rig.emitted.slice(rig.emitted.length - reachable.length));
			const grid = activeGrid(rig.terminal);
			expect(rowsContaining(grid, EDITOR_TEXT)).toEqual([rig.terminal.rows - 1]);
			expect(screenShowsPaint(lastPaint(rig), grid)).toBe(true);
			expect(grid).toContain(rig.emitted.at(-1)!);
		} finally {
			rig.composer.stop();
		}
	});

	it("commits streamed history without rewriting the unchanged screen", async () => {
		const { rig, steps } = await runStreamWorkload();
		try {
			// Skip the steps that fill the first screen; the rest each retire rows.
			const steady = steps.slice(10);
			expect(steady.filter(step => step.historyRows > 0).length).toBeGreaterThanOrEqual(
				Math.floor(steady.length * 0.8),
			);
			for (const [index, step] of steady.entries()) {
				expect(step.eraseScrollback, `step ${index}: ED3`).toBe(0);
				expect(step.writesOutsideSync, `step ${index}: unsynchronized cells`).toBe(0);
			}
			// Writes may cover rows that changed after the scroll, plus re-emitting
			// the committed rows themselves and a few rows of slack per step; a
			// full-viewport repaint per commit is ~a screen per step over that.
			const written = steady.reduce((sum, step) => sum + step.rowWrites, 0);
			const needed = steady.reduce((sum, step) => sum + step.changedRows + step.historyRows + 4, 0);
			expect(written).toBeLessThanOrEqual(needed);
			expectFullSurface(rig, "after the stream");
		} finally {
			rig.composer.stop();
		}
	});
});
