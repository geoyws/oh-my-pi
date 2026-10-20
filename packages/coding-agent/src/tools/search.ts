import type { SearchToolDetails } from "@oh-my-pi/pi-tui/tools/search";
import { type } from "@oh-my-pi/omptype";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-pi/pi-agent-core";
import type { ToolExample } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import searchDescription from "../prompts/tools/search.md" with { type: "text" };
import { sessionDelegationBias } from "../task/prompt-policy";
import { cfgTaskDisabledAgents } from "../task/settings";
import { isScoutSpawnable } from "../task/spawn-policy";
import type { ToolSession } from ".";
import { GlobTool } from "./glob";
import { GrepTool } from "./grep";
import { FindTool, isFindEnabled } from "./jfind";
import { searchPathTier } from "./path-utils";
import { cfgGlobEnabled, cfgGrepEnabled } from "./settings";

/** `search` tool modes, in display order. */
export const SEARCH_MODES = ["regex", "glob", "semantic"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

const regexFields = {
	pattern: type("string"),
	"path?": type("string").describe("file, directory, glob, or URL; `;`-separated; default `.`"),
	"case?": "boolean",
	"gitignore?": "boolean",
	"skip?": type("number").or("null"),
};

const globFields = {
	"path?": "string",
	"hidden?": "boolean",
	"gitignore?": "boolean",
	"limit?": "number",
};

const semanticFields = {
	query: "string",
	grep_keywords: "string[]",
	"path?": "string",
};

/**
 * Both-modes wire schema. {@link buildSearchSchema} narrows the wire copy per
 * session so an unavailable mode is never advertised; single-mode copies drop
 * `mode` and {@link searchCallMode} infers it from the fields present.
 */
export const searchSchema = type({
	mode: type("'regex' | 'glob' | 'semantic'").describe(
		"regex: content by pattern; glob: files by pattern; semantic: behavior by description",
	),
	"pattern?": "string",
	"query?": "string",
	"grep_keywords?": "string[]",
	"path?": "string",
	"case?": "boolean",
	"gitignore?": "boolean",
	"hidden?": "boolean",
	"limit?": "number",
	"skip?": type("number").or("null"),
});
/** Call input; `mode` is absent when the session advertises a single-mode schema. */
export type SearchToolParams = Omit<typeof searchSchema.infer, "mode"> & { mode?: SearchMode };

const regexOnlySchema = type(regexFields);
const globOnlySchema = type(globFields);
const semanticOnlySchema = type(semanticFields);

/**
 * Effective mode of a call: explicit `mode`, else `query` means semantic, else
 * `pattern` means regex, else glob. Approval, execution, and renderers all
 * classify calls through this rule.
 */
export function searchCallMode(args: unknown): SearchMode {
	const params = (args ?? {}) as Partial<SearchToolParams>;
	if (params.mode === "regex" || params.mode === "glob" || params.mode === "semantic") return params.mode;
	if (params.query !== undefined) return "semantic";
	if (params.pattern !== undefined) return "regex";
	return "glob";
}

function buildSearchSchema(modes: readonly SearchMode[]): typeof searchSchema {
	if (modes.length === 1 && modes[0] === "regex") return regexOnlySchema as unknown as typeof searchSchema;
	if (modes.length === 1 && modes[0] === "glob") return globOnlySchema as unknown as typeof searchSchema;
	if (modes.length === 1 && modes[0] === "semantic") return semanticOnlySchema as unknown as typeof searchSchema;
	// Multi-mode: advertise only the available modes' fields, so a disabled
	// mode's parameters never reach the wire.
	const fields: Record<string, unknown> = {
		mode: type("'regex' | 'glob' | 'semantic'").describe(
			"regex: content by pattern; glob: files by pattern; semantic: behavior by description",
		),
		"path?": "string",
	};
	if (modes.includes("regex")) {
		fields["pattern?"] = "string";
		fields["case?"] = "boolean";
		fields["skip?"] = type("number").or("null");
	}
	if (modes.includes("regex") || modes.includes("glob")) {
		fields["gitignore?"] = "boolean";
	}
	if (modes.includes("glob")) {
		fields["hidden?"] = "boolean";
		fields["limit?"] = "number";
	}
	if (modes.includes("semantic")) {
		fields["query?"] = "string";
		fields["grep_keywords?"] = "string[]";
	}
	return type(fields) as unknown as typeof searchSchema;
}

/**
 * Modes this session may use. Regex follows `grep.enabled`, glob follows
 * `glob.enabled`, semantic follows `find` availability (find.enabled + judge).
 */
export function resolveSearchModes(session: ToolSession): SearchMode[] {
	const modes: SearchMode[] = [];
	if (cfgGrepEnabled.get(session.settings)) modes.push("regex");
	if (cfgGlobEnabled.get(session.settings)) modes.push("glob");
	if (isFindEnabled(session)) modes.push("semantic");
	return modes;
}

const LEGACY_POLICY_KEYS: Record<SearchMode, string> = { regex: "grep", glob: "glob", semantic: "find" };

const ALL_EXAMPLES: readonly ToolExample<SearchToolParams>[] = [
	{
		caption: "Regex content search",
		call: { mode: "regex", pattern: "function\\s+main", path: "src" },
	},
	{
		caption: "Find TypeScript files by name",
		call: { mode: "glob", path: "src/**/*.ts" },
	},
	{
		caption: "Semantic behavior search",
		call: { mode: "semantic", query: "validates incoming webhooks", grep_keywords: ["webhook", "signature"] },
	},
];

/**
 * Unified search tool: `mode: "regex"` (formerly `grep`), `mode: "glob"`
 * (formerly `glob`), and `mode: "semantic"` (formerly `find`) over one schema.
 * Execution delegates to the existing tool implementations.
 */
export class SearchTool implements AgentTool<typeof searchSchema, SearchToolDetails> {
	readonly name = "search";
	readonly label = "Search";
	readonly summary = "Search contents, file names, and behavior (regex/glob/semantic)";
	readonly strict = true;
	readonly loadMode = "essential";
	// Plain properties, not #fields: xdev docs render through Object.create
	// clones of mounted tools, where #field access throws.
	private cachedParams: typeof searchSchema | undefined;
	private paramsKey: string | undefined;
	private descriptionKey = "";
	private descriptionText = "";
	private readonly regexTool: GrepTool;
	private readonly globTool: GlobTool;
	private readonly semanticTool: FindTool;

	/** Construct only when at least one mode is usable in this session. */
	static createIf(session: ToolSession): SearchTool | null {
		return resolveSearchModes(session).length > 0 ? new SearchTool(session) : null;
	}

	constructor(private readonly session: ToolSession) {
		this.regexTool = new GrepTool(session);
		this.globTool = new GlobTool(session, { rootPathAlias: true });
		this.semanticTool = new FindTool(session);
	}

	readonly approval = (args: unknown): ToolApprovalDecision => {
		const mode = searchCallMode(args);
		// All three mode runners share `searchPathTier`; the merge adds only the
		// per-mode policy key so pre-merge user policies keep applying.
		return { tier: searchPathTier(args), policyKey: LEGACY_POLICY_KEYS[mode] };
	};

	readonly approvalCacheTargets = (args: unknown): readonly string[] | undefined => {
		const mode = searchCallMode(args);
		const sub = mode === "regex" ? this.regexTool : mode === "glob" ? this.globTool : this.semanticTool;
		return sub.approvalCacheTargets?.(args);
	};

	get description(): string {
		const modes = resolveSearchModes(this.session);
		const eagerDelegation = sessionDelegationBias(this.session) === "eager";
		const scoutAvailable = isScoutSpawnable(
			cfgTaskDisabledAgents.get(this.session.settings),
			this.session.getSessionSpawns?.() ?? "*",
		);
		const key = `${modes.join(",")}|${eagerDelegation ? 1 : 0}|${scoutAvailable ? 1 : 0}`;
		if (key !== this.descriptionKey) {
			this.descriptionText = prompt.render(searchDescription, {
				regex: modes.includes("regex"),
				glob: modes.includes("glob"),
				semantic: modes.includes("semantic"),
				eagerDelegation,
				scoutAvailable,
			});
			this.descriptionKey = key;
		}
		return this.descriptionText;
	}

	get parameters(): typeof searchSchema {
		const modes = resolveSearchModes(this.session);
		const key = modes.join(",");
		if (this.paramsKey !== key) {
			this.cachedParams = buildSearchSchema(modes);
			this.paramsKey = key;
		}
		return this.cachedParams ?? searchSchema;
	}

	get examples(): readonly ToolExample<SearchToolParams>[] {
		const modes = resolveSearchModes(this.session);
		const available = ALL_EXAMPLES.filter(
			example => "call" in example && modes.includes(searchCallMode(example.call)),
		);
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
		params: SearchToolParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<SearchToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<SearchToolDetails>> {
		const modes = resolveSearchModes(this.session);
		const mode = searchCallMode(params);
		if (!modes.includes(mode)) {
			throw new ToolError(
				`\`search\` ${mode} mode is unavailable in this session; available: ${modes.join(", ") || "none"}.`,
			);
		}
		if (mode === "regex") {
			if (params.query !== undefined || params.grep_keywords !== undefined) {
				throw new ToolError("`query` and `grep_keywords` are semantic-only; regex takes `pattern`.");
			}
			if (typeof params.pattern !== "string" || params.pattern.length === 0) {
				throw new ToolError("regex mode requires `pattern`.");
			}
			return this.regexTool.execute(
				_toolCallId,
				{
					pattern: params.pattern,
					path: params.path,
					case: params.case,
					gitignore: params.gitignore,
					skip: params.skip,
				},
				signal,
			) as Promise<AgentToolResult<SearchToolDetails>>;
		}
		if (mode === "glob") {
			if (params.pattern !== undefined || params.query !== undefined) {
				throw new ToolError(
					"`pattern` is regex-only and `query` is semantic-only; glob takes `path` as its pattern.",
				);
			}
			return this.globTool.execute(
				_toolCallId,
				{
					path: params.path,
					hidden: params.hidden,
					gitignore: params.gitignore,
					limit: params.limit,
				},
				signal,
			) as Promise<AgentToolResult<SearchToolDetails>>;
		}
		if (params.pattern !== undefined) {
			throw new ToolError("`pattern` is regex-only; semantic takes `query` and `grep_keywords`.");
		}
		if (typeof params.query !== "string" || params.query.trim().length === 0) {
			throw new ToolError("semantic mode requires `query`.");
		}
		return this.semanticTool.execute(
			_toolCallId,
			{
				query: params.query,
				grep_keywords: params.grep_keywords ?? [],
				path: params.path,
			},
			signal,
		) as Promise<AgentToolResult<SearchToolDetails>>;
	}
}
