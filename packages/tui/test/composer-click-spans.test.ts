import { beforeAll, describe, expect, it } from "bun:test";
import { Container, type Component } from "@oh-my-pi/pi-tui";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { VirtualTerminal } from "./virtual-terminal";

beforeAll(async () => {
	await initTheme();
});

class ClickableBlock implements Component {
	constructor(
		private readonly rows: readonly string[],
		private readonly ids: readonly string[],
	) {}
	render(): readonly string[] {
		return this.rows;
	}
	getClickAgentAtRow(_row: number): string | undefined {
		return this.ids[0];
	}
}

function startComposer() {
	const terminal = new VirtualTerminal(80, 24);
	const composer = new Composer({ terminal, preferences: { ...COMPOSER_DEFAULTS, quiet: true } });
	composer.start();
	return composer;
}

describe("Composer below-transcript click spans", () => {
	it("records candidates for a clickable root rendered below the transcript", () => {
		const composer = startComposer();
		try {
			composer.setRuntimeChildren([new TranscriptContainer(), new ClickableBlock(["row-a", "row-b"], ["AgentX"])]);
			const frame = composer.renderFrame({ columns: 80, rows: 24 });
			const index = frame.viewport.findIndex(line => Bun.stripANSI(line).includes("row-a"));
			expect(index).toBeGreaterThanOrEqual(0);
			expect(composer.viewportClickCandidates(index)).toEqual(["AgentX"]);
			expect(composer.viewportClickCandidates(index + 1)).toEqual(["AgentX"]);
			const plainRow = frame.viewport.findIndex(line => Bun.stripANSI(line).includes("row-b"));
			expect(composer.viewportClickCandidates(plainRow + 5)).toEqual([]);
		} finally {
			composer.stop();
		}
	});

	it("tiles candidates for children of a plain container root", () => {
		const composer = startComposer();
		try {
			const container = new Container();
			container.addChild(new ClickableBlock(["kid-a"], ["KidA"]));
			container.addChild(new ClickableBlock(["kid-b"], ["KidB"]));
			composer.setRuntimeChildren([new TranscriptContainer(), container]);
			const frame = composer.renderFrame({ columns: 80, rows: 24 });
			const a = frame.viewport.findIndex(line => Bun.stripANSI(line).includes("kid-a"));
			const b = frame.viewport.findIndex(line => Bun.stripANSI(line).includes("kid-b"));
			expect(composer.viewportClickCandidates(a)).toEqual(["KidA"]);
			expect(composer.viewportClickCandidates(b)).toEqual(["KidB"]);
		} finally {
			composer.stop();
		}
	});
});
