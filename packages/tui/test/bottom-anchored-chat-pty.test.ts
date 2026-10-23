import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { PtySession, type PtyRunResult } from "@oh-my-pi/pi-natives";
import { TERMINAL_MULTIPLEXER_ENV_KEYS } from "@oh-my-pi/pi-tui/terminal-multiplexer";
import { activeGrid, ledger } from "./helpers/bottom-anchored-chat";
import { changedRows, EDITOR_TEXT, plain, rowsContaining, scanTerminalBytes } from "./helpers/chat-surface";
import { VirtualTerminal } from "./virtual-terminal";

// t-d6c9e119 on a real PTY: the fixture is a separate process running the
// real ProcessTerminal + Composer stack (raw mode, capability probes,
// SIGWINCH, DEC 2026 framing); this side plays the terminal with the kitty VT
// engine, answers its probes, scrolls like a reader, and resizes like a window.

const FIXTURE = path.join(import.meta.dir, "fixtures/pty-chat-surface.ts");
const TITLE = /\x1b\]0;(\{"pty":[^\x07]*\})\x07/g;
const SYNC_MARKERS = ["\x1b[?2026h", "\x1b[?2026l"];
/** Matches fixtures/pty-chat-surface.ts. */
const SETTLED_LINES = 40;
const LINES_PER_STEP = 4;

interface FixtureState {
	pty: number;
	columns: number;
	rows: number;
}

function fixtureEnv(): Record<string, string> {
	// The PTY child inherits this process's environment; blank every marker that
	// would route rendering down a multiplexer, Warp or TSP path.
	const env: Record<string, string> = {};
	for (const key of TERMINAL_MULTIPLEXER_ENV_KEYS) env[key] = "";
	return {
		...env,
		TERM: "xterm-256color",
		COLORTERM: "truecolor",
		TERM_PROGRAM: "",
		PI_TUI_RESIZE_IN_PLACE: "",
		PI_TUI_NATIVE: "0",
		PI_TUI_SYNC_OUTPUT: "1",
		PI_NO_SYNC_OUTPUT: "",
		PI_TEST_RUNTIME: "",
		OMP_TUI_DEBUG: "",
	};
}

/** The fixture on a real PTY, rendered into a kitty VT engine that plays the terminal. */
class PtyChat {
	readonly screen: VirtualTerminal;
	readonly exited: Promise<PtyRunResult | undefined>;
	readonly errors: Error[] = [];
	#pty = new PtySession();
	#state: FixtureState | undefined;
	#titleTail = "";
	#syncCarry = "";
	#output = "";
	#lastChunkAt = performance.now();
	#sent = 0;
	#waiters = new Set<() => void>();
	#running = true;
	#closing = false;

	constructor(columns: number, rows: number) {
		this.screen = new VirtualTerminal(columns, rows, 10_000);
		// The engine answers the app's DA/DECRQM/CPR/kitty-keyboard probes back down the PTY.
		this.screen.start(
			reply => this.#pty.write(reply),
			() => {},
		);
		this.exited = this.#pty
			.startArgv(
				{
					application: process.execPath,
					args: [FIXTURE],
					cwd: import.meta.dir,
					env: fixtureEnv(),
					cols: columns,
					rows,
					timeoutMs: 120_000,
				},
				(error, chunk) => {
					if (error) this.errors.push(error);
					else this.#receive(chunk);
					for (const check of this.#waiters) check();
				},
			)
			.then(
				result => {
					if (!this.#closing) this.errors.push(new Error(`fixture exited early: ${JSON.stringify(result)}`));
					return result;
				},
				(error: Error) => {
					this.errors.push(error);
					return undefined;
				},
			)
			.finally(() => {
				this.#running = false;
				for (const check of this.#waiters) check();
			});
	}

	#receive(chunk: string): void {
		this.#lastChunkAt = performance.now();
		this.#output += chunk;
		this.#titleTail += chunk;
		let consumed = -1;
		for (const match of this.#titleTail.matchAll(TITLE)) {
			this.#state = JSON.parse(match[1]!) as FixtureState;
			consumed = (match.index ?? 0) + match[0].length;
		}
		if (consumed >= 0) this.#titleTail = this.#titleTail.slice(consumed);
		else if (this.#titleTail.length > 8192) this.#titleTail = this.#titleTail.slice(-1024);
		// The engine model strips whole DEC 2026 markers; hold back a marker a PTY
		// read split, so a fragment never reaches the parser.
		let data = this.#syncCarry + chunk;
		this.#syncCarry = "";
		const escape = data.lastIndexOf("\x1b");
		if (escape >= 0) {
			const tail = data.slice(escape);
			if (SYNC_MARKERS.some(marker => marker.length > tail.length && marker.startsWith(tail))) {
				this.#syncCarry = tail;
				data = data.slice(0, escape);
			}
		}
		this.screen.write(data);
	}

	/** Resolve once `done()` holds, re-checked on every chunk the fixture writes. */
	async #waitFor(done: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const check = (): void => {
			if (this.errors.length > 0) reject(this.errors[0]);
			else if (done()) resolve();
		};
		const timer = setTimeout(() => {
			const screen = activeGrid(this.screen).join("\n");
			reject(new Error(`${label}: timed out at ${JSON.stringify(this.#state)}\n${screen}`));
		}, timeoutMs);
		this.#waiters.add(check);
		check();
		try {
			await promise;
		} finally {
			clearTimeout(timer);
			this.#waiters.delete(check);
		}
	}

	/**
	 * Wait until the fixture has written nothing for `ms`. A step can owe more
	 * than the paint that acknowledged it (a retirement pump, a resize settle
	 * and rebuild), and a separate process exposes no "done" signal for those,
	 * so an output-idle window on the real clock is the only completion test.
	 */
	async #quiet(ms: number): Promise<void> {
		for (let idle = ms - (performance.now() - this.#lastChunkAt); idle > 0;) {
			await Bun.sleep(idle);
			idle = ms - (performance.now() - this.#lastChunkAt);
		}
		if (this.errors.length > 0) throw this.errors[0];
	}

	async started(columns: number, rows: number): Promise<string> {
		await this.#waitFor(() => this.#state?.columns === columns && this.#state.rows === rows, "first paint", 30_000);
		await this.#quiet(300);
		return this.#take();
	}

	/** Send one command byte; resolve with everything the fixture wrote for it once it went quiet. */
	async step(key: string): Promise<string> {
		this.#take();
		this.#sent++;
		const target = this.#sent;
		this.#pty.write(key);
		await this.#waitFor(() => (this.#state?.pty ?? 0) >= target, `step ${target} (${key})`);
		await this.#quiet(150);
		return this.#take();
	}

	/** Resize the window the way a terminal does: grid first, then SIGWINCH. */
	async resize(columns: number, rows: number): Promise<string> {
		this.#take();
		this.screen.resize(columns, rows);
		this.#pty.resize(columns, rows);
		await this.#waitFor(
			() => this.#state?.columns === columns && this.#state.rows === rows,
			`resize to ${columns}x${rows}`,
		);
		await this.#quiet(400);
		return this.#take();
	}

	#take(): string {
		const output = this.#output;
		this.#output = "";
		return output;
	}

	async close(): Promise<void> {
		this.#closing = true;
		this.#pty.write("q");
		await this.#waitFor(() => !this.#running, "fixture exit after q", 5000);
	}

	kill(): void {
		this.#closing = true;
		if (this.#running) this.#pty.kill();
	}
}

interface Expected {
	lines: string[];
	tool: number;
	hud: number;
}

/** Full-screen chat contract, read from the terminal the fixture painted. */
function expectChat(chat: PtyChat, expected: Expected, label: string): void {
	const { screen } = chat;
	expect(ledger(screen, /\bPTY\d{4}\b/), `${label}: transcript ledger`).toEqual(expected.lines);
	const grid = activeGrid(screen);
	expect(rowsContaining(grid, EDITOR_TEXT), `${label}: editor row`).toEqual([screen.rows - 1]);
	expect(ledger(screen, new RegExp(EDITOR_TEXT)), `${label}: editor copies in the buffer`).toHaveLength(1);
	expect(screen.getCursor().row, `${label}: cursor row`).toBe(screen.rows - 2);
	expect(ledger(screen, /\bTOOL-\d+\b/), `${label}: tool rows`).toHaveLength(expected.tool);
	expect(ledger(screen, /\bHUD-\d+\b/), `${label}: HUD rows`).toHaveLength(expected.hud);
	expect(ledger(screen, /\bOVERLAY-\d+\b/), `${label}: overlay rows`).toEqual([]);
}

function expectOrdinaryBytes(output: string, rows: number, label: string): void {
	const scan = scanTerminalBytes(output, rows);
	expect(scan.eraseScrollback, `${label}: ED3 on an ordinary update`).toBe(0);
	expect(scan.writesOutsideSync, `${label}: cells written outside a synchronized update`).toBe(0);
}

describe("bottom-anchored chat on a real PTY (t-d6c9e119)", () => {
	it.skipIf(process.platform === "win32")(
		"streams, scrolls, grows chrome, opens a panel and resizes without losing, duplicating or hiding rows",
		async () => {
			const chat = new PtyChat(100, 30);
			const expected: Expected = {
				lines: Array.from({ length: SETTLED_LINES }, (_, index) => `PTY${String(index).padStart(4, "0")}`),
				tool: 0,
				hud: 0,
			};
			const stream = (): void => {
				for (let index = 0; index < LINES_PER_STEP; index++) {
					expected.lines.push(`PTY${String(expected.lines.length).padStart(4, "0")}`);
				}
			};
			let written = 0;
			let needed = 0;
			const measuredStream = async (label: string): Promise<void> => {
				const before = activeGrid(chat.screen);
				const baseBefore = chat.screen.getBufferPosition().baseY;
				const output = await chat.step("b");
				stream();
				expectOrdinaryBytes(output, chat.screen.rows, label);
				const scrolled = chat.screen.getBufferPosition().baseY - baseBefore;
				written += scanTerminalBytes(output, chat.screen.rows).rowWrites;
				needed += changedRows(before, activeGrid(chat.screen), scrolled) + scrolled + 4;
			};
			try {
				await chat.started(100, 30);
				expectChat(chat, expected, "first paint");
				for (let step = 0; step < 6; step++) {
					await measuredStream(`stream ${step}`);
					expectChat(chat, expected, `stream ${step}`);
				}

				// A reader scrolls up while output keeps streaming, then returns to the tail.
				chat.screen.scrollLines(-12);
				const held = chat.screen.getViewport().map(plain);
				const position = chat.screen.getBufferPosition();
				expect(position.viewportY).toBeLessThan(position.baseY);
				for (let step = 0; step < 4; step++) {
					await measuredStream(`scrolled-up ${step}`);
					expect(chat.screen.getViewport().map(plain), `scrolled-up ${step}: reader viewport`).toEqual(held);
					expect(chat.screen.getBufferPosition().viewportY, `scrolled-up ${step}: reader offset`).toBe(
						position.viewportY,
					);
					expect(ledger(chat.screen, /\bPTY\d{4}\b/), `scrolled-up ${step}: ledger`).toEqual(expected.lines);
				}
				chat.screen.scrollLines(chat.screen.getBufferPosition().baseY);
				await measuredStream("back at tail");
				expect(chat.screen.isNativeViewportAtBottom()).toBe(true);
				expectChat(chat, expected, "back at tail");
				expect(chat.screen.getViewport().map(plain)).toContain(expected.lines.at(-1)!);

				// Tool preview grows and collapses to its settled result.
				expectOrdinaryBytes(await chat.step("t"), chat.screen.rows, "tool starts");
				expectChat(chat, { ...expected, tool: 2 }, "tool starts");
				expectOrdinaryBytes(await chat.step("g"), chat.screen.rows, "tool grows");
				expectChat(chat, { ...expected, tool: 12 }, "tool grows");
				expectOrdinaryBytes(await chat.step("s"), chat.screen.rows, "tool settles");
				expected.tool = 3;
				expectChat(chat, expected, "tool settles");
				for (let step = 0; step < 3; step++) {
					await measuredStream(`after tool ${step}`);
					expectChat(chat, expected, `after tool ${step}`);
				}

				// A self-clearing todo HUD displaces the live tail, then clears.
				expectOrdinaryBytes(await chat.step("h"), chat.screen.rows, "HUD appears");
				expected.hud = 6;
				expectChat(chat, expected, "HUD appears");
				for (let step = 0; step < 2; step++) {
					await measuredStream(`under HUD ${step}`);
					expectChat(chat, expected, `under HUD ${step}`);
				}
				expectOrdinaryBytes(await chat.step("H"), chat.screen.rows, "HUD clears");
				expected.hud = 0;
				expectChat(chat, expected, "HUD clears");

				// A bottom-anchored panel opens over the editor, grows, and closes.
				const overlayRows = (): number[] => rowsContaining(activeGrid(chat.screen), "OVERLAY-");
				const rows = chat.screen.rows;
				expectOrdinaryBytes(await chat.step("o"), rows, "panel opens");
				expect(overlayRows()).toEqual([rows - 4, rows - 3, rows - 2, rows - 1]);
				expectOrdinaryBytes(await chat.step("u"), rows, "panel grows");
				expect(overlayRows()).toEqual(Array.from({ length: 8 }, (_, index) => rows - 8 + index));
				// Rows under the panel are covered, never moved, dropped or duplicated.
				const covered = ledger(chat.screen, /\bPTY\d{4}\b/);
				expect(covered).toEqual(expected.lines.filter(line => covered.includes(line)));
				expect(covered.length).toBeGreaterThanOrEqual(expected.lines.length - 4);
				expectOrdinaryBytes(await chat.step("c"), rows, "panel closes");
				expectChat(chat, expected, "panel closes");

				// Window resizes: width and height together, then grow back.
				for (const [columns, height] of [
					[84, 24],
					[110, 34],
				] as const) {
					await chat.resize(columns, height);
					expectChat(chat, expected, `${columns}x${height} settled`);
					for (let step = 0; step < 2; step++) {
						await measuredStream(`${columns}x${height} stream ${step}`);
						expectChat(chat, expected, `${columns}x${height} stream ${step}`);
					}
				}

				// Committing streamed rows rewrites what changed after the scroll, not the screen.
				expect(written).toBeLessThanOrEqual(needed);
				await chat.close();
				expect(chat.errors).toEqual([]);
			} finally {
				chat.kill();
				await chat.exited;
			}
		},
		90_000,
	);
});
