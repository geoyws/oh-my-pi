import { afterEach, describe, expect, it } from "bun:test";
import { Editor } from "@oh-my-pi/pi-tui/components/editor";
import { node } from "@oh-my-pi/pi-tui/native/describe";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";
import type { Component } from "@oh-my-pi/pi-tui/tui";
import { ManualScheduler, TspHarness, TspTestTerminal } from "./native/tsp-harness";
import { defaultEditorTheme } from "./test-themes";

/** A settings page that docks beside the transcript or, with `sheet` off, a modal panel. */
class Panel implements Component {
	readonly keys: string[] = [];
	constructor(readonly sheet: boolean) {}
	render(): string[] {
		return ["panel"];
	}
	handleInput(data: string): void {
		this.keys.push(data);
	}
	invalidate(): void {}
	nativeSheet(): boolean {
		return this.sheet;
	}
	describe(): NativeNode {
		return node("prefs", { title: "Settings", pages: [{ id: "a", label: "A" }], page: "a", sections: [] });
	}
}

let harness: TspHarness | undefined;
afterEach(() => {
	harness?.stop();
	harness = undefined;
});

async function open(sheet: boolean) {
	const editor = new Editor(defaultEditorTheme);
	const panel = new Panel(sheet);
	harness = await TspHarness.start(tui => {
		tui.addChild(editor);
		tui.setFocus(editor);
	});
	const h = harness;
	const sf = h.terminal.surface!;
	const editorId = h.find(n => n.k === "editor")!.id;
	h.tui.showOverlay(panel, { fullscreen: true, width: "100%", maxHeight: "100%" });
	await h.render();
	expect(h.tui.getFocused()).toBe(panel);
	return { h, editor, panel, sf, editorId };
}

describe("TUI native host (root-scope TSP)", () => {
	it("moves the keys between the composer and a settings sheet beside it", async () => {
		const { h, editor, panel, sf, editorId } = await open(true);
		const prefsId = h.find(n => n.k === "prefs")!.id;

		h.event({ ev: "focus", sf, id: editorId });
		expect(h.tui.getFocused()).toBe(editor);
		h.terminal.send("hi");
		h.flush();
		expect(editor.getText()).toBe("hi");
		expect(panel.keys).toEqual([]);

		h.event({ ev: "focus", sf, id: prefsId });
		expect(h.tui.getFocused()).toBe(panel);
		// A second focus event for the already-focused panel keeps the keys there.
		h.event({ ev: "focus", sf, id: prefsId });
		expect(h.tui.getFocused()).toBe(panel);
		h.terminal.send("x");
		h.flush();
		expect(panel.keys).toEqual(["x"]);
	});

	it("repaints on terminal theme and motion events", async () => {
		const { h, sf } = await open(true);
		const framesBefore = h.frames.length;
		h.event({ ev: "theme", dark: false });
		h.event({ ev: "motion", reduce: true });
		h.flush();
		expect(h.frames.length).toBeGreaterThanOrEqual(framesBefore);
		expect(h.terminal.docs.get(sf)).toBeDefined();
	});

	it("repaints rows instead of going native when the TSP hello never arrives", async () => {
		const terminal = new TspTestTerminal({ reply: false, manualProbe: true });
		const hold = new TspHarness(terminal, new ManualScheduler());
		harness = hold;
		hold.tui.addChild(new Panel(true));
		hold.tui.start();
		hold.flush(1000);
		expect(hold.tui.nativeRendering).toBe(false);
	});

	it("leaves the keys with a modal panel when the composer is clicked", async () => {
		const { h, panel, sf, editorId } = await open(false);
		h.event({ ev: "focus", sf, id: editorId });
		expect(h.tui.getFocused()).toBe(panel);
	});
});
