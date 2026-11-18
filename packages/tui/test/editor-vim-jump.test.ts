import { describe, expect, it } from "bun:test";
import { Editor } from "@oh-my-pi/pi-tui/components/editor";
import { defaultEditorTheme } from "./test-themes";

const ESC = "\x1b";

function insertEditor(text: string): Editor {
	const editor = new Editor(defaultEditorTheme);
	editor.setVimMode(true);
	editor.setText(text);
	editor.moveToMessageStart();
	return editor;
}

describe("Editor character jump and replace modes", () => {
	it("jumps forward to the named character", () => {
		const editor = insertEditor("hello world");
		editor.handleInput("\x1d"); // Ctrl+]
		editor.handleInput("w");
		expect(editor.getCursor().col).toBe(6);
		expect(editor.getText()).toBe("hello world");
	});

	it("jumps backward to the named character", () => {
		const editor = insertEditor("hello world");
		editor.handleInput("\x1b[29;5u"); // Ctrl+Alt+]
		editor.handleInput("o");
		expect(editor.getCursor().col).toBeLessThan(11);
	});

	it("cancels jump mode when the hotkey is pressed again", () => {
		const editor = insertEditor("hello");
		editor.handleInput("\x1d");
		editor.handleInput("\x1d");
		editor.handleInput("x");
		expect(editor.getText()).toBe("xhello");
	});

	it("cancels jump mode on a control character and handles it normally", () => {
		const editor = insertEditor("hello");
		editor.handleInput("\x1d");
		editor.handleInput(ESC);
		// Jump mode cancelled; Escape falls through to Vim mode handling.
		expect(editor.vimMode).toBe("normal");
		expect(editor.getText()).toBe("hello");
		editor.handleInput("i");
		editor.handleInput("x");
		expect(editor.getText()).toBe("xhello");
	});

	it("inserts a regular space for shift+space", () => {
		const editor = insertEditor("ab");
		editor.handleInput("\x1b[32;2u");
		expect(editor.getText()).toBe(" ab");
	});

	it("routes Alt+Enter to its callback when set and to a new line otherwise", () => {
		const editor = insertEditor("line");
		const seen: string[] = [];
		editor.onAltEnter = text => seen.push(text);
		editor.handleInput("\x1b\r");
		expect(seen).toEqual(["line"]);
		expect(editor.getText()).toBe("line");

		const plain = insertEditor("line");
		plain.handleInput("\x1b\r");
		expect(plain.getText()).toContain("\n");
	});

	it("inserts a new line for Shift+Enter encodings", () => {
		for (const seq of ["\x1b[13;2~", "\x1b[13;2u"]) {
			const editor = insertEditor("ab");
			editor.handleInput(seq);
			expect(editor.getText()).toContain("\n");
		}
	});

	it("inserts a new line after a trailing backslash without a submit remap", () => {
		const editor = insertEditor("cmd\\");
		const submitted: string[] = [];
		editor.onSubmit = text => submitted.push(text);
		editor.handleInput("\x1b[13;2u");
		expect(submitted).toEqual([]);
		expect(editor.getText()).toBe("cmd\\\n");
	});

	it("declines an unmapped normal-mode key without editing", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setVimMode(true);
		editor.setText("abc");
		editor.handleInput(ESC);
		editor.handleInput("g");
		editor.handleInput("g");
		editor.handleInput("!");
		expect(editor.getText()).toBe("abc");
		expect(editor.vimMode).toBe("normal");
	});

	it("overwrites in replace mode and restores on backspace", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setVimMode(true);
		editor.setText("abc");
		editor.handleInput(ESC);
		editor.handleInput("g");
		editor.handleInput("g");
		expect(editor.vimMode).toBe("normal");
		editor.handleInput("R");
		expect(editor.vimMode).toBe("replace");
		editor.handleInput("X");
		expect(editor.getText()).toBe("Xbc");
		editor.handleInput("\x7f");
		expect(editor.getText()).toBe("abc");
		editor.handleInput(ESC);
		expect(editor.vimMode).toBe("normal");
	});
});
