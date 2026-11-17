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

	it("falls back to centred placement for invalid percentage row and column", async () => {
		const centred = await showOverlay({ width: 6 });
		const invalid = await showOverlay({ width: 6, row: "bogus", col: "bogus" });
		expect(invalid.row).toBe(centred.row);
		expect(invalid.col).toBe(centred.col);
		expect(invalid.row).toBeGreaterThan(0);
	});

	it("falls back to the default width for an invalid percentage width", async () => {
		const { row, col } = await showOverlay({ width: "bogus%" as never, row: 1, col: 1 });
		expect(row).toBe(1);
		// The default width fills the terminal, so the column clamps to 0.
		expect(col).toBe(0);
	});
});
