// Real ProcessTerminal + Composer chat surface for bottom-anchored-chat-pty.test.ts.
// Each command byte on stdin runs one deterministic step (no timers, no model);
// every normal-screen paint reports `{"pty":<steps handled>,"columns","rows"}`
// in the window title so the test knows which step a frame belongs to.
import { Container, type OverlayHandle } from "@oh-my-pi/pi-tui";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { ProcessTerminal, type TerminalStartOptions } from "@oh-my-pi/pi-tui/terminal";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils";
import { EditorStub, LineBlock, RowsBlock, StatusLine } from "../helpers/chat-surface";

/** Finalized transcript lines before the first paint: more than a screen. */
const SETTLED_LINES = 40;
/** Finalized lines one `b` step appends. */
const LINES_PER_STEP = 4;

class StepTerminal extends ProcessTerminal {
	onStep?: (key: string) => boolean;

	override start(
		onInput: (data: string) => void,
		onResize: () => void,
		onDisconnect?: () => void,
		options?: TerminalStartOptions,
	): void {
		// Command bytes are the test driving the scenario, not keystrokes for the app.
		const forward = (data: string): void => {
			if (this.onStep?.(data) !== true) onInput(data);
		};
		super.start(forward, onResize, onDisconnect, options);
	}
}

setTerminalHeadless(false);
const terminal = new StepTerminal();
const composer = new Composer({ terminal, preferences: { ...COMPOSER_DEFAULTS, quiet: true } });
const transcript = new TranscriptContainer();
const hud = new RowsBlock("HUD");
const status = new StatusLine();
const editor = new Container();
editor.addChild(new EditorStub());
composer.setRuntimeChildren([transcript, hud, status, editor]);

let lines = 0;
const addLines = (count: number): void => {
	for (let index = 0; index < count; index++) {
		transcript.addChild(new LineBlock(`PTY${String(lines++).padStart(4, "0")}`));
	}
};
addLines(SETTLED_LINES);

let tool: RowsBlock | undefined;
const panel = new RowsBlock("OVERLAY", 4);
let overlay: OverlayHandle | undefined;
let handled = 0;

const steps: Record<string, () => void> = {
	// Streamed output: finalized lines land at the tail.
	b: () => {
		addLines(LINES_PER_STEP);
		status.text = `Working step ${handled}`;
	},
	// A tool starts with a short live preview, grows, then collapses to its settled result.
	t: () => {
		tool = new RowsBlock("TOOL", 2, true);
		transcript.addChild(tool);
	},
	g: () => {
		if (tool) tool.rows = 12;
	},
	s: () => {
		if (!tool) return;
		tool.rows = 3;
		tool.live = false;
	},
	// Self-clearing todo HUD appears and clears.
	h: () => {
		hud.rows = 6;
	},
	H: () => {
		hud.rows = 0;
	},
	// Bottom-anchored inline panel (selector, report) opens, grows, closes.
	o: () => {
		panel.rows = 4;
		overlay = composer.ui.showOverlay(panel, {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
		});
	},
	u: () => {
		panel.rows = 8;
	},
	c: () => {
		overlay?.hide();
		overlay = undefined;
	},
	q: () => {
		composer.stop();
		process.exit(0);
	},
};

terminal.onStep = key => {
	const step = steps[key];
	if (step === undefined) return false;
	step();
	handled++;
	composer.ui.requestRender();
	return true;
};
composer.ui.addPaintListener(paint => {
	if (!paint.alt) terminal.setTitle(JSON.stringify({ pty: handled, columns: paint.columns, rows: paint.rows }));
});
composer.start({ playWelcomeIntro: false });
// The test quits with `q`; this bounds an orphaned fixture.
await Bun.sleep(120_000);
composer.stop();
