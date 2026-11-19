import { describe, expect, it } from "bun:test";
import { Editor } from "@oh-my-pi/pi-tui/components/editor";
import { defaultEditorTheme } from "./test-themes";

describe("Editor history admission and storage", () => {
	it("ignores blank history entries", async () => {
		const editor = new Editor(defaultEditorTheme);
		editor.addToHistory("   ");
		await editor.whenHistorySettled();
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("");
	});

	it("records accepted prompts and skips consecutive duplicates", async () => {
		const editor = new Editor(defaultEditorTheme);
		editor.addToHistory("first");
		editor.addToHistory("first");
		await editor.whenHistorySettled();
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("first");
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("first");
	});

	it("never records a prompt refused synchronously or asynchronously", async () => {
		const sync = new Editor(defaultEditorTheme);
		sync.setHistoryAdmission(() => false);
		sync.addToHistory("secret");
		await sync.whenHistorySettled();
		sync.handleInput("\x1b[A");
		expect(sync.getText()).toBe("");

		const async_ = new Editor(defaultEditorTheme);
		async_.setHistoryAdmission(async () => false);
		async_.addToHistory("secret");
		await async_.whenHistorySettled();
		async_.handleInput("\x1b[A");
		expect(async_.getText()).toBe("");
	});

	it("records a prompt accepted asynchronously, in call order", async () => {
		const editor = new Editor(defaultEditorTheme);
		const verdicts: boolean[] = [];
		editor.setHistoryAdmission(async prompt => {
			verdicts.push(prompt === "kept");
			return prompt === "kept";
		});
		editor.addToHistory("kept");
		editor.addToHistory("dropped");
		await editor.whenHistorySettled();
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("kept");
		expect(verdicts).toEqual([true, false]);
	});

	it("does not record a prompt whose admission throws or rejects", async () => {
		const throwing = new Editor(defaultEditorTheme);
		throwing.setHistoryAdmission(() => {
			throw new Error("boom");
		});
		throwing.addToHistory("secret");
		await throwing.whenHistorySettled();
		throwing.handleInput("\x1b[A");
		expect(throwing.getText()).toBe("");

		const rejecting = new Editor(defaultEditorTheme);
		rejecting.setHistoryAdmission(async () => {
			throw new Error("boom");
		});
		rejecting.addToHistory("secret");
		await rejecting.whenHistorySettled();
		rejecting.handleInput("\x1b[A");
		expect(rejecting.getText()).toBe("");
	});

	it("recalls a prompt locally even when the persistent store fails", async () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setHistoryStorage({
			add: async () => {
				throw new Error("disk full");
			},
			getRecent: () => [],
		});
		editor.addToHistory("kept locally");
		await editor.whenHistorySettled();
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("kept locally");
	});

	it("does not remember an empty draft", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("   ");
		editor.rememberDraft();
		editor.setText("");
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("");
	});
});
