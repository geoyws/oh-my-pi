import { beforeAll, expect, it } from "bun:test";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { activeGrid, createChatRig, ledger } from "./helpers/bottom-anchored-chat";
import { EDITOR_TEXT, rowsContaining } from "./helpers/chat-surface";

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
