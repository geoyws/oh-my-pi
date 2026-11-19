import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	computeEditorMaxHeight,
	layoutPinnedHud,
	nextSubagentPreviewTickMs,
	renderSubagentHudLines,
	shouldEnterPlanModeOnStartup,
	SubagentHudComponent,
} from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import * as piTui from "@oh-my-pi/pi-tui";
import type { ObservableSession } from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import { setFeedModelBadgeEnabled } from "@oh-my-pi/pi-tui/render/render-utils";
import * as treeList from "@oh-my-pi/pi-tui/render/tree-list";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { PINNED_HUD_TOGGLE_ID } from "@oh-my-pi/pi-coding-agent/task/output-manager";

function render(sessions: ObservableSession[], columns = 120): string {
	return Bun.stripANSI(renderSubagentHudLines(sessions, columns).join("\n"));
}

/** A running subagent observer session with `progress` merged over a running, tool-less snapshot. */
function running(id: string, progress: Record<string, unknown> = {}): ObservableSession {
	return {
		kind: "subagent",
		id,
		label: id,
		status: "active",
		progress: { status: "running", recentTools: [], ...progress },
	} as unknown as ObservableSession;
}

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
		expect(
			nextSubagentPreviewTickMs([session({ status: "idle", currentTool: "read", currentToolStartMs: 0 })], 1000),
		).toBeUndefined();
		expect(
			nextSubagentPreviewTickMs(
				[session({ status: "running", currentTool: undefined, currentToolStartMs: 0 })],
				1000,
			),
		).toBeUndefined();
		expect(
			nextSubagentPreviewTickMs(
				[session({ status: "running", currentTool: "read", currentToolStartMs: undefined })],
				1000,
			),
		).toBeUndefined();
	});

	it("waits until the elapsed marker, then ticks once a second, taking the earliest", () => {
		expect(
			nextSubagentPreviewTickMs(
				[session({ status: "running", currentTool: "read", currentToolStartMs: 900 })],
				1000,
			),
		).toBe(4901);
		expect(
			nextSubagentPreviewTickMs([session({ status: "running", currentTool: "read", currentToolStartMs: 0 })], 10000),
		).toBe(1000);
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

describe("SubagentHudComponent click map", () => {
	it("maps rendered rows to agents only after a render", () => {
		const hud = new SubagentHudComponent(["header", "sub", "itemA", "itemB"], ["AgentA", "AgentB"]);
		expect(hud.getClickAgentAtRow(2)).toBeUndefined();
		hud.render(60);
		expect(hud.getClickAgentAtRow(-1)).toBeUndefined();
		expect(hud.getClickAgentAtRow(0)).toBeUndefined();
		expect(hud.getClickAgentAtRow(2)).toBe("AgentA");
		expect(hud.getClickAgentAtRow(3)).toBe("AgentB");
		expect(hud.getClickAgentAtRow(99)).toBeUndefined();
	});

	it("routes the toggle row to the pinned toggle id and remaps after update", () => {
		const hud = new SubagentHudComponent(["header", "sub", "itemA", "more"], ["AgentA"], 3);
		hud.render(60);
		expect(hud.getClickAgentAtRow(3)).toBe(PINNED_HUD_TOGGLE_ID);
		hud.update(["header", "sub", "itemZ"], ["AgentZ"], undefined);
		hud.render(60);
		expect(hud.getClickAgentAtRow(2)).toBe("AgentZ");
		expect(hud.getClickAgentAtRow(3)).toBeUndefined();
	});

	it("maps every wrapped physical row of a long item to its agent", () => {
		const hud = new SubagentHudComponent(
			["header", "sub", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa item"],
			["AgentLong"],
		);
		const rows = hud.render(20);
		expect(rows.length).toBeGreaterThan(3);
		const owners = rows.map((_row, index) => hud.getClickAgentAtRow(index));
		expect(owners.slice(2).every(owner => owner === "AgentLong")).toBe(true);
	});
});

describe("renderSubagentHudLines", () => {
	it("renders nothing when nothing is running", async () => {
		await initTheme();
		expect(renderSubagentHudLines([], 120)).toEqual([]);
		const idle = { kind: "subagent", id: "Idle", label: "Idle", status: "completed", progress: { status: "idle" } };
		expect(renderSubagentHudLines([idle as unknown as ObservableSession], 120)).toEqual([]);
	});

	it("lists running agents with descriptions and previews raw assignments", async () => {
		await initTheme();
		const withDescription = render([
			{
				kind: "subagent",
				id: "Alpha",
				label: "Alpha",
				status: "active",
				detached: true,
				progress: { status: "running", description: "alpha work" },
			},
		] as never);
		expect(withDescription).toContain("Alpha: alpha work");
		const withAssignment = render([
			{
				kind: "subagent",
				id: "Beta",
				label: "Beta",
				status: "active",
				detached: true,
				progress: { status: "running", assignment: "beta task text" },
			},
		] as never);
		expect(withAssignment).toContain("beta task text");
	});

	it("shows the expand line when collapsed past the limit and every row when expanded", async () => {
		await initTheme();
		const sessions = Array.from({ length: 5 }, (_, i) => ({
			kind: "subagent",
			id: `Agent${i}`,
			label: `Agent${i}`,
			status: "active",
			detached: true,
			progress: { status: "running", description: `work ${i}` },
		})) as never;
		const collapsed = renderSubagentHudLines(sessions, 120, false).join("\n");
		expect(Bun.stripANSI(collapsed)).toContain("more");
		const expanded = renderSubagentHudLines(sessions, 120, true).join("\n");
		expect(Bun.stripANSI(expanded)).toContain("work 4");
	});

	it("leads each row with the resolved model badge when feed badges are on", async () => {
		await initTheme();
		const session = running("Alpha", { description: "alpha work", resolvedModel: "anthropic/claude-sonnet-4-5" });
		expect(render([session])).not.toContain("sonnet");
		setFeedModelBadgeEnabled(true);
		try {
			expect(render([session])).toMatch(/sonnet.*Alpha: alpha work/);
		} finally {
			setFeedModelBadgeEnabled(false);
		}
	});

	it("previews a raw task message when no assignment was recorded, and nothing when neither exists", async () => {
		await initTheme();
		expect(render([running("Gamma", { task: "irc woke me" })])).toContain("Gamma irc woke me");
		expect(
			render([running("Delta")])
				.split("\n")
				.at(-1)!,
		).toMatch(/Delta$/);
	});

	it("drops the description or preview when the row has no room left after the id", async () => {
		await initTheme();
		const narrow = (session: ObservableSession) => render([session], 12).split("\n").at(-1)!;
		expect(narrow(running("Epsilon", { description: "long description" }))).not.toContain(":");
		expect(narrow(running("Epsilon", { assignment: "long assignment" }))).not.toContain("long");
	});

	it("budgets the full row when the tree list reports no prefix width", async () => {
		await initTheme();
		const sessions = [running("Zeta", { description: "x".repeat(200) })];
		const lastRow = () => Bun.stripANSI(renderSubagentHudLines(sessions, 60).at(-1)!);
		// With the connector width reserved, the description is cut to the row with an ellipsis.
		expect(lastRow()).toMatch(/x…$/);
		const original = treeList.renderTreeList;
		const spy = vi.spyOn(treeList, "renderTreeList").mockImplementation((options, listTheme) =>
			original(
				{
					...options,
					renderItem: (item, context) => options.renderItem(item, { ...context, prefixWidth: undefined }),
				},
				listTheme,
			),
		);
		try {
			// Without it the row overruns by the connector width and only the outer clamp cuts it, bare.
			const row = lastRow();
			expect(row).toMatch(/xx$/);
			expect(piTui.visibleWidth(row)).toBe(58);
		} finally {
			spy.mockRestore();
		}
	});
});

describe("Subagent HUD live previews and hit-map fallback", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("falls back to one owner row per logical line when the wrap map disagrees with the rendered rows", async () => {
		await initTheme();
		const hud = new SubagentHudComponent(["", "title", "itemA", "itemB", "orphan", "more"], ["AgentA", "AgentB"], 5);
		const plain = new SubagentHudComponent(["", "title", "itemA"], ["AgentA"]);
		expect(hud.render(40)).toHaveLength(6);
		expect(plain.render(40)).toHaveLength(3);
		// Every logical line now claims two physical rows: twice as many owners as rendered rows.
		vi.spyOn(piTui, "wrapTextWithAnsi").mockReturnValue(["a", "b"]);
		const owners = [0, 1, 2, 3, 4, 5].map(row => hud.getClickAgentAtRow(row));
		expect(owners).toEqual([undefined, undefined, "AgentA", "AgentB", undefined, PINNED_HUD_TOGGLE_ID]);
		expect([0, 1, 2].map(row => plain.getClickAgentAtRow(row))).toEqual([undefined, undefined, "AgentA"]);
	});

	it("answers no agent for a click after the width configuration changed since the render", async () => {
		await initTheme();
		const hud = new SubagentHudComponent(["", "title", "itemA"], ["AgentA"]);
		hud.render(40);
		try {
			expect(piTui.setHangulCompatibilityJamoWidth(2)).toBe(true);
			expect(hud.getClickAgentAtRow(2)).toBeUndefined();
			hud.render(40);
			expect(hud.getClickAgentAtRow(2)).toBe("AgentA");
		} finally {
			piTui.resetHangulCompatibilityJamoWidthForTests();
		}
	});

	it("shows no preview row for a stopped agent or one that has not called a tool", async () => {
		await initTheme();
		const rows = (session: ObservableSession) => renderSubagentHudLines([session], 120, false, true).at(-1)!;
		const stopped = {
			...running("Eta", { currentTool: "read" }),
			progress: { status: "completed", currentTool: "read", recentTools: [] },
		} as never;
		expect(rows(stopped)).not.toContain("\n");
		expect(rows(running("Eta", { description: "thinking" }))).not.toContain("\n");
	});

	it("keeps the last finished call between calls, marked by how it ended", async () => {
		await initTheme();
		const preview = (recent: Record<string, unknown>) =>
			renderSubagentHudLines(
				[running("Theta", { recentTools: [{ endMs: 1, args: "", ...recent }] })],
				120,
				false,
				true,
			)
				.at(-1)!
				.split("\n")[1]!;
		const failed = preview({ tool: "grep", intent: "find todos", isError: true });
		expect(failed).toContain(theme.styledSymbol("status.error", "error"));
		expect(Bun.stripANSI(failed)).toContain("grep: find todos");
		const ok = preview({ tool: "bash", args: "ls ~/notes", argsKey: "command" });
		expect(ok).toContain(theme.styledSymbol("status.success", "success"));
		expect(Bun.stripANSI(ok)).toContain("bash: ls ~/notes");
	});

	it("renders a live tool preview row with intent and an elapsed marker", async () => {
		await initTheme();
		const now = Date.now();
		const sessions = [
			{
				kind: "subagent",
				id: "Worker",
				label: "Worker",
				status: "active",
				detached: true,
				progress: {
					status: "running",
					description: "working",
					currentTool: "read",
					currentToolStartMs: now - 60_000,
					currentToolIntent: "read the config",
					recentTools: [],
				},
			},
		] as never;
		const out = renderSubagentHudLines(sessions, 120, false, true).join("\n");
		// a call running past the threshold shows its elapsed time after the detail
		expect(Bun.stripANSI(out)).toMatch(/read: read the config.+1m/);
		const recent = [
			{
				kind: "subagent",
				id: "Worker",
				label: "Worker",
				status: "active",
				detached: true,
				progress: {
					status: "running",
					description: "working",
					currentTool: "read",
					currentToolStartMs: now,
					currentToolIntent: "read the config",
					recentTools: [],
				},
			},
		] as never;
		const fresh = renderSubagentHudLines(recent, 120, false, true).join("\n");
		// a call that just started shows no marker
		expect(Bun.stripANSI(fresh).split("\n").at(-1)!.trimEnd()).toEndWith("read: read the config");
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
			shouldEnterPlanModeOnStartup(
				manager(),
				Settings.isolated({ "plan.defaultOnStartup": true, "plan.enabled": false }),
			),
		).toBe(false);
		expect(shouldEnterPlanModeOnStartup(manager(), Settings.isolated({}))).toBe(false);
		expect(shouldEnterPlanModeOnStartup(manager(), Settings.isolated({ "plan.defaultOnStartup": true }))).toBe(true);
	});
});
