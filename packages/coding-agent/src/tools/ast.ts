import type { AstToolDetails } from "@oh-my-pi/pi-tui/tools/ast";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ToolExample } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { toPathList } from "@oh-my-pi/pi-tui/render/render-utils";
import astDescription from "../prompts/tools/ast.md" with { type: "text" };
import { sessionDelegationBias } from "../task/prompt-policy";
import { cfgTaskDisabledAgents } from "../task/settings";
import { isScoutSpawnable } from "../task/spawn-policy";
import type { ToolSession } from ".";
import { truncateForPrompt } from "./approval";
import { astEditApproval, runAstEdit } from "./ast-edit";
import { astSearchApproval, astSearchApprovalCacheTargets, runAstSearch } from "./ast-grep";
import { cfgAstEditEnabled, cfgAstGrepEnabled } from "./settings";

/** `ast` tool modes, in display order. */
export const AST_MODES = ["search", "edit"] as const;
export type AstMode = (typeof AST_MODES)[number];

const astOpSchema = type({
	pat: type("string").describe("ast pattern"),
	out: type("string").describe("replacement template"),
});

const SEARCH_PATH_DESCRIPTION =
	'file, directory, glob, or internal URL to search; pass several as a semicolon-delimited list ("src; tests"). Omitted -> searches the workspace root (".")';
const EDIT_PATH_DESCRIPTION =
	'file, directory, glob, or internal URL to rewrite; pass several as a semicolon-delimited list ("src; tests")';
const SHARED_PATH_DESCRIPTION =
	'file, directory, glob, or internal URL; pass several as a semicolon-delimited list ("src; tests"). search defaults to the workspace root ("."); edit requires it';

/**
 * Both-modes wire schema, and the type-level source of truth. {@link buildAstSchema}
 * narrows the wire copy per session so a disabled mode (setting off, or edit
 * without the `edit` grant) is never advertised; single-mode copies also drop
 * `mode` and {@link astCallMode} infers it.
 */
export const astSchema = type({
	mode: type("'search' | 'edit'").describe("search: find matches; edit: stage rewrites"),
	"pat?": type("string").describe("search: ast pattern"),
	"ops?": astOpSchema.array().atLeastLength(1).describe("edit: rewrite ops"),
	"path?": type("string").describe(SHARED_PATH_DESCRIPTION),
	"lang?": type("string").describe("search: language override, e.g. cpp for ambiguous .h files"),
	"skip?": type("number").describe("search: matches to skip"),
});
/** Call input; `mode` is absent when the session advertises a single-mode schema. */
export type AstToolParams = Omit<typeof astSchema.infer, "mode"> & { mode?: AstMode };

const astSearchOnlySchema = type({
	pat: type("string").describe("ast pattern"),
	"path?": type("string").describe(SEARCH_PATH_DESCRIPTION),
	"lang?": type("string").describe("language override, e.g. cpp for ambiguous .h files"),
	"skip?": type("number").describe("matches to skip"),
});

const astEditOnlySchema = type({
	ops: astOpSchema.array().atLeastLength(1).describe("rewrite ops"),
	path: type("string").describe(EDIT_PATH_DESCRIPTION),
});

/**
 * Effective mode of a call: explicit `mode`, else `ops` means edit, else search.
 * Approval, execution, and renderers all classify calls through this rule.
 */
export function astCallMode(args: unknown): AstMode {
	const params = (args ?? {}) as Partial<AstToolParams>;
	if (params.mode === "search" || params.mode === "edit") return params.mode;
	return params.ops !== undefined ? "edit" : "search";
}

function buildAstSchema(modes: readonly AstMode[]): typeof astSchema {
	if (modes.length === 1 && modes[0] === "search") return astSearchOnlySchema as unknown as typeof astSchema;
	if (modes.length === 1 && modes[0] === "edit") return astEditOnlySchema as unknown as typeof astSchema;
	return astSchema;
}

/**
 * Modes this session may use. Search follows `astGrep.enabled`. Edit follows
 * `astEdit.enabled` AND the session's `edit` grant, so read-only tool sets
 * (scouts, plan mode, reviewers) only ever see search.
 */
export function resolveAstModes(session: ToolSession): AstMode[] {
	const modes: AstMode[] = [];
	if (cfgAstGrepEnabled.get(session.settings)) modes.push("search");
	if (cfgAstEditEnabled.get(session.settings) && (session.isToolActive?.("edit") ?? true)) modes.push("edit");
	return modes;
}

const ALL_EXAMPLES: readonly ToolExample<AstToolParams>[] = [
	{
		caption: "Search TypeScript files under src",
		call: { mode: "search", pat: "console.log($$$)", path: "src/**/*.ts" },
	},
	{
		caption: "Named imports from a specific package",
		call: { mode: "search", pat: 'import { $$$IMPORTS } from "react"', path: "src/**/*.ts" },
	},
	{
		caption: "Method call on any object, ignoring method name with `$_`",
		call: { mode: "search", pat: "logger.$_($$$ARGS)", path: "src/**/*.ts" },
	},
	{
		caption: "Loosest existence check for a symbol in one file",
		call: { mode: "search", pat: "processItems", path: "src/worker.ts" },
	},
	{
		caption: "Rename a call site across TypeScript files",
		call: { mode: "edit", ops: [{ pat: "oldApi($$$ARGS)", out: "newApi($$$ARGS)" }], path: "src/**/*.ts" },
	},
	{
		caption: "Delete matching calls",
		call: { mode: "edit", ops: [{ pat: "console.log($$$ARGS)", out: "" }], path: "src/**/*.ts" },
	},
	{
		caption: "Modernize to optional chaining (same metavariable enforces identity)",
		call: { mode: "edit", ops: [{ pat: "$A && $A()", out: "$A?.()" }], path: "src/**/*.ts" },
	},
	{
		caption: "Swap two arguments using captures",
		call: { mode: "edit", ops: [{ pat: "assertEqual($A, $B)", out: "assertEqual($B, $A)" }], path: "tests/**/*.ts" },
	},
];

/**
 * Structural AST tool: `mode: "search"` (formerly `ast_grep`) and
 * `mode: "edit"` (formerly `ast_edit`) over one schema.
 */
export class AstTool implements AgentTool<typeof astSchema, AstToolDetails> {
	readonly name = "ast";
	readonly label = "AST";
	readonly summary = "Structural AST search and codemods (ast-grep)";
	readonly strict = true;
	readonly loadMode = "discoverable";
	// Plain properties, not #fields: xdev docs render through Object.create
	// clones of mounted tools, where #field access throws.
	private cachedParams: typeof astSchema | undefined;
	private paramsKey: string | undefined;
	private descriptionKey = "";
	private descriptionText = "";

	/** Construct only when at least one mode is usable in this session. */
	static createIf(session: ToolSession): AstTool | null {
		return resolveAstModes(session).length > 0 ? new AstTool(session) : null;
	}

	constructor(private readonly session: ToolSession) {}

	/** Search never stages; edit stages previews resolved through `write`. */
	get deferrable(): boolean {
		return resolveAstModes(this.session).includes("edit");
	}

	readonly approval = (args: unknown) => {
		return astCallMode(args) === "edit" ? astEditApproval(args) : astSearchApproval(args);
	};

	readonly approvalCacheTargets = (args: unknown): readonly string[] | undefined => {
		return astCallMode(args) === "edit" ? undefined : astSearchApprovalCacheTargets(this.session, args);
	};

	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = (args ?? {}) as Partial<AstToolParams>;
		const mode = astCallMode(args);
		const lines: string[] = [`Mode: ${mode}`];
		if (mode === "edit") {
			const ops = Array.isArray(params.ops) ? params.ops : [];
			const firstOp = ops[0];
			if (firstOp) {
				lines.push(`Pattern: ${truncateForPrompt(firstOp.pat)}`);
				lines.push(`Replacement: ${truncateForPrompt(firstOp.out)}`);
				if (ops.length > 1) lines.push(`+${ops.length - 1} more op${ops.length === 2 ? "" : "s"}`);
			}
		} else if (typeof params.pat === "string") {
			lines.push(`Pattern: ${truncateForPrompt(params.pat)}`);
		}
		if (typeof params.path === "string" && params.path.length > 0) {
			lines.push(`Paths: ${truncateForPrompt(params.path)}`);
		}
		return lines;
	};

	get description(): string {
		const modes = resolveAstModes(this.session);
		const eagerDelegation = sessionDelegationBias(this.session) === "eager";
		const scoutAvailable = isScoutSpawnable(
			cfgTaskDisabledAgents.get(this.session.settings),
			this.session.getSessionSpawns?.() ?? "*",
		);
		const key = `${modes.join(",")}|${eagerDelegation ? 1 : 0}|${scoutAvailable ? 1 : 0}`;
		if (key !== this.descriptionKey) {
			this.descriptionText = prompt.render(astDescription, {
				search: modes.includes("search"),
				edit: modes.includes("edit"),
				eagerDelegation,
				scoutAvailable,
			});
			this.descriptionKey = key;
		}
		return this.descriptionText;
	}

	get parameters(): typeof astSchema {
		const modes = resolveAstModes(this.session);
		const key = modes.join(",");
		if (this.paramsKey !== key) {
			this.cachedParams = buildAstSchema(modes);
			this.paramsKey = key;
		}
		return this.cachedParams ?? astSchema;
	}

	get examples(): readonly ToolExample<AstToolParams>[] {
		const modes = resolveAstModes(this.session);
		const available = ALL_EXAMPLES.filter(example => "call" in example && modes.includes(astCallMode(example.call)));
		if (modes.length > 1) return available;
		// Single-mode schemas carry no `mode` field; keep the examples in that shape.
		return available.map(example => {
			if (!("call" in example)) return example;
			const { mode: _mode, ...call } = example.call;
			return { ...example, call };
		});
	}

	async execute(
		_toolCallId: string,
		params: AstToolParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<AstToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<AstToolDetails>> {
		const modes = resolveAstModes(this.session);
		const mode = astCallMode(params);
		if (!modes.includes(mode)) {
			throw new ToolError(
				`\`ast\` ${mode} mode is unavailable in this session; available: ${modes.join(", ") || "none"}.`,
			);
		}
		if (mode === "search") {
			if (params.ops !== undefined) throw new ToolError("`ops` is edit-only; search takes one `pat`.");
			if (typeof params.pat !== "string") throw new ToolError("search requires `pat`.");
			return runAstSearch(
				this.session,
				{ pat: params.pat, path: params.path, lang: params.lang, skip: params.skip },
				signal,
			);
		}
		if (params.pat !== undefined || params.lang !== undefined || params.skip !== undefined) {
			throw new ToolError("`pat`, `lang`, and `skip` are search-only; edit takes `ops: [{ pat, out }]`.");
		}
		if (!params.ops || params.ops.length === 0) throw new ToolError("edit requires `ops`.");
		if (typeof params.path !== "string" || params.path.trim().length === 0) {
			throw new ToolError("edit requires `path`: the files, directories, or globs to rewrite.");
		}
		return runAstEdit(this.session, { ops: params.ops, paths: toPathList(params.path) }, this.name, signal);
	}
}
