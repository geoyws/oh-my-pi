import { beforeAll, expect, it } from "bun:test";
import { CURSOR_MARKER, type TerminalFrameProvider, TUI } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { ledger, RecordingTerminal } from "./helpers/bottom-anchored-chat";
import { RowsBlock } from "./helpers/chat-surface";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";

withoutTerminalMultiplexer();
beforeAll(async () => {
	await initTheme();
});

it("never lets an inline overlay enter native history when the terminal resizes while it is open", async () => {
	const terminal = new RecordingTerminal(80, 24);
	const scheduler = new VirtualRenderScheduler();
	const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
	const history = Array.from({ length: 6 }, (_, index) => `SAVED-${index}`);
	let pending = true;
	const provider: TerminalFrameProvider = {
		renderFrame: () => ({
			history: pending ? { id: 1, rows: history } : undefined,
			viewport: ["live-tail", `input${CURSOR_MARKER}`],
		}),
		acknowledgeHistory: () => {
			pending = false;
		},
	};
	tui.setFrameProvider(provider);
	tui.start();
	try {
		await scheduler.settle(terminal);
		expect(ledger(terminal, /SAVED-\d/g)).toEqual(history);
		const handle = tui.showOverlay(new RowsBlock("MODAL", 4), {
			anchor: "top-center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
		});
		await scheduler.settle(terminal);
		terminal.resize(40, 18);
		await scheduler.advance(terminal, 300);
		handle.hide();
		await scheduler.settle(terminal);
		expect(ledger(terminal, /SAVED-\d/g), "all covered history remains reachable exactly once").toEqual(history);
		expect(ledger(terminal, /MODAL-\d/g), "modal pixels never become native history").toEqual([]);
		expect(ledger(terminal, /live-tail/g), "the live tail is not duplicated").toEqual(["live-tail"]);
	} finally {
		tui.stop();
	}
});
