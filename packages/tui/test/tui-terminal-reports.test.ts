import { afterEach, describe, expect, it } from "bun:test";
import type { Component } from "@oh-my-pi/pi-tui";
import { TUI } from "@oh-my-pi/pi-tui";
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
