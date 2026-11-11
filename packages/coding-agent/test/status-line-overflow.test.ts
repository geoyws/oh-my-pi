import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line";
import { statusLineHost } from "@oh-my-pi/pi-coding-agent/modes/status-line-host";
import type { SegmentContext } from "@oh-my-pi/pi-tui/status-line/segments";
import type { StatusLineSegmentId } from "@oh-my-pi/pi-tui/status-line/schema";
import { renderSegment } from "@oh-my-pi/pi-tui/status-line/segments";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { getSessionAccentAnsi, getSessionAccentHex } from "@oh-my-pi/pi-tui/theme/session-color";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";
import { StatusLineTestComponents } from "./helpers/status-line";

const originalProjectDir = getProjectDir();
const statusLines = new StatusLineTestComponents();

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	statusLines.dispose();
	resetSettingsForTest();
	setProjectDir(originalProjectDir);
});

/** Minimal SegmentContext factory — only path/git fields matter for these tests. */
function createCtx(overrides?: {
	pathMaxLength?: number;
	branch?: string | null;
	sessionName?: string;
	sessionAccent?: boolean;
	previewTitle?: string;
}): SegmentContext {
	const hasName = overrides?.sessionName !== undefined;
	return {
		session: {
			state: {},
			isFastModeEnabled: () => false,
			modelRegistry: { isUsingOAuth: () => false },
			sessionManager: hasName ? { getSessionName: () => overrides.sessionName } : undefined,
		} as unknown as SegmentContext["session"],
		sessionAccent: overrides?.sessionAccent,
		previewTitle: overrides?.previewTitle,
		width: 120,
		compactThinkingLevel: false,
		options: {
			path: {
				abbreviate: false,
				maxLength: overrides?.pathMaxLength ?? 40,
				stripWorkPrefix: false,
			},
		},
		planMode: null,
		loopMode: null,
		prewalk: null,
		goalMode: null,
		vibeMode: null,
		vim: null,
		collab: null,
		stream: null,
		recording: false,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			orchestrationInput: 0,
			orchestrationOutput: 0,
			orchestrationCacheRead: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: null,
		},
		contextPercent: 0,
		contextTokens: 0,
		contextWindow: 0,
		autoCompactEnabled: false,
		compactionSpeculation: "idle",
		speculationBlinkOn: true,
		subagentCount: 0,
		activeMs: 0,
		turnElapsedMs: null,
		activeRepo: null,
		worktree: null,
		git: {
			branch: overrides?.branch ?? null,
			status: null,
			pr: null,
		},
		usage: null,
	};
}

function createStatusLineSession(sessionName: string, modelName?: string) {
	const model = modelName ? { name: modelName, contextWindow: 128000 } : undefined;
	return {
		state: { messages: [], model },
		messages: [],
		model: model ?? { contextWindow: 128000 },
		contextUsageRevision: 0,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		isStreaming: false,
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		isAdvisorActive: () => false,
		getAdvisorStatusOverview: () => ({ configured: false, advisors: [] }),
		isFastModeActive: () => false,
		getAsyncJobSnapshot: () => ({ running: [] }),
		getCurrentModel: () => undefined,
		isFastModeEnabled: () => false,
		getContextUsage: () => ({ tokens: 0, contextWindow: 128000 }),
		getGoalModeState: () => null,
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getSessionName: () => sessionName,
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0];
}

function stripAnsi(value: string): string {
	return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

describe("status line session accent", () => {
	function buildComponent(sessionAccent: boolean) {
		const component = statusLines.track(
			new StatusLineComponent(createStatusLineSession("Named session"), statusLineHost),
		);
		component.updateSettings({
			preset: "custom",
			leftSegments: ["pi"],
			rightSegments: ["session_name"],
			separator: "powerline-thin",
			sessionAccent,
		});
		return component;
	}

	// Computed lazily: `theme` is assigned by initTheme() in beforeAll, after module evaluation.
	const accentAnsi = (): string => {
		const ansi = getSessionAccentAnsi(getSessionAccentHex("Named session", theme.sessionAccentInputs));
		if (!ansi) throw new Error("expected a session accent ANSI sequence for the test theme");
		return ansi;
	};

	it("paints the gap with the session accent when enabled", () => {
		const ansi = accentAnsi();
		expect(ansi).toBeDefined();
		const border = buildComponent(true).getTopBorder(80).content;
		expect(border).toContain(`${ansi}${theme.boxRound.horizontal}`);
	});

	it("paints the gap with the border color and omits the session accent when disabled", () => {
		const ansi = accentAnsi();
		expect(ansi).toBeDefined();
		const border = buildComponent(false).getTopBorder(80).content;
		// Positive: gap is rendered with the theme border color.
		expect(border).toContain(`${theme.getFgAnsi("border")}${theme.boxRound.horizontal}`);
		// Negative: neither the gap nor the session-name segment may emit the
		// hash-derived session accent when the effective setting is disabled.
		expect(border).not.toContain(ansi);
	});

	it("renders the session name with the theme accent color when the accent is disabled", () => {
		const ansi = accentAnsi();
		expect(ansi).toBeDefined();
		const disabled = renderSegment("session_name", createCtx({ sessionName: "Named session", sessionAccent: false }));
		expect(disabled.visible).toBe(true);
		// Positive: the name uses the theme accent color, not the hash-derived session ANSI.
		expect(disabled.content).toContain(theme.getFgAnsi("accent"));
		// Negative: the hash-derived session ANSI must not appear for the name text.
		expect(disabled.content).not.toContain(ansi);
	});

	it("still renders the session name with the hash-derived accent when enabled", () => {
		const ansi = accentAnsi();
		expect(ansi).toBeDefined();
		const enabled = renderSegment("session_name", createCtx({ sessionName: "Named session", sessionAccent: true }));
		expect(enabled.visible).toBe(true);
		expect(enabled.content).toContain(ansi);
	});
});

describe("session_name preview-title fallback", () => {
	it("renders the stand-in title when the session is unnamed", () => {
		const seg = renderSegment("session_name", createCtx({ previewTitle: "omp" }));
		expect(seg.visible).toBe(true);
		expect(stripAnsi(seg.content)).toBe("omp");
	});

	it("prefers the real session name over the stand-in", () => {
		const seg = renderSegment("session_name", createCtx({ sessionName: "Named session", previewTitle: "omp" }));
		expect(stripAnsi(seg.content)).toBe("Named session");
	});

	it("right-aligns the stand-in title through the box border pipeline", () => {
		const component = statusLines.track(new StatusLineComponent(createStatusLineSession(""), statusLineHost));
		component.updateSettings({
			preset: "custom",
			leftSegments: ["pi"],
			rightSegments: ["session_name"],
			separator: "powerline-thin",
			sessionAccent: false,
		});
		const withTitle = component.getTopBorder(80, "omp");
		// The gauge fill pads the group gap, so the title chip lands flush right.
		expect(withTitle.width).toBe(80);
		expect(stripAnsi(withTitle.content).trimEnd().endsWith("omp")).toBe(true);
		// Live render path passes no preview title: unnamed sessions show none.
		expect(stripAnsi(component.getTopBorder(80).content)).not.toContain("omp");
	});
});

describe("status line focused-agent dimming", () => {
	it("keeps powerline end caps at full intensity while text stays dimmed", () => {
		const component = statusLines.track(
			new StatusLineComponent(createStatusLineSession("Focused session"), statusLineHost),
		);
		component.updateSettings({
			preset: "custom",
			leftSegments: ["pi"],
			rightSegments: ["session_name"],
			separator: "powerline-thin",
			sessionAccent: false,
		});
		component.setSession(createStatusLineSession("Focused session"), "agent-1");

		const border = component.getTopBorder(80).content;

		expect(border).toStartWith("\x1b[2m");
		expect(border).toContain(`\x1b[22m${theme.sep.powerlineLeft}\x1b[0m\x1b[2m`);
		expect(border).toContain(`\x1b[22m${theme.sep.powerlineRight}\x1b[0m\x1b[2m`);
		expect(border).toContain("\x1b[0m\x1b[2m");
		expect(border).toEndWith("\x1b[22m");
	});
});

describe("path segment truncation at varying maxLength", () => {
	let tmpDir: string;

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-overflow-very-long-directory-name-for-testing-"));
		setProjectDir(tmpDir);
	});

	it("truncates path with ellipsis when maxLength is smaller than path", () => {
		const full = renderSegment("path", createCtx({ pathMaxLength: 200 }));
		const short = renderSegment("path", createCtx({ pathMaxLength: 10 }));

		expect(full.visible).toBe(true);
		expect(short.visible).toBe(true);
		expect(visibleWidth(short.content)).toBeLessThan(visibleWidth(full.content));
	});

	it("reduces visible width monotonically as maxLength decreases", () => {
		const widths = [40, 20, 10, 4].map(maxLen => {
			const rendered = renderSegment("path", createCtx({ pathMaxLength: maxLen }));
			return visibleWidth(rendered.content);
		});

		for (let i = 1; i < widths.length; i++) {
			expect(widths[i]).toBeLessThanOrEqual(widths[i - 1]);
		}
	});

	it("still renders a visible segment at maxLength=4", () => {
		const rendered = renderSegment("path", createCtx({ pathMaxLength: 4 }));
		expect(rendered.visible).toBe(true);
		expect(visibleWidth(rendered.content)).toBeGreaterThan(0);
	});
});

describe("overflow: path survives before model", () => {
	it("drops the model segment before the cwd path when both cannot fit", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-statusline-overflow-"));
		const cwd = path.join(root, "cwdxyz");
		fs.mkdirSync(cwd);
		setProjectDir(cwd);

		const modelName = `MODEL_SHOULD_DROP_${"x".repeat(24)}`;
		const session = createStatusLineSession("overflow test", modelName);
		const component = statusLines.track(new StatusLineComponent(session, statusLineHost));
		const pathOptions = {
			abbreviate: false,
			maxLength: 32,
			stripWorkPrefix: false,
		};
		component.updateSettings({
			preset: "custom",
			leftSegments: ["pi", "model", "path"],
			rightSegments: [],
			separator: "none",
			sessionAccent: false,
			transparent: true,
			segmentOptions: {
				model: { showThinkingLevel: false },
				path: pathOptions,
			},
		});

		const ctx = {
			...createCtx({ pathMaxLength: pathOptions.maxLength }),
			session,
			options: {
				model: { showThinkingLevel: false },
				path: pathOptions,
			},
		} as SegmentContext;
		const pi = renderSegment("pi", ctx).content;
		const model = renderSegment("model", ctx).content;
		const minPath = renderSegment("path", {
			...ctx,
			options: { ...ctx.options, path: { ...pathOptions, maxLength: 4 } },
		}).content;
		const separatorWidth = visibleWidth(theme.sep.space);
		const groupWidth = (parts: string[]) =>
			parts.reduce((sum, part) => sum + visibleWidth(part), 0) +
			Math.max(0, parts.length - 1) * (separatorWidth + 2) +
			2;
		const width = groupWidth([pi, model]) + 1;

		expect(groupWidth([pi, model, minPath])).toBeGreaterThan(width);
		expect(groupWidth([pi, minPath])).toBeLessThanOrEqual(width);

		const rendered = stripAnsi(component.getTopBorder(width).content);
		expect(rendered).toContain("xyz");
		expect(rendered).not.toContain("MODEL_SHOULD_DROP");
	});
});

describe("overflow: narrow-pane clip floor", () => {
	const LONG_MODEL = `MODEL_CLIP_${"x".repeat(49)}`;

	function buildNarrowComponent(segments: { left: StatusLineSegmentId[]; right: StatusLineSegmentId[] }) {
		const component = statusLines.track(
			new StatusLineComponent(createStatusLineSession("narrow pane", LONG_MODEL), statusLineHost),
		);
		component.updateSettings({
			preset: "custom",
			leftSegments: segments.left,
			rightSegments: segments.right,
			separator: "none",
			sessionAccent: false,
			transparent: true,
			segmentOptions: { model: { showThinkingLevel: false } },
		});
		return component;
	}

	it("paints a clipped first configured segment at 51 and 40 cols instead of an empty bar", () => {
		const component = buildNarrowComponent({ left: ["model"], right: [] });
		for (const width of [51, 40]) {
			const content = component.getTopBorder(width).content;
			const stripped = stripAnsi(content).trim();
			expect(stripped.length, `width ${width}`).toBeGreaterThan(0);
			expect(stripped.includes("MODEL_CLIP"), `width ${width}`).toBe(true);
			expect(visibleWidth(content), `width ${width}`).toBeLessThanOrEqual(width + 1);
		}
	});

	it("prefers the status segment over earlier configured segments when clipping", () => {
		const component = buildNarrowComponent({ left: ["model"], right: ["status"] });
		component.setHookStatus("test", "kb omp WATCH");
		const content = component.getTopBorder(40).content;
		const stripped = stripAnsi(content).trim();
		expect(stripped).toContain("kb omp WATCH");
		expect(stripped).not.toContain("MODEL_CLIP");
	});

	// At 5 cols even the subagent badge cannot fit, so every part is dropped and
	// the floor picks from the original parts, where the badge sits ahead of the
	// tracked right segment ids.
	it("clips the right status segment, not a badge or neighbour, when a badge was unshifted ahead of it", () => {
		const component = buildNarrowComponent({ left: [], right: ["model", "status"] });
		component.setHookStatus("test", "kb omp WATCH");
		component.setRunningSubagents(["agent-a"]);
		const stripped = stripAnsi(component.getTopBorder(5).content).trim();
		expect(stripped).toContain("kb");
		expect(stripped).not.toContain("⬢");
		expect(stripped).not.toContain("👥");
	});

	it("clips the first configured right segment, not a badge, when no status is configured", () => {
		const component = buildNarrowComponent({ left: [], right: ["model"] });
		component.setRunningSubagents(["agent-a"]);
		const stripped = stripAnsi(component.getTopBorder(5).content).trim();
		// The 3-cell budget leaves the model segment's icon and an ellipsis.
		expect(stripped).toContain("⬢");
		expect(stripped).not.toContain("👥");
	});

	it("leaves wide panes unchanged: the full long model segment still renders at 80 and 120 cols", () => {
		const component = buildNarrowComponent({ left: ["pi", "model"], right: [] });
		for (const width of [80, 120]) {
			const stripped = stripAnsi(component.getTopBorder(width).content);
			expect(stripped, `width ${width}`).toContain(LONG_MODEL);
		}
	});
});
