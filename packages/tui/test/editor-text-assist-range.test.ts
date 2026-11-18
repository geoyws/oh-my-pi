import { describe, expect, it } from "bun:test";
import { Editor } from "@oh-my-pi/pi-tui/components/editor";
import type { DescribeContext } from "@oh-my-pi/pi-tui/native/node";

const DESCRIBE_CX: DescribeContext = { cols: 80, reduceMotion: false, dark: true, supports: () => true, feature: () => true };
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

	it("does not apply a spelling suggestion after the word itself is edited", async () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setTextAssistProvider({
			getWordReplacements: () => ({ line: 0, startCol: 0, endCol: 4, items: ["good"] }),
		});
		editor.setText("badw");
		const submitted: string[] = [];
		editor.onSubmit = text => submitted.push(text);
		editor.handleInput("\x1b[46;5u");
		await untilShown(editor);
		editor.handleInput("\x7f");
		editor.handleInput("\r");
		expect(submitted).toEqual(["bad"]);
		expect(editor.isShowingAutocomplete()).toBe(false);
	});

	it("cancels the popup when the provider fails and when the cursor leaves its token", async () => {
		const failing = new Editor(defaultEditorTheme);
		failing.setAutocompleteProvider({
			getSuggestions: async () => {
				throw new Error("provider down");
			},
			applyCompletion: () => {},
		});
		failing.setText("");
		failing.handleInput("@");
		await new Promise(resolve => setTimeout(resolve, 10));
		expect(failing.isShowingAutocomplete()).toBe(false);
		failing.handleInput("x");
		expect(failing.getText()).toBe("@x");

		const moving = new Editor(defaultEditorTheme);
		moving.setAutocompleteProvider({
			getSuggestions: async () => ({ items: [{ value: "@alpha.ts", label: "alpha.ts" }], prefix: "@" }),
			applyCompletion: () => {},
		});
		moving.setText("");
		moving.handleInput("@");
		await untilShown(moving);
		moving.handleInput("\x1b[D");
		expect(moving.isShowingAutocomplete()).toBe(false);
	});

	it("describes a placeholder only for an empty editor and a prediction only as a live suffix", () => {
		const described = (editor: Editor) => JSON.stringify(editor.describe(DESCRIBE_CX));
		const editor = new Editor(defaultEditorTheme);
		editor.placeholder = () => "Type here";
		expect(described(editor)).toContain("Type here");
		editor.setText("x");
		expect(described(editor)).not.toContain("Type here");

		const predicted = new Editor(defaultEditorTheme);
		predicted.prediction = () => "hello world";
		predicted.setText("hel");
		expect(described(predicted)).toContain("lo world");
		// A prediction that does not extend the typed text shows nothing.
		predicted.prediction = () => "other";
		expect(described(predicted)).not.toContain("lo world");
		// A cursor not at the end shows nothing either.
		predicted.prediction = () => "hello world";
		predicted.moveToLineStart();
		expect(described(predicted)).not.toContain("lo world");
	});

	it("submits instead of accepting a slash argument that restates the typed text", async () => {
		const editor = new Editor(defaultEditorTheme);
		let applied = 0;
		editor.setAutocompleteProvider({
			getSuggestions: async (lines: string[]) =>
				(lines[0] ?? "").startsWith("/mcp") ? { items: [{ value: "list", label: "list" }], prefix: "list" } : null,
			applyCompletion: () => {
				applied++;
				return { lines: ["/mcp list"], cursorLine: 0, cursorCol: 9 };
			},
		});
		const submitted: string[] = [];
		editor.onSubmit = text => submitted.push(text);
		for (const ch of "/mcp list") editor.handleInput(ch);
		await untilShown(editor);
		editor.handleInput("\r");
		expect(submitted).toEqual(["/mcp list"]);
		expect(applied).toBe(0);
	});

	it("accepts instead of submitting when the slash argument still requires an argument", async () => {
		const editor = new Editor(defaultEditorTheme);
		let applied = 0;
		editor.setAutocompleteProvider({
			getSuggestions: async (lines: string[]) =>
				(lines[0] ?? "").startsWith("/mcp")
					? { items: [{ value: "list", label: "list", hint: "list <name>" }], prefix: "list" }
					: null,
			applyCompletion: () => {
				applied++;
				return { lines: ["/mcp list "], cursorLine: 0, cursorCol: 10 };
			},
		});
		const submitted: string[] = [];
		editor.onSubmit = text => submitted.push(text);
		for (const ch of "/mcp list") editor.handleInput(ch);
		await untilShown(editor);
		editor.handleInput("\r");
		expect(applied).toBe(1);
		expect(submitted).toEqual([]);
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
