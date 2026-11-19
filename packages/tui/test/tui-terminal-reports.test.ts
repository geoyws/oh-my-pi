import { afterEach, describe, expect, it } from "bun:test";
import type { Component } from "@oh-my-pi/pi-tui";
import { TUI } from "@oh-my-pi/pi-tui";
import type { RenderTimer } from "@oh-my-pi/pi-tui/tui";
import { ImageProtocol, setTerminalImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

class ReportTerminal extends VirtualTerminal {
	readonly writes: string[] = [];
	#glyph: ((supported: boolean) => void) | undefined;
	#sixel: ((supported: boolean) => void) | undefined;

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	onGlyphProtocolReport(callback: (supported: boolean) => void): void {
		this.#glyph = callback;
	}

	onSixelSupport(callback: (supported: boolean) => void): void {
		this.#sixel = callback;
	}

	reportGlyph(supported: boolean): void {
		this.#glyph?.(supported);
	}

	reportSixel(supported: boolean): void {
		this.#sixel?.(supported);
	}
}

class Probe implements Component {
	renders = 0;
	render(): string[] {
		this.renders++;
		return ["probe"];
	}
}

/** Records every timer the engine arms and which of them it cancels, by arming order. */
class TrackingScheduler extends VirtualRenderScheduler {
	readonly cancelled: number[] = [];
	#armed = 0;
	#live = new Set<number>();

	override scheduleRender(callback: () => void, delayMs: number): RenderTimer {
		const id = this.#armed++;
		this.#live.add(id);
		const timer = super.scheduleRender(() => {
			this.#live.delete(id);
			callback();
		}, delayMs);
		return {
			cancel: () => {
				if (this.#live.delete(id)) this.cancelled.push(id);
				timer.cancel();
			},
		};
	}

	pending(): number[] {
		return [...this.#live];
	}
}

describe("TUI terminal report callbacks", () => {
	const previousProtocol = TERMINAL.imageProtocol;
	afterEach(() => {
		setTerminalImageProtocol(previousProtocol);
	});

	it("repaints on a supported glyph report and ignores an unsupported one", async () => {
		const terminal = new ReportTerminal(40, 6);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		const probe = new Probe();
		tui.addChild(probe);
		try {
			tui.start();
			await scheduler.settle(terminal);
			const settled = probe.renders;
			terminal.reportGlyph(false);
			await scheduler.settle(terminal);
			expect(probe.renders).toBe(settled);

			terminal.reportGlyph(true);
			await scheduler.settle(terminal);
			expect(probe.renders).toBeGreaterThan(settled);
		} finally {
			tui.stop();
		}
	});

	it("does not repaint on a glyph report after stop", async () => {
		const terminal = new ReportTerminal(40, 6);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		const probe = new Probe();
		tui.addChild(probe);
		tui.start();
		await scheduler.settle(terminal);
		tui.stop();
		const settled = probe.renders;
		terminal.reportGlyph(true);
		await scheduler.settle(terminal);
		expect(probe.renders).toBe(settled);
	});

	it("defers the first Ghostty Kitty paint until the initial-image timer fires", async () => {
		const mutable = TERMINAL as unknown as { id: string; imageProtocol: ImageProtocol | null };
		const originalId = mutable.id;
		mutable.id = "ghostty";
		setTerminalImageProtocol(ImageProtocol.Kitty);
		const terminal = new ReportTerminal(40, 12);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		const { Image } = await import("@oh-my-pi/pi-tui/components/image");
		tui.addChild(
			new Image(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==",
				"image/png",
				{ fallbackColor: (text: string) => text },
				{ maxWidthCells: 4, maxHeightCells: 4, budget: tui.imageBudget, imageKey: "ghostty-initial" },
				{ widthPx: 40, heightPx: 40 },
			),
		);
		try {
			tui.start();
			await scheduler.settle(terminal);
			// No Kitty graphics APC of any action (transmit is `a=t`, placement `a=p`) before the timer.
			expect(terminal.writes.join("")).not.toContain("\x1b_G");
			await scheduler.advance(terminal, 150);
			expect(terminal.writes.join("")).toContain("\x1b_G");
		} finally {
			tui.stop();
			mutable.id = originalId;
		}
	});

	it("cancels the pending Ghostty initial-image timer when stopped during the delay", async () => {
		const mutable = TERMINAL as unknown as { id: string; imageProtocol: ImageProtocol | null };
		const originalId = mutable.id;
		mutable.id = "ghostty";
		setTerminalImageProtocol(ImageProtocol.Kitty);
		const terminal = new ReportTerminal(40, 12);
		const scheduler = new TrackingScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		const { Image } = await import("@oh-my-pi/pi-tui/components/image");
		tui.addChild(
			new Image(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==",
				"image/png",
				{ fallbackColor: (text: string) => text },
				{ maxWidthCells: 4, maxHeightCells: 4, budget: tui.imageBudget, imageKey: "ghostty-stop" },
				{ widthPx: 40, heightPx: 40 },
			),
		);
		try {
			tui.start();
			await scheduler.settle(terminal);
			// The deferred first image frame is the only timer still owed.
			const owed = scheduler.pending();
			expect(owed).toHaveLength(1);
			tui.stop();
			expect(scheduler.pending()).toEqual([]);
			expect(scheduler.cancelled).toContain(owed[0]!);
			await scheduler.advance(terminal, 1_000);
			expect(terminal.writes.join("")).not.toContain("\x1b_G");
		} finally {
			tui.stop();
			mutable.id = originalId;
		}
	});

	it("clearInlineImages deletes each transmitted Kitty image while running and nothing once stopped", async () => {
		const mutable = TERMINAL as unknown as { id: string };
		const originalId = mutable.id;
		mutable.id = "kitty";
		setTerminalImageProtocol(ImageProtocol.Kitty);
		const { Image } = await import("@oh-my-pi/pi-tui/components/image");
		async function paintedImage(): Promise<{ tui: TUI; terminal: ReportTerminal }> {
			const terminal = new ReportTerminal(40, 12);
			const scheduler = new VirtualRenderScheduler();
			const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
			tui.addChild(
				new Image(
					"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==",
					"image/png",
					{ fallbackColor: (text: string) => text },
					{ maxWidthCells: 4, maxHeightCells: 4, budget: tui.imageBudget, imageKey: "purge" },
					{ widthPx: 40, heightPx: 40 },
				),
			);
			tui.start();
			await scheduler.settle(terminal);
			expect(terminal.writes.join("")).toContain("\x1b_G");
			terminal.writes.length = 0;
			return { tui, terminal };
		}
		const running = await paintedImage();
		const stopped = await paintedImage();
		const switched = await paintedImage();
		try {
			running.tui.clearInlineImages();
			expect(running.terminal.writes.join("")).toMatch(/\x1b_Ga=d,d=I,i=\d+,q=2\x1b\\/);
			// The purge consumed the tracked ids: a second call has nothing to delete.
			running.terminal.writes.length = 0;
			running.tui.clearInlineImages();
			expect(running.terminal.writes).toEqual([]);

			stopped.tui.stop();
			stopped.terminal.writes.length = 0;
			stopped.tui.clearInlineImages();
			expect(stopped.terminal.writes).toEqual([]);

			// Off Kitty no delete is written, and the tracked ids are still dropped.
			setTerminalImageProtocol(null);
			switched.tui.clearInlineImages();
			expect(switched.terminal.writes).toEqual([]);
			setTerminalImageProtocol(ImageProtocol.Kitty);
			switched.tui.clearInlineImages();
			expect(switched.terminal.writes).toEqual([]);
		} finally {
			running.tui.stop();
			stopped.tui.stop();
			switched.tui.stop();
			mutable.id = originalId;
		}
	});

	it("enables SIXEL and queries cell size on a supported SIXEL report", async () => {
		setTerminalImageProtocol(null);
		const terminal = new ReportTerminal(40, 6);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.addChild(new Probe());
		try {
			tui.start();
			await scheduler.settle(terminal);
			terminal.writes.length = 0;
			terminal.reportSixel(false);
			await scheduler.settle(terminal);
			expect(TERMINAL.imageProtocol).toBeNull();
			expect(terminal.writes.join("")).not.toContain("\x1b[16t");

			terminal.reportSixel(true);
			await scheduler.settle(terminal);
			expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Sixel);
			expect(terminal.writes.join("")).toContain("\x1b[16t");
		} finally {
			tui.stop();
		}
	});
});
