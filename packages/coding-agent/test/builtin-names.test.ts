import { describe, expect, it } from "bun:test";
import { normalizeToolName } from "../src/tools/builtin-names";

describe("normalizeToolName", () => {
	it("maps legacy builtin aliases without touching plugin case", () => {
		expect(normalizeToolName("search")).toBe("grep");
		expect(normalizeToolName("Read")).toBe("read");
		expect(normalizeToolName("CaseAdd")).toBe("CaseAdd");
		expect(normalizeToolName("Constructor")).toBe("Constructor");
	});

	it("maps the pre-merge AST tool names to ast", () => {
		expect(normalizeToolName("ast_grep")).toBe("ast");
		expect(normalizeToolName("ast_edit")).toBe("ast");
		expect(normalizeToolName("ast")).toBe("ast");
	});
});
