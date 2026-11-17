import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Markdown } from "@oh-my-pi/pi-tui/components/markdown";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { setExtensionLinks } from "@oh-my-pi/pi-tui/render/extension-links";
import { getMarkdownTheme, initTheme } from "@oh-my-pi/pi-tui/theme";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

beforeAll(async () => {
	await initTheme();
});
afterEach(() => {
	setExtensionLinks([]);
});

async function startWithLink() {
	setExtensionLinks(["demo"]);
	const terminal = new VirtualTerminal(80, 24);
	const scheduler = new VirtualRenderScheduler();
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { spellingTypoDetection: false, spellingAutocomplete: "off", spellingAutocorrect: false },
	});
	const transcript = new TranscriptContainer();
	transcript.addChild(new Markdown("Open [the details](demo:open/7) now", 0, 0, getMarkdownTheme()));
	composer.setRuntimeChildren([transcript]);
	composer.start({ playWelcomeIntro: false });
	await scheduler.settle(terminal);
	return { terminal, scheduler, composer };
}

describe("Composer viewport links and link hints", () => {
	it("locates extension link labels in the last viewport rows", async () => {
		const { terminal, composer } = await startWithLink();
		try {
			expect(composer.viewportLinkCount()).toBe(1);
			const rows = terminal.getViewport().map(row => Bun.stripANSI(row));
			const row = rows.findIndex(line => line.includes("the details"));
			expect(row).toBeGreaterThanOrEqual(0);
			const col = rows[row]!.indexOf("the details");
			expect(composer.viewportLinkAt(row, col)).toMatchObject({ url: "demo:open/7", row, start: col });
			expect(composer.viewportLinkAt(row, 0)).toBeUndefined();
			expect(composer.viewportLinkAt(row, -1)).toBeUndefined();
			expect(composer.viewportLinkAt(999, col)).toBeUndefined();
		} finally {
			composer.stop();
		}
	});

	it("picks a link by typing its hint tag and ends the mode", async () => {
		const { composer } = await startWithLink();
		const ends: (string | undefined)[] = [];
		try {
			expect(composer.typeLinkHint("a")).toBe(false);
			composer.startLinkHints(reason => ends.push(reason));
			expect(composer.linkHintsActive).toBe(true);
			const picked = composer.typeLinkHint("a");
			expect(picked).toMatchObject({ url: "demo:open/7" });
			expect(composer.linkHintsActive).toBe(false);
			expect(ends).toEqual([undefined]);
		} finally {
			composer.stop();
		}
	});

	it("ends the mode on a miss and on cancel", async () => {
		const { composer } = await startWithLink();
		const ends: (string | undefined)[] = [];
		try {
			composer.startLinkHints(reason => ends.push(reason));
			expect(composer.typeLinkHint("z")).toBe(false);
			expect(composer.linkHintsActive).toBe(false);
			composer.startLinkHints(reason => ends.push(reason));
			expect(composer.linkHintsActive).toBe(true);
			composer.cancelLinkHints();
			expect(composer.linkHintsActive).toBe(false);
			expect(ends).toEqual([undefined, undefined]);
		} finally {
			composer.stop();
		}
	});

	it("clears the hovered click target without candidates", async () => {
		const { composer } = await startWithLink();
		try {
			expect(composer.viewportClickCandidates(0)).toEqual([]);
			composer.setHoveredClickId("some-agent");
			composer.setHoveredClickId(undefined);
			expect(composer.viewportClickCandidates(999)).toEqual([]);
		} finally {
			composer.stop();
		}
	});
});
