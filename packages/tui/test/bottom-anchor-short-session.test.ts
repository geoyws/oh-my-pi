import { beforeAll, expect, it } from "bun:test";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { activeGrid, createChatRig, ledger, RecordingTerminal } from "./helpers/bottom-anchored-chat";
import { EDITOR_TEXT, EditorStub, LineBlock, rowsContaining } from "./helpers/chat-surface";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";

beforeAll(async () => {
	await initTheme();
});

it("anchors an empty and short chat before history fills, including chrome contraction", async () => {
	const rig = createChatRig({ columns: 100, rows: 30, settled: 0, prefix: "QZB" });
	const check = (label: string): void => {
		expect(rowsContaining(activeGrid(rig.terminal), EDITOR_TEXT), `${label}: editor bottom`).toEqual([
			rig.terminal.rows - 1,
		]);
		expect(rig.terminal.getCursor().row, `${label}: input cursor`).toBe(rig.terminal.rows - 2);
		expect(ledger(rig.terminal, /\bQZB\d{4}\b/), `${label}: transcript remains reachable`).toEqual(rig.emitted);
		expect(ledger(rig.terminal, new RegExp(EDITOR_TEXT)), `${label}: one editor`).toEqual([EDITOR_TEXT]);
	};
	try {
		await rig.scheduler.settle(rig.terminal);
		check("empty");
		for (const count of [1, 3]) {
			rig.addLines(count);
			rig.composer.ui.requestRender();
			await rig.scheduler.settle(rig.terminal);
			check("short output");
		}
		for (const rows of [6, 0]) {
			rig.hud.rows = rows;
			rig.composer.ui.requestRender();
			await rig.scheduler.settle(rig.terminal);
			check(rows === 0 ? "chrome contracts" : "chrome grows");
		}
	} finally {
		rig.composer.stop();
	}
});

it("keeps the welcome header live above a short chat and retires it to scrollback once the screen fills", async () => {
	const rows = 30;
	const terminal = new RecordingTerminal(100, rows, 1000);
	const scheduler = new VirtualRenderScheduler();
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { ...COMPOSER_DEFAULTS, quiet: false },
	});
	const transcript = new TranscriptContainer();
	composer.setRuntimeChildren([transcript, new EditorStub()]);
	const lines: string[] = [];
	const addLines = async (count: number): Promise<void> => {
		for (let index = 0; index < count; index++) {
			const line = `QZH${String(lines.length).padStart(4, "0")}`;
			lines.push(line);
			transcript.addChild(new LineBlock(line));
		}
		composer.ui.requestRender();
		await scheduler.settle(terminal);
	};
	try {
		composer.start({ playWelcomeIntro: false });
		await scheduler.settle(terminal);
		await addLines(3);
		const grid = activeGrid(terminal);
		expect(rowsContaining(grid, "Tip:"), "header on screen").toHaveLength(1);
		expect(rowsContaining(grid, "Tip:")[0]!, "header above the transcript").toBeLessThan(
			rowsContaining(grid, "QZH0000")[0]!,
		);
		expect(terminal.getScrollBuffer(), "nothing committed to scrollback yet").toHaveLength(rows);
		// One finalized line per frame, as a streamed answer settles.
		for (let step = 0; step < rows; step++) await addLines(1);
		expect(ledger(terminal, /Tip:/), "header retired exactly once").toEqual(["Tip:"]);
		expect(ledger(terminal, /\bQZH\d{4}\b/), "transcript reachable in order").toEqual(lines);
		expect(rowsContaining(activeGrid(terminal), EDITOR_TEXT), "editor on the bottom row").toEqual([rows - 1]);
	} finally {
		composer.stop();
	}
});
