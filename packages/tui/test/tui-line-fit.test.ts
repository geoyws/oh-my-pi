import { describe, expect, it } from "bun:test";
import { TUI } from "@oh-my-pi/pi-tui";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

async function renderLines(lines: string[], width = 10, rows = 6): Promise<string[]> {
	const terminal = new VirtualTerminal(width, rows);
	const scheduler = new VirtualRenderScheduler();
	const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
	tui.setFrameProvider({
		renderFrame: () => ({ viewport: lines }),
		acknowledgeHistory() {},
	});
	try {
		tui.start();
		await scheduler.settle(terminal);
		return terminal.getViewport();
	} finally {
		tui.stop();
	}
}

describe("TUI provider line fitting", () => {
	it("fits a giant provider line to the viewport width", async () => {
		const viewport = await renderLines(["x".repeat(5000)]);
		expect(viewport[0]!.trimEnd().length).toBeLessThanOrEqual(10);
		expect(viewport[0]).toContain("x");
	});

	it("does not split a wide character at the width boundary", async () => {
		// Nine ASCII cells plus one two-cell CJK character in a 10-cell viewport.
		const viewport = await renderLines([`${"a".repeat(9)}界`]);
		expect(viewport[0]).toContain("a".repeat(9));
		expect(viewport[0]).not.toContain("界");
	});

	it("keeps a wide character that exactly fills the viewport", async () => {
		const viewport = await renderLines([`${"a".repeat(8)}界`]);
		expect(viewport[0]).toContain("界");
	});

	it("renders combining and zero-width characters without widening the row", async () => {
		const viewport = await renderLines(["éx", "a‍b"]);
		expect(viewport[0]).toContain("e");
		expect(viewport[1]!.replace(/\u200d/g, "")).toContain("ab");
	});

	it("renders an emoji surrogate pair as one glyph at the boundary", async () => {
		const viewport = await renderLines([`${"a".repeat(8)}😀`]);
		expect(viewport[0]).toContain("😀");
	});

	it("passes a line with an unterminated ANSI sequence through fitting", async () => {
		const viewport = await renderLines(["abc\x1b[31"]);
		expect(viewport[0]).toContain("abc");
	});

	it("renders an OSC 8 hyperlink line's visible text", async () => {
		const viewport = await renderLines(["\x1b]8;;https://example.com\x07link\x1b]8;;\x07"]);
		expect(viewport[0]).toContain("link");
	});
});
