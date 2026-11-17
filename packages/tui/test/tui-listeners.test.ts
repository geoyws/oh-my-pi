import { afterEach, describe, expect, it } from "bun:test";
import { Text, TUI } from "@oh-my-pi/pi-tui";
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";
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

	it("slices an oversized provider frame outside test environments instead of throwing", async () => {
		const previousEnv = Bun.env.NODE_ENV;
		Bun.env.NODE_ENV = "production";
		const terminal = new VirtualTerminal(40, 3);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider({
			renderFrame: () => ({ viewport: ["1", "2", "3", "4", "5"] }),
			acknowledgeHistory() {},
		});
		try {
			tui.start();
			await scheduler.settle(terminal);
			expect(terminal.getViewport().map(row => row.trim())).toEqual(["1", "2", "3"]);
		} finally {
			tui.stop();
			if (previousEnv === undefined) delete Bun.env.NODE_ENV;
			else Bun.env.NODE_ENV = previousEnv;
		}
	});

	it("counts full redraws for alt-screen paints and reports no native document without a native surface", async () => {
		const terminal = new VirtualTerminal(40, 6);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.addChild(new Text("hello", 0, 0));
		try {
			tui.start();
			await scheduler.settle(terminal);
			expect(tui.getNativeDocument()).toBeUndefined();
			expect(tui.getNativeFrames()).toEqual([]);
			expect(tui.getNativeFrames(2)).toEqual([]);
			expect(tui.nativeFallbackCount).toBe(0);
			const before = tui.fullRedraws;
			tui.showOverlay(new Text("modal", 0, 0), { fullscreen: true, width: "100%", maxHeight: "100%" });
			await scheduler.settle(terminal);
			expect(tui.fullRedraws).toBeGreaterThan(before);
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
			expect(terminal.getViewport().join("\n")).not.toContain("provider-40");
		} finally {
			tui.stop();
		}
	});
});

describe("TUI provider history flush and component renders", () => {
	it("flushes pending provider history when stopped", async () => {
		const terminal = new VirtualTerminal(40, 6);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		let flushes = 0;
		let pending = false;
		let acknowledged: number | undefined;
		tui.setFrameProvider({
			beginHistoryFlush: () => {
				flushes++;
			},
			renderFrame: () => ({
				viewport: ["live"],
				history: pending ? { id: 7, rows: ["hist-row"], kind: "append" as const } : undefined,
			}),
			acknowledgeHistory: (id: number) => {
				acknowledged = id;
				pending = false;
			},
		});
		tui.start();
		await scheduler.settle(terminal);
		expect(flushes).toBe(0);
		pending = true;
		tui.stop();
		expect(flushes).toBeGreaterThan(0);
		expect(acknowledged).toBe(7);
	});

	it("schedules a render for a component render request and reports frame cost", async () => {
		const terminal = new VirtualTerminal(40, 6);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		const probe = { renders: 0 };
		const component = {
			render: () => {
				probe.renders++;
				return ["body"];
			},
		};
		tui.addChild(component);
		try {
			tui.start();
			await scheduler.settle(terminal);
			expect(tui.lastFrameCostMs).toBeGreaterThanOrEqual(0);
			const settled = probe.renders;
			tui.requestComponentRender(component);
			await scheduler.settle(terminal);
			expect(probe.renders).toBeGreaterThan(settled);
		} finally {
			tui.stop();
		}
	});
});

describe("TUI settled-resize history replay", () => {
	function provider(replays: { count: number }) {
		return {
			renderFrame: (size: { columns: number }) => ({ viewport: [`w-${size.columns}`] }),
			acknowledgeHistory() {},
			beginHistoryReplay: () => {
				replays.count++;
			},
		};
	}

	it("replays provider history after a settled width change in append mode", async () => {
		const terminal = new VirtualTerminal(40, 6);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		const replays = { count: 0 };
		tui.setFrameProvider(provider(replays));
		tui.setResizeScrollback("append");
		try {
			tui.start();
			await scheduler.settle(terminal);
			terminal.resize(50, 6);
			await scheduler.advance(terminal, 300);
			await scheduler.settle(terminal);
			expect(replays.count).toBeGreaterThan(0);
			expect(terminal.getViewport().join("\n")).toContain("w-50");
		} finally {
			tui.stop();
		}
	});

	it("ignores a resize settle that fires after stop", async () => {
		const terminal = new VirtualTerminal(40, 6);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider({
			renderFrame: (size: { columns: number }) => ({ viewport: [`w-${size.columns}`] }),
			acknowledgeHistory() {},
		});
		tui.start();
		await scheduler.settle(terminal);
		expect(terminal.getViewport().join("\n")).toContain("w-40");
		terminal.resize(50, 8);
		tui.stop();
		// The pending settle timer fires into the stopped TUI and must not
		// repaint or throw.
		await scheduler.advance(terminal, 1000);
		expect(terminal.getViewport().join("\n")).not.toContain("w-50");
	});

	it("handles a burst of resizes and paints only the final geometry", async () => {
		const terminal = new VirtualTerminal(40, 6);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider({
			renderFrame: (size: { columns: number }) => ({ viewport: [`w-${size.columns}`] }),
			acknowledgeHistory() {},
		});
		try {
			tui.start();
			await scheduler.settle(terminal);
			terminal.resize(50, 6);
			terminal.resize(60, 7);
			terminal.resize(55, 8);
			await scheduler.advance(terminal, 1000);
			await scheduler.settle(terminal);
			expect(terminal.getViewport().join("\n")).toContain("w-55");
		} finally {
			tui.stop();
		}
	});

	it("does not replay provider history for a height-only change in rebuild mode", async () => {
		const terminal = new VirtualTerminal(40, 6);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		const replays = { count: 0 };
		tui.setFrameProvider(provider(replays));
		tui.setResizeScrollback("rebuild");
		try {
			tui.start();
			await scheduler.settle(terminal);
			terminal.resize(40, 8);
			await scheduler.advance(terminal, 300);
			await scheduler.settle(terminal);
			expect(replays.count).toBe(0);
		} finally {
			tui.stop();
		}
	});
});

describe("TUI degenerate geometry and history re-offers", () => {
	it("skips the stop history flush on a zero-width terminal", async () => {
		const terminal = new VirtualTerminal(40, 6);
		Object.defineProperty(terminal, "columns", { get: () => 0 });
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		let flushes = 0;
		tui.setFrameProvider({
			beginHistoryFlush: () => {
				flushes++;
			},
			renderFrame: () => ({ viewport: ["live"], history: { id: 1, rows: ["h"], kind: "append" as const } }),
			acknowledgeHistory() {},
		});
		tui.start();
		await scheduler.settle(terminal);
		tui.stop();
		expect(flushes).toBe(0);
	});

	it("slices an oversized provider viewport during the stop flush", async () => {
		const terminal = new VirtualTerminal(40, 3);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		let pending = false;
		let acknowledged: number | undefined;
		tui.setFrameProvider({
			beginHistoryFlush: () => {},
			renderFrame: () => ({
				viewport: pending ? ["1", "2", "3", "4", "5"] : ["live"],
				history: pending ? { id: 9, rows: ["hist"], kind: "append" as const } : undefined,
			}),
			acknowledgeHistory: (id: number) => {
				acknowledged = id;
				pending = false;
			},
		});
		tui.start();
		await scheduler.settle(terminal);
		pending = true;
		expect(() => tui.stop()).not.toThrow();
		expect(acknowledged).toBe(9);
	});

	it("does not call a frame provider on a zero-width terminal", async () => {
		const terminal = new VirtualTerminal(40, 6);
		Object.defineProperty(terminal, "columns", { get: () => 0 });
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		let calls = 0;
		tui.setFrameProvider({
			renderFrame: () => {
				calls++;
				return { viewport: ["live"] };
			},
			acknowledgeHistory() {},
		});
		try {
			tui.start();
			await scheduler.settle(terminal);
			expect(calls).toBe(0);
		} finally {
			tui.stop();
		}
	});

	it.each([
		[40, 1],
		[1, 6],
	] as const)("renders text on a %sx%s terminal", async (cols, rows) => {
		const terminal = new VirtualTerminal(cols, rows);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.addChild(new Text("body", 0, 0));
		try {
			tui.start();
			await scheduler.settle(terminal);
			expect(terminal.getViewport().join("\n")).toContain("b");
		} finally {
			tui.stop();
		}
	});

	it("acknowledges a re-offered history batch without painting it twice", async () => {
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
		let offer = true;
		const acks: number[] = [];
		tui.setFrameProvider({
			renderFrame: () => ({
				viewport: ["live"],
				history: offer ? { id: 7, rows: ["hist-row"], kind: "append" as const } : undefined,
			}),
			acknowledgeHistory: (id: number) => {
				acks.push(id);
			},
		});
		try {
			tui.start();
			await scheduler.settle(terminal);
			const firstPaints = terminal.writes.join("").split("hist-row").length - 1;
			expect(firstPaints).toBeGreaterThan(0);
			// Re-offer the same batch id: it is acknowledged, not repainted.
			tui.requestRender(true);
			await scheduler.settle(terminal);
			expect(acks.filter(id => id === 7).length).toBeGreaterThanOrEqual(2);
			expect(terminal.writes.join("").split("hist-row").length - 1).toBe(firstPaints);
		} finally {
			tui.stop();
		}
	});
});

describe("TUI synchronous and reset renders", () => {
	it("renderNow paints synchronously and is a no-op after stop", async () => {
		const terminal = new VirtualTerminal(40, 6);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		const probe = { renders: 0 };
		tui.addChild({
			render: () => {
				probe.renders++;
				return ["sync-body"];
			},
		});
		tui.renderNow();
		expect(probe.renders).toBe(1);
		try {
			tui.start();
			await scheduler.settle(terminal);
			const settled = probe.renders;
			tui.renderNow();
			expect(probe.renders).toBeGreaterThan(settled);
			expect(terminal.getViewport().join("\n")).toContain("sync-body");
		} finally {
			tui.stop();
		}
		const afterStop = probe.renders;
		tui.renderNow();
		expect(probe.renders).toBe(afterStop);
	});

	it("resetDisplay repaints while running and is a no-op after stop", async () => {
		const terminal = new VirtualTerminal(40, 6);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		const probe = { renders: 0, invalidations: 0 };
		tui.addChild({
			render: () => {
				probe.renders++;
				return ["reset-body"];
			},
			invalidate: () => {
				probe.invalidations++;
			},
		});
		try {
			tui.start();
			await scheduler.settle(terminal);
			const settled = probe.renders;
			tui.resetDisplay();
			expect(probe.invalidations).toBeGreaterThan(0);
			expect(probe.renders).toBeGreaterThan(settled);
			expect(terminal.getViewport().join("\n")).toContain("reset-body");
		} finally {
			tui.stop();
		}
		const afterStop = probe.renders;
		tui.resetDisplay();
		expect(probe.renders).toBe(afterStop);
	});
});

describe("TUI postmortem restore", () => {
	it("stops the TUI when the postmortem cleanup pass runs", async () => {
		const terminal = new VirtualTerminal(40, 6);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		const probe = { renders: 0 };
		tui.addChild({
			render: () => {
				probe.renders++;
				return ["body"];
			},
		});
		tui.start();
		await scheduler.settle(terminal);
		await postmortem.cleanup();
		await scheduler.settle(terminal);
		const settled = probe.renders;
		tui.requestRender(true);
		await scheduler.settle(terminal);
		expect(probe.renders).toBe(settled);
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
