import { describe, expect, it } from "bun:test";
import { Editor } from "@oh-my-pi/pi-tui/components/editor";
import { defaultEditorTheme } from "./test-themes";

async function untilShown(editor: Editor): Promise<void> {
	while (!editor.isShowingAutocomplete()) await new Promise(resolve => setTimeout(resolve, 0));
}

describe("Editor spelling suggestions and ghost completion", () => {
	it("applies a spelling suggestion over the misspelled word", async () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setTextAssistProvider({
			getWordReplacements: () => ({ line: 0, startCol: 0, endCol: 4, items: ["good", "goodly"] }),
		});
		editor.setText("badw");
		editor.handleInput("\x1b[46;5u"); // Ctrl+.
		await untilShown(editor);
		editor.handleInput("\r");
		expect(editor.getText()).toBe("good");
		expect(editor.isShowingAutocomplete()).toBe(false);
	});

	it("shows no suggestions for invalid replacement spans", async () => {
		for (const result of [
			null,
			{ line: 9, startCol: 0, endCol: 2, items: ["good"] },
			{ line: 0, startCol: 0, endCol: 99, items: ["good"] },
			{ line: 0, startCol: 0, endCol: 4, items: [] },
			{ line: 0, startCol: 3, endCol: 3, items: ["good"] },
		]) {
			const editor = new Editor(defaultEditorTheme);
			editor.setTextAssistProvider({ getWordReplacements: () => result as never });
			editor.setText("badw");
			editor.handleInput("\x1b[46;5u");
			await new Promise(resolve => setTimeout(resolve, 5));
			expect(editor.isShowingAutocomplete()).toBe(false);
		}
	});

	it("accepts a ghost word completion with Tab and reports feedback", async () => {
		const editor = new Editor(defaultEditorTheme);
		const feedback: boolean[] = [];
		editor.setTextAssistProvider({
			getWordCompletion: (_lines, _line, _col) => "lo",
			wordCompletionFeedback: (_lines, _line, _col, _suggestion, accepted) => {
				feedback.push(accepted);
			},
		});
		editor.setText("");
		editor.handleInput("h");
		editor.handleInput("e");
		editor.handleInput("l");
		editor.handleInput("\t");
		// Word completions land with a provisional trailing space.
		expect(editor.getText()).toBe("hello ");
		expect(feedback).toContain(true);
	});

	it("does not apply a spelling suggestion when the word changed underneath", async () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setTextAssistProvider({
			getWordReplacements: async () => ({ line: 0, startCol: 0, endCol: 4, items: ["good"] }),
		});
		editor.setText("badw");
		editor.handleInput("\x1b[46;5u");
		await untilShown(editor);
		editor.setText("different");
		editor.handleInput("\r");
		expect(editor.getText()).toBe("different");
	});
});
