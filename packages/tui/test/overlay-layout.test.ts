import { describe, expect, it } from "bun:test";
import { Text, TUI } from "@oh-my-pi/pi-tui";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

async function showOverlay(options: Parameters<TUI["showOverlay"]>[1]) {
	const terminal = new VirtualTerminal(40, 10);
	const scheduler = new VirtualRenderScheduler();
	const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
	tui.addChild(new Text("base", 0, 0));
	tui.start();
	try {
		await scheduler.settle(terminal);
		tui.showOverlay(new Text("LAYOUT", 0, 0), options);
		await scheduler.settle(terminal);
		const viewport = terminal.getViewport();
		const row = viewport.findIndex(line => line.includes("LAYOUT"));
		const col = row === -1 ? -1 : viewport[row]!.indexOf("LAYOUT");
		return { row, col };
	} finally {
		tui.stop();
	}
}

describe("TUI overlay layout options", () => {
	it("places an overlay by percentage width, row and column", async () => {
		const { row, col } = await showOverlay({ width: "50%", row: "0%", col: "0%" });
		expect(row).toBe(0);
		expect(col).toBe(0);
	});

	it("places an overlay by absolute row and column", async () => {
		const { row, col } = await showOverlay({ width: 20, row: 2, col: 3 });
		expect(row).toBe(2);
		expect(col).toBe(3);
	});

	it.each([
		["top-left", 0, 0],
		["top-center", 0, 17],
		["top-right", 0, 34],
		["left-center", 4, 0],
		["center", 4, 17],
		["right-center", 4, 34],
		["bottom-left", 9, 0],
		["bottom-center", 9, 17],
		["bottom-right", 9, 34],
	] as const)("places an overlay at anchor %s", async (anchor, row, col) => {
		const placed = await showOverlay({ width: 6, anchor });
		expect(placed.row).toBe(row);
		expect(placed.col).toBe(col);
	});

	it("applies row and column offsets to anchored placement", async () => {
		const placed = await showOverlay({ width: 6, anchor: "top-left", offsetY: 2, offsetX: 3 });
		expect(placed.row).toBe(2);
		expect(placed.col).toBe(3);
	});

	it("falls back to centred placement for invalid percentage row and column", async () => {
		const centred = await showOverlay({ width: 6 });
		const invalid = await showOverlay({ width: 6, row: "bogus", col: "bogus" });
		expect(invalid.row).toBe(centred.row);
		expect(invalid.col).toBe(centred.col);
		expect(invalid.row).toBeGreaterThan(0);
	});

	it("honours minWidth when resolving overlay width", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		const widths: number[] = [];
		tui.addChild(new Text("base", 0, 0));
		tui.start();
		try {
			await scheduler.settle(terminal);
			tui.showOverlay(
				{
					render: (width: number) => {
						widths.push(width);
						return ["WIDE"];
					},
				},
				{ width: 4, minWidth: 12, row: 0, col: 0 },
			);
			await scheduler.settle(terminal);
			expect(Math.max(...widths)).toBe(12);
		} finally {
			tui.stop();
		}
	});

	it("repaints a fullscreen overlay at the new size after a resize", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.addChild(new Text("base", 0, 0));
		tui.start();
		try {
			await scheduler.settle(terminal);
			tui.showOverlay(new Text("FULLSCREEN", 0, 0), { fullscreen: true, width: "100%", maxHeight: "100%" });
			await scheduler.settle(terminal);
			expect(terminal.getViewport().join("\n")).toContain("FULLSCREEN");
			terminal.resize(30, 8);
			await scheduler.advance(terminal, 1000);
			await scheduler.settle(terminal);
			expect(terminal.getViewport().join("\n")).toContain("FULLSCREEN");
		} finally {
			tui.stop();
		}
	});

	it("renders only the visible overlay when another overlay is hidden", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.addChild(new Text("base", 0, 0));
		tui.start();
		try {
			await scheduler.settle(terminal);
			const lower = tui.showOverlay(new Text("LOWER", 0, 0), { width: 6, row: 1, col: 0 });
			tui.showOverlay(new Text("UPPER", 0, 0), { width: 6, row: 3, col: 0 });
			await scheduler.settle(terminal);
			lower.setHidden(true);
			await scheduler.settle(terminal);
			const viewport = terminal.getViewport().join("\n");
			expect(viewport).toContain("UPPER");
			expect(viewport).not.toContain("LOWER");
		} finally {
			tui.stop();
		}
	});

	it("falls back to the default width for an invalid percentage width", async () => {
		const { row, col } = await showOverlay({ width: "bogus%" as never, row: 1, col: 1 });
		expect(row).toBe(1);
		// The default width fills the terminal, so the column clamps to 0.
		expect(col).toBe(0);
	});
});
