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
		editor.moveToMessageEnd();
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

	it("joins lines with vim gap rules", () => {
		const plain = new Editor(defaultEditorTheme);
		plain.setVimMode(true);
		plain.setText("one\ntwo");
		plain.handleInput(ESC);
		plain.handleInput("g");
		plain.handleInput("g");
		plain.handleInput("J");
		expect(plain.getText()).toBe("one two");

		const sentence = new Editor(defaultEditorTheme);
		sentence.setVimMode(true);
		sentence.setText("end.\nnext");
		sentence.handleInput(ESC);
		sentence.handleInput("g");
		sentence.handleInput("g");
		sentence.handleInput("J");
		expect(sentence.getText()).toBe("end.  next");

		const empty = new Editor(defaultEditorTheme);
		empty.setVimMode(true);
		empty.setText("one\n");
		empty.handleInput(ESC);
		empty.handleInput("g");
		empty.handleInput("g");
		empty.handleInput("J");
		expect(empty.getText()).toBe("one");
	});

	it("indents and dedents lines, leaving empty lines empty", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setVimMode(true);
		editor.setText("one\n\ntwo");
		editor.handleInput(ESC);
		editor.handleInput("g");
		editor.handleInput("g");
		editor.handleInput(">");
		editor.handleInput(">");
		expect(editor.getText()).toBe("  one\n\ntwo");
		editor.handleInput("<");
		editor.handleInput("<");
		expect(editor.getText()).toBe("one\n\ntwo");
	});

	it("deletes a line and pastes it back linewise", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setVimMode(true);
		editor.setText("one\ntwo");
		editor.handleInput(ESC);
		editor.handleInput("g");
		editor.handleInput("g");
		editor.handleInput("d");
		editor.handleInput("d");
		expect(editor.getText()).toBe("two");
		editor.handleInput("p");
		expect(editor.getText()).toBe("two\none");
	});

	it("repeats a word deletion with dot", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setVimMode(true);
		editor.setText("one two three");
		editor.handleInput(ESC);
		editor.handleInput("g");
		editor.handleInput("g");
		editor.handleInput("d");
		editor.handleInput("w");
		expect(editor.getText()).toBe("two three");
		editor.handleInput(".");
		expect(editor.getText()).toBe("three");
	});

	it("jumps backward with the ctrl+alt encoding", () => {
		const editor = insertEditor("hello world");
		editor.moveToMessageEnd();
		editor.handleInput("\x1b[93;7u"); // Ctrl+Alt+]
		editor.handleInput("o");
		expect(editor.getCursor().col).toBe(7);
	});

	it("indents a tabbed line with a tab and dedents it back", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setVimMode(true);
		editor.setText("one");
		editor.handleInput(ESC);
		editor.handleInput("g");
		editor.handleInput("g");
		// Make the line tab-indented first through a replace-free path: use >>
		// on an already tabbed line instead.
		editor.setText("\tone");
		const original = editor.getText();
		editor.handleInput("g");
		editor.handleInput("g");
		editor.handleInput(">");
		editor.handleInput(">");
		expect(editor.getText()).not.toBe(original);
		editor.handleInput("<");
		editor.handleInput("<");
		expect(editor.getText()).toBe(original);
	});

	it("deleting the only empty line is a no-op", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setVimMode(true);
		editor.setText("");
		editor.handleInput(ESC);
		editor.handleInput("d");
		editor.handleInput("d");
		expect(editor.getText()).toBe("");
	});

	it("declines an invalid motion after an operator without editing", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setVimMode(true);
		editor.setText("abc");
		editor.handleInput(ESC);
		editor.handleInput("g");
		editor.handleInput("g");
		editor.handleInput("d");
		editor.handleInput("!");
		expect(editor.getText()).toBe("abc");
	});

	it("pastes before the cursor line with P and repeats a paste with a count", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setVimMode(true);
		editor.setText("one\ntwo");
		editor.handleInput(ESC);
		editor.handleInput("g");
		editor.handleInput("g");
		editor.handleInput("d");
		editor.handleInput("d");
		editor.handleInput("P");
		expect(editor.getText()).toBe("one\ntwo");

		const word = new Editor(defaultEditorTheme);
		word.setVimMode(true);
		word.setText("ab cd");
		word.handleInput(ESC);
		word.handleInput("g");
		word.handleInput("g");
		word.handleInput("v");
		word.handleInput("l");
		word.handleInput("y");
		word.handleInput("$");
		word.handleInput("2");
		word.handleInput("p");
		expect(word.getText()).toBe("ab cdabab");
	});

	it("deletes a characterwise and a linewise visual selection", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setVimMode(true);
		editor.setText("hello world");
		editor.handleInput(ESC);
		editor.handleInput("g");
		editor.handleInput("g");
		editor.handleInput("v");
		expect(editor.vimMode).toBe("visual");
		editor.handleInput("l");
		editor.handleInput("l");
		editor.handleInput("d");
		expect(editor.getText()).toBe("lo world");
		expect(editor.vimMode).toBe("normal");

		const lines = new Editor(defaultEditorTheme);
		lines.setVimMode(true);
		lines.setText("one\ntwo\nthree");
		lines.handleInput(ESC);
		lines.handleInput("g");
		lines.handleInput("g");
		lines.handleInput("V");
		expect(lines.vimMode).toBe("visual-line");
		lines.handleInput("d");
		expect(lines.getText()).toBe("two\nthree");
	});

	it("retypes an opened-line insert session with a count", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setVimMode(true);
		editor.setText("base");
		editor.handleInput(ESC);
		editor.handleInput("g");
		editor.handleInput("g");
		editor.handleInput("o");
		editor.handleInput("foo");
		editor.handleInput(ESC);
		editor.handleInput("2");
		editor.handleInput(".");
		expect(editor.getText()).toBe("base\nfoo\nfoo\nfoo");
	});

	it("does not overwrite an atomic token in replace mode", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setVimMode(true);
		editor.setText("hello world");
		(editor as unknown as { atomicTokenPattern: RegExp }).atomicTokenPattern = /\[W\]/g;
		editor.collapseToAtom(0, 6, 11, "[W]", "world");
		editor.handleInput(ESC);
		editor.handleInput("g");
		editor.handleInput("g");
		for (let i = 0; i < 6; i++) editor.handleInput("l");
		editor.handleInput("R");
		editor.handleInput("X");
		expect(editor.getText()).toBe("hello [W]");
	});

	it("joins onto an atom-led line without eating the token", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setVimMode(true);
		editor.setText("one\nworld");
		editor.collapseToAtom(1, 0, 5, "[W]", "world");
		editor.handleInput(ESC);
		editor.handleInput("g");
		editor.handleInput("g");
		editor.handleInput("J");
		expect(editor.getText()).toBe("one [W]");
	});

	it("deletes an empty first line linewise", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setVimMode(true);
		editor.setText("\nabc");
		editor.handleInput(ESC);
		editor.handleInput("g");
		editor.handleInput("g");
		editor.handleInput("d");
		editor.handleInput("d");
		expect(editor.getText()).toBe("abc");
	});

	it("pastes nothing in normal mode when the register is empty", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setVimMode(true);
		editor.setText("abc");
		editor.handleInput(ESC);
		editor.handleInput("g");
		editor.handleInput("g");
		editor.handleInput("p");
		editor.handleInput("P");
		expect(editor.getText()).toBe("abc");
	});

	it("highlights only the selected segment of a wrapped visual selection", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setVimMode(true);
		editor.focused = true;
		editor.setText("hello world");
		editor.handleInput(ESC);
		editor.handleInput("g");
		editor.handleInput("g");
		editor.handleInput("v");
		editor.handleInput("l");
		editor.handleInput("l");
		const rows = editor.render(40);
		expect(rows.join("")).toContain("\x1b[7mh");
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
