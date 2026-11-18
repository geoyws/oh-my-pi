import { describe, expect, it } from "bun:test";
import { Editor } from "@oh-my-pi/pi-tui/components/editor";
import { defaultEditorTheme } from "./test-themes";

function editorWith(text: string): Editor {
	const editor = new Editor(defaultEditorTheme);
	editor.setText(text);
	return editor;
}

function right(editor: Editor, count: number): void {
	for (let i = 0; i < count; i++) editor.handleInput("\x1b[C");
}

describe("Editor kill ring, yank and undo", () => {
	it("yanks nothing when the kill ring is empty", () => {
		const editor = editorWith("abc");
		editor.handleInput("\x19"); // Ctrl+Y
		expect(editor.getText()).toBe("abc");
	});

	it("kills to end of line and yanks it back", () => {
		const editor = editorWith("hello world");
		editor.moveToLineStart();
		right(editor, 6);
		editor.handleInput("\x0b"); // Ctrl+K
		expect(editor.getText()).toBe("hello ");
		editor.handleInput("\x19"); // Ctrl+Y
		expect(editor.getText()).toBe("hello world");
	});

	it("kills to start of line and yanks it back at the cursor", () => {
		const editor = editorWith("hello world");
		editor.moveToLineStart();
		right(editor, 6);
		editor.handleInput("\x15"); // Ctrl+U
		expect(editor.getText()).toBe("world");
		editor.handleInput("\x19");
		expect(editor.getText()).toBe("hello world");
	});

	it("does not yank-pop after a non-yank action or with a single entry", () => {
		const editor = editorWith("hello world");
		editor.moveToLineStart();
		right(editor, 6);
		editor.handleInput("\x0b");
		editor.handleInput("\x19");
		editor.handleInput("\x1by"); // Alt+Y, single ring entry
		expect(editor.getText()).toBe("hello world");
		editor.handleInput("z");
		editor.handleInput("\x1by");
		expect(editor.getText()).toBe("hello worldz");
	});

	it("undoes typing and is a no-op with an empty undo stack", () => {
		const editor = editorWith("");
		editor.handleInput("\x1f"); // Ctrl+_
		expect(editor.getText()).toBe("");
		editor.handleInput("x");
		expect(editor.getText()).toBe("x");
		editor.handleInput("\x1f");
		expect(editor.getText()).toBe("");
	});

	it("deletes a word backward and forward", () => {
		const editor = editorWith("hello world");
		editor.handleInput("\x17"); // Ctrl+W
		expect(editor.getText()).toBe("hello ");
		const forward = editorWith("hello world");
		forward.moveToLineStart();
		forward.handleInput("\x1bd"); // Alt+D
		expect(forward.getText()).toBe(" world");
	});

	it("moves to line start and end", () => {
		const editor = editorWith("hello");
		editor.moveToLineStart();
		expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
		editor.moveToLineEnd();
		expect(editor.getCursor()).toEqual({ line: 0, col: 5 });
	});
});
