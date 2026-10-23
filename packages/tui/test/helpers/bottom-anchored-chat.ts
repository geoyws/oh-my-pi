import { Container, type TuiPaint } from "@oh-my-pi/pi-tui";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { VirtualRenderScheduler } from "../virtual-render-scheduler";
import { VirtualTerminal } from "../virtual-terminal";
import { changedRows, EditorStub, LineBlock, plain, RowsBlock, StatusLine, scanTerminalBytes } from "./chat-surface";

// In-process rig for the bottom-anchored chat regressions: a real Composer
// over the kitty VT engine, plus what a reader of that terminal sees
// (scrollback ledger, active grid, painted frame vs. screen) and per-step
// measurements of what the renderer sent.

/** Every `pattern` match across native scrollback plus the active grid, top to bottom. */
export function ledger(terminal: VirtualTerminal, pattern: RegExp): string[] {
	const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
	const found: string[] = [];
	for (const row of terminal.getScrollBuffer()) {
		for (const match of plain(row).matchAll(global)) found.push(match[0]);
	}
	return found;
}

/** The active grid (bottom `rows` of the buffer), independent of where the reader scrolled. */
export function activeGrid(terminal: VirtualTerminal): string[] {
	const buffer = terminal.getScrollBuffer();
	return buffer.slice(buffer.length - terminal.rows).map(plain);
}

/**
 * Whether the screen shows exactly what the last paint said it painted: the
 * painted rows sit as one contiguous block and only blanks follow it.
 */
export function screenShowsPaint(paint: TuiPaint, grid: readonly string[]): boolean {
	const painted = paint.viewport.map(plain);
	for (let top = grid.length - painted.length; top >= 0; top--) {
		if (painted.every((row, index) => grid[top + index] === row)) {
			return grid.slice(top + painted.length).every(row => row === "");
		}
	}
	return false;
}

/** VirtualTerminal that keeps every raw write and the wall time the VT engine spent parsing them. */
export class RecordingTerminal extends VirtualTerminal {
	writes: string[] = [];
	engineMs = 0;

	override write(data: string): void {
		this.writes.push(data);
		const started = Bun.nanoseconds();
		super.write(data);
		this.engineMs += (Bun.nanoseconds() - started) / 1e6;
	}

	takeWrites(): string[] {
		const writes = this.writes;
		this.writes = [];
		return writes;
	}
}

export interface ChatRig {
	terminal: RecordingTerminal;
	scheduler: VirtualRenderScheduler;
	composer: Composer;
	transcript: TranscriptContainer;
	/** Turn chrome between transcript and status (todo/subagent HUD, extension widget). */
	hud: RowsBlock;
	status: StatusLine;
	/** Rows a multi-line draft or inline dialog adds to the editor surface. */
	draft: RowsBlock;
	paints: TuiPaint[];
	/** Composer frame compositions the TUI requested. */
	renderCalls: () => number;
	/** Append finalized transcript lines continuing the rig's numbered ledger. */
	addLines: (count: number) => void;
	/** Every line `addLines` produced, in order. */
	emitted: string[];
}

export interface ChatRigOptions {
	columns: number;
	rows: number;
	/** Native scrollback line cap (default 10 000, so nothing is evicted). */
	scrollback?: number;
	/** Finalized lines in the transcript before the first paint. */
	settled: number;
	/** Ledger token prefix; tokens are `${prefix}${4-digit index}`. */
	prefix: string;
	/** Lines written to the terminal before the composer starts, scrolled into native history. */
	shell?: readonly string[];
}

/**
 * Composer chat surface: transcript, HUD, a one-line status and the editor at
 * the bottom (its draft rows above the input), prefilled with `settled`
 * finalized lines.
 */
export function createChatRig(options: ChatRigOptions): ChatRig {
	const terminal = new RecordingTerminal(options.columns, options.rows, options.scrollback ?? 10_000);
	if (options.shell !== undefined && options.shell.length > 0) {
		terminal.write(`${options.shell.join("\r\n")}${"\r\n".repeat(options.rows + 1)}`);
	}
	const scheduler = new VirtualRenderScheduler();
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { ...COMPOSER_DEFAULTS, quiet: true },
	});
	const transcript = new TranscriptContainer();
	const hud = new RowsBlock("HUD");
	const status = new StatusLine();
	const draft = new RowsBlock("DRAFT");
	const editor = new Container();
	editor.addChild(draft);
	editor.addChild(new EditorStub());
	composer.setRuntimeChildren([transcript, hud, status, editor]);
	const paints: TuiPaint[] = [];
	composer.ui.addPaintListener(paint => {
		paints.push(paint);
	});
	let renderCalls = 0;
	const renderFrame = composer.renderFrame.bind(composer);
	composer.renderFrame = viewport => {
		renderCalls++;
		return renderFrame(viewport);
	};
	const emitted: string[] = [];
	const addLines = (count: number): void => {
		for (let index = 0; index < count; index++) {
			const line = `${options.prefix}${String(emitted.length).padStart(4, "0")}`;
			emitted.push(line);
			transcript.addChild(new LineBlock(line));
		}
	};
	addLines(options.settled);
	composer.start({ playWelcomeIntro: false });
	return {
		terminal,
		scheduler,
		composer,
		transcript,
		hud,
		status,
		draft,
		paints,
		renderCalls: () => renderCalls,
		addLines,
		emitted,
	};
}

export interface StepMetrics {
	/** `terminal.write` calls. */
	writes: number;
	bytes: number;
	/** Row visits that wrote cells; see `scanTerminalBytes`. */
	rowWrites: number;
	/** Rows the step's paints committed to native scrollback. */
	historyRows: number;
	/** Rows the grid scrolled into native scrollback. */
	scrolled: number;
	/** Rows no pure scroll could have produced: the minimum any renderer must write. */
	changedRows: number;
	eraseScrollback: number;
	writesOutsideSync: number;
	paints: number;
	renderCalls: number;
	/** Wall time of the step minus the time the VT engine spent parsing its bytes. */
	frameworkMs: number;
}

/** Run `mutate`, settle every frame it owes, and measure what reached the terminal. */
export async function measureStep(rig: ChatRig, mutate: () => void): Promise<StepMetrics> {
	const { terminal, scheduler, composer } = rig;
	terminal.takeWrites();
	const before = activeGrid(terminal);
	const baseBefore = terminal.getBufferPosition().baseY;
	const paintsBefore = rig.paints.length;
	const callsBefore = rig.renderCalls();
	const engineBefore = terminal.engineMs;
	const started = Bun.nanoseconds();
	mutate();
	composer.ui.requestRender();
	await scheduler.settle(terminal);
	const wallMs = (Bun.nanoseconds() - started) / 1e6;
	const writes = terminal.takeWrites();
	const data = writes.join("");
	const scan = scanTerminalBytes(data, terminal.rows);
	const scrolled = terminal.getBufferPosition().baseY - baseBefore;
	const paints = rig.paints.slice(paintsBefore);
	return {
		writes: writes.length,
		bytes: Buffer.byteLength(data),
		rowWrites: scan.rowWrites,
		historyRows: paints.reduce((sum, paint) => sum + paint.history.length, 0),
		scrolled,
		changedRows: changedRows(before, activeGrid(terminal), scrolled),
		eraseScrollback: scan.eraseScrollback,
		writesOutsideSync: scan.writesOutsideSync,
		paints: paints.length,
		renderCalls: rig.renderCalls() - callsBefore,
		frameworkMs: wallMs - (terminal.engineMs - engineBefore),
	};
}

export interface StreamWorkload {
	columns: number;
	rows: number;
	/** Finalized lines already in the transcript (more than a screen). */
	settled: number;
	steps: number;
	/** Finalized lines each step appends. */
	linesPerStep: number;
}

/** The representative stream: a full screen over settled history, one finalized line per step, ticking status. */
export const STREAM_WORKLOAD: StreamWorkload = { columns: 100, rows: 30, settled: 60, steps: 120, linesPerStep: 1 };

/**
 * Drive `workload` through a real Composer into the VT engine and return
 * per-step measurements. Deterministic: virtual clock, fixed content, no
 * wall-clock waits; only `frameworkMs` varies between runs.
 */
export async function runStreamWorkload(
	workload: StreamWorkload = STREAM_WORKLOAD,
): Promise<{ rig: ChatRig; steps: StepMetrics[] }> {
	const rig = createChatRig({
		columns: workload.columns,
		rows: workload.rows,
		settled: workload.settled,
		prefix: "QZE",
	});
	rig.hud.rows = 2;
	await rig.scheduler.settle(rig.terminal);
	const steps: StepMetrics[] = [];
	for (let step = 0; step < workload.steps; step++) {
		steps.push(
			await measureStep(rig, () => {
				rig.addLines(workload.linesPerStep);
				rig.status.text = `Working step ${step}`;
			}),
		);
	}
	return { rig, steps };
}
