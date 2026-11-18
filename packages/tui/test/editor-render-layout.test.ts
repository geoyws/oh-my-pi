import { beforeAll, describe, expect, it } from "bun:test";
import { Editor } from "@oh-my-pi/pi-tui/components/editor";
import type { DescribeContext } from "@oh-my-pi/pi-tui/native/node";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { defaultEditorTheme } from "./test-themes";

beforeAll(async () => {
	await initTheme(false);
});

const cx: DescribeContext = {
	cols: 80,
	reduceMotion: false,
	dark: true,
	supports: () => true,
	feature: () => true,
};

describe("Editor debug state and simple setters", () => {
	it("reports bounded debug state for empty, short and long text", () => {
		const editor = new Editor(defaultEditorTheme);
		expect(editor.debugState()).toMatchObject({ textLength: 0, lineCount: 1, selection: null });
		editor.setText("hello");
		expect(editor.debugState()).toMatchObject({ textPreview: "hello", textLength: 5, previewTruncated: false });
		editor.setText("x".repeat(200));
		const long = editor.debugState();
		expect(long.previewTruncated).toBe(true);
		expect((long.textPreview as string).length).toBeLessThanOrEqual(120);
		editor.setText("one\ntwo");
		expect(editor.debugState()).toMatchObject({ lineCount: 2, textPreview: "one\ntwo" });
	});

	it("has no debug children without an autocomplete list", () => {
		const editor = new Editor(defaultEditorTheme);
		expect(editor.debugChildren).toEqual([]);
	});

	it("round-trips terminal-cursor and vim-escape state", () => {
		const editor = new Editor(defaultEditorTheme);
		const initial = editor.getUseTerminalCursor();
		editor.setUseTerminalCursor(!initial);
		expect(editor.getUseTerminalCursor()).toBe(!initial);
		editor.setUseTerminalCursor(initial);
		expect(editor.getUseTerminalCursor()).toBe(initial);
		expect(editor.vimConsumesEscape()).toBe(false);
		editor.setVimMode(true);
		// Vim starts in insert mode, which consumes Escape.
		expect(editor.vimConsumesEscape()).toBe(true);
	});

	it("accepts repeated and undefined max heights without losing render", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("a\nb\nc\nd\ne");
		editor.setMaxHeight(2);
		editor.setMaxHeight(2);
		expect(editor.render(40).length).toBeGreaterThan(0);
		editor.setMaxHeight(undefined);
		expect(editor.render(40).length).toBeGreaterThan(0);
	});

	it("clamp autocomplete max visible into its documented range", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteMaxVisible(1);
		expect(editor.getAutocompleteMaxVisible()).toBe(3);
		editor.setAutocompleteMaxVisible(100);
		expect(editor.getAutocompleteMaxVisible()).toBe(20);
		editor.setAutocompleteMaxVisible(Number.NaN);
		expect(editor.getAutocompleteMaxVisible()).toBe(10);
		editor.setAutocompleteMaxVisible(7);
		expect(editor.getAutocompleteMaxVisible()).toBe(7);
	});

	it("renders with scrollbar hidden and explicit padding", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("body");
		editor.setScrollbarVisible(false);
		editor.setPaddingX(2);
		const rows = editor.render(40);
		expect(rows.join("\n")).toContain("body");
	});
});

describe("Editor border, gutter and invalidation", () => {
	it("hides the border chrome when border visibility is off and restores it when on", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("body");
		const bordered = editor.render(40).map(row => Bun.stripANSI(row));
		expect(bordered.join("\n")).toContain("+");
		editor.setBorderVisible(false);
		editor.setBorderVisible(false);
		const plain = editor.render(40).map(row => Bun.stripANSI(row));
		expect(plain.join("\n")).not.toContain("+");
		expect(plain.join("\n")).toContain("body");
		editor.setBorderVisible(true);
		expect(editor.render(40).map(row => Bun.stripANSI(row)).join("\n")).toContain("+");
	});

	it("keeps the same top-border provider without re-registering it", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("body");
		let calls = 0;
		const provider = (availableWidth: number) => {
			calls++;
			return { content: `w=${availableWidth}`, width: 6 };
		};
		editor.setTopBorderProvider(provider);
		editor.setTopBorderProvider(provider);
		editor.render(80);
		expect(calls).toBe(1);
		editor.setTopBorderProvider(undefined);
		editor.render(80);
		expect(calls).toBe(1);
	});

	it("shows a prompt gutter only in borderless contexts", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("body");
		editor.setPromptGutter(">> ");
		const bordered = editor.render(40).map(row => Bun.stripANSI(row));
		expect(bordered.join("\n")).not.toContain(">>");
		editor.setBorderVisible(false);
		const borderless = editor.render(40).map(row => Bun.stripANSI(row));
		expect(borderless.join("\n")).toContain(">>");
	});

});

describe("Editor wrap rendering", () => {
	it("renders an empty editor as a blank row", () => {
		const editor = new Editor(defaultEditorTheme);
		const rows = editor.render(20);
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.join("\n")).not.toContain("undefined");
	});

	it("breaks a single word wider than the viewport by grapheme", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("abcdefghijklmnop");
		const rows = editor.render(16).map(row => Bun.stripANSI(row));
		expect(rows.length).toBeGreaterThan(1);
		expect(rows.join("")).toContain("abcdefghij");
		expect(rows.join("")).toContain("klmnop");
	});

	it("keeps leading whitespace mapped across wrapped lines", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("    indented words wrap here please");
		const rows = editor.render(16).map(row => Bun.stripANSI(row));
		expect(rows.length).toBeGreaterThan(1);
		expect(rows.join(" ")).toContain("indented");
	});

	it("describes the editor as a native editor node", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("draft");
		const node = editor.describe(cx);
		expect(node.k).toBeDefined();
		expect(JSON.stringify(node)).toContain("draft");
	});
});
