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
		// Each line fills all 10 cells only if the accent and the joiner count as zero
		// width; a miscount would cut the final "x"/"b".
		const viewport = await renderLines([`e\u0301${"x".repeat(9)}`, `a\u200d${"b".repeat(9)}`]);
		expect(viewport[0]!.normalize("NFC")).toBe(`\u00e9${"x".repeat(9)}`);
		expect(viewport[1]!.replace(/\u200d/g, "")).toBe(`a${"b".repeat(9)}`);
	});

	it("renders an emoji surrogate pair as one glyph at the boundary", async () => {
		const viewport = await renderLines([`${"a".repeat(8)}😀`]);
		expect(viewport[0]).toContain("😀");
	});

	// A sequence left open at the end of a line would swallow the row's SGR reset
	// and leak "[0m" as text (t-54b2ea43); the short-line path cuts it as the
	// giant-line path does.
	it.each([
		["an unterminated CSI", "abc\x1b[31", "abc"],
		["an unterminated OSC 8", "abc\x1b]8;;https://example.com", "abc"],
		["a lone trailing ESC", "abc\x1b", "abc"],
		["a dangling CSI after a styled span", "a\x1b[31mb\x1b[0mc\x1b[", "abc"],
	])("cuts %s from a short line before the row reset", async (_name, line, visible) => {
		const terminal = new VirtualTerminal(10, 6);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider({
			renderFrame: () => ({ viewport: [line] }),
			acknowledgeHistory() {},
		});
		const frames: string[] = [];
		tui.addFrameWriteListener(data => {
			frames.push(data);
		});
		try {
			tui.start();
			await scheduler.settle(terminal);
		} finally {
			tui.stop();
		}
		expect(terminal.getViewport()[0]!.trimEnd()).toBe(visible);
		// Everything before the dangling sequence reaches the terminal, followed
		// directly by the row reset: the open sequence's bytes are gone.
		expect(frames.join("")).toContain(`${line.slice(0, line.lastIndexOf("\x1b"))}\x1b[0m`);
	});

	it("renders an OSC 8 hyperlink line's visible text", async () => {
		const viewport = await renderLines(["\x1b]8;;https://example.com\x07link\x1b]8;;\x07"]);
		expect(viewport[0]).toContain("link");
	});

	// Lines longer than the fit source budget (4096 code units at this width) take the
	// giant-line path, which copies only the visible prefix.
	const GIANT_TAIL = 70_000;

	it("stops a giant line at a wide character that would cross the width", async () => {
		const viewport = await renderLines([`${"a".repeat(9)}\u754c${"b".repeat(GIANT_TAIL)}`]);
		expect(viewport[0]!.trimEnd()).toBe("a".repeat(9));
	});

	it("cuts a giant line at an unterminated CSI sequence", async () => {
		const viewport = await renderLines([`abc\x1b[${"1;".repeat(GIANT_TAIL / 2)}`]);
		expect(viewport[0]!.trimEnd()).toBe("abc");
	});

	it("cuts a giant line at an unterminated OSC sequence", async () => {
		const viewport = await renderLines([`abc\x1b]8;;${"u".repeat(GIANT_TAIL)}`]);
		expect(viewport[0]!.trimEnd()).toBe("abc");
	});

	it("cuts a giant line at a trailing lone ESC", async () => {
		// Zero-width joiners past the source budget are skipped without filling the row,
		// so the scan reaches the final ESC, which has no sequence byte after it.
		const viewport = await renderLines([`ab${"\u200d".repeat(GIANT_TAIL)}\x1b`]);
		expect(viewport[0]!.replace(/\u200d/g, "").trimEnd()).toBe("ab");
	});

	it("drops a two-byte escape from a giant line and keeps fitting the text after it", async () => {
		// ESC 7 (save cursor) has no visible payload: it is skipped, not treated as a cut.
		const viewport = await renderLines([`ab\x1b7${"c".repeat(GIANT_TAIL)}`]);
		expect(viewport[0]).toBe(`ab${"c".repeat(8)}`);
	});

	describe("once an OSC 66 run fills the source budget", () => {
		// 4094 code units of scaled-text metadata with one visible cell: "ab" plus
		// this sequence leaves exactly the 4096-unit budget used and 7 cells free.
		const scaled = `\x1b]66;w=1${":n=1".repeat(1019)}:n=123;X\x1b\\`;

		async function frameText(line: string): Promise<string> {
			const terminal = new VirtualTerminal(10, 6);
			const scheduler = new VirtualRenderScheduler();
			const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
			tui.setFrameProvider({ renderFrame: () => ({ viewport: [line] }), acknowledgeHistory() {} });
			const frames: string[] = [];
			tui.addFrameWriteListener(data => {
				frames.push(data);
			});
			try {
				tui.start();
				await scheduler.settle(terminal);
			} finally {
				tui.stop();
			}
			return frames.join("");
		}

		it("stops at the next visible character even though cells remain", async () => {
			expect(scaled.length).toBe(4094);
			const text = await frameText(`ab${scaled}\u00e9${"z".repeat(GIANT_TAIL)}`);
			expect(text).toContain(`ab${scaled}`);
			expect(text).not.toContain("\u00e9");
			expect(text).not.toContain("z");
		});

		it("drops zero-width characters that no longer fit the budget", async () => {
			const text = await frameText(`ab${scaled}\u200d\u00e9${"z".repeat(GIANT_TAIL)}`);
			expect(text).toContain(`ab${scaled}`);
			expect(text).not.toContain("\u200d");
			expect(text).not.toContain("\u00e9");
		});

		it("stops an ASCII run once the budget is spent", async () => {
			const text = await frameText(`ab${scaled}${"z".repeat(GIANT_TAIL)}`);
			expect(text).toContain(`ab${scaled}`);
			expect(text).not.toContain("z");
		});

		it("skips a scaled-text run that would overflow the budget and fits the text after it", async () => {
			const oversized = `\x1b]66;w=1${":n=1".repeat(1100)};Y\x1b\\`;
			const text = await frameText(`ab${oversized}${"c".repeat(GIANT_TAIL)}`);
			expect(text).not.toContain(oversized);
			expect(text).toContain(`ab${"c".repeat(8)}`);
		});
	});

	it("fits a giant line led by a surrogate-pair emoji", async () => {
		const viewport = await renderLines([`😀${"z".repeat(GIANT_TAIL)}`]);
		expect(viewport[0]).toBe(`😀${"z".repeat(8)}`);
	});

	it("keeps a wide character that fits at the start of a giant line", async () => {
		const viewport = await renderLines([`\u754c${"b".repeat(GIANT_TAIL)}`]);
		expect(viewport[0]).toBe(`\u754c${"b".repeat(8)}`);
	});
});
