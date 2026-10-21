import type { SearchMode } from "./search";

export const BUILTIN_TOOL_NAMES = [
	"read",
	"bash",
	"edit",
	"ast",
	"ask",
	"debug",
	"ida",
	"eval",
	"github",
	"search",
	"lsp",
	"checkpoint",
	"rewind",
	"context_notes",
	"new_context",
	"security_scan",
	"task",
	"wait",
	"todo",
	"web_search",
	"write",
	"memory_edit",
	"retain",
	"recall",
	"reflect",
	"learn",
	"manage_skill",
] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

export const HIDDEN_TOOL_NAMES = ["yield", "goal", "think"] as const;

export type HiddenToolName = (typeof HIDDEN_TOOL_NAMES)[number];

// Aliases grant the whole merged tool: a list naming only `glob` (or `grep`/`find`) yields
// `search` with every enabled mode, and `createTools` then auto-adds `ast` (if ast-grep is
// enabled) and, with `read` under context management, `context_notes`/`new_context` for
// unrestricted sessions.
const LEGACY_BUILTIN_TOOL_NAME_ALIASES: ReadonlyMap<string, BuiltinToolName> = new Map([
	["ast_grep", "ast"],
	["ast_edit", "ast"],
	["grep", "search"],
	["glob", "search"],
	["find", "search"],
]);

/** `search` mode that replaced each pre-merge search tool name (`grep`, `glob`, `find`). */
export const LEGACY_SEARCH_TOOL_MODES: Readonly<Record<string, SearchMode>> = {
	grep: "regex",
	glob: "glob",
	find: "semantic",
};

/** The `search` mode a pre-merge search tool name maps to, or `undefined` for any other name. */
export function legacySearchToolMode(name: string): SearchMode | undefined {
	return Object.hasOwn(LEGACY_SEARCH_TOOL_MODES, name) ? LEGACY_SEARCH_TOOL_MODES[name] : undefined;
}

const CANONICAL_TOOL_NAMES: Record<string, true> = Object.fromEntries(
	[...BUILTIN_TOOL_NAMES, ...HIDDEN_TOOL_NAMES].map(name => [name, true]),
);

/** Canonicalize built-in IDs and legacy aliases. Leave plugin names unchanged. */
export function normalizeToolName(name: string): string {
	const lower = name.toLowerCase();
	return LEGACY_BUILTIN_TOOL_NAME_ALIASES.get(lower) ?? (Object.hasOwn(CANONICAL_TOOL_NAMES, lower) ? lower : name);
}

/** Normalize and deduplicate tool names while preserving first-seen order. */
export function normalizeToolNames(names: Iterable<string>): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const name of names) {
		const normalized = normalizeToolName(name);
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		out.push(normalized);
	}
	return out;
}

/** MCP tool names carry the `mcp__<server>_<tool>` prefix minted by `createMCPToolName`. */
export function isMCPToolName(name: string): boolean {
	return name.startsWith("mcp__");
}
