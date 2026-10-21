import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { normalizeToolName } from "@oh-my-pi/pi-coding-agent/tools/builtin-names";
import { FindTool } from "@oh-my-pi/pi-coding-agent/tools/jfind";
import { SearchTool, searchCallMode } from "@oh-my-pi/pi-coding-agent/tools/search";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

type ModeSettings = { regex?: boolean; glob?: boolean; semantic?: boolean };

function createTestSession(
	cwd = "/tmp/test",
	overrides: Partial<ToolSession> = {},
	modes: ModeSettings = {},
): ToolSession {
	return {
		cwd,
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"grep.enabled": modes.regex ?? true,
			"glob.enabled": modes.glob ?? true,
			"find.enabled": modes.semantic ? "on" : "off",
			"tools.xdev": false,
		}),
		// Semantic mode also needs a model registry with a resolvable judge;
		// tests that only check availability leave it absent (mode off).
		...overrides,
	};
}

function asSchemaObject(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Expected object schema");
	}
	return value as Record<string, unknown>;
}

describe("search tool modes", () => {
	it("advertises only available modes' fields in a multi-mode schema", () => {
		// Default session: regex + glob available, semantic off (no judge).
		const tool = new SearchTool(createTestSession());
		const properties = asSchemaObject(toolWireSchema(tool).properties);
		expect(Object.keys(properties)).toContain("mode");
		expect(Object.keys(properties)).toContain("pattern");
		expect(Object.keys(properties)).toContain("limit");
		expect(Object.keys(properties)).not.toContain("query");
		expect(Object.keys(properties)).not.toContain("grep_keywords");
	});
	it("is not constructed when no mode is usable", () => {
		expect(SearchTool.createIf(createTestSession("/tmp/test", {}, { regex: false, glob: false }))).toBeNull();
		expect(SearchTool.createIf(createTestSession())).toBeInstanceOf(SearchTool);
	});

	it("advertises a modeless regex-only schema when other modes are off", () => {
		const tool = new SearchTool(createTestSession("/tmp/test", {}, { glob: false }));
		const properties = asSchemaObject(toolWireSchema(tool).properties);
		expect(Object.keys(properties).sort()).toEqual(["case", "gitignore", "path", "pattern", "skip"]);
		expect(tool.description).toContain("Search file contents by regex.");
		expect(tool.description).not.toContain("mode:");
	});

	it("advertises a modeless glob-only schema when other modes are off", () => {
		const tool = new SearchTool(createTestSession("/tmp/test", {}, { regex: false }));
		const properties = asSchemaObject(toolWireSchema(tool).properties);
		expect(Object.keys(properties).sort()).toEqual(["gitignore", "hidden", "limit", "path"]);
	});

	it("advertises the union of available modes with mode when several are available", () => {
		const tool = new SearchTool(createTestSession());
		const properties = asSchemaObject(toolWireSchema(tool).properties);
		expect(Object.keys(properties)).toContain("mode");
		expect(Object.keys(properties)).toContain("pattern");
		expect(Object.keys(properties)).not.toContain("query");
	});
});

describe("search call mode inference", () => {
	it("prefers an explicit mode, then query, then pattern, else glob", () => {
		expect(searchCallMode({ mode: "glob", pattern: "x" })).toBe("glob");
		expect(searchCallMode({ query: "what renders the header" })).toBe("semantic");
		expect(searchCallMode({ pattern: "needle" })).toBe("regex");
		expect(searchCallMode({ path: "src/**/*.ts" })).toBe("glob");
		expect(searchCallMode({})).toBe("glob");
		expect(searchCallMode(undefined)).toBe("glob");
	});
});

describe("search tool mode mismatches", () => {
	it("rejects a mode the session does not offer", async () => {
		const tool = new SearchTool(createTestSession("/tmp/test", {}, { glob: false }));
		await expect(tool.execute("s1", { mode: "glob", path: "src/**/*.ts" })).rejects.toThrow(
			"`search` glob mode is unavailable in this session; available: regex.",
		);
	});

	it("rejects semantic fields on regex and an unavailable semantic mode", async () => {
		const tool = new SearchTool(createTestSession());
		await expect(tool.execute("s2", { mode: "regex", pattern: "x", query: "y" })).rejects.toThrow(
			"`query` and `grep_keywords` are semantic-only",
		);
		await expect(tool.execute("s3", { mode: "semantic", query: "y", pattern: "x" })).rejects.toThrow(
			"`search` semantic mode is unavailable in this session; available: regex, glob.",
		);
	});

	it("requires pattern for regex and rejects pattern on glob", async () => {
		const tool = new SearchTool(createTestSession());
		await expect(tool.execute("s4", { mode: "regex" })).rejects.toThrow("regex mode requires `pattern`.");
		await expect(tool.execute("s5", { mode: "glob", pattern: "x" })).rejects.toThrow("`pattern` is regex-only");
	});

	it("rejects pattern and an empty query in semantic mode", async () => {
		const tool = new SearchTool(createTestSession("/tmp/test", {}, { semantic: true }));
		await expect(tool.execute("s6", { mode: "semantic", query: "y", pattern: "x" })).rejects.toThrow(
			"`pattern` is regex-only; semantic takes `query` and `grep_keywords`.",
		);
		await expect(tool.execute("s7", { mode: "semantic", query: "" })).rejects.toThrow(
			"semantic mode requires `query`.",
		);
		await expect(tool.execute("s8", { mode: "semantic", query: "   " })).rejects.toThrow(
			"semantic mode requires `query`.",
		);
	});

	it("dispatches semantic mode to the semantic runner", async () => {
		const result = { content: [{ type: "text" as const, text: "stubbed" }], details: undefined };
		const spy = spyOn(FindTool.prototype, "execute").mockResolvedValue(result as never);
		try {
			const tool = new SearchTool(createTestSession("/tmp/test", {}, { semantic: true }));
			const got = await tool.execute("s9", { query: "what renders the header", path: "src" });
			expect(got).toBe(result as never);
			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy.mock.calls[0]?.[1]).toEqual({ query: "what renders the header", grep_keywords: [], path: "src" });
		} finally {
			spy.mockRestore();
		}
	});
});

describe("search tool approval", () => {
	const tool = new SearchTool(createTestSession());

	it("carries the legacy per-mode policy keys", () => {
		expect(tool.approval({ mode: "regex", pattern: "x", path: "src" })).toEqual({
			tier: "read",
			policyKey: "grep",
		});
		expect(tool.approval({ mode: "glob", path: "src/**/*.ts" })).toEqual({ tier: "read", policyKey: "glob" });
		expect(tool.approval({ mode: "semantic", query: "x" })).toEqual({ tier: "read", policyKey: "find" });
	});

	it("keeps pre-merge user policies applying per mode under yolo", () => {
		expect(resolveApproval(tool, { mode: "regex", pattern: "x" }, "yolo", { grep: "deny" }).policy).toBe("deny");
		expect(resolveApproval(tool, { mode: "glob", path: "src" }, "yolo", { grep: "deny" }).policy).not.toBe("deny");
		expect(resolveApproval(tool, { mode: "glob", path: "src" }, "yolo", { glob: "deny" }).policy).toBe("deny");
		expect(resolveApproval(tool, { mode: "semantic", query: "x" }, "yolo", { find: "deny" }).policy).toBe("deny");
		expect(resolveApproval(tool, { mode: "regex", pattern: "x" }, "yolo", { search: "deny" }).policy).toBe("deny");
	});
});

describe("search tool legacy names", () => {
	it("normalizes the pre-merge tool names to search", () => {
		expect(normalizeToolName("grep")).toBe("search");
		expect(normalizeToolName("glob")).toBe("search");
		expect(normalizeToolName("find")).toBe("search");
	});
});

describe("search execute", () => {
	it("runs regex and glob modes against real files", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "search-exec-"));
		try {
			await Bun.write(path.join(tempDir, "alpha.ts"), "export const needleValue = 1;\n");
			await Bun.write(path.join(tempDir, "beta.ts"), "export const otherValue = 2;\n");
			const tool = new SearchTool(createTestSession(tempDir));

			const regex = await tool.execute("search-regex", { mode: "regex", pattern: "needleValue", path: tempDir });
			const regexText = regex.content.find(c => c.type === "text")?.text ?? "";
			expect(regexText).toContain("alpha.ts");
			expect(regexText).not.toContain("otherValue");

			const glob = await tool.execute("search-glob", { mode: "glob", path: path.join(tempDir, "*.ts") });
			const globText = glob.content.find(c => c.type === "text")?.text ?? "";
			expect(globText).toContain("alpha.ts");
			expect(globText).toContain("beta.ts");

			const modeless = await tool.execute("search-modeless", { pattern: "otherValue", path: tempDir });
			expect(modeless.content.find(c => c.type === "text")?.text ?? "").toContain("beta.ts");
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("advertises a modeless regex-only search from createTools when glob is disabled", async () => {
		const tools = await createTools(createTestSession("/tmp/test", {}, { glob: false }), ["search"]);
		const tool = tools.find(entry => entry.name === "search");
		expect(tool).toBeDefined();
		const properties = asSchemaObject(toolWireSchema(tool!).properties);
		expect(Object.keys(properties)).not.toContain("mode");
		expect(Object.keys(properties)).not.toContain("query");
	});
});
