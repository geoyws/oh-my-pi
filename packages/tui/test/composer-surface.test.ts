import { beforeAll, describe, expect, it } from "bun:test";
import { Text } from "@oh-my-pi/pi-tui";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-tui/theme";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
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
		preferences: { quiet: false, spellingTypoDetection: false, spellingAutocomplete: "off", spellingAutocorrect: false },
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

	it("exposes welcome unless quiet and tracks the started lifecycle", async () => {
		const { terminal, scheduler, composer } = makeComposer();
		expect(composer.welcome).toBeDefined();
		expect(composer.started).toBe(false);
		composer.start({ playWelcomeIntro: false });
		try {
			await scheduler.settle(terminal);
			expect(composer.started).toBe(true);
			// A second start is a no-op.
			composer.start({ playWelcomeIntro: false });
			expect(composer.started).toBe(true);
		} finally {
			composer.stop();
		}
		expect(composer.started).toBe(false);
		// Starting after stop does not revive the composer.
		composer.start({ playWelcomeIntro: false });
		expect(composer.started).toBe(false);
		composer.enableInput();
		expect(composer.started).toBe(false);
	});

	it("has no welcome component in quiet mode", () => {
		const terminal = new VirtualTerminal(80, 24);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: {
				quiet: true,
				spellingTypoDetection: false,
				spellingAutocomplete: "off",
				spellingAutocorrect: false,
			},
		});
		expect(composer.welcome).toBeUndefined();
	});

	it("starts deferred without playing the welcome intro", async () => {
		const { terminal, scheduler, composer } = makeComposer();
		composer.start({ deferInput: true, playWelcomeIntro: false });
		try {
			await scheduler.settle(terminal);
			expect(composer.started).toBe(true);
			composer.enableInput();
			expect(composer.started).toBe(true);
		} finally {
			composer.stop();
		}
	});

	it("clears the draft on first Ctrl+C and exits 130 on a second within the window", () => {
		const exits: number[] = [];
		let now = 1000;
		const terminal = new VirtualTerminal(80, 24);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			exit: code => exits.push(code),
			now: () => now,
			preferences: { spellingTypoDetection: false, spellingAutocomplete: "off", spellingAutocorrect: false },
		});
		composer.editor.setText("draft");
		composer.editor.onClear?.();
		expect(composer.editor.getText()).toBe("");
		expect(exits).toEqual([]);
		now += 10;
		composer.editor.onClear?.();
		expect(exits).toEqual([130]);
	});

	it("exits 0 through the editor exit hook", () => {
		const exits: number[] = [];
		const terminal = new VirtualTerminal(80, 24);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			exit: code => exits.push(code),
			preferences: { spellingTypoDetection: false, spellingAutocomplete: "off", spellingAutocorrect: false },
		});
		composer.editor.onExit?.();
		expect(exits).toEqual([0]);
	});

	it("wraps the editor border with a persisted status border colour", () => {
		const terminal = new VirtualTerminal(80, 24);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			status: { borderColor: { prefix: "<B>", suffix: "</B>" }, statusLine: { settings: {}, gitEnabled: false, autoThinking: false, fastMode: false, usingSubscription: false, autoCompactEnabled: false, compactionBoundaries: null } as never },
			preferences: { spellingTypoDetection: false, spellingAutocomplete: "off", spellingAutocorrect: false },
		});
		expect(composer.editor.borderColor("x")).toBe("<B>x</B>");
	});

	it("toggles the welcome component with quiet preferences", async () => {
		const { terminal, scheduler, composer } = makeComposer();
		expect(composer.welcome).toBeDefined();
		composer.start({ playWelcomeIntro: false });
		try {
			await scheduler.settle(terminal);
			composer.setPreferences({ quiet: true });
			expect(composer.welcome).toBeUndefined();
			composer.setPreferences({ quiet: false });
			expect(composer.welcome).toBeDefined();
		} finally {
			composer.stop();
		}
		// Preference and welcome updates after stop are no-ops.
		composer.setPreferences({ quiet: true });
		composer.updateWelcome({ version: "9.9.9" });
		expect(composer.welcome).toBeDefined();
	});

	it("applies welcome updates and header extras, and replaces the editor", async () => {
		const { terminal, scheduler, composer } = makeComposer();
		const extra = new Text("extra-header", 0, 0);
		composer.start({ playWelcomeIntro: false });
		try {
			await scheduler.settle(terminal);
			composer.updateWelcome({ version: "1.2.3" });
			composer.setHeaderExtras([extra], []);
			const surface = composer.describeSurface();
			expect(surface.main).toContain(extra);
			const replacement = new CustomEditor(getEditorTheme());
			composer.setEditor(replacement);
			expect(composer.editor).toBe(replacement);
		} finally {
			composer.stop();
		}
		composer.setHeaderExtras([], []);
	});

	it("mounts a session status component, adopting git status from the startup line", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			status: {
				borderColor: { prefix: "<B>", suffix: "</B>" },
				statusLine: {
					settings: {},
					gitEnabled: true,
					autoThinking: false,
					fastMode: false,
					usingSubscription: false,
					autoCompactEnabled: false,
					compactionBoundaries: null,
				} as never,
			},
			preferences: { spellingTypoDetection: false, spellingAutocomplete: "off", spellingAutocorrect: false },
		});
		let adopted: unknown;
		const component = {
			render: () => ["session-status"],
			adoptGitStatus: (from: unknown) => {
				adopted = from;
			},
		};
		composer.start({ playWelcomeIntro: false });
		try {
			await scheduler.settle(terminal);
			composer.setStatusComponent(component as never);
			expect(adopted).toBeDefined();
			expect(composer.editor.composerFacts).toBe(component as never);
		} finally {
			composer.stop();
		}
	});

	it("replaces runtime children and refuses runtime changes after stop", async () => {
		const { terminal, scheduler, composer } = makeComposer();
		const first = new Text("first", 0, 0);
		const second = new Text("second", 0, 0);
		composer.start({ playWelcomeIntro: false });
		try {
			await scheduler.settle(terminal);
			composer.setRuntimeChildren([first]);
			expect(composer.describeSurface().dock).toEqual([first]);
			composer.setRuntimeChildren([second]);
			expect(composer.describeSurface().dock).toEqual([second]);
		} finally {
			composer.stop();
		}
		composer.setRuntimeChildren([first]);
		expect(composer.describeSurface().dock).toEqual([second]);
	});

	it("transfers ownership once and cannot transfer before start or after stop", async () => {
		const { terminal, scheduler, composer } = makeComposer();
		expect(() => composer.transfer()).toThrow("Composer is not available for transfer");
		composer.start({ playWelcomeIntro: false });
		try {
			await scheduler.settle(terminal);
			composer.transfer();
			expect(() => composer.transfer()).toThrow("Composer is not available for transfer");
			// Stop after transfer is a no-op: ownership moved to InteractiveMode.
			composer.stop();
			expect(composer.started).toBe(true);
		} finally {
			// The composer was transferred; stop the UI directly for cleanup.
			composer.ui.stop();
		}
	});

	it("does not exit again through the editor hook after stop", async () => {
		const exits: number[] = [];
		const terminal = new VirtualTerminal(80, 24);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			exit: code => exits.push(code),
			preferences: { spellingTypoDetection: false, spellingAutocomplete: "off", spellingAutocorrect: false },
		});
		composer.start({ playWelcomeIntro: false });
		await scheduler.settle(terminal);
		composer.stop();
		composer.editor.onExit?.();
		expect(exits).toEqual([]);
	});

	it("ignores history acknowledgements for unknown batches", () => {
		const { composer } = makeComposer();
		expect(() => composer.acknowledgeHistory(999)).not.toThrow();
		expect(() => composer.beginHistoryReplay()).not.toThrow();
		expect(() => composer.beginHistoryFlush()).not.toThrow();
	});

	it("renders no resize frame before start or after stop, and a tail while running", async () => {
		const { terminal, scheduler, composer } = makeComposer();
		expect(composer.renderResizeFrame({ columns: 80, rows: 10 })).toEqual([]);
		expect(composer.rowsBelow(new Text("x", 0, 0))).toBeUndefined();
		composer.start({ playWelcomeIntro: false });
		try {
			await scheduler.settle(terminal);
			const tail = composer.renderResizeFrame({ columns: 80, rows: 10 });
			expect(tail.length).toBeGreaterThan(0);
			expect(tail.length).toBeLessThanOrEqual(10);
		} finally {
			composer.stop();
		}
		expect(composer.renderResizeFrame({ columns: 80, rows: 10 })).toEqual([]);
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
