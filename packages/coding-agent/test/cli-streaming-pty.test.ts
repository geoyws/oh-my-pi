import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type PtyRunResult, PtySession } from "@oh-my-pi/pi-natives";
import { TERMINAL_MULTIPLEXER_ENV_KEYS } from "@oh-my-pi/pi-tui/terminal-multiplexer";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

// t-d6c9e119, end to end: the real `omp` CLI (src/cli.ts → InteractiveMode →
// AssistantMessageComponent) on a native PTY, answering through a local
// OpenAI-compatible SSE stand-in the test drives one delta at a time. The kitty
// VT engine plays the terminal: it answers the app's probes, keeps native
// scrollback, scrolls like a reader and resizes like a window. Each delta closes
// one Markdown paragraph and opens the next, so the screen must show every
// closed paragraph exactly once, in order, while the open one stays live above
// a bottom-anchored input, status line and cursor.
//
// The stand-in is synthetic transport only: this proves the app's terminal
// surface, not model quality.

const CLI_ENTRY = path.join(import.meta.dir, "..", "src", "cli.ts");
const PROVIDER = "ptyfixture";
const MODEL_ID = "pty-model";
/** The model's display name: the status line's model segment prints it. */
const STATUS = "PTYSTATUS";
/** Text typed into the input while the answer streams. */
const DRAFT = "PTYDRAFT";
const PROMPT = "Recite the synthetic streaming answer";
const CLI_ARGS = [
	"--no-session",
	"--no-extensions",
	"--no-skills",
	"--no-rules",
	"--no-lsp",
	"--no-title",
	"--no-tools",
	"--model",
	`${PROVIDER}/${MODEL_ID}`,
	PROMPT,
];
const TOKEN = /\bLEDGER-[PE]\d{3}\b/g;
const SYNC_BEGIN = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
const SYNC_MARKERS = [SYNC_BEGIN, SYNC_END];
const ERASE_SCROLLBACK = "\x1b[3J";
/** Kitty keyboard encodings; the key parser accepts them whether or not the protocol was negotiated. */
const KEY = {
	altP: "\x1b[112;3u",
	escape: "\x1b[27u",
	ctrlC: "\x1b[99;5u",
	ctrlD: "\x1b[100;5u",
};
/** The input row sits within this many rows of the bottom edge. */
const BOTTOM_BAND = 6;
/** The status line sits within this many rows of the input row. */
const STATUS_REACH = 4;
/** Paragraphs streamed at the tail before the reader scrolls up: twice a 30-row screen. */
const TAIL_STEPS = 24;
const HELD_STEPS = 4;
/** When set, the raw PTY bytes, final screen and step receipt are written here. */
const RECEIPT_DIR_ENV = "OMP_CLI_PTY_RECEIPT_DIR";

const openToken = (index: number): string => `LEDGER-P${String(index).padStart(3, "0")}`;
const closeToken = (index: number): string => `LEDGER-E${String(index).padStart(3, "0")}`;

function plain(row: string): string {
	return Bun.stripANSI(row).trimEnd();
}

function tokens(rows: readonly string[]): string[] {
	const found: string[] = [];
	for (const row of rows) for (const match of row.matchAll(TOKEN)) found.push(match[0]);
	return found;
}

function rowsWith(rows: readonly string[], text: string): number[] {
	const found: number[] = [];
	for (const [index, row] of rows.entries()) if (row.includes(text)) found.push(index);
	return found;
}

function occurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

function bufferRows(screen: VirtualTerminal): string[] {
	return screen.getScrollBuffer().map(plain);
}

/** The active grid (bottom `rows` of the buffer), wherever the reader scrolled. */
function activeGrid(screen: VirtualTerminal): string[] {
	const buffer = bufferRows(screen);
	return buffer.slice(buffer.length - screen.rows);
}

/** Native scrollback above the active grid. */
function history(screen: VirtualTerminal): string[] {
	const buffer = bufferRows(screen);
	return buffer.slice(0, buffer.length - screen.rows);
}

function sseChunk(choice: Record<string, unknown>): string {
	const chunk = { id: "chatcmpl-pty", object: "chat.completion.chunk", created: 0, model: MODEL_ID, ...choice };
	return `data: ${JSON.stringify(chunk)}\n\n`;
}

const textChunk = (content: string, first: boolean): string =>
	sseChunk({
		choices: [{ index: 0, delta: first ? { role: "assistant", content } : { content }, finish_reason: null }],
	});

const FINISH_CHUNKS =
	sseChunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
	sseChunk({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 200, total_tokens: 210 } }) +
	"data: [DONE]\n\n";

/**
 * Local OpenAI-compatible chat completions stand-in. The first completion
 * request is the CLI's prompt turn: its SSE body stays open and emits exactly
 * what the test pushes. Any later request gets a short complete reply.
 */
class ScriptedModel {
	readonly baseUrl: string;
	readonly #stop: () => void;
	mainBody: string | undefined;
	extraRequests = 0;
	cancelled = false;
	/** Called once the prompt turn's stream is open, so waiters re-check off the PTY. */
	onTurn: () => void = () => {};
	#controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	#encoder = new TextEncoder();
	#pushed = 0;

	constructor() {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			idleTimeout: 0,
			fetch: async request => {
				const url = new URL(request.url);
				if (url.pathname.endsWith("/models")) {
					return Response.json({ object: "list", data: [{ id: MODEL_ID, object: "model", owned_by: PROVIDER }] });
				}
				if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
					return new Response("not found", { status: 404 });
				}
				const body = await request.text();
				if (this.mainBody !== undefined) {
					this.extraRequests++;
					return new Response(textChunk("ok", true) + FINISH_CHUNKS, {
						headers: { "content-type": "text/event-stream" },
					});
				}
				this.mainBody = body;
				queueMicrotask(() => this.onTurn());
				const stream = new ReadableStream<Uint8Array>({
					start: controller => {
						this.#controller = controller;
					},
					cancel: () => {
						this.cancelled = true;
					},
				});
				return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
			},
		});
		this.baseUrl = `http://127.0.0.1:${server.port}/v1`;
		this.#stop = () => server.stop(true);
	}

	get turnStarted(): boolean {
		return this.#controller !== undefined;
	}

	/** Emit one content delta on the open prompt turn. */
	push(content: string): void {
		this.#send(textChunk(content, this.#pushed === 0));
		this.#pushed++;
	}

	/** Emit the last delta, then end the turn. */
	finish(content: string): void {
		this.#send(textChunk(content, this.#pushed === 0) + FINISH_CHUNKS);
		this.#controller?.close();
		this.#controller = undefined;
	}

	dispose(): void {
		try {
			this.#controller?.close();
		} catch {
			// Already closed or cancelled by the client.
		}
		this.#controller = undefined;
		this.#stop();
	}

	#send(data: string): void {
		if (!this.#controller) throw new Error("no open prompt turn");
		if (this.cancelled) throw new Error("the CLI cancelled the prompt turn");
		this.#controller.enqueue(this.#encoder.encode(data));
	}
}

function cliEnv(root: TempDir, agentDir: string): Record<string, string> {
	// The PTY child inherits this process's environment: blank every marker that
	// would route rendering down a multiplexer, Warp, TSP or headless test path,
	// and pin config, home and network to the sandbox.
	const env: Record<string, string> = {};
	for (const key of TERMINAL_MULTIPLEXER_ENV_KEYS) env[key] = "";
	const home = root.join("home");
	// Hermetic: anything not bound for the loopback stand-in dies on a dead proxy.
	const deadProxy = "http://127.0.0.1:9";
	return {
		...env,
		TERM: "xterm-256color",
		COLORTERM: "truecolor",
		TERM_PROGRAM: "",
		PI_TUI_RESIZE_IN_PLACE: "",
		PI_TUI_NATIVE: "0",
		OMP_TUI_NATIVE: "0",
		PI_TUI_SYNC_OUTPUT: "1",
		PI_NO_SYNC_OUTPUT: "",
		PI_TEST_RUNTIME: "",
		BUN_ENV: "",
		NODE_ENV: "",
		OMP_TUI_DEBUG: "",
		HOME: home,
		USERPROFILE: home,
		XDG_CONFIG_HOME: root.join("config"),
		XDG_DATA_HOME: root.join("data"),
		XDG_CACHE_HOME: root.join("cache"),
		XDG_STATE_HOME: root.join("state"),
		PI_CODING_AGENT_DIR: agentDir,
		PI_CONFIG_DIR: "",
		OMP_PROFILE: "",
		PI_PROFILE: "",
		PI_NO_TITLE: "1",
		HTTP_PROXY: deadProxy,
		HTTPS_PROXY: deadProxy,
		http_proxy: deadProxy,
		https_proxy: deadProxy,
		NO_PROXY: "127.0.0.1,localhost",
		no_proxy: "127.0.0.1,localhost",
		AWS_EC2_METADATA_DISABLED: "true",
	};
}

interface PtyCliOptions {
	cwd: string;
	env: Record<string, string>;
	columns: number;
	rows: number;
}

/** `omp` on a native PTY, rendered into a kitty VT engine that plays the terminal. */
class PtyCli {
	readonly screen: VirtualTerminal;
	readonly exited: Promise<PtyRunResult | undefined>;
	readonly errors: Error[] = [];
	readonly raw: string[] = [];
	/** Synchronized-update frames the app completed. */
	frames = 0;
	#pty = new PtySession();
	#syncCarry = "";
	#inFrame = false;
	#pending = "";
	#lastChunkAt = performance.now();
	#waiters = new Set<() => void>();
	#running = true;
	#closing = false;

	constructor(options: PtyCliOptions) {
		this.screen = new VirtualTerminal(options.columns, options.rows, 10_000);
		// The engine answers the app's DA/DECRQM/CPR/kitty-keyboard probes back down the PTY.
		this.screen.start(
			reply => {
				if (this.#running) this.#pty.write(reply);
			},
			() => {},
		);
		this.exited = this.#pty
			.startArgv(
				{
					application: process.execPath,
					args: [CLI_ENTRY, ...CLI_ARGS],
					cwd: options.cwd,
					env: options.env,
					cols: options.columns,
					rows: options.rows,
					timeoutMs: 170_000,
				},
				(error, chunk) => {
					if (error) this.errors.push(error);
					else this.#receive(chunk);
					for (const check of this.#waiters) check();
				},
			)
			.then(
				result => {
					if (!this.#closing) {
						this.errors.push(new Error(`omp exited mid-scenario: ${JSON.stringify(result)}\n${this.dump()}`));
					}
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
		this.raw.push(chunk);
		this.#pending += chunk;
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
		this.frames += occurrences(data, SYNC_END);
		const begin = data.lastIndexOf(SYNC_BEGIN);
		const end = data.lastIndexOf(SYNC_END);
		if (begin > end) this.#inFrame = true;
		else if (end > begin) this.#inFrame = false;
		this.screen.write(data);
	}

	/**
	 * Resolve once `done()` holds on a completed frame, re-checked on every chunk
	 * the app writes and on {@link recheck} for state that changes off the PTY.
	 * The timer only bounds a failure: the app is a separate process on the real
	 * clock, so a hung scenario must end with the screen it stopped on.
	 */
	async waitFor(done: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const check = (): void => {
			if (this.errors.length > 0) {
				reject(this.errors[0]);
				return;
			}
			if (this.#inFrame) return;
			try {
				if (done()) resolve();
			} catch (error) {
				reject(error);
			}
		};
		const timer = setTimeout(() => {
			reject(new Error(`${label}: timed out after ${timeoutMs} ms\n${this.dump()}`));
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

	/** Re-run the pending {@link waitFor} check after a change the PTY does not report. */
	recheck(): void {
		for (const check of this.#waiters) check();
	}

	/**
	 * Resolve once the app has written nothing for `ms`, bounded by `timeoutMs`.
	 * Only used once the turn is idle: a resize settles in the separate process
	 * with no completion signal, so an output-idle window on the real clock is
	 * the only test that its rebuild finished.
	 */
	async quiet(ms: number, label: string, timeoutMs = 10_000): Promise<void> {
		const deadline = performance.now() + timeoutMs;
		for (;;) {
			if (this.errors.length > 0) throw this.errors[0];
			const idle = ms - (performance.now() - this.#lastChunkAt);
			if (idle <= 0 && !this.#inFrame) return;
			if (performance.now() > deadline) throw new Error(`${label}: output never settled\n${this.dump()}`);
			await Bun.sleep(Math.max(idle, 10));
		}
	}

	send(data: string): void {
		this.#pty.write(data);
	}

	/** Resize the window the way a terminal does: grid first, then SIGWINCH. */
	resize(columns: number, rows: number): void {
		this.screen.resize(columns, rows);
		this.#pty.resize(columns, rows);
	}

	/** Everything the app wrote since the previous call. */
	take(): string {
		const output = this.#pending;
		this.#pending = "";
		return output;
	}

	dump(): string {
		const cursor = this.screen.getCursor();
		const position = this.screen.getBufferPosition();
		const grid = activeGrid(this.screen).map((row, index) => `${String(index).padStart(2)}|${row}`);
		return [`cursor ${cursor.row}:${cursor.col} baseY ${position.baseY} viewportY ${position.viewportY}`, ...grid].join(
			"\n",
		);
	}

	/** Ask the app to exit (clear the input, then Ctrl+D); kill it if it has not within 5 s. */
	async close(): Promise<void> {
		this.#closing = true;
		if (this.#running) {
			try {
				this.#pty.write(KEY.ctrlC);
				this.#pty.write(KEY.ctrlD);
			} catch {
				// The child exited between the check and the write.
			}
			const grace = Promise.withResolvers<void>();
			const timer = setTimeout(grace.resolve, 5000);
			await Promise.race([this.exited, grace.promise]);
			clearTimeout(timer);
			if (this.#running) this.#pty.kill();
		}
		await this.exited;
	}
}

function ledgerProblem(actual: readonly string[], expected: readonly string[]): string | undefined {
	if (Bun.deepEquals(actual, expected)) return undefined;
	let at = 0;
	while (at < actual.length && at < expected.length && actual[at] === expected[at]) at++;
	const got = JSON.stringify(actual.slice(at, at + 4));
	const want = JSON.stringify(expected.slice(at, at + 4));
	return `ledger diverges at ${at}: got ${got}, want ${want} (${actual.length} vs ${expected.length} tokens)`;
}

/**
 * The bottom-anchored chat contract, read from what the terminal shows: every
 * answer token exactly once and in order across native scrollback and the
 * grid; one input row at the bottom with the cursor on it and the status line
 * beside it; no transcript row under that chrome; and, while following, the
 * newest token on the live grid.
 */
function surfaceProblems(screen: VirtualTerminal, expected: readonly string[], newest: string | undefined): string[] {
	const problems: string[] = [];
	const buffer = bufferRows(screen);
	const grid = buffer.slice(buffer.length - screen.rows);
	const ledger = ledgerProblem(tokens(buffer), expected);
	if (ledger) problems.push(ledger);
	const inputCopies = buffer.filter(row => row.includes(DRAFT)).length;
	if (inputCopies !== 1) problems.push(`${inputCopies} copies of the input in the buffer`);
	const inputRows = rowsWith(grid, DRAFT);
	if (inputRows.length === 1) {
		const inputRow = inputRows[0]!;
		if (inputRow < screen.rows - BOTTOM_BAND) {
			problems.push(`input row ${inputRow} is not at the bottom of ${screen.rows}`);
		}
		const cursor = screen.getCursor();
		if (cursor.row !== inputRow) problems.push(`cursor row ${cursor.row} is off the input row ${inputRow}`);
		const statusRow = rowsWith(grid, STATUS).findLast(row => Math.abs(row - inputRow) <= STATUS_REACH);
		if (statusRow === undefined) problems.push(`no status line within ${STATUS_REACH} rows of the input`);
		const chromeTop = Math.min(inputRow, statusRow ?? inputRow);
		const lowestToken = grid.findLastIndex(row => tokens([row]).length > 0);
		if (lowestToken >= chromeTop) problems.push(`transcript row ${lowestToken} overlaps the chrome at ${chromeTop}`);
	} else {
		problems.push(`input on grid rows ${JSON.stringify(inputRows)}`);
	}
	if (newest !== undefined && !grid.some(row => row.includes(newest))) {
		problems.push(`${newest} is not on the live grid`);
	}
	return problems;
}

interface StepReceipt {
	label: string;
	size: string;
	bytes: number;
	eraseScrollback: number;
}

describe.skipIf(process.platform === "win32")("omp CLI streaming on a real PTY (t-d6c9e119)", () => {
	it("keeps a long streamed answer ordered and reachable under a bottom input through scrollback, a picker and resizes", async () => {
		const root = TempDir.createSync("@omp-cli-streaming-pty-");
		const model = new ScriptedModel();
		const agentDir = root.join("agent");
		const workspace = root.join("work");
		const steps: StepReceipt[] = [];
		const expected: string[] = [];
		let cli: PtyCli | undefined;
		let failure: string | undefined;
		try {
			await Bun.write(
				path.join(agentDir, "models.yml"),
				[
					"providers:",
					`  ${PROVIDER}:`,
					`    baseUrl: ${model.baseUrl}`,
					"    auth: none",
					"    api: openai-completions",
					"    models:",
					`      - id: ${MODEL_ID}`,
					`        name: ${STATUS}`,
					"        reasoning: false",
					"",
				].join("\n"),
			);
			await fs.mkdir(workspace, { recursive: true });
			await fs.mkdir(root.join("home"), { recursive: true });
			const app = new PtyCli({ cwd: workspace, env: cliEnv(root, agentDir), columns: 100, rows: 30 });
			cli = app;
			const { screen } = app;
			model.onTurn = () => app.recheck();

			let next = 0;
			/** Close the open paragraph and open the next one in one delta; returns the token the live grid must show. */
			const advance = (): string => {
				let delta = "";
				if (next > 0) {
					delta += ` ${closeToken(next - 1)}\n\n`;
					expected.push(closeToken(next - 1));
				}
				delta += `${openToken(next)} streamed answer paragraph`;
				expected.push(openToken(next));
				model.push(delta);
				next++;
				return openToken(next - 1);
			};
			const record = (label: string, bytes: string): StepReceipt => {
				const step = {
					label,
					size: `${screen.columns}x${screen.rows}`,
					bytes: bytes.length,
					eraseScrollback: occurrences(bytes, ERASE_SCROLLBACK),
				};
				steps.push(step);
				return step;
			};
			/** Stream one delta and check the first complete frame that shows it. */
			const strictStep = async (label: string): Promise<void> => {
				app.take();
				const newest = advance();
				await app.waitFor(() => activeGrid(screen).some(row => row.includes(newest)), label);
				const step = record(label, app.take());
				expect(surfaceProblems(screen, expected, newest), label).toEqual([]);
				expect(step.eraseScrollback, `${label}: scrollback erased by an ordinary update`).toBe(0);
			};
			/** Stream one delta and wait for the surface to settle on the contract (a resize may still be settling). */
			const settledStep = async (label: string): Promise<void> => {
				app.take();
				const newest = advance();
				await app.waitFor(() => surfaceProblems(screen, expected, newest).length === 0, label);
				record(label, app.take());
			};

			// The CLI dispatches its prompt to the stand-in after startup: the request is the readiness handshake.
			await app.waitFor(() => model.turnStarted, "prompt turn reaches the local model", 90_000);
			expect(model.mainBody).toContain(PROMPT);
			app.take();
			const first = advance();
			await app.waitFor(() => activeGrid(screen).some(row => row.includes(first)), "first delta paints");
			record("first delta", app.take());

			// Type into the input while the answer streams.
			app.send(DRAFT);
			await app.waitFor(() => surfaceProblems(screen, expected, first).length === 0, "input draft paints");
			record("draft typed", app.take());

			for (let step = 1; step <= TAIL_STEPS; step++) await strictStep(`tail ${step}`);
			// The answer outgrew the screen: its head is reachable only through native scrollback.
			expect(tokens(history(screen))).toContain(openToken(0));
			expect(tokens(activeGrid(screen))).not.toContain(openToken(0));

			// A reader scrolls up into native history while the rest of the answer arrives.
			const shift = screen.rows - 8;
			expect(screen.getBufferPosition().baseY).toBeGreaterThanOrEqual(shift);
			screen.scrollLines(-shift);
			const held = screen.getViewport().map(plain);
			const heldAt = screen.getBufferPosition().viewportY;
			expect(tokens(held).length).toBeGreaterThan(0);
			for (let step = 1; step <= HELD_STEPS; step++) {
				const label = `scrolled up ${step}`;
				await strictStep(label);
				expect(screen.getViewport().map(plain), `${label}: reader viewport`).toEqual(held);
				expect(screen.getBufferPosition().viewportY, `${label}: reader offset`).toBe(heldAt);
			}

			// Back at the tail, the view follows the stream again.
			screen.scrollLines(screen.getBufferPosition().baseY);
			await strictStep("back at tail");
			expect(screen.isNativeViewportAtBottom()).toBe(true);
			expect(screen.getViewport().map(plain).some(row => row.includes(expected.at(-1)!))).toBe(true);

			// A real selector overlay (Alt+P model picker) opens over the input mid-stream.
			const historyBefore = tokens(history(screen));
			app.take();
			app.send(KEY.altP);
			await app.waitFor(() => {
				const grid = activeGrid(screen);
				return rowsWith(grid, DRAFT).length === 0 || rowsWith(grid, MODEL_ID).length > 0;
			}, "model picker opens");
			record("picker opens", app.take());
			const covered = tokens(bufferRows(screen));
			expect(new Set(covered).size, "picker: duplicated answer rows").toBe(covered.length);
			expect(covered, "picker: answer rows moved").toEqual(expected.filter(token => covered.includes(token)));
			expect(tokens(history(screen)).slice(0, historyBefore.length), "picker: native history").toEqual(historyBefore);
			// More of the answer arrives under the picker; closing it must reveal all of it once.
			const underPicker = advance();
			app.send(KEY.escape);
			await app.waitFor(
				() =>
					rowsWith(activeGrid(screen), MODEL_ID).length === 0 &&
					surfaceProblems(screen, expected, underPicker).length === 0,
				"model picker closes",
			);
			record("picker closes", app.take());
			await strictStep("after picker");

			// The window shrinks mid-stream; the surface must settle on the contract while deltas keep coming.
			app.resize(84, 24);
			await settledStep("84x24 stream 1");
			await settledStep("84x24 stream 2");

			// The turn ends with the last paragraph closed.
			app.take();
			const last = closeToken(next - 1);
			expected.push(last);
			model.finish(` ${last}`);
			await app.waitFor(() => surfaceProblems(screen, expected, last).length === 0, "turn completes");
			await app.quiet(400, "turn completes");
			record("turn completes", app.take());
			expect(surfaceProblems(screen, expected, last), "idle after the turn").toEqual([]);

			// The window grows back out once the turn is idle.
			app.resize(110, 34);
			await app.waitFor(() => surfaceProblems(screen, expected, last).length === 0, "110x34 resize");
			await app.quiet(400, "110x34 resize");
			record("110x34 settled", app.take());
			expect(surfaceProblems(screen, expected, last), "110x34 settled").toEqual([]);
			// Harness validity: the readiness gate saw real synchronized frames.
			expect(app.frames).toBeGreaterThan(0);
		} catch (error) {
			failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
			throw error;
		} finally {
			const receiptDir = process.env[RECEIPT_DIR_ENV];
			if (cli && receiptDir) {
				const { screen } = cli;
				await Bun.write(path.join(receiptDir, "cli-streaming-pty.raw"), cli.raw.join(""));
				await Bun.write(
					path.join(receiptDir, "cli-streaming-pty.screen.txt"),
					[cli.dump(), "", "---- native scrollback + grid ----", ...bufferRows(screen)].join("\n"),
				);
				await Bun.write(
					path.join(receiptDir, "cli-streaming-pty.json"),
					JSON.stringify(
						{
							command: ["bun", "packages/coding-agent/src/cli.ts", ...CLI_ARGS],
							size: `${screen.columns}x${screen.rows}`,
							frames: cli.frames,
							rawBytes: cli.raw.reduce((total, chunk) => total + chunk.length, 0),
							answerTokens: expected.length,
							extraModelRequests: model.extraRequests,
							steps,
							failure,
						},
						null,
						"\t",
					),
				);
			}
			try {
				await cli?.close();
			} finally {
				model.dispose();
				await root.remove();
			}
		}
	}, 180_000);
});
