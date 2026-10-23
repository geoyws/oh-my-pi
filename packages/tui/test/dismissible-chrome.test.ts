import { beforeAll, describe, expect, it } from "bun:test";
import { Container, Text } from "@oh-my-pi/pi-tui";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

const ROWS = 30;
const PANEL_ROWS = 10;

beforeAll(async () => {
	await initTheme();
});

/** A long transcript above a dismissible panel slot and a one-row editor. */
async function mount(transcriptRows: number) {
	const terminal = new VirtualTerminal(80, ROWS);
	const scheduler = new VirtualRenderScheduler();
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { ...COMPOSER_DEFAULTS, quiet: true },
	});
	const transcript = new TranscriptContainer();
	let appended = 0;
	const append = (count: number) => {
		for (let i = 0; i < count; i++) {
			const row = appended++;
			transcript.addChild({ render: () => [`Transcript ${row}`] });
		}
	};
	append(transcriptRows);
	const panelSlot = new Container();
	const editor = new Container();
	editor.addChild(new Text("EDITOR", 0, 0));
	composer.setRuntimeChildren([transcript, panelSlot, editor], { dismissibleChrome: [panelSlot] });
	composer.start({ playWelcomeIntro: false });
	await scheduler.settle(terminal);
	const settle = async () => {
		composer.ui.requestRender();
		await scheduler.settle(terminal);
	};
	const screen = () => terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
	/** Transcript row numbers in scrollback then on screen, top to bottom. */
	const transcriptOrder = () =>
		[...terminal.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd())]
			.map(row => row.match(/^Transcript (\d+)$/)?.[1])
			.filter(row => row !== undefined)
			.map(Number);
	const open = async () => {
		panelSlot.addChild(new Text(Array.from({ length: PANEL_ROWS }, (_, i) => `Panel ${i}`).join("\n"), 0, 0));
		await settle();
	};
	const close = async () => {
		panelSlot.clear();
		await settle();
	};
	return { composer, append, settle, screen, transcriptOrder, open, close, last: () => `Transcript ${appended - 1}` };
}

describe("dismissible below-transcript chrome", () => {
	it("covers the transcript tail while open and puts the covered rows back in place when it closes", async () => {
		const h = await mount(60);
		const last = h.last();
		const lastRow = h.screen().indexOf(last);
		expect(lastRow).toBeGreaterThan(0);

		await h.open();
		const opened = h.screen();
		expect(opened.some(row => row === "Panel 0")).toBe(true);
		// The tail stays visible directly above the panel.
		expect(opened.indexOf(last)).toBe(opened.indexOf("Panel 0") - 1);

		await h.close();
		expect(h.screen().indexOf(last)).toBe(lastRow);
		expect(h.screen().some(row => row.startsWith("Panel"))).toBe(false);
		// Covering rows never pushed transcript rows into scrollback twice or out of order.
		const order = h.transcriptOrder();
		expect(order).toEqual(Array.from({ length: 60 }, (_, i) => i));
		h.composer.stop();
	});

	it("keeps every transcript row exactly once, in order, when output streams while the panel is open", async () => {
		const h = await mount(60);
		await h.open();
		h.append(25);
		await h.settle();
		expect(h.screen().indexOf(h.last())).toBe(h.screen().indexOf("Panel 0") - 1);

		await h.close();
		expect(h.transcriptOrder()).toEqual(Array.from({ length: 85 }, (_, i) => i));
		// The tail sits directly above the input again: no blank band where the panel was.
		const screen = h.screen();
		expect(screen.indexOf(h.last())).toBe(screen.indexOf("EDITOR") - 1);
		h.composer.stop();
	});
});
