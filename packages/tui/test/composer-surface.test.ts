import { beforeAll, describe, expect, it } from "bun:test";
import { Text } from "@oh-my-pi/pi-tui";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

beforeAll(async () => {
	await initTheme();
});

function makeComposer() {
	const terminal = new VirtualTerminal(80, 24);
	const scheduler = new VirtualRenderScheduler();
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { spellingTypoDetection: false, spellingAutocomplete: "off", spellingAutocorrect: false },
	});
	return { terminal, scheduler, composer };
}

describe("Composer describeSurface", () => {
	it("returns the cached surface before start", () => {
		const { composer } = makeComposer();
		const surface = composer.describeSurface();
		expect(surface.dock).toEqual([]);
		expect(composer.describeSurface()).toBe(surface);
	});

	it("docks only the editor before runtime children mount", async () => {
		const { terminal, scheduler, composer } = makeComposer();
		composer.start();
		try {
			await scheduler.settle(terminal);
			const surface = composer.describeSurface();
			expect(surface.dock).toEqual([composer.editor]);
			// Unchanged children return the identical arrays.
			const again = composer.describeSurface();
			expect(again.main).toBe(surface.main);
			expect(again.dock).toBe(surface.dock);
		} finally {
			composer.stop();
		}
	});

	it("docks every runtime root when no transcript is mounted", async () => {
		const { terminal, scheduler, composer } = makeComposer();
		const first = new Text("first", 0, 0);
		const second = new Text("second", 0, 0);
		composer.setRuntimeChildren([first, second]);
		composer.start();
		try {
			await scheduler.settle(terminal);
			const surface = composer.describeSurface();
			expect(surface.dock).toEqual([first, second]);
		} finally {
			composer.stop();
		}
	});

	it("splits roots around the transcript into main and dock", async () => {
		const { terminal, scheduler, composer } = makeComposer();
		const before = new Text("before", 0, 0);
		const transcript = new TranscriptContainer();
		const after = new Text("after", 0, 0);
		composer.setRuntimeChildren([before, transcript, after]);
		composer.start();
		try {
			await scheduler.settle(terminal);
			const surface = composer.describeSurface();
			expect(surface.main).toContain(before);
			expect(surface.dock).toEqual([after]);
		} finally {
			composer.stop();
		}
	});

	it("returns the cached surface after stop", async () => {
		const { terminal, scheduler, composer } = makeComposer();
		composer.start();
		await scheduler.settle(terminal);
		const live = composer.describeSurface();
		composer.stop();
		expect(composer.describeSurface()).toBe(live);
	});
});
