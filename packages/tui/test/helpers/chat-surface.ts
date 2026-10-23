import { type Component, CURSOR_MARKER } from "@oh-my-pi/pi-tui";

// VT-free pieces of the bottom-anchored chat scenarios, shared by the
// in-process regressions and the real-PTY fixture process: the transcript and
// chrome blocks the scenarios drive, and the raw-byte oracles. The byte oracles
// read what the renderer sent, because the VT engine strips DEC 2026 markers
// before it parses a frame.

export const EDITOR_TEXT = "EDITOR-BOTTOM";

const APC_SEQUENCE = /\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** Plain text of a terminal row: no SGR, no cursor marker, no trailing blanks. */
export function plain(row: string): string {
	return Bun.stripANSI(row.replace(APC_SEQUENCE, "")).trimEnd();
}

/** Indices of `grid` rows that contain `text`. */
export function rowsContaining(grid: readonly string[], text: string): number[] {
	const rows: number[] = [];
	for (let index = 0; index < grid.length; index++) if (grid[index]!.includes(text)) rows.push(index);
	return rows;
}

/**
 * Rows of `after` a pure scroll by `scrolled` rows could not have produced
 * from `before`: the minimum set of rows any renderer had to write.
 */
export function changedRows(before: readonly string[], after: readonly string[], scrolled: number): number {
	let changed = 0;
	for (let index = 0; index < after.length; index++) {
		if (after[index] !== (before[index + scrolled] ?? "")) changed++;
	}
	return changed;
}

export interface ByteScan {
	/** Row visits that wrote cells (text, EL, ECH, ICH/DCH, IL/DL); one per cursor arrival on a row. */
	rowWrites: number;
	/** Cell-writing bytes emitted outside a DEC 2026 synchronized-output bracket. */
	writesOutsideSync: number;
	/** ED3 (erase saved lines) sequences. */
	eraseScrollback: number;
}

/**
 * Scan raw terminal output the way a VT parser walks it, counting how many
 * row visits wrote cells. Absolute and relative cursor moves, LF/IND/NEL/RI
 * and DECSC/DECRC start a new visit; text and in-line erases count the visit
 * once. Independent of how a renderer addresses rows (CUP diffs, LF runs,
 * scrolls), so it measures redraw work rather than one encoding of it.
 */
export function scanTerminalBytes(data: string, height: number): ByteScan {
	let row = 0;
	let saved = 0;
	let printed = false;
	let synchronized = false;
	const scan: ByteScan = { rowWrites: 0, writesOutsideSync: 0, eraseScrollback: 0 };
	const moveTo = (next: number): void => {
		row = Math.max(0, Math.min(height - 1, next));
		printed = false;
	};
	const touch = (): void => {
		if (!printed) {
			scan.rowWrites++;
			printed = true;
		}
		if (!synchronized) scan.writesOutsideSync++;
	};
	let index = 0;
	while (index < data.length) {
		const code = data.charCodeAt(index);
		if (code === 0x1b) {
			const next = data[index + 1];
			if (next === "[") {
				let end = index + 2;
				while (end < data.length && data.charCodeAt(end) >= 0x20 && data.charCodeAt(end) <= 0x3f) end++;
				const body = data.slice(index + 2, end);
				const final = data[end];
				index = end + 1;
				if (body.startsWith("?")) {
					if (body === "?2026" && final === "h") synchronized = true;
					else if (body === "?2026" && final === "l") synchronized = false;
					continue;
				}
				if (/^[<>=]/.test(body)) continue;
				const first = Number.parseInt(body.split(";")[0] ?? "", 10);
				const count = Number.isFinite(first) && first > 0 ? first : 1;
				switch (final) {
					case "H":
					case "f":
					case "d":
						moveTo(count - 1);
						break;
					case "A":
					case "F":
						moveTo(row - count);
						break;
					case "B":
					case "E":
					case "e":
						moveTo(row + count);
						break;
					case "K":
					case "X":
					case "@":
					case "P":
					case "L":
					case "M":
						touch();
						break;
					case "J":
						if (body === "3") scan.eraseScrollback++;
						break;
				}
				continue;
			}
			if (next === "]" || next === "P" || next === "_" || next === "^" || next === "X") {
				let end = index + 2;
				while (end < data.length) {
					if (data[end] === "\x07") {
						end++;
						break;
					}
					if (data[end] === "\x1b" && data[end + 1] === "\\") {
						end += 2;
						break;
					}
					end++;
				}
				index = end;
				continue;
			}
			if (next !== undefined && "()*+-./#%".includes(next)) {
				index += 3;
				continue;
			}
			if (next === "7") saved = row;
			else if (next === "8") moveTo(saved);
			else if (next === "M") moveTo(row - 1);
			else if (next === "D" || next === "E") moveTo(row + 1);
			index += 2;
			continue;
		}
		if (code === 0x0a || code === 0x0b || code === 0x0c) moveTo(row + 1);
		else if (code >= 0x20 && code !== 0x7f) touch();
		index++;
	}
	return scan;
}

/** A finalized one-row transcript block (a settled message or tool result line). */
export class LineBlock implements Component {
	readonly #rows: readonly string[];
	constructor(text: string) {
		this.#rows = [text];
	}
	render(): readonly string[] {
		return this.#rows;
	}
}

/** Chrome, panel or tool output whose height a scenario drives; a transcript block stays unfinalized while `live`. */
export class RowsBlock implements Component {
	#rows: readonly string[] = [];
	#count = 0;
	live: boolean;
	readonly label: string;
	constructor(label: string, count = 0, live = false) {
		this.label = label;
		this.live = live;
		this.rows = count;
	}
	get rows(): number {
		return this.#count;
	}
	set rows(count: number) {
		this.#count = count;
		this.#rows = Array.from({ length: count }, (_, index) => `${this.label}-${index}`);
	}
	isTranscriptBlockFinalized(): boolean {
		return !this.live;
	}
	render(): readonly string[] {
		return this.#rows;
	}
}

/** One-line status whose text changes per step (spinner, token counter). */
export class StatusLine implements Component {
	#rows: readonly string[] = ["Working"];
	set text(value: string) {
		this.#rows = [value];
	}
	render(): readonly string[] {
		return this.#rows;
	}
}

/** Editor surface with the hardware cursor on its input row and a fixed last row. */
export class EditorStub implements Component {
	readonly #rows = ["EDITOR-TOP", `input${CURSOR_MARKER}`, EDITOR_TEXT];
	render(): readonly string[] {
		return this.#rows;
	}
}
