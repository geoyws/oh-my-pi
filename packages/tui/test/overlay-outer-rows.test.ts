import { afterEach, beforeAll, beforeEach, expect, it, spyOn, vi } from "bun:test";
import { CURSOR_MARKER, type TerminalFramePlan, type TerminalFrameProvider, TUI } from "@oh-my-pi/pi-tui";
import * as capabilities from "@oh-my-pi/pi-tui/terminal-capabilities";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { activeGrid, ledger, RecordingTerminal } from "./helpers/bottom-anchored-chat";
import { EDITOR_TEXT, RowsBlock, rowsContaining, scanTerminalBytes } from "./helpers/chat-surface";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";

// t-d6c9e119: an inline overlay opens over a full-screen viewport; the frame
// that then commits history and shrinks the viewport leaves overlay rows over
// history rows above it. Those rows must come back intact when the overlay
// closes, and a covered row the renderer cannot rewrite (scaled OSC 66 text)
// must reach scrollback instead of being painted over.

withoutTerminalMultiplexer();

beforeAll(async () => {
	await initTheme();
});

beforeEach(() => {
	spyOn(capabilities, "shouldEnableSynchronizedOutputByDefault").mockReturnValue(true);
	spyOn(capabilities, "synchronizedOutputUserOverride").mockReturnValue(null);
});

afterEach(() => {
	vi.restoreAllMocks();
});

const ROWS = 24;

/** Provider whose viewport and pending history each step sets directly. */
class SteppedProvider implements TerminalFrameProvider {
	#id = 1;
	history: string[] = [];
	kind: "append" | "replay" = "append";
	viewport: string[];

	constructor(viewport: string[]) {
		this.viewport = viewport;
	}

	renderFrame(): TerminalFramePlan {
		return {
			history: this.history.length > 0 ? { id: this.#id, rows: this.history, kind: this.kind } : undefined,
			viewport: this.viewport,
		};
	}

	acknowledgeHistory(id: number): void {
		if (id !== this.#id) return;
		this.#id++;
		this.history = [];
		this.kind = "append";
	}
}

const fullViewport = (): string[] => [
	...Array.from({ length: ROWS - 1 }, (_, index) => `full-${index}`),
	`${EDITOR_TEXT}${CURSOR_MARKER}`,
];

function startFull() {
	const terminal = new RecordingTerminal(80, ROWS, 1000);
	const scheduler = new VirtualRenderScheduler();
	const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
	const provider = new SteppedProvider(fullViewport());
	tui.setFrameProvider(provider);
	tui.start();
	return { terminal, scheduler, tui, provider };
}

/**
 * Open a six-row inline overlay over a full-screen viewport, then commit the
 * viewport plus `historyRows` and shrink the live tail to two rows in one
 * frame: the overlay's top rows land above the viewport, over history.
 */
async function openOverHistory(historyRows: readonly string[], kind: "append" | "replay" = "append") {
	const { terminal, scheduler, tui, provider } = startFull();
	await scheduler.settle(terminal);
	const panel = new RowsBlock("OVERLAY", 6);
	const handle = tui.showOverlay(panel, { anchor: "bottom-center", width: "100%", maxHeight: "100%", margin: 0 });
	await scheduler.settle(terminal);
	expect(rowsContaining(activeGrid(terminal), "OVERLAY-"), "inline overlay on the bottom rows").toEqual([
		18, 19, 20, 21, 22, 23,
	]);
	terminal.takeWrites();
	provider.history = [...fullViewport().slice(0, ROWS - 1), ...historyRows];
	provider.kind = kind;
	provider.viewport = ["live-0", `${EDITOR_TEXT}${CURSOR_MARKER}`];
	tui.requestRender();
	await scheduler.settle(terminal);
	return { terminal, scheduler, tui, handle };
}

const HISTORY_ROW = /MARK-OSC|\bhist-\d\b/;
const OSC_ROW = "MARK-OSC \x1b]66;s=2;Hi\x1b\\";

/** Overlay gone, every history row reachable once, input on the screen's last painted rows. */
function expectClosedCleanly(terminal: RecordingTerminal, history: readonly string[]): void {
	expect(ledger(terminal, /OVERLAY-\d/), "no overlay row survives the close").toEqual([]);
	expect(ledger(terminal, HISTORY_ROW), "every history row reachable exactly once").toEqual(
		history.filter(row => row !== "").map(row => (row === OSC_ROW ? "MARK-OSC" : row)),
	);
	const grid = activeGrid(terminal);
	const editor = rowsContaining(grid, EDITOR_TEXT);
	expect(editor, "one editor").toHaveLength(1);
	expect(grid[editor[0]! - 1], "live tail right above the input").toBe("live-0");
	expect(
		grid.slice(editor[0]! + 1).every(row => row === ""),
		"nothing below the input",
	).toBe(true);
	expect(scanTerminalBytes(terminal.takeWrites().join(""), ROWS).eraseScrollback).toBe(0);
}

for (const kind of ["append", "replay"] as const) {
	for (const [label, history] of [
		["text rows", ["hist-0", "hist-1", "hist-2", "hist-3", "hist-4", "hist-5"]],
		["a trailing blank row", ["hist-0", "hist-1", "hist-2", "hist-3", "hist-5", ""]],
	] as const) {
		it(`restores ${label} an overlay covered above a shrunken viewport (${kind})`, async () => {
			const { terminal, scheduler, tui, handle } = await openOverHistory(history, kind);
			try {
				handle.hide();
				await scheduler.settle(terminal);
				expectClosedCleanly(terminal, history);
				expect(activeGrid(terminal).slice(-8), "history back in place above the live tail").toEqual([
					...history,
					"live-0",
					EDITOR_TEXT,
				]);
			} finally {
				tui.stop();
			}
		});
	}

	// A scaled OSC 66 row owns cells beyond its own row, so neither it nor a
	// blank run touching it can be rewritten after an overlay covers it.
	for (const [label, history] of [
		["the scaled row itself", ["hist-0", "hist-1", OSC_ROW, "hist-3", "hist-4", "hist-5"]],
		["a blank row below it", ["hist-0", OSC_ROW, "", "hist-3", "hist-4", "hist-5"]],
		["a blank run above it", ["hist-0", "hist-1", "", "", OSC_ROW, "hist-5"]],
	] as const) {
		it(`keeps an overlay off ${label} instead of painting over it (${kind})`, async () => {
			const { terminal, scheduler, tui, handle } = await openOverHistory(history, kind);
			try {
				const grid = activeGrid(terminal);
				const overlayRows = rowsContaining(grid, "OVERLAY-");
				expect(overlayRows).toHaveLength(6);
				expect(ledger(terminal, /MARK-OSC/), "the scaled row is never overwritten").toEqual(["MARK-OSC"]);
				const scaled = grid.findIndex(row => row.includes("MARK-OSC"));
				expect(scaled < 0 || !overlayRows.includes(scaled), "no overlay row over the scaled row").toBe(true);
				handle.hide();
				await scheduler.settle(terminal);
				expectClosedCleanly(terminal, history);
			} finally {
				tui.stop();
			}
		});
	}
}

it("keeps covered history in place when the terminal height changes while the overlay is open", async () => {
	// In-place resize (Warp): no alt borrow and no replay, so the outer overlay
	// rows and the history under them must follow the CPR-recovered anchor.
	Bun.env.PI_TUI_RESIZE_IN_PLACE = "1";
	const history = Array.from({ length: 6 }, (_, index) => `hist-${index}`);
	const { terminal, scheduler, tui, handle } = await openOverHistory(history);
	try {
		terminal.resize(80, ROWS - 4);
		await scheduler.advance(terminal, 160);
		handle.hide();
		await scheduler.settle(terminal);
		expect(ledger(terminal, /OVERLAY-\d/), "no overlay row survives the close").toEqual([]);
		expect(ledger(terminal, HISTORY_ROW), "history reachable exactly once").toEqual(history);
	} finally {
		tui.stop();
	}
});

it("erases stale rows below a viewport that shrinks while history scrolls up", async () => {
	const { terminal, scheduler, tui, provider } = startFull();
	try {
		await scheduler.settle(terminal);
		const full = fullViewport();
		provider.history = full.slice(0, 2);
		provider.viewport = full.slice(2, 12);
		tui.requestRender();
		await scheduler.settle(terminal);
		const grid = activeGrid(terminal);
		expect(grid.slice(0, 12)).toEqual(Array.from({ length: 12 }, (_, index) => `full-${index}`));
		expect(grid.slice(12), "no stale row below the shrunken viewport").toEqual(Array<string>(ROWS - 12).fill(""));
		expect(ledger(terminal, /\bfull-\d+\b/)).toEqual(Array.from({ length: 12 }, (_, index) => `full-${index}`));
	} finally {
		tui.stop();
	}
});

/**
 * Open a six-row inline overlay over a full-screen viewport at row zero, then
 * collapse the live tail in place to two rows: the overlay's rows now sit
 * below the viewport, over blank rows.
 */
async function openBelowShrunkenViewport() {
	const { terminal, scheduler, tui, provider } = startFull();
	await scheduler.settle(terminal);
	const handle = tui.showOverlay(new RowsBlock("OVERLAY", 6), {
		anchor: "bottom-center",
		width: "100%",
		maxHeight: "100%",
		margin: 0,
	});
	await scheduler.settle(terminal);
	provider.viewport = ["live-0", `${EDITOR_TEXT}${CURSOR_MARKER}`];
	tui.requestRender();
	await scheduler.settle(terminal);
	const grid = activeGrid(terminal);
	expect(grid.slice(0, 2), "collapsed tail on the top rows").toEqual(["live-0", EDITOR_TEXT]);
	expect(rowsContaining(grid, "OVERLAY-"), "overlay kept over the erased rows").toEqual([18, 19, 20, 21, 22, 23]);
	expect(grid.slice(2, 18).every(row => row === ""), "the old tail erased").toBe(true);
	return { terminal, scheduler, tui, provider, handle };
}

it("blanks the rows an overlay covered below a collapsed viewport when it closes", async () => {
	const { terminal, scheduler, tui, handle } = await openBelowShrunkenViewport();
	try {
		handle.hide();
		await scheduler.settle(terminal);
		const grid = activeGrid(terminal);
		expect(grid.slice(0, 2)).toEqual(["live-0", EDITOR_TEXT]);
		expect(grid.slice(2), "nothing left below the input").toEqual(Array<string>(ROWS - 2).fill(""));
		expect(ledger(terminal, /OVERLAY-\d/)).toEqual([]);
	} finally {
		tui.stop();
	}
});

it("lets a regrown viewport own the rows a closing overlay covered", async () => {
	const { terminal, scheduler, tui, provider, handle } = await openBelowShrunkenViewport();
	try {
		provider.viewport = fullViewport();
		handle.hide();
		await scheduler.settle(terminal);
		expect(activeGrid(terminal)).toEqual(fullViewport().map(row => row.replace(CURSOR_MARKER, "")));
		expect(ledger(terminal, /OVERLAY-\d/)).toEqual([]);
	} finally {
		tui.stop();
	}
});

it("never addresses overlay rows a height shrink left below the screen", async () => {
	Bun.env.PI_TUI_RESIZE_IN_PLACE = "1";
	const { terminal, scheduler, tui, handle } = await openBelowShrunkenViewport();
	try {
		terminal.takeWrites();
		handle.hide();
		terminal.resize(80, 16);
		await scheduler.advance(terminal, 160);
		await scheduler.settle(terminal);
		const rowsAddressed = [...terminal.takeWrites().join("").matchAll(/\x1b\[(\d+);\d+H/g)].map(m => Number(m[1]));
		expect(Math.max(...rowsAddressed), "every cursor move stays on the 16-row screen").toBeLessThanOrEqual(16);
		expect(ledger(terminal, /OVERLAY-\d/)).toEqual([]);
		expect(rowsContaining(activeGrid(terminal), EDITOR_TEXT)).toHaveLength(1);
	} finally {
		delete Bun.env.PI_TUI_RESIZE_IN_PLACE;
		tui.stop();
	}
});

it("drops covered-row records a large height shrink moves off the screen", async () => {
	Bun.env.PI_TUI_RESIZE_IN_PLACE = "1";
	const history = Array.from({ length: 6 }, (_, index) => `hist-${index}`);
	const { terminal, scheduler, tui, handle } = await openOverHistory(history);
	try {
		terminal.resize(80, 6);
		await scheduler.advance(terminal, 160);
		handle.hide();
		await scheduler.settle(terminal);
		expect(ledger(terminal, /OVERLAY-\d/), "no overlay row survives the close").toEqual([]);
		expect(ledger(terminal, HISTORY_ROW), "history reachable exactly once").toEqual(history);
		expect(rowsContaining(activeGrid(terminal), EDITOR_TEXT)).toHaveLength(1);
	} finally {
		delete Bun.env.PI_TUI_RESIZE_IN_PLACE;
		tui.stop();
	}
});

it("paints nothing for an overlay whose margins leave it no row on screen", async () => {
	const { terminal, scheduler, tui } = startFull();
	try {
		await scheduler.settle(terminal);
		const before = activeGrid(terminal);
		tui.showOverlay(new RowsBlock("OVERLAY", 3), { anchor: "top-left", margin: { top: ROWS } });
		await scheduler.settle(terminal);
		expect(activeGrid(terminal)).toEqual(before);
		expect(ledger(terminal, /OVERLAY-\d/)).toEqual([]);
	} finally {
		tui.stop();
	}
});

it("keeps the hardware cursor on the input when an overlay row above the viewport carries a marker", async () => {
	const { terminal, scheduler, tui, provider } = startFull();
	try {
		await scheduler.settle(terminal);
		const panel = {
			render: () => [`OVERLAY-0${CURSOR_MARKER}`, ...Array.from({ length: 5 }, (_, index) => `OVERLAY-${index + 1}`)],
			invalidate: () => {},
		};
		tui.showOverlay(panel, { anchor: "bottom-center", width: "100%", maxHeight: "100%", margin: 0 });
		await scheduler.settle(terminal);
		terminal.takeWrites();
		provider.history = fullViewport().slice(0, ROWS - 1);
		provider.viewport = ["live-0", `${EDITOR_TEXT}${CURSOR_MARKER}`];
		tui.requestRender();
		await scheduler.settle(terminal);
		const grid = activeGrid(terminal);
		expect(rowsContaining(grid, "OVERLAY-0"), "the marked overlay row sits above the viewport").toEqual([18]);
		const shown = [...terminal.takeWrites().join("").matchAll(/\x1b\[(\d+);\d+H\x1b\[\?25h/g)].map(m => Number(m[1]));
		expect(shown.at(-1), "cursor on the bottom-most marker: the input row").toBe(ROWS);
	} finally {
		tui.stop();
	}
});

it("leaves a scaled history row out of the alternate-buffer copy an overlay paints over", async () => {
	const { terminal, scheduler, tui, provider } = startFull();
	try {
		await scheduler.settle(terminal);
		provider.history = [...fullViewport().slice(0, ROWS - 1), "hist-0", OSC_ROW, "hist-2"];
		provider.viewport = ["live-0", `${EDITOR_TEXT}${CURSOR_MARKER}`];
		tui.requestRender();
		await scheduler.settle(terminal);
		expect(rowsContaining(activeGrid(terminal), "MARK-OSC"), "scaled row on screen above the viewport").toHaveLength(1);
		const handle = tui.showOverlay(new RowsBlock("OVERLAY", 2), { anchor: "top-left", width: 20 });
		await scheduler.settle(terminal);
		const covered = activeGrid(terminal);
		expect(rowsContaining(covered, "hist-2"), "plain history copied under the overlay").toHaveLength(1);
		expect(rowsContaining(covered, "MARK-OSC"), "the scaled row is not copied").toEqual([]);
		handle.hide();
		await scheduler.settle(terminal);
		expect(ledger(terminal, /MARK-OSC/), "the normal buffer keeps the scaled row once").toEqual(["MARK-OSC"]);
	} finally {
		tui.stop();
	}
});
