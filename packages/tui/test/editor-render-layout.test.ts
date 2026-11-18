import { beforeAll, describe, expect, it } from "bun:test";
import { CURSOR_MARKER } from "@oh-my-pi/pi-tui";
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

describe("Editor cursor and scroll rendering", () => {
	it("marks the cursor in a focused editor and omits it unfocused", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("hello");
		expect(editor.render(40).join("\n")).not.toContain(CURSOR_MARKER);
		editor.focused = true;
		expect(editor.render(40).join("\n")).toContain(CURSOR_MARKER);
	});

	it("renders the cursor marker at the end of an exactly full row", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.focused = true;
		// Content width at 16 is 10 (border chrome): exactly fill it.
		editor.setText("0123456789ABCDEFGHIJKLMNOPQRST");
		const rows = editor.render(16);
		expect(rows.join("\n")).toContain(CURSOR_MARKER);
	});

	it("scrolls to keep the cursor visible under a max height", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText(Array.from({ length: 10 }, (_, i) => `line-${i}`).join("\n"));
		editor.setMaxHeight(3);
		const atEnd = editor.render(40).map(row => Bun.stripANSI(row).replaceAll(CURSOR_MARKER, ""));
		expect(atEnd.join("\n")).toContain("line-9");
		expect(atEnd.join("\n")).not.toContain("line-0");
		editor.moveToMessageStart();
		const atStart = editor.render(40).map(row => Bun.stripANSI(row).replaceAll(CURSOR_MARKER, ""));
		expect(atStart.join("\n")).toContain("line-0");
		expect(atStart.join("\n")).not.toContain("line-9");
	});
});

describe("Editor native describe", () => {
	it("memoizes the described root until the text changes", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("draft");
		const first = editor.describe(cx);
		expect(editor.describe(cx)).toBe(first);
		editor.setText("draft v2");
		const second = editor.describe(cx);
		expect(second).not.toBe(first);
		expect(JSON.stringify(second)).toContain("draft v2");
	});

	it("describes text, end cursor and max lines", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("one\ntwo");
		editor.setMaxHeight(4);
		const root = editor.describe(cx);
		const editorNode = (root.c ?? []).find(child => "k" in child && child.k === "editor") as
			| { p?: { text?: string; cursor?: number; maxLines?: number } }
			| undefined;
		expect(editorNode?.p?.text).toBe("one\ntwo");
		expect(editorNode?.p?.cursor).toBe("one\ntwo".length);
		expect(editorNode?.p?.maxLines).toBe(4);
	});

	it("describes an empty editor with no text and cursor at zero", () => {
		const editor = new Editor(defaultEditorTheme);
		const root = editor.describe(cx);
		const editorNode = (root.c ?? []).find(child => "k" in child && child.k === "editor") as
			| { p?: { text?: string; cursor?: number } }
			| undefined;
		expect(editorNode?.p?.text).toBe("");
		expect(editorNode?.p?.cursor).toBe(0);
	});
});

describe("Editor decorations, scrollbar and gutter edges", () => {
	it("keeps decoration identity across describes with equal decorations", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("draft");
		const decor = [{ from: 0, to: 2, s: "accent" }];
		(editor as unknown as { describeDecorations: unknown }).describeDecorations = () => decor;
		const propsOf = () => {
			const root = editor.describe(cx);
			const found = (root.c ?? []).find(child => "k" in child && child.k === "editor") as
				| { p?: { decor?: unknown } }
				| undefined;
			return found?.p?.decor;
		};
		expect(propsOf()).toBe(decor);
		editor.invalidate();
		// Equal decorations keep the previous array identity.
		(editor as unknown as { describeDecorations: unknown }).describeDecorations = () => [{ from: 0, to: 2, s: "accent" }];
		expect(propsOf()).toBe(decor);
	});

	it("replaces decorations when their length or fields change", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("draft");
		const propsOf = () => {
			const root = editor.describe(cx);
			const found = (root.c ?? []).find(child => "k" in child && child.k === "editor") as
				| { p?: { decor?: unknown } }
				| undefined;
			return found?.p?.decor;
		};
		(editor as unknown as { describeDecorations: unknown }).describeDecorations = () => [{ from: 0, to: 2, s: "accent" }];
		expect(propsOf()).toEqual([{ from: 0, to: 2, s: "accent" }]);
		editor.invalidate();
		(editor as unknown as { describeDecorations: unknown }).describeDecorations = () => [
			{ from: 0, to: 2, s: "accent" },
			{ from: 3, to: 5, s: "muted" },
		];
		expect(propsOf()).toHaveLength(2);
		editor.invalidate();
		(editor as unknown as { describeDecorations: unknown }).describeDecorations = () => [{ from: 1, to: 2, s: "accent" }];
		expect(propsOf()).toEqual([{ from: 1, to: 2, s: "accent" }]);
		// Clearing decorations removes them from the description.
		editor.invalidate();
		(editor as unknown as { describeDecorations: unknown }).describeDecorations = () => [];
		expect(propsOf()).toBeUndefined();
	});

	it("bounds the debug preview when the first line alone exceeds it", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText(`${"x".repeat(200)}\nsecond`);
		const state = editor.debugState();
		expect(state.previewTruncated).toBe(true);
		expect(state.lineCount).toBe(2);
		expect((state.textPreview as string).length).toBeLessThanOrEqual(120);
	});

	it("paints a scrollbar thumb when content overflows with the scrollbar visible", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText(Array.from({ length: 20 }, (_, i) => `row-${i}`).join("\n"));
		editor.setMaxHeight(3);
		editor.setScrollbarVisible(true);
		const rows = editor.render(40).map(row => Bun.stripANSI(row));
		expect(rows.length).toBeGreaterThan(1);
		// The cursor rests on the last row, so the viewport follows it there.
		expect(rows.join("\n")).toContain("row-19");
		expect(rows.join("\n")).not.toContain("row-0");
	});

	it("slices a prompt gutter wider than the terminal to the row width", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("body");
		editor.setBorderVisible(false);
		editor.setPromptGutter(">>>>>>>>>>");
		const rows = editor.render(8).map(row => Bun.stripANSI(row));
		expect(rows[0]).toContain(">>>>>>>>");
	});
});

describe("Editor software and terminal cursor shapes", () => {
	it("highlights the grapheme under a software cursor mid-text", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setUseTerminalCursor(false);
		editor.focused = true;
		editor.setText("hello");
		editor.handleInput("\x1b[D");
		editor.handleInput("\x1b[D");
		const rows = editor.render(40);
		expect(rows.join("")).toContain("\x1b[7ml\x1b[0m");
	});

	it("renders a cursor override at the end of the text", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setUseTerminalCursor(false);
		editor.focused = true;
		editor.setText("hi");
		editor.cursorOverride = "X";
		const rows = editor.render(40);
		expect(rows.join("")).toContain(`${CURSOR_MARKER}X`);
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

	it("collapses trailing whitespace at a wrap boundary without losing words", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("alpha     beta gamma delta epsilon");
		const rows = editor.render(16).map(row => Bun.stripANSI(row));
		const joined = rows.join(" ");
		expect(joined).toContain("alpha");
		expect(joined).toContain("beta");
		expect(joined).toContain("epsilon");
	});

	it("describes the editor as a native editor node", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("draft");
		const node = editor.describe(cx);
		expect(node.k).toBeDefined();
		expect(JSON.stringify(node)).toContain("draft");
	});
});
