/** `search` — regex content search, glob file search, and semantic search, dispatched per call. */
import type { ReactNode } from "react";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord } from "../util";
import { globRenderer } from "./glob";
import { grepRenderer } from "./grep";

/** Mirrors coding-agent `searchCallMode`; semantic and glob share the glob renderer here. */
function modeRenderer(props: ToolRenderProps): ToolRenderer {
	const { mode, pattern, query } = props.args;
	const details = detailsRecord(props.result);
	const isRegex =
		mode === "regex" ||
		(mode === undefined && query === undefined && pattern !== undefined) ||
		details?.fileMatches !== undefined ||
		details?.matchCount !== undefined;
	return isRegex ? grepRenderer : globRenderer;
}

function Summary(props: ToolRenderProps): ReactNode {
	const { Summary: ModeSummary } = modeRenderer(props);
	return <ModeSummary {...props} />;
}

function Body(props: ToolRenderProps): ReactNode {
	const { Body: ModeBody } = modeRenderer(props);
	return ModeBody ? <ModeBody {...props} /> : null;
}

export const searchRenderer: ToolRenderer = { Summary, Body };
