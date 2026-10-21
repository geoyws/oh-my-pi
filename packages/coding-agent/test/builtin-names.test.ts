import { describe, expect, it } from "bun:test";
import { normalizeToolName } from "../src/tools/builtin-names";

describe("normalizeToolName", () => {
	it("maps legacy builtin aliases without touching plugin case", () => {
		expect(normalizeToolName("grep")).toBe("search");
		expect(normalizeToolName("glob")).toBe("search");
		expect(normalizeToolName("find")).toBe("search");
		expect(normalizeToolName("ast_grep")).toBe("ast");
		expect(normalizeToolName("search")).toBe("search");
		expect(normalizeToolName("Read")).toBe("read");
		expect(normalizeToolName("CaseAdd")).toBe("CaseAdd");
		expect(normalizeToolName("Constructor")).toBe("Constructor");
	});
});
