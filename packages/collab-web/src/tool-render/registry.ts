/**
 * Tool renderer registry. Keys are current wire tool names.
 * Unknown tools fall back to the generic JSON renderer.
 */
import { genericRenderer } from "./generic";
import { askRenderer } from "./tools/ask";
import { astRenderer } from "./tools/ast";
import { bashRenderer } from "./tools/bash";
import { browserRenderer } from "./tools/browser";
import { debugRenderer } from "./tools/debug";
import { editRenderer } from "./tools/edit";
import { evalRenderer } from "./tools/eval";
import { fetchRenderer } from "./tools/fetch";
import { generateImageRenderer } from "./tools/generate-image";
import { githubRenderer } from "./tools/github";
import { goalRenderer } from "./tools/goal";
import { searchRenderer } from "./tools/search";
import { waitRenderer } from "./tools/wait";
import { lspRenderer } from "./tools/lsp";
import { recallRenderer } from "./tools/memory-recall";
import { reflectRenderer } from "./tools/memory-reflect";
import { retainRenderer } from "./tools/memory-retain";
import { readRenderer } from "./tools/read";
import { reportToolIssueRenderer } from "./tools/report-tool-issue";
import { resolveRenderer } from "./tools/resolve";
import { taskRenderer } from "./tools/task";
import { todoRenderer } from "./tools/todo";
import { webSearchRenderer } from "./tools/web-search";
import { writeRenderer } from "./tools/write";
import { yieldRenderer } from "./tools/yield";
import type { ToolRenderer } from "./types";

const RENDERERS: Record<string, ToolRenderer> = {
	ask: askRenderer,
	ast: astRenderer,
	bash: bashRenderer,
	browser: browserRenderer,
	puppeteer: browserRenderer,
	debug: debugRenderer,
	edit: editRenderer,
	apply_patch: editRenderer,
	eval: evalRenderer,
	js: evalRenderer,
	python: evalRenderer,
	notebook: evalRenderer,
	fetch: fetchRenderer,
	generate_image: generateImageRenderer,
	github: githubRenderer,
	// Pre-merge names, so transcripts recorded before `search` still render.
	glob: searchRenderer,
	find: searchRenderer,
	grep: searchRenderer,
	goal: goalRenderer,
	wait: waitRenderer,
	lsp: lspRenderer,
	recall: recallRenderer,
	reflect: reflectRenderer,
	retain: retainRenderer,
	read: readRenderer,
	report_tool_issue: reportToolIssueRenderer,
	resolve: resolveRenderer,
	reject: resolveRenderer,
	propose: resolveRenderer,
	search: searchRenderer,
	task: taskRenderer,
	todo: todoRenderer,
	web_search: webSearchRenderer,
	write: writeRenderer,
	yield: yieldRenderer,
};

export function resolveToolRenderer(name: string): ToolRenderer {
	return RENDERERS[name] ?? genericRenderer;
}
