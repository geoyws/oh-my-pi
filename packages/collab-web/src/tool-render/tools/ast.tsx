/** `ast` — structural AST search (`mode: "search"`) and rewrites (`mode: "edit"`), dispatched per call. */
import type { ReactNode } from "react";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord } from "../util";
import { astEditRenderer } from "./ast-edit";
import { astGrepRenderer } from "./ast-grep";

/** Mirrors coding-agent `astCallMode` (explicit `mode`, else `ops` means edit); results fall back to `totalReplacements`. */
function modeRenderer(props: ToolRenderProps): ToolRenderer {
	const { mode, ops } = props.args;
	const isEdit =
		mode === "edit" ||
		(mode === undefined && ops !== undefined) ||
		detailsRecord(props.result)?.totalReplacements !== undefined;
	return isEdit ? astEditRenderer : astGrepRenderer;
}

function Summary(props: ToolRenderProps): ReactNode {
	const { Summary: ModeSummary } = modeRenderer(props);
	return <ModeSummary {...props} />;
}

function Body(props: ToolRenderProps): ReactNode {
	const { Body: ModeBody } = modeRenderer(props);
	return ModeBody ? <ModeBody {...props} /> : null;
}

export const astRenderer: ToolRenderer = { Summary, Body };
