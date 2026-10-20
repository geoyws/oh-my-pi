import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { adaptSchemaForStrict, toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolChoiceQueue } from "@oh-my-pi/pi-coding-agent/session/tool-choice-queue";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { AstTool, astCallMode } from "@oh-my-pi/pi-coding-agent/tools/ast";
import { normalizeToolName } from "@oh-my-pi/pi-coding-agent/tools/builtin-names";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

type InvokedToolResult = {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
	isError?: boolean;
};

type ModeSettings = { search?: boolean; edit?: boolean };

/**
 * Both modes on by default. `tools.xdev` is off so the discoverable `ast` tool
 * stays in the returned toolset instead of unmounting into xd://.
 */
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
			"astGrep.enabled": modes.search ?? true,
			"astEdit.enabled": modes.edit ?? true,
			"tools.xdev": false,
		}),
		...overrides,
	};
}

/** Edit-capable session wired to a resolve queue so staged previews can be applied. */
function createEditSession(cwd: string, queue: ToolChoiceQueue): ToolSession {
	return createTestSession(cwd, {
		getToolChoiceQueue: () => queue,
		buildToolChoice: () => ({ type: "tool" as const, name: "resolve" }),
		steer: () => {},
	});
}

/**
 * `createTools` scopes `isToolActive` to the requested names, and edit mode
 * rides the `edit` grant — so edit-mode callers request `edit` alongside `ast`.
 */
async function getAstTool(session: ToolSession, names: string[] = ["ast", "edit"]) {
	const tools = await createTools(session, names);
	const tool = tools.find(entry => entry.name === "ast");
	expect(tool).toBeDefined();
	return tool!;
}

function asSchemaObject(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Expected object schema");
	}
	return value as Record<string, unknown>;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(content => content.type === "text")?.text ?? "";
}

describe("ast tool modes", () => {
	it("is not constructed when no mode is usable", () => {
		expect(AstTool.createIf(createTestSession("/tmp/test", {}, { search: false, edit: false }))).toBeNull();
		expect(
			AstTool.createIf(createTestSession("/tmp/test", { isToolActive: () => false }, { search: false })),
		).toBeNull();
		expect(AstTool.createIf(createTestSession())).toBeInstanceOf(AstTool);
	});

	it("advertises a modeless search-only schema and description when edit is off", () => {
		const tool = new AstTool(createTestSession("/tmp/test", {}, { edit: false }));
		const schema = toolWireSchema(tool);
		const properties = asSchemaObject(schema.properties);
		expect(Object.keys(properties).sort()).toEqual(["lang", "pat", "path", "skip"]);
		expect(schema.required).toEqual(["pat"]);
		expect(tool.description).toContain("Structural code search via ast-grep");
		expect(tool.description).not.toContain("STAGED");
		expect(tool.description).not.toContain('`mode: "edit"`');
		expect(tool.examples.length).toBeGreaterThan(0);
		for (const example of tool.examples) {
			if (!("call" in example)) continue;
			expect("mode" in example.call).toBe(false);
			expect(astCallMode(example.call)).toBe("search");
		}
	});

	it("advertises a modeless edit-only schema and description when search is off", () => {
		const tool = new AstTool(createTestSession("/tmp/test", {}, { search: false }));
		const schema = toolWireSchema(tool);
		const properties = asSchemaObject(schema.properties);
		expect(Object.keys(properties).sort()).toEqual(["ops", "path"]);
		expect([...(schema.required as string[])].sort()).toEqual(["ops", "path"]);
		expect(asSchemaObject(properties.path).type).toBe("string");
		expect(tool.description).toContain("Structural AST-aware rewrites via ast-grep");
		expect(tool.description).toContain("STAGED");
		expect(tool.description).not.toContain("Narrow each search");
		expect(tool.description).not.toContain("AVOID repo-root scans");
		expect(tool.examples.length).toBeGreaterThan(0);
		for (const example of tool.examples) {
			if (!("call" in example)) continue;
			expect("mode" in example.call).toBe(false);
			expect(astCallMode(example.call)).toBe("edit");
		}
	});

	it("advertises the full union with a required mode when both modes are available", () => {
		const tool = new AstTool(createTestSession());
		const schema = toolWireSchema(tool);
		const properties = asSchemaObject(schema.properties);
		expect(Object.keys(properties).sort()).toEqual(["lang", "mode", "ops", "pat", "path", "skip"]);
		expect(schema.required).toEqual(["mode"]);
		const modeSchema = JSON.stringify(properties.mode);
		expect(modeSchema).toContain("search");
		expect(modeSchema).toContain("edit");
		expect(tool.description).toContain(
			'Structural code search (`mode: "search"`) and codemods (`mode: "edit"`) via ast-grep',
		);
		expect(tool.description).toContain("Narrow each search");
		expect(tool.description).toContain("STAGED");
		const exampleModes = new Set(tool.examples.map(example => ("call" in example ? example.call.mode : undefined)));
		expect(exampleModes).toEqual(new Set(["search", "edit"]));
	});

	it("drops edit mode when the session lacks the edit grant", () => {
		const session = createTestSession("/tmp/test", { isToolActive: name => name !== "edit" });
		const tool = new AstTool(session);
		expect(tool.deferrable).toBe(false);
		const properties = Object.keys(asSchemaObject(toolWireSchema(tool).properties));
		expect(properties).not.toContain("ops");
		expect(properties).not.toContain("mode");
		expect(tool.description).not.toContain("STAGED");
	});

	it("keeps only search mode when createTools omits edit", async () => {
		const tool = await getAstTool(createTestSession(), ["ast"]);
		const properties = asSchemaObject(toolWireSchema(tool).properties);
		expect(Object.keys(properties)).not.toContain("ops");
		await expect(
			tool.execute("ast-edit-ungranted", {
				mode: "edit",
				ops: [{ pat: "a", out: "b" }],
				path: "src/a.ts",
			}),
		).rejects.toThrow("`ast` edit mode is unavailable in this session; available: search.");
		// A modeless call carrying `ops` is still an edit, so it is refused too.
		await expect(
			tool.execute("ast-edit-ungranted-modeless", { ops: [{ pat: "a", out: "b" }], path: "src/a.ts" }),
		).rejects.toThrow("`ast` edit mode is unavailable in this session; available: search.");
	});

	it("is not created for a read-only session with search disabled", async () => {
		const tools = await createTools(createTestSession("/tmp/test", {}, { search: false }), ["ast", "read"]);
		expect(tools.some(entry => entry.name === "ast")).toBe(false);
	});

	it("is deferrable only while edit mode is available", () => {
		expect(new AstTool(createTestSession()).deferrable).toBe(true);
		expect(new AstTool(createTestSession("/tmp/test", {}, { search: false })).deferrable).toBe(true);
		expect(new AstTool(createTestSession("/tmp/test", {}, { edit: false })).deferrable).toBe(false);
		expect(new AstTool(createTestSession("/tmp/test", { isToolActive: () => false })).deferrable).toBe(false);
	});
});

describe("ast call mode inference", () => {
	it("prefers an explicit mode, then infers edit from ops, else search", () => {
		expect(astCallMode({ mode: "search", ops: [{ pat: "a", out: "b" }] })).toBe("search");
		expect(astCallMode({ mode: "edit" })).toBe("edit");
		expect(astCallMode({ ops: [{ pat: "a", out: "b" }], path: "src/a.ts" })).toBe("edit");
		expect(astCallMode({ pat: "x" })).toBe("search");
		expect(astCallMode(undefined)).toBe("search");
	});

	it("executes a modeless ops call as an edit in an edit-only session", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-modeless-edit-"));
		try {
			const filePath = path.join(tempDir, "legacy.ts");
			await Bun.write(filePath, "legacyWrap(x, value)\n");
			const queue = new ToolChoiceQueue();
			const session = createTestSession(
				tempDir,
				{
					getToolChoiceQueue: () => queue,
					buildToolChoice: () => ({ type: "tool" as const, name: "resolve" }),
					steer: () => {},
				},
				{ search: false },
			);
			const tool = new AstTool(session);

			const preview = await tool.execute("ast-modeless-edit", {
				ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
				path: filePath,
			});
			expect((preview.details as { totalReplacements?: number } | undefined)?.totalReplacements).toBe(1);
			expect(queue.hasPendingInvoker).toBe(true);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("executes a modeless pat call as a search in a search-only session", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-modeless-search-"));
		try {
			const filePath = path.join(tempDir, "sample.ts");
			await Bun.write(filePath, "const sharedSymbol = 1;\n");
			const tool = new AstTool(createTestSession(tempDir, {}, { edit: false }));

			const result = await tool.execute("ast-modeless-search", { pat: "sharedSymbol", path: filePath });
			expect((result.details as { matchCount?: number } | undefined)?.matchCount).toBe(1);
		} finally {
			await removeWithRetries(tempDir);
		}
	});
});

describe("ast tool mode mismatches", () => {
	it("rejects a mode the session does not offer", async () => {
		const tool = new AstTool(createTestSession("/tmp/test", {}, { search: false }));
		const execution = tool.execute("ast-search-disabled", { mode: "search", pat: "x" });
		await expect(execution).rejects.toBeInstanceOf(ToolError);
		await expect(tool.execute("ast-search-disabled", { mode: "search", pat: "x" })).rejects.toThrow(
			"`ast` search mode is unavailable in this session; available: edit.",
		);
		// Without `ops`, a modeless call is a search and is refused the same way.
		await expect(tool.execute("ast-search-disabled-modeless", { pat: "x" })).rejects.toThrow(
			"`ast` search mode is unavailable in this session; available: edit.",
		);
	});

	it("rejects edit-only fields on search", async () => {
		const tool = new AstTool(createTestSession());
		const execution = tool.execute("ast-search-ops", {
			mode: "search",
			pat: "x",
			ops: [{ pat: "a", out: "b" }],
		});
		await expect(execution).rejects.toBeInstanceOf(ToolError);
		await expect(
			tool.execute("ast-search-ops", { mode: "search", pat: "x", ops: [{ pat: "a", out: "b" }] }),
		).rejects.toThrow("`ops` is edit-only; search takes one `pat`.");
	});

	it("requires pat for search", async () => {
		const tool = new AstTool(createTestSession());
		await expect(tool.execute("ast-search-nopat", { mode: "search" })).rejects.toThrow("search requires `pat`.");
	});

	it("rejects search-only fields on edit", async () => {
		const tool = new AstTool(createTestSession());
		for (const extra of [{ pat: "x" }, { lang: "ts" }, { skip: 1 }]) {
			const execution = tool.execute("ast-edit-search-fields", {
				mode: "edit",
				ops: [{ pat: "a", out: "b" }],
				path: "src/a.ts",
				...extra,
			});
			await expect(execution).rejects.toBeInstanceOf(ToolError);
			await expect(
				tool.execute("ast-edit-search-fields", {
					mode: "edit",
					ops: [{ pat: "a", out: "b" }],
					path: "src/a.ts",
					...extra,
				}),
			).rejects.toThrow("`pat`, `lang`, and `skip` are search-only; edit takes `ops: [{ pat, out }]`.");
		}
	});

	it("requires ops and path for edit", async () => {
		const tool = new AstTool(createTestSession());
		await expect(tool.execute("ast-edit-noops", { mode: "edit", path: "src/a.ts" })).rejects.toThrow(
			"edit requires `ops`.",
		);
		await expect(tool.execute("ast-edit-nopath", { mode: "edit", ops: [{ pat: "a", out: "b" }] })).rejects.toThrow(
			"edit requires `path`: the files, directories, or globs to rewrite.",
		);
		await expect(
			tool.execute("ast-edit-blankpath", { mode: "edit", ops: [{ pat: "a", out: "b" }], path: "  " }),
		).rejects.toThrow("edit requires `path`: the files, directories, or globs to rewrite.");
	});
});

describe("ast tool approval", () => {
	const tool = new AstTool(createTestSession());
	const ops = [{ pat: "a", out: "b" }];

	it("treats search as read-tier", () => {
		expect(tool.approval({ mode: "search", pat: "x" })).toBe("read");
		expect(tool.approval({ mode: "search", pat: "x", path: "src/x.ts" })).toBe("read");
	});

	it("treats edit over internal URLs only as read-tier", () => {
		expect(tool.approval({ mode: "edit", ops, path: "local://a.md" })).toBe("read");
		expect(tool.approval({ mode: "edit", ops, path: "local://a.md; local://b.md" })).toBe("read");
	});

	it("treats edit touching any filesystem path as write-tier", () => {
		expect(tool.approval({ mode: "edit", ops, path: "src/x.ts" })).toBe("write");
		expect(tool.approval({ mode: "edit", ops, path: "local://a.md src/x.ts" })).toBe("write");
		expect(tool.approval({ mode: "edit", ops, path: "local://a.md; src/x.ts" })).toBe("write");
		expect(tool.approval({ mode: "edit", ops })).toBe("write");
	});

	it("classifies modeless calls by their fields", () => {
		expect(tool.approval({ pat: "x", path: "src/x.ts" })).toBe("read");
		expect(tool.approval({ ops, path: "src/x.ts" })).toBe("write");
		expect(tool.approval({ ops, path: "local://a.md" })).toBe("read");
		expect(tool.approval({ ops, path: "local://a.md src/x.ts" })).toBe("write");
	});
});

describe("ast tool legacy names", () => {
	it("normalizes the pre-merge tool names to ast", () => {
		expect(normalizeToolName("ast_grep")).toBe("ast");
		expect(normalizeToolName("ast_edit")).toBe("ast");
		expect(normalizeToolName("ast")).toBe("ast");
	});
});

describe("ast search", () => {
	it("reports parse errors for the searched file", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-search-parse-"));
		try {
			const filePath = path.join(tempDir, "broken.ts");
			await Bun.write(filePath, "export function broken( { return 1; }");

			const tool = await getAstTool(createTestSession(tempDir), ["ast"]);
			const result = await tool.execute("ast-search-parse", {
				mode: "search",
				pat: "someUnlikelyCall($A)",
				path: filePath,
			});

			const text = textOf(result);
			const details = result.details as { parseErrors?: string[]; matchCount?: number } | undefined;

			expect(details?.matchCount).toBe(0);
			expect(text).toContain("No matches found");
			expect(text).toContain("Parse issues mean the query may be mis-scoped");
			expect(details?.parseErrors).toHaveLength(1);
			expect(details?.parseErrors?.[0]).toContain("broken.ts: parse error (syntax tree contains error nodes)");
			expect(details?.parseErrors?.[0]).not.toContain("someUnlikelyCall($A):");
			expect(text.match(/parse error \(syntax tree contains error nodes\)/g)?.length ?? 0).toBe(1);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("caps parseErrors at PARSE_ERRORS_LIMIT and records the original total", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-search-parse-cap-"));
		try {
			const fileCount = 21;
			for (let i = 0; i < fileCount; i++) {
				await Bun.write(path.join(tempDir, `broken-${i}.ts`), "export function broken( { return 1; }");
			}

			const tool = await getAstTool(createTestSession(tempDir), ["ast"]);
			const result = await tool.execute("ast-search-parse-cap", {
				mode: "search",
				pat: "someUnlikelyCall($A)",
				path: tempDir,
			});

			const text = textOf(result);
			const details = result.details as
				| { parseErrors?: string[]; parseErrorsTotal?: number; matchCount?: number }
				| undefined;

			expect(details?.matchCount).toBe(0);
			expect(details?.parseErrors?.length).toBe(20);
			expect(details?.parseErrorsTotal).toBe(fileCount);
			expect(text).toContain(`Parse issues (20 / ${fileCount}):`);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("combines globbing from path and glob parameters", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-search-glob-"));
		try {
			const packagesDir = path.join(tempDir, "packages");
			const sourceDir = path.join(packagesDir, "pkg-123", "src");
			const nestedDir = path.join(sourceDir, "nested");
			await fs.mkdir(nestedDir, { recursive: true });
			await Bun.write(path.join(sourceDir, "root.ts"), "const providerOptions = {};\n");
			await Bun.write(path.join(nestedDir, "child.ts"), "const providerOptions = { nested: true };\n");
			await Bun.write(path.join(sourceDir, "ignore.js"), "const providerOptions = {};\n");
			await Bun.write(path.join(tempDir, "outside.ts"), "const providerOptions = {};\n");

			const tool = await getAstTool(createTestSession(tempDir), ["ast"]);
			const result = await tool.execute("ast-search-glob", {
				mode: "search",
				pat: "providerOptions",
				path: `${packagesDir}/pkg-*/src/**/*.ts`,
			});

			const text = textOf(result);
			const details = result.details as { matchCount?: number; fileCount?: number } | undefined;

			// Multi-level tree output: `# packages/pkg-…/src/`, `## root.ts#<hash>`, then a
			// nested `## nested/` directory with `### child.ts#<hash>` under it.
			expect(text).toMatch(/^## root\.ts#[0-9A-F]{4}/m);
			expect(text).toMatch(/^### child\.ts#[0-9A-F]{4}/m);
			expect(text).not.toContain("ignore.js");
			expect(text).not.toContain("outside.ts");
			expect(details?.matchCount).toBe(2);
			expect(details?.fileCount).toBe(2);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("keeps multi-target results globally ordered and skip does not truncate match totals", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-search-multi-skip-"));
		try {
			const earlyDir = path.join(tempDir, "a");
			const lateDir = path.join(tempDir, "z");
			await fs.mkdir(earlyDir, { recursive: true });
			await fs.mkdir(lateDir, { recursive: true });
			await Bun.write(
				path.join(earlyDir, "a.ts"),
				Array.from({ length: 8 }, () => "const sharedSymbol = 1;").join("\n"),
			);
			await Bun.write(
				path.join(lateDir, "z.ts"),
				Array.from({ length: 8 }, () => "const sharedSymbol = 1;").join("\n"),
			);

			const tool = await getAstTool(createTestSession(tempDir), ["ast"]);

			// skip spans the globally merged ordering (a/* before z/*), so skipping
			// past a.ts's 8 matches must surface only z.ts — while matchCount still
			// reports the untruncated total across both targets.
			const result = await tool.execute("ast-search-multi-skip", {
				mode: "search",
				pat: "sharedSymbol",
				path: `${earlyDir};${lateDir}`,
				skip: 8,
			});
			const text = textOf(result);
			const details = result.details as { matchCount?: number; limitReached?: boolean } | undefined;

			expect(details?.matchCount).toBe(16);
			expect(details?.limitReached).toBe(false);
			expect(text).toContain("z.ts");
			expect(text).not.toContain("a.ts");
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("parses PlusCal content through the tlaplus language aliases", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-search-pluscal-"));
		try {
			const filePath = path.join(tempDir, "algo.tla");
			await Bun.write(
				filePath,
				"---- MODULE Algo ----\n(*--algorithm Demo\nvariables x = 0;\nbegin\n  x := x + 1;\nend algorithm;*)\n====\n",
			);
			const tool = await getAstTool(createTestSession(tempDir), ["ast"]);

			const result = await tool.execute("ast-search-pluscal", {
				mode: "search",
				pat: "x",
				path: filePath,
				lang: "pluscal",
			});
			const details = result.details as { matchCount?: number } | undefined;
			expect(details?.matchCount).toBeGreaterThan(0);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("honors an explicit C++ language for ambiguous headers", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-search-cpp-header-"));
		try {
			const filePath = path.join(tempDir, "buffer.h");
			await Bun.write(filePath, "class Buffer { public: int size() const { return 1; } };\n");
			const tool = await getAstTool(createTestSession(tempDir), ["ast"]);

			const result = await tool.execute("ast-search-explicit-cpp", {
				mode: "search",
				pat: "class Buffer",
				path: filePath,
				lang: "cpp",
			});
			const details = result.details as { matchCount?: number } | undefined;
			expect(details?.matchCount).toBe(1);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("forwards an explicit language to every multi-target branch", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-search-multi-lang-"));
		try {
			// `.h` infers as C, so only the explicit `cpp` override can match the
			// class pattern — and only if `runMultiTargetAstGrep` forwards `lang`
			// to each per-target `astGrep` call behind the `;` scope.
			const firstDir = path.join(tempDir, "a");
			const secondDir = path.join(tempDir, "b");
			await fs.mkdir(firstDir, { recursive: true });
			await fs.mkdir(secondDir, { recursive: true });
			for (const dir of [firstDir, secondDir]) {
				await Bun.write(path.join(dir, "buffer.h"), "class Buffer { public: int size() const { return 1; } };\n");
			}
			const tool = await getAstTool(createTestSession(tempDir), ["ast"]);

			const result = await tool.execute("ast-search-multi-lang", {
				mode: "search",
				pat: "class Buffer",
				path: `${firstDir};${secondDir}`,
				lang: "cpp",
			});
			const details = result.details as { matchCount?: number } | undefined;
			expect(details?.matchCount).toBe(2);
		} finally {
			await removeWithRetries(tempDir);
		}
	});
});

describe("ast edit", () => {
	it("uses op entries as [{ pat, out }]", async () => {
		const tool = await getAstTool(createTestSession("/tmp/test", {}, { search: false }));
		const schema = toolWireSchema(tool);
		const properties = asSchemaObject(schema.properties);
		const ops = asSchemaObject(properties.ops);

		expect(ops.type).toBe("array");
		const items = asSchemaObject(ops.items);
		expect(items.type).toBe("object");
		expect(items.required).toEqual(["pat", "out"]);
		const itemProperties = asSchemaObject(items.properties);
		expect(asSchemaObject(itemProperties.pat).type).toBe("string");
		expect(asSchemaObject(itemProperties.out).type).toBe("string");
		expect(properties.preview).toBeUndefined();
		expect(properties.paths).toBeUndefined();
	});

	it("remains strict-representable after strict adaptation in every mode set", async () => {
		for (const modes of [{}, { search: false }, { edit: false }] satisfies ModeSettings[]) {
			const tool = await getAstTool(createTestSession("/tmp/test", {}, modes));
			const strict = adaptSchemaForStrict(toolWireSchema(tool), true);
			expect(strict.strict).toBe(true);
		}
	});

	it("renders +/- lines with numbered hashline prefixes", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-render-"));
		try {
			const filePath = path.join(tempDir, "legacy.ts");
			await Bun.write(filePath, "legacyWrap(x, value)\n");

			const tool = await getAstTool(createTestSession(tempDir));
			const result = await tool.execute("ast-edit-test", {
				mode: "edit",
				ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
				path: filePath,
			});
			const lines = textOf(result).split("\n");
			const removedLine = lines.find(line => line.startsWith("-"));
			const addedLine = lines.find(line => line.startsWith("+"));

			expect(removedLine).toBeDefined();
			expect(addedLine).toBeDefined();
			expect(removedLine).toMatch(/^-\d+:/);
			expect(addedLine).toMatch(/^\+\d+:/);
			expect(removedLine?.split(":", 1)[0].length).toBe(addedLine?.split(":", 1)[0].length);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("registers a pending action that apply writes changes", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-pending-"));
		try {
			const filePath = path.join(tempDir, "legacy.ts");
			await Bun.write(filePath, "legacyWrap(x, value)\n");
			const queue = new ToolChoiceQueue();

			const tool = await getAstTool(createEditSession(tempDir, queue));
			const previewResult = await tool.execute("ast-edit-preview", {
				mode: "edit",
				ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
				path: filePath,
			});
			expect(previewResult.details).toBeDefined();
			expect((previewResult.details as { applied?: boolean }).applied).toBe(false);

			expect(queue.hasPendingInvoker).toBe(true);
			const invoker = queue.peekPendingInvoker()!;
			const applyResult = (await invoker({
				action: "apply",
				reason: "apply previewed AST edit",
			})) as InvokedToolResult;
			expect(applyResult.isError).toBeUndefined();
			expect(textOf(applyResult)).toContain("Applied 1 replacement in 1 file.");
			expect(
				(applyResult.details as { sourceResultDetails?: { totalReplacements?: number } } | undefined)
					?.sourceResultDetails?.totalReplacements,
			).toBe(1);
			const updated = await Bun.file(filePath).text();
			expect(updated).toContain("modernWrap(x, value)");
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("fails stale pending apply when preview no longer matches", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-stale-"));
		try {
			const filePath = path.join(tempDir, "legacy.ts");
			await Bun.write(filePath, "legacyWrap(x, value)\n");
			const queue = new ToolChoiceQueue();

			const tool = await getAstTool(createEditSession(tempDir, queue));
			const previewResult = await tool.execute("ast-edit-preview", {
				mode: "edit",
				ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
				path: filePath,
			});
			expect((previewResult.details as { totalReplacements?: number } | undefined)?.totalReplacements).toBe(1);

			const mutatedContent = "otherWrap(x, value)\n";
			await Bun.write(filePath, mutatedContent);

			const invoker = queue.peekPendingInvoker()!;
			const applyResult = (await invoker({ action: "apply", reason: "apply stale preview" })) as InvokedToolResult;
			const applyText = textOf(applyResult);

			expect(applyResult.isError).toBe(true);
			expect(applyText).toContain("Preview is stale / no longer matches");
			expect(applyText).toContain("no replacements were applied");
			expect(
				(applyResult.details as { sourceResultDetails?: { totalReplacements?: number } } | undefined)
					?.sourceResultDetails?.totalReplacements,
			).toBe(0);
			expect(await Bun.file(filePath).text()).toBe(mutatedContent);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("combines globbing from path and glob parameters", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-glob-"));
		try {
			const packagesDir = path.join(tempDir, "packages");
			const sourceDir = path.join(packagesDir, "pkg-123", "src");
			const nestedDir = path.join(sourceDir, "nested");
			await fs.mkdir(nestedDir, { recursive: true });
			await Bun.write(path.join(sourceDir, "root.ts"), "legacyWrap(rootValue, rootArg)\n");
			await Bun.write(path.join(nestedDir, "child.ts"), "legacyWrap(childValue, childArg)\n");
			await Bun.write(path.join(sourceDir, "ignore.js"), "legacyWrap(ignoreValue, ignoreArg)\n");
			await Bun.write(path.join(tempDir, "outside.ts"), "legacyWrap(outsideValue, outsideArg)\n");
			const queue = new ToolChoiceQueue();

			const tool = await getAstTool(createEditSession(tempDir, queue));
			const previewResult = await tool.execute("ast-edit-glob", {
				mode: "edit",
				ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
				path: `${packagesDir}/pkg-*/src/**/*.ts`,
			});

			const text = textOf(previewResult);
			const details = previewResult.details as
				| { totalReplacements?: number; fileReplacements?: Array<{ path: string; count: number }> }
				| undefined;

			// Multi-level tree output: `# packages/pkg-…/src/`, `## root.ts#<hash>`, then a
			// nested `## nested/` directory with `### child.ts#<hash>` under it.
			expect(text).toMatch(/^## root\.ts#[0-9A-F]{4} \(\d+ replacement[s]?\)$/m);
			expect(text).toMatch(/^### child\.ts#[0-9A-F]{4} \(\d+ replacement[s]?\)$/m);
			expect(text).not.toContain("ignore.js");
			expect(text).not.toContain("outside.ts");
			expect(details?.totalReplacements).toBe(2);
			expect(details?.fileReplacements).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ path: "packages/pkg-123/src/root.ts", count: 1 }),
					expect.objectContaining({ path: "packages/pkg-123/src/nested/child.ts", count: 1 }),
				]),
			);

			const invoker = queue.peekPendingInvoker()!;
			await invoker({ action: "apply", reason: "apply previewed AST edit with combined globs" });

			expect(await Bun.file(path.join(sourceDir, "root.ts")).text()).toContain("modernWrap(rootValue, rootArg)");
			expect(await Bun.file(path.join(nestedDir, "child.ts")).text()).toContain("modernWrap(childValue, childArg)");
			expect(await Bun.file(path.join(sourceDir, "ignore.js")).text()).toContain(
				"legacyWrap(ignoreValue, ignoreArg)",
			);
			expect(await Bun.file(path.join(tempDir, "outside.ts")).text()).toContain(
				"legacyWrap(outsideValue, outsideArg)",
			);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("applies across a semicolon-delimited path list", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-multi-path-"));
		try {
			const firstPath = path.join(tempDir, "a.ts");
			const secondPath = path.join(tempDir, "b.ts");
			await Bun.write(firstPath, "legacyWrap(a, b)\n");
			await Bun.write(secondPath, "legacyWrap(c, d)\n");
			const queue = new ToolChoiceQueue();

			const tool = await getAstTool(createEditSession(tempDir, queue));
			const previewResult = await tool.execute("ast-edit-multi-path", {
				mode: "edit",
				ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
				path: `${firstPath}; ${secondPath}`,
			});
			expect((previewResult.details as { totalReplacements?: number } | undefined)?.totalReplacements).toBe(2);

			const invoker = queue.peekPendingInvoker()!;
			await invoker({ action: "apply", reason: "apply multi-path AST edit" });
			expect(await Bun.file(firstPath).text()).toContain("modernWrap(a, b)");
			expect(await Bun.file(secondPath).text()).toContain("modernWrap(c, d)");
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("infers tlaplus from .tla files for AST edits", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-tlaplus-"));
		try {
			const filePath = path.join(tempDir, "Spec.tla");
			await Bun.write(filePath, `---- MODULE Spec ----\nVARIABLE x\n\nInit == x = 0\n\nNext == x' = x + 1\n====\n`);
			const queue = new ToolChoiceQueue();

			const tool = await getAstTool(createEditSession(tempDir, queue));
			const previewResult = await tool.execute("ast-edit-tlaplus", {
				mode: "edit",
				ops: [{ pat: "Init", out: "Start" }],
				path: filePath,
			});

			const details = previewResult.details as { totalReplacements?: number; parseErrors?: string[] } | undefined;
			expect(textOf(previewResult)).toContain("Start");
			expect(details?.totalReplacements).toBe(1);
			expect(details?.parseErrors).toBeUndefined();

			const invoker = queue.peekPendingInvoker()!;
			await invoker({ action: "apply", reason: "apply tlaplus AST edit" });
			expect(await Bun.file(filePath).text()).toContain("Start == x = 0");
		} finally {
			await removeWithRetries(tempDir);
		}
	});
});
