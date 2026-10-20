import { type FindToolDetails, findToolRenderer } from "./find";
import { type GlobToolDetails, globToolRenderer } from "./glob";
import { type GrepToolDetails, grepToolRenderer } from "./grep";
import type { ToolRenderer } from "./renderer";

/** Result details of the `search` tool: regex, glob, or semantic payload. */
export type SearchToolDetails = GrepToolDetails | GlobToolDetails | FindToolDetails;

interface SearchRenderArgs {
	mode?: string;
	pattern?: string;
	query?: string;
	grep_keywords?: string[];
	path?: string;
}

/** Mirrors coding-agent `searchCallMode`: explicit `mode`, else `query` means semantic, else `pattern` means regex, else glob. */
function callMode(args: SearchRenderArgs | undefined): "regex" | "glob" | "semantic" {
	if (args?.mode === "regex" || args?.mode === "glob" || args?.mode === "semantic") return args.mode;
	if (args?.query !== undefined) return "semantic";
	if (args?.pattern !== undefined) return "regex";
	return "glob";
}

function detailsMode(details: SearchToolDetails | undefined): "regex" | "glob" | "semantic" | undefined {
	if (details === undefined) return undefined;
	if ("hits" in details) return "semantic";
	if ("fileMatches" in details) return "regex";
	return "glob";
}

/** Render `search` calls through the matching mode renderer. */
export const searchToolRenderer = {
	inline: true,
	renderCall(args, options, uiTheme) {
		const mode = callMode(args);
		if (mode === "semantic") return findToolRenderer.renderCall(args as never, options, uiTheme);
		if (mode === "regex") return grepToolRenderer.renderCall(args as never, options, uiTheme);
		return globToolRenderer.renderCall(args as never, options, uiTheme);
	},
	renderResult(result, options, uiTheme, args) {
		const mode = detailsMode(result.details as SearchToolDetails | undefined) ?? callMode(args);
		if (mode === "semantic") {
			return findToolRenderer.renderResult(
				{ ...result, details: result.details as FindToolDetails | undefined },
				options,
				uiTheme,
				args as never,
			);
		}
		if (mode === "regex") {
			return grepToolRenderer.renderResult(
				{ ...result, details: result.details as GrepToolDetails | undefined },
				options,
				uiTheme,
				args as never,
			);
		}
		return globToolRenderer.renderResult(
			{ ...result, details: result.details as GlobToolDetails | undefined },
			options,
			uiTheme,
			args as never,
		);
	},
	mergeCallAndResult: true,
} satisfies ToolRenderer<SearchRenderArgs, SearchToolDetails>;
