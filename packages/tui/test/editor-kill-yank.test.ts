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

	it("cycles yank-pop between two separate kills", () => {
		const editor = editorWith("aaa\nbbb");
		editor.moveToMessageStart();
		editor.handleInput("\x0b"); // kill "aaa"
		editor.handleInput("x"); // intervening edit separates the kills
		editor.handleInput("\x7f"); // remove the intervening edit
		editor.handleInput("\x1b[B"); // down to "bbb"
		editor.moveToLineStart();
		editor.handleInput("\x0b"); // kill "bbb"
		editor.setText("");
		editor.handleInput("\x19"); // yank newest
		const newest = editor.getText();
		editor.handleInput("\x1by"); // pop to the older kill
		const older = editor.getText();
		expect([newest, older]).toEqual(expect.arrayContaining(["aaa", "bbb"]));
		expect(newest).not.toBe(older);
		editor.handleInput("\x1by"); // pop cycles back
		expect(editor.getText()).toBe(newest);
	});

	it("deletes across line boundaries at line edges", () => {
		const editor = editorWith("aa\nbb");
		editor.moveToMessageEnd();
		editor.handleInput("\x17"); // Ctrl+W deletes the last word
		expect(editor.getText()).toBe("aa\n");
		const atStart = editorWith("aa\nbb");
		atStart.moveToMessageStart();
		atStart.handleInput("\x15"); // Ctrl+U at line start: nothing to delete
		expect(atStart.getText()).toBe("aa\nbb");
		atStart.handleInput("\x0b"); // kill "aa"
		atStart.handleInput("\x0b"); // kill at empty line start joins or clears
		expect(atStart.getText()).not.toContain("aa");
	});

	it("moves to message start and end across lines", () => {
		const editor = editorWith("one\ntwo\nthree");
		editor.moveToMessageEnd();
		expect(editor.getCursor()).toEqual({ line: 2, col: 5 });
		editor.moveToMessageStart();
		expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
	});

	it("undoes past a transient completion and ignores a transient that is not at the cursor", () => {
		const editor = editorWith("hello world");
		editor.undoPastTransientText("world");
		expect(editor.getText()).toBe("hello ");

		const other = editorWith("hello");
		other.undoPastTransientText("xyz");
		expect(other.getText()).toBe("hello");

		const typed = editorWith("");
		typed.handleInput("a");
		typed.handleInput("b");
		typed.undoPastTransientText("");
		// The two typed characters form one undo unit.
		expect(typed.getText()).toBe("");
	});

	it("submits through onSubmit unless submit is disabled", () => {
		const editor = editorWith("prompt text");
		const submitted: string[] = [];
		editor.onSubmit = text => submitted.push(text);
		editor.submit();
		expect(submitted).toEqual(["prompt text"]);
		editor.disableSubmit = true;
		editor.submit();
		expect(submitted).toEqual(["prompt text"]);
	});

	it("inserts multi-line text at the cursor", () => {
		const editor = editorWith("XY");
		editor.moveToLineStart();
		right(editor, 1);
		editor.insertText("a\nb");
		expect(editor.getText()).toBe("Xa\nbY");
		expect(editor.getCursor()).toEqual({ line: 1, col: 1 });
	});

	it("yanks and pops multi-line kills", () => {
		function killTwoLines(editor: Editor): void {
			editor.handleInput("\x0b"); // kill the first line's text
			editor.handleInput("\x0b"); // kill the line break, accumulating
		}
		const editor = editorWith("aa\nbb");
		editor.moveToMessageStart();
		killTwoLines(editor);
		editor.handleInput("x");
		editor.handleInput("\x7f");
		editor.setText("cc\ndd");
		editor.moveToMessageStart();
		killTwoLines(editor);
		editor.setText("");
		editor.handleInput("\x19");
		const newest = editor.getText();
		editor.handleInput("\x1by");
		const older = editor.getText();
		expect([newest, older]).toEqual(expect.arrayContaining(["aa\n", "cc\n"]));
		expect(newest).not.toBe(older);
	});

	it("deletes forward by grapheme, joins lines at the end, and stops at the buffer end", () => {
		const editor = editorWith("abc");
		editor.moveToLineStart();
		editor.handleInput("\x1b[3~"); // Delete
		expect(editor.getText()).toBe("bc");

		const emoji = editorWith("a😀b");
		emoji.moveToLineStart();
		emoji.handleInput("\x1b[C");
		emoji.handleInput("\x1b[3~");
		expect(emoji.getText()).toBe("ab");

		const join = editorWith("aa\nbb");
		join.moveToMessageStart();
		join.moveToLineEnd();
		join.handleInput("\x1b[3~");
		expect(join.getText()).toBe("aabb");

		const atEnd = editorWith("aa");
		atEnd.handleInput("\x1b[3~");
		expect(atEnd.getText()).toBe("aa");
	});

	it("deletes the line break forward at the end of a line and yanks it back", () => {
		const editor = editorWith("aa\nbb");
		editor.moveToMessageStart();
		editor.moveToLineEnd();
		editor.handleInput("\x1bd"); // Alt+D at end of line
		expect(editor.getText()).toBe("aabb");
		editor.handleInput("\x19"); // yank the killed break
		expect(editor.getText()).toBe("aa\nbb");
	});

	it("pops the per-keystroke snapshots under a transient completion", () => {
		const editor = editorWith("hello ");
		for (const ch of "world") editor.handleInput(ch);
		expect(editor.getText()).toBe("hello world");
		editor.undoPastTransientText("world");
		expect(editor.getText()).toBe("hello ");
		expect(editor.getCursor()).toEqual({ line: 0, col: 6 });
		// The transient snapshots are gone: a plain undo does not resurrect them.
		editor.handleInput("\x1f");
		expect(editor.getText()).toBe("hello ");
	});

	it("does not yank-pop when the cursor moved away from the yanked text", () => {
		const editor = editorWith("aaa\nbbb");
		editor.moveToMessageStart();
		editor.handleInput("\x0b");
		editor.handleInput("x");
		editor.handleInput("\x7f");
		editor.handleInput("\x1b[B");
		editor.moveToLineStart();
		editor.handleInput("\x0b");
		editor.setText("base");
		editor.handleInput("\x19"); // yank newest kill
		const yanked = editor.getText();
		editor.insertText("\nzz");
		editor.handleInput("\x1by"); // cursor no longer at the yank end
		expect(editor.getText()).toBe(`${yanked}\nzz`);
	});

	it("merges with the previous line on word-backward at a line start", () => {
		const editor = editorWith("aa\nbb");
		editor.moveToMessageEnd();
		editor.moveToLineStart();
		editor.handleInput("\x17"); // Ctrl+W at start of "bb"
		expect(editor.getText()).toBe("aabb");
	});

	it("moves to line start and end", () => {
		const editor = editorWith("hello");
		editor.moveToLineStart();
		expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
		editor.moveToLineEnd();
		expect(editor.getCursor()).toEqual({ line: 0, col: 5 });
	});
});
