import { afterEach, describe, expect, it } from "bun:test";
import { Editor } from "@oh-my-pi/pi-tui/components/editor";
import { node } from "@oh-my-pi/pi-tui/native/describe";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";
import type { Terminal } from "@oh-my-pi/pi-tui/terminal";
import { type Component, TUI } from "@oh-my-pi/pi-tui/tui";
import { ManualScheduler, TspHarness, TspTestTerminal } from "./native/tsp-harness";
import { defaultEditorTheme } from "./test-themes";

/** A settings page that docks beside the transcript or, with `sheet` off, a modal panel. */
class Panel implements Component {
	readonly keys: string[] = [];
	invalidations = 0;
	constructor(readonly sheet: boolean) {}
	render(): string[] {
		return ["panel"];
	}
	handleInput(data: string): void {
		this.keys.push(data);
	}
	invalidate(): void {
		this.invalidations++;
	}
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

	it("closeNative closes the live surface and is a no-op without one", async () => {
		const { h } = await open(true);
		expect(h.terminal.surface).toBeDefined();
		h.tui.closeNative();
		expect(h.terminal.surface).toBeUndefined();
		// Already closed surfaces are not closed again.
		h.tui.closeNative();
		expect(h.terminal.surface).toBeUndefined();
	});

	it("flushes a requested render before closing the native surface", async () => {
		const { h, editor } = await open(true);
		const logStart = h.terminal.log.length;
		editor.setText("draft");
		h.tui.requestRender();
		h.tui.closeNative();
		expect(h.terminal.surface).toBeUndefined();
		const verbs = h.terminal.log.slice(logStart).map(entry => entry.verb);
		// The pending frame goes out first, then the close.
		expect(verbs).toContain("f");
		expect(verbs).toContain("x");
		expect(verbs.lastIndexOf("f")).toBeLessThan(verbs.indexOf("x"));
		expect(JSON.stringify(h.terminal.frames.at(-1))).toContain("draft");
	});

	it("re-arms the native confirm deadline after a stalled event loop, then revokes", async () => {
		const scheduler = new ManualScheduler();
		const terminal = new TspTestTerminal({ expected: true, reply: false, manualProbe: true });
		const tui = new TUI(terminal, false, { renderScheduler: scheduler });
		tui.addChild(new Panel(true));
		try {
			tui.start();
			expect(tui.nativeRendering).toBe(true);
			// Simulate a stalled loop: the 1000 ms confirm deadline fires far
			// past its 100 ms grace, so it re-arms instead of revoking.
			scheduler.advance(5000);
			scheduler.flush(0, () => terminal.deliver());
			expect(tui.nativeRendering).toBe(true);
			// The re-armed deadline fires inside its grace and revokes.
			scheduler.flush(200, () => terminal.deliver());
			expect(tui.nativeRendering).toBe(false);
		} finally {
			tui.stop();
		}
	});

	it("resumes the native surface across a stop and start cycle", async () => {
		const { h } = await open(true);
		const firstSurface = h.terminal.surface;
		expect(firstSurface).toBeDefined();
		h.tui.stop();
		h.tui.start();
		h.flush();
		expect(h.tui.nativeRendering).toBe(true);
		expect(h.terminal.surface).toBeDefined();
	});

	it("refreshes appearance on a theme event and invalidates components on a motion event, keeping focus", async () => {
		const { h, panel } = await open(true);
		let refreshes = 0;
		const terminal: Terminal = h.terminal;
		terminal.refreshAppearance = () => {
			refreshes++;
		};
		h.event({ ev: "theme", dark: false });
		h.flush();
		expect(refreshes).toBe(1);
		const invalidations = panel.invalidations;
		h.event({ ev: "motion", reduce: true });
		h.flush();
		expect(panel.invalidations).toBeGreaterThan(invalidations);
		expect(h.tui.getFocused()).toBe(panel);
		h.terminal.send("x");
		h.flush();
		expect(panel.keys).toEqual(["x"]);
	});

	it("holds row painting for the TSP probe, then repaints rows when no hello arrives", async () => {
		const terminal = new TspTestTerminal({ reply: false, manualProbe: true });
		const hold = new TspHarness(terminal, new ManualScheduler());
		harness = hold;
		hold.tui.addChild(new Panel(true));
		hold.tui.start();
		hold.flush(0);
		expect(terminal.rowBytes).not.toContain("panel");
		hold.flush(1000);
		expect(hold.tui.nativeRendering).toBe(false);
		expect(terminal.rowBytes).toContain("panel");
	});

	it("repaints rows at once when a no-hello reply ends the probe hold early", async () => {
		const terminal = new TspTestTerminal({ reply: false, manualProbe: true });
		const hold = new TspHarness(terminal, new ManualScheduler());
		harness = hold;
		hold.tui.addChild(new Panel(true));
		hold.tui.start();
		hold.flush(0);
		expect(terminal.rowBytes).not.toContain("panel");
		// The terminal answers the probe without a hello before the hold timer fires.
		expect(terminal.answerProbe()).toBe(true);
		hold.flush(0);
		expect(hold.tui.nativeRendering).toBe(false);
		expect(terminal.rowBytes).toContain("panel");
	});

	it("leaves the keys with a modal panel when the composer is clicked", async () => {
		const { h, panel, sf, editorId } = await open(false);
		h.event({ ev: "focus", sf, id: editorId });
		expect(h.tui.getFocused()).toBe(panel);
	});
});
