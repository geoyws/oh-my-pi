import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	computeEditorMaxHeight,
	layoutPinnedHud,
	nextSubagentPreviewTickMs,
	shouldEnterPlanModeOnStartup,
} from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";

describe("computeEditorMaxHeight edges", () => {
	it("falls back for non-positive and non-finite row counts", () => {
		expect(computeEditorMaxHeight(-5)).toBe(computeEditorMaxHeight(0));
		expect(computeEditorMaxHeight(Number.POSITIVE_INFINITY)).toBe(computeEditorMaxHeight(0));
	});

	it("pins to the rendered floor on tiny terminals and fits from four rows up", () => {
		// The bordered editor occupies its floor even when the terminal is
		// smaller; reporting less would misreport the rows it actually uses.
		expect(computeEditorMaxHeight(1)).toBe(3);
		expect(computeEditorMaxHeight(2)).toBe(3);
		for (const rows of [4, 5, 6, 7, 9, 12, 20, 40, 100]) {
			expect(rows - computeEditorMaxHeight(rows)).toBeGreaterThanOrEqual(0);
		}
	});
});

describe("layoutPinnedHud", () => {
	it("fits without a toggle at and below the collapsed limit", () => {
		expect(layoutPinnedHud(0, false)).toEqual({ itemRows: 0, toggle: undefined, toggleRow: undefined });
		expect(layoutPinnedHud(3, true)).toEqual({ itemRows: 3, toggle: undefined, toggleRow: undefined });
	});

	it("shows an expand toggle collapsed and a collapse toggle expanded above the limit", () => {
		expect(layoutPinnedHud(4, false)).toEqual({ itemRows: 3, toggle: "expand", toggleRow: 5 });
		expect(layoutPinnedHud(4, true)).toEqual({ itemRows: 4, toggle: "collapse", toggleRow: 6 });
		expect(layoutPinnedHud(10, true)).toEqual({ itemRows: 10, toggle: "collapse", toggleRow: 12 });
	});
});

describe("nextSubagentPreviewTickMs", () => {
	const session = (progress: unknown) => ({ progress }) as never;

	it("is undefined with no running tool call", () => {
		expect(nextSubagentPreviewTickMs([], 1000)).toBeUndefined();
		expect(nextSubagentPreviewTickMs([session(undefined)], 1000)).toBeUndefined();
		expect(nextSubagentPreviewTickMs([session({ status: "idle", currentTool: "read", currentToolStartMs: 0 })], 1000)).toBeUndefined();
		expect(nextSubagentPreviewTickMs([session({ status: "running", currentTool: undefined, currentToolStartMs: 0 })], 1000)).toBeUndefined();
		expect(nextSubagentPreviewTickMs([session({ status: "running", currentTool: "read", currentToolStartMs: undefined })], 1000)).toBeUndefined();
	});

	it("waits until the elapsed marker, then ticks once a second, taking the earliest", () => {
		expect(nextSubagentPreviewTickMs([session({ status: "running", currentTool: "read", currentToolStartMs: 900 })], 1000)).toBe(4901);
		expect(nextSubagentPreviewTickMs([session({ status: "running", currentTool: "read", currentToolStartMs: 0 })], 10000)).toBe(1000);
		expect(
			nextSubagentPreviewTickMs(
				[
					session({ status: "running", currentTool: "read", currentToolStartMs: 0 }),
					session({ status: "running", currentTool: "bash", currentToolStartMs: 9500 }),
				],
				10000,
			),
		).toBe(1000);
	});
});

describe("shouldEnterPlanModeOnStartup gates", () => {
	const manager = (options: { conversation?: boolean; explicitMode?: boolean } = {}) =>
		({
			buildSessionContext: () => ({ messages: options.conversation ? [{}] : [] }) as never,
			getEntries: () => (options.explicitMode ? [{ type: "mode_change" }] : []) as never,
		}) as never;

	it("requires plan mode enabled as well as defaulted on", () => {
		expect(
			shouldEnterPlanModeOnStartup(manager(), Settings.isolated({ "plan.defaultOnStartup": true, "plan.enabled": false })),
		).toBe(false);
		expect(shouldEnterPlanModeOnStartup(manager(), Settings.isolated({}))).toBe(false);
		expect(
			shouldEnterPlanModeOnStartup(manager(), Settings.isolated({ "plan.defaultOnStartup": true })),
		).toBe(true);
	});
});
