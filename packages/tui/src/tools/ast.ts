import { type AstEditToolDetails, astEditToolRenderer } from "./ast-edit";
import { type AstGrepToolDetails, astGrepToolRenderer } from "./ast-grep";
import type { ToolRenderer } from "./renderer";

/** Result details of the `ast` tool: search-mode or edit-mode payload. */
export type AstToolDetails = AstGrepToolDetails | AstEditToolDetails;

interface AstRenderArgs {
	mode?: string;
	pat?: string;
	ops?: Array<{ pat?: string; out?: string }>;
	path?: string;
	skip?: number;
}

/** Mirrors coding-agent `astCallMode`: explicit `mode`, else `ops` means edit. */
function isEditCall(args: AstRenderArgs | undefined): boolean {
	return args?.mode === "edit" || (args?.mode === undefined && args?.ops !== undefined);
}

/** Render `ast` calls through the matching mode renderer (edit-mode details carry `totalReplacements`). */
export const astToolRenderer = {
	inline: true,
	renderCall(args, options, uiTheme) {
		return isEditCall(args)
			? astEditToolRenderer.renderCall(args, options, uiTheme)
			: astGrepToolRenderer.renderCall(args, options, uiTheme);
	},
	renderResult(result, options, uiTheme, args) {
		const details = result.details;
		const isEdit = isEditCall(args) || (details !== undefined && "totalReplacements" in details);
		return isEdit
			? astEditToolRenderer.renderResult(
					{ ...result, details: details as AstEditToolDetails | undefined },
					options,
					uiTheme,
					args,
				)
			: astGrepToolRenderer.renderResult(
					{ ...result, details: details as AstGrepToolDetails | undefined },
					options,
					uiTheme,
					args,
				);
	},
	mergeCallAndResult: true,
} satisfies ToolRenderer<AstRenderArgs, AstToolDetails>;
