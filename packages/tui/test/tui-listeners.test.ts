import { afterEach, describe, expect, it } from "bun:test";
import { Text, TUI } from "@oh-my-pi/pi-tui";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

describe("TUI paint and frame-write listeners", () => {
	it("notifies paint listeners until unsubscribed", async () => {
		const terminal = new VirtualTerminal(40, 6);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.addChild(new Text("hello", 0, 0));
		let paints = 0;
		const unsubscribe = tui.addPaintListener(() => {
			paints++;
		});
		try {
			tui.start();
			await scheduler.settle(terminal);
			expect(paints).toBeGreaterThan(0);
			const afterFirst = paints;
			unsubscribe();
			tui.requestRender(true);
			await scheduler.settle(terminal);
			expect(paints).toBe(afterFirst);
		} finally {
			tui.stop();
		}
	});

	it("notifies frame-write listeners with frame data until unsubscribed", async () => {
		const terminal = new VirtualTerminal(40, 6);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.addChild(new Text("frame-body", 0, 0));
		const frames: string[] = [];
		const unsubscribe = tui.addFrameWriteListener(data => {
			frames.push(data);
		});
		try {
			tui.start();
			await scheduler.settle(terminal);
			expect(frames.join("")).toContain("frame-body");
			const afterFirst = frames.length;
			unsubscribe();
			tui.requestRender(true);
			await scheduler.settle(terminal);
			expect(frames.length).toBe(afterFirst);
		} finally {
			tui.stop();
		}
	});

	it("keeps rendering and notifies later listeners when an earlier listener throws", async () => {
		const terminal = new VirtualTerminal(40, 6);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.addChild(new Text("hello", 0, 0));
		let paints = 0;
		let frames = 0;
		tui.addPaintListener(() => {
			throw new Error("broken paint listener");
		});
		tui.addPaintListener(() => {
			paints++;
		});
		tui.addFrameWriteListener(() => {
			throw new Error("broken frame listener");
		});
		tui.addFrameWriteListener(() => {
			frames++;
		});
		try {
			tui.start();
			await scheduler.settle(terminal);
			expect(paints).toBeGreaterThan(0);
			expect(frames).toBeGreaterThan(0);
			expect(terminal.getViewport().join("\n")).toContain("hello");
		} finally {
			tui.stop();
		}
	});

	it("rejects a frame provider that returns more rows than the viewport in tests", async () => {
		const terminal = new VirtualTerminal(40, 3);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider({
			renderFrame: () => ({ viewport: ["1", "2", "3", "4", "5"] }),
			acknowledgeHistory() {},
		});
		try {
			tui.start();
			await expect(scheduler.settle(terminal)).rejects.toThrow("Frame provider returned 5 rows for a 3-row viewport");
		} finally {
			tui.stop();
		}
	});

	it("counts full redraws and reports no native document without a native surface", async () => {
		const terminal = new VirtualTerminal(40, 6);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.addChild(new Text("hello", 0, 0));
		try {
			tui.start();
			await scheduler.settle(terminal);
			expect(tui.fullRedraws).toBeGreaterThanOrEqual(0);
			expect(tui.getNativeDocument()).toBeUndefined();
			expect(tui.getNativeFrames()).toEqual([]);
			expect(tui.getNativeFrames(2)).toEqual([]);
			const before = tui.fullRedraws;
			tui.requestRender(true);
			await scheduler.settle(terminal);
			expect(tui.fullRedraws).toBeGreaterThanOrEqual(before);
		} finally {
			tui.stop();
		}
	});

	it("installs and clears a frame provider", async () => {
		const terminal = new VirtualTerminal(40, 6);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider({
			renderFrame: size => ({ viewport: [`provider-${size.columns}`] }),
			acknowledgeHistory() {},
		});
		try {
			tui.start();
			await scheduler.settle(terminal);
			expect(terminal.getViewport().join("\n")).toContain("provider-40");
			tui.setFrameProvider(undefined);
			await scheduler.settle(terminal);
		} finally {
			tui.stop();
		}
	});
});

describe("TUI inline-image purge", () => {
	it("clearInlineImages writes no Kitty deletes on a non-Kitty terminal and is a no-op once stopped", async () => {
		class WriteCapture extends VirtualTerminal {
			readonly writes: string[] = [];
			override write(data: string): void {
				this.writes.push(data);
				super.write(data);
			}
		}
		const terminal = new WriteCapture(40, 6);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.addChild(new Text("body", 0, 0));
		try {
			tui.start();
			await scheduler.settle(terminal);
			terminal.writes.length = 0;
			tui.clearInlineImages();
			await scheduler.settle(terminal);
			// No graphics delete sequence is emitted without transmitted Kitty images.
			expect(terminal.writes.join("")).not.toContain("\x1b_Ga=d");
		} finally {
			tui.stop();
		}
		// Stopped: purging is refused entirely, still no writes.
		terminal.writes.length = 0;
		tui.clearInlineImages();
		expect(terminal.writes).toEqual([]);
	});
});

describe("TUI resize scrollback mode", () => {
	const previous = Bun.env.PI_TUI_RESIZE_SCROLLBACK;
	afterEach(() => {
		if (previous === undefined) delete Bun.env.PI_TUI_RESIZE_SCROLLBACK;
		else Bun.env.PI_TUI_RESIZE_SCROLLBACK = previous;
	});

	it.each(["append", "rebuild", "preserve"] as const)("reads %s from the environment", mode => {
		Bun.env.PI_TUI_RESIZE_SCROLLBACK = mode;
		const tui = new TUI(new VirtualTerminal(40, 6));
		expect(tui.getResizeScrollback()).toBe(mode);
	});

	it("falls back to preserve for an unknown environment value", () => {
		Bun.env.PI_TUI_RESIZE_SCROLLBACK = "bogus";
		const tui = new TUI(new VirtualTerminal(40, 6));
		expect(tui.getResizeScrollback()).toBe("preserve");
	});

	it("round-trips an explicit setter value", () => {
		delete Bun.env.PI_TUI_RESIZE_SCROLLBACK;
		const tui = new TUI(new VirtualTerminal(40, 6));
		tui.setResizeScrollback("rebuild");
		expect(tui.getResizeScrollback()).toBe("rebuild");
	});
});
