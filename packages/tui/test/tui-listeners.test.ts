import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Text, TUI } from "@oh-my-pi/pi-tui";
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";
import { TERMINAL_MULTIPLEXER_ENV_KEYS } from "@oh-my-pi/pi-tui/terminal-multiplexer";
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
			await expect(scheduler.settle(terminal)).rejects.toThrow(
				"Frame provider returned 5 rows for a 3-row viewport",
			);
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
		// Each component render costs 7 ms on the virtual clock.
		let renderCost = 0;
		class CostedScheduler extends VirtualRenderScheduler {
			override now(): number {
				return super.now() + renderCost;
			}
		}
		const scheduler = new CostedScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		const probe = { renders: 0 };
		const component = {
			render: () => {
				probe.renders++;
				renderCost += 7;
				return ["body"];
			},
		};
		tui.addChild(component);
		try {
			tui.start();
			await scheduler.settle(terminal);
			expect(tui.lastFrameCostMs).toBe(7);
			const settled = probe.renders;
			tui.requestComponentRender(component);
			await scheduler.settle(terminal);
			expect(probe.renders).toBe(settled + 1);
			expect(tui.lastFrameCostMs).toBe(7);
		} finally {
			tui.stop();
		}
		// Once stopped, a component's render request schedules nothing.
		const afterStop = probe.renders;
		tui.requestComponentRender(component);
		await scheduler.settle(terminal);
		expect(probe.renders).toBe(afterStop);
	});

	it("repaints the whole viewport when a fullscreen overlay entered mid-resize closes", async () => {
		const previous = Bun.env.PI_TUI_RESIZE_IN_PLACE;
		Bun.env.PI_TUI_RESIZE_IN_PLACE = "1";
		const terminal = new VirtualTerminal(40, 6);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.addChild(new Text("base-body", 0, 0));
		try {
			tui.start();
			await scheduler.settle(terminal);
			// The in-place resize blanks the live rows and defers the repaint; the
			// overlay opens before it settles, so the alt screen is entered at 40x8.
			terminal.resize(40, 8);
			await scheduler.advance(terminal, 50);
			const handle = tui.showOverlay(new Text("modal", 0, 0), {
				fullscreen: true,
				width: "100%",
				maxHeight: "100%",
			});
			await scheduler.advance(terminal, 1000);
			expect(terminal.getViewport().join("\n")).toContain("modal");
			// Back to the last normal-screen geometry while covered: a geometry diff
			// alone sees nothing to rewrite, yet the restored buffer is blank.
			terminal.resize(40, 6);
			await scheduler.advance(terminal, 1000);
			handle.hide();
			await scheduler.advance(terminal, 1000);
			expect(terminal.getViewport().join("\n")).toContain("base-body");
		} finally {
			tui.stop();
			if (previous === undefined) delete Bun.env.PI_TUI_RESIZE_IN_PLACE;
			else Bun.env.PI_TUI_RESIZE_IN_PLACE = previous;
		}
	});

	it("repaints the base after an overlay opened during an in-place resize closes at the original size", async () => {
		// t-f1cd8621: the in-place resize erased the live rows, the overlay opened
		// before the settle and the screen went back to its pre-resize size, so
		// the settled repaint was spent on the first alt frame and closing the
		// overlay restored a blank normal screen.
		// The live-row erase only happens on a direct terminal: pin one even when
		// the suite runs inside a multiplexer.
		const envKeys = [...TERMINAL_MULTIPLEXER_ENV_KEYS, "TERM_PROGRAM", "TERM", "PI_TUI_RESIZE_IN_PLACE"];
		const savedEnv = new Map(envKeys.map(key => [key, Bun.env[key]]));
		for (const key of envKeys) delete Bun.env[key];
		Bun.env.TERM = "xterm-256color";
		Bun.env.PI_TUI_RESIZE_IN_PLACE = "1";
		const terminal = new VirtualTerminal(40, 6);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.addChild(new Text("base-body", 0, 0));
		try {
			tui.start();
			await scheduler.settle(terminal);
			terminal.resize(40, 8);
			await scheduler.advance(terminal, 50);
			const handle = tui.showOverlay(new Text("modal", 0, 0), {
				fullscreen: true,
				width: "100%",
				maxHeight: "100%",
			});
			await scheduler.advance(terminal, 10);
			// Still inside the resize transaction: nothing painted yet.
			expect(terminal.getViewport().join("")).toBe("");
			terminal.resize(40, 6);
			await scheduler.advance(terminal, 1000);
			expect(terminal.getViewport().join("\n")).toContain("modal");
			handle.hide();
			await scheduler.advance(terminal, 1000);
			expect(terminal.getViewport().join("\n")).toContain("base-body");
		} finally {
			tui.stop();
			for (const [key, value] of savedEnv) {
				if (value === undefined) delete Bun.env[key];
				else Bun.env[key] = value;
			}
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
		let frames = 0;
		tui.setFrameProvider({
			renderFrame: (size: { columns: number }) => {
				frames++;
				return { viewport: [`w-${size.columns}`] };
			},
			acknowledgeHistory() {},
		});
		tui.start();
		await scheduler.settle(terminal);
		expect(terminal.getViewport().join("\n")).toContain("w-40");
		terminal.resize(50, 8);
		tui.stop();
		const framesAtStop = frames;
		const writes: string[] = [];
		const write = terminal.write.bind(terminal);
		terminal.write = (data: string) => {
			writes.push(data);
			write(data);
		};
		// The pending settle window elapses after stop: no frame is composed
		// and nothing reaches the terminal.
		await scheduler.advance(terminal, 1000);
		expect(frames).toBe(framesAtStop);
		expect(writes).toEqual([]);
		expect(terminal.getViewport().join("\n")).not.toContain("w-50");
	});

	it("settles a rebuild-mode width change without a destructive reset when the provider cannot replay", async () => {
		async function settledResizeWrites(canReplay: boolean): Promise<string> {
			const terminal = new VirtualTerminal(40, 6);
			const scheduler = new VirtualRenderScheduler();
			const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
			const replays = { count: 0 };
			const base = provider(replays);
			tui.setFrameProvider(
				canReplay ? base : { renderFrame: base.renderFrame, acknowledgeHistory: base.acknowledgeHistory },
			);
			tui.setResizeScrollback("rebuild");
			const writes: string[] = [];
			try {
				tui.start();
				await scheduler.settle(terminal);
				const write = terminal.write.bind(terminal);
				terminal.write = (data: string) => {
					writes.push(data);
					write(data);
				};
				terminal.resize(50, 6);
				await scheduler.advance(terminal, 1000);
				await scheduler.settle(terminal);
				expect(terminal.getViewport().join("\n")).toContain("w-50");
				expect(replays.count).toBe(canReplay ? 1 : 0);
			} finally {
				tui.stop();
			}
			return writes.join("");
		}
		// A replaying provider gets the scrollback-clearing rebuild ...
		expect(await settledResizeWrites(true)).toContain("\x1b[3J");
		// ... one that cannot replay keeps its scrollback: no ED3.
		expect(await settledResizeWrites(false)).not.toContain("\x1b[3J");
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

describe("TUI in-place resize CPR probe", () => {
	class CprTerminal extends VirtualTerminal {
		readonly writes: string[] = [];
		constructor(
			cols: number,
			rows: number,
			readonly tagged: boolean,
		) {
			super(cols, rows);
		}
		override write(data: string): void {
			this.writes.push(data);
			const probe = data.match(/\x1b\[(\d+)G\x1b\[6n/);
			// Keep the emulator from answering the DSR itself: this terminal's
			// reply (tagged column, or a column-1 reply that cannot be
			// attributed) is the only one the TUI sees.
			super.write(probe ? data.replace("\x1b[6n", "") : data);
			if (probe) {
				const column = this.tagged ? probe[1] : "1";
				queueMicrotask(() => this.sendInput(`\x1b[2;${column}R`));
			}
		}
	}

	/**
	 * Resize in place and step past the 120 ms settle (which sends the DSR
	 * probe), then report whether the settled width painted before the 200 ms
	 * probe timeout and once every timeout (including the grow's one retry)
	 * has run, plus any keys the focused component saw.
	 */
	async function resizeWithReply(tagged: boolean) {
		const previous = Bun.env.PI_TUI_RESIZE_IN_PLACE;
		Bun.env.PI_TUI_RESIZE_IN_PLACE = "1";
		const terminal = new CprTerminal(40, 6, tagged);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		const keys: string[] = [];
		const focus = { render: () => [], invalidate() {}, handleInput: (data: string) => keys.push(data) };
		tui.addChild(focus);
		tui.setFocus(focus);
		tui.setFrameProvider({
			renderFrame: (size: { columns: number }) => ({ viewport: [`w-${size.columns}`] }),
			acknowledgeHistory() {},
		});
		try {
			tui.start();
			await scheduler.settle(terminal);
			terminal.writes.length = 0;
			terminal.resize(50, 8);
			// Settle fires at 120 ms; the follow-up settle runs to ~170 ms, short of the 320 ms timeout.
			await scheduler.advance(terminal, 130);
			const probed = terminal.writes.join("").includes("\x1b[6n");
			const beforeTimeout = terminal.getViewport().join("\n").includes("w-50");
			await scheduler.advance(terminal, 1000);
			const afterTimeout = terminal.getViewport().join("\n").includes("w-50");
			return { probed, beforeTimeout, afterTimeout, keys };
		} finally {
			tui.stop();
			if (previous === undefined) delete Bun.env.PI_TUI_RESIZE_IN_PLACE;
			else Bun.env.PI_TUI_RESIZE_IN_PLACE = previous;
		}
	}

	it("anchors the settled repaint as soon as a tagged CPR reply arrives", async () => {
		const result = await resizeWithReply(true);
		expect(result.probed).toBe(true);
		expect(result.beforeTimeout).toBe(true);
		expect(result.afterTimeout).toBe(true);
		expect(result.keys).toEqual([]);
	});

	it("discards an untagged CPR reply and anchors only on the probe timeout", async () => {
		const result = await resizeWithReply(false);
		expect(result.probed).toBe(true);
		expect(result.beforeTimeout).toBe(false);
		expect(result.afterTimeout).toBe(true);
		// The stripped reply never reaches the focused component as a key.
		expect(result.keys).toEqual([]);
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
		const acks: number[] = [];
		tui.setFrameProvider({
			renderFrame: () => ({
				viewport: ["live"],
				history: { id: 7, rows: ["hist-row"], kind: "append" as const },
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
			// Re-offer the same batch id: it is acknowledged again, not repainted.
			const acksBefore = acks.filter(id => id === 7).length;
			tui.requestRender(true);
			await scheduler.settle(terminal);
			expect(acks.filter(id => id === 7).length).toBeGreaterThan(acksBefore);
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

	it("closeNative leaves a row-rendered TUI and its pending render alone", async () => {
		const terminal = new VirtualTerminal(40, 6);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		const probe = { renders: 0 };
		tui.addChild({
			render: () => {
				probe.renders++;
				return ["rows-body"];
			},
		});
		try {
			tui.start();
			await scheduler.settle(terminal);
			const settled = probe.renders;
			tui.requestRender();
			// Not native: no early flush of the requested frame and nothing to close.
			tui.closeNative();
			expect(probe.renders).toBe(settled);
			await scheduler.settle(terminal);
			expect(probe.renders).toBe(settled + 1);
			expect(terminal.getViewport().join("\n")).toContain("rows-body");
		} finally {
			tui.stop();
		}
	});

	it("enableInput hands stdin to the terminal only after a deferred start", () => {
		class InputTerminal extends VirtualTerminal {
			enables = 0;
			enableInput(): void {
				this.enables++;
			}
		}
		const eager = new InputTerminal(40, 6);
		const eagerTui = new TUI(eager, undefined, { renderScheduler: new VirtualRenderScheduler() });
		const deferred = new InputTerminal(40, 6);
		const deferredTui = new TUI(deferred, undefined, { renderScheduler: new VirtualRenderScheduler() });
		const late = new InputTerminal(40, 6);
		const lateTui = new TUI(late, undefined, { renderScheduler: new VirtualRenderScheduler() });
		try {
			eagerTui.start();
			eagerTui.enableInput();
			expect(eager.enables).toBe(0);

			deferredTui.start({ deferInput: true });
			deferredTui.enableInput();
			deferredTui.enableInput();
			expect(deferred.enables).toBe(1);

			// A deferred start that is stopped before input is enabled never takes stdin.
			lateTui.start({ deferInput: true });
			lateTui.stop();
			lateTui.enableInput();
			expect(late.enables).toBe(0);
		} finally {
			eagerTui.stop();
			deferredTui.stop();
			lateTui.stop();
		}
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
	it("registers a postmortem restore that stops the TUI and releases its registration", async () => {
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
		// Capture only the TUI's own registration instead of running every
		// process-wide cleanup callback.
		let restore: ((reason: postmortem.Reason) => void | Promise<void>) | undefined;
		let cancelled = 0;
		const register = spyOn(postmortem, "register").mockImplementation((id, callback) => {
			expect(id).toBe("tui-restore");
			restore = callback;
			return () => {
				cancelled++;
			};
		});
		try {
			tui.start();
			await scheduler.settle(terminal);
			expect(restore).toBeDefined();
			await restore?.(postmortem.Reason.MANUAL);
			expect(cancelled).toBe(1);
			const settled = probe.renders;
			tui.requestRender(true);
			await scheduler.settle(terminal);
			expect(probe.renders).toBe(settled);
		} finally {
			register.mockRestore();
			tui.stop();
		}
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
