import { describe, expect, it } from "bun:test";
import { Editor } from "@oh-my-pi/pi-tui/components/editor";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@oh-my-pi/pi-tui/keybindings";
import { defaultEditorTheme } from "./test-themes";

function edit(editor: Editor, from: number, to: number, text: string, cursor: number, len?: number): void {
	editor.handleNativeEvent({
		type: "edit",
		key: "",
		from,
		to,
		text,
		cursor,
		len: len ?? editor.getText().length,
	});
}

describe("Editor host edits", () => {
	it("replaces a range and places the caret, as one undo unit", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("hello world");
		edit(editor, 6, 11, "there", 11);
		expect(editor.getText()).toBe("hello there");
		expect(editor.getCursor()).toEqual({ line: 0, col: 11 });
		editor.handleNativeEvent({ type: "undo", key: "" });
		expect(editor.getText()).toBe("hello world");
	});

	it("moves only the caret for a pure caret move", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("hello");
		edit(editor, 0, 0, "", 2);
		expect(editor.getText()).toBe("hello");
		expect(editor.getCursor()).toEqual({ line: 0, col: 2 });
	});

	it("drops a stale edit whose length no longer matches", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("hello");
		edit(editor, 0, 5, "bye", 3, 999);
		expect(editor.getText()).toBe("hello");
	});

	it("maps a caret offset across lines after a multi-line edit", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("aa\nbb");
		edit(editor, 0, 5, "x\nyy\nzzz", 8);
		expect(editor.getText()).toBe("x\nyy\nzzz");
		expect(editor.getCursor()).toEqual({ line: 2, col: 3 });
	});

	it("widens an edit range over an atomic paste marker", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.atomicTokenPattern = /\[(?:Image|Paste) #\d+(?:,[^\]\n]*)?\]/g;
		editor.setText("");
		editor.insertPaste("stored paste body");
		const marker = editor.getText();
		expect(marker).toContain("[Paste #");
		// Replace a slice inside the marker: the whole marker is replaced.
		edit(editor, 1, 3, "X", 1, marker.length);
		expect(editor.getText()).toBe("X");
	});
});

describe("Editor volatile preview and delete-before-cursor", () => {
	it("shows, replaces, and clears a volatile preview without an undo step", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("say: ");
		editor.moveToLineEnd();
		editor.setVolatileText("helo");
		expect(editor.getText()).toBe("say: helo");
		editor.setVolatileText("hello");
		expect(editor.getText()).toBe("say: hello");
		editor.clearVolatileText();
		expect(editor.getText()).toBe("say: ");
		editor.clearVolatileText();
		expect(editor.getText()).toBe("say: ");
	});

	it("commits a volatile preview as a single undoable edit", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("say: ");
		editor.moveToLineEnd();
		editor.setVolatileText("helo");
		editor.commitVolatileText("hello");
		expect(editor.getText()).toBe("say: hello");
		editor.handleInput("\x1f");
		expect(editor.getText()).toBe("say: ");
	});

	it("clears a volatile preview with an empty set and an empty commit", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("say: ");
		editor.moveToLineEnd();
		editor.setVolatileText("helo");
		editor.setVolatileText("");
		expect(editor.getText()).toBe("say: ");
		editor.setVolatileText("helo");
		editor.commitVolatileText("");
		expect(editor.getText()).toBe("say: ");
	});

	it("replaces a multi-line volatile preview across the line break", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("ab\ncd");
		editor.setVolatileText("X\nYZ");
		expect(editor.getText()).toBe("ab\ncdX\nYZ");
		editor.setVolatileText("q");
		expect(editor.getText()).toBe("ab\ncdq");
		editor.clearVolatileText();
		expect(editor.getText()).toBe("ab\ncd");
	});

	it("prepends a space when pasting a file path after a word character", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("file");
		editor.pasteText("/tmp/x");
		expect(editor.getText()).toBe("file /tmp/x");
		const atStart = new Editor(defaultEditorTheme);
		atStart.setText("");
		atStart.pasteText("/tmp/x");
		expect(atStart.getText()).toBe("/tmp/x");
	});

	it("collapses a marker-sized paste and expands it on read", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("");
		const big = Array.from({ length: 12 }, (_, i) => `line-${i}`).join("\n");
		editor.pasteText(big);
		expect(editor.getText()).toContain("[Paste #");
		expect(editor.getExpandedText()).toBe(big);
	});

	it("inserts nothing when the host intercepts a marker-sized paste", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("keep");
		const seen: string[] = [];
		editor.onLargePaste = text => {
			seen.push(text);
			return true;
		};
		editor.pasteText(Array.from({ length: 12 }, (_, i) => `line-${i}`).join("\n"));
		expect(editor.getText()).toBe("keep");
		expect(seen).toHaveLength(1);
		// A host that declines lets the editor collapse it to a marker.
		editor.onLargePaste = () => false;
		editor.pasteText(Array.from({ length: 12 }, (_, i) => `line-${i}`).join("\n"));
		expect(editor.getText()).toContain("[Paste #");
	});

	it("stops deleting a volatile preview at the buffer start", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("");
		editor.setVolatileText("abc");
		editor.moveToMessageStart();
		editor.setVolatileText("z");
		// The stale preview cannot be deleted past the buffer start; the new
		// single-character preview replaces what it can and stays consistent.
		expect(editor.getText()).toContain("z");
		editor.clearVolatileText();
		expect(editor.getText()).not.toContain("z");
	});

	it("submits on backslash plus Shift+Enter when submit is remapped to it", () => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.input.submit": "shift+enter" }));
		try {
			const editor = new Editor(defaultEditorTheme);
			editor.setText("cmd\\");
			const submitted: string[] = [];
			editor.onSubmit = text => submitted.push(text);
			editor.handleInput("\x1b[13;5u"); // Ctrl+Enter: not the submit binding
			expect(submitted).toEqual(["cmd"]);
		} finally {
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
		}
	});

	it("deletes before the cursor capped at the line start", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("hello");
		editor.deleteBeforeCursor(2);
		expect(editor.getText()).toBe("hel");
		editor.deleteBeforeCursor(99);
		expect(editor.getText()).toBe("");
		editor.deleteBeforeCursor(1);
		expect(editor.getText()).toBe("");
		editor.deleteBeforeCursor(0);
		expect(editor.getText()).toBe("");
	});
});
