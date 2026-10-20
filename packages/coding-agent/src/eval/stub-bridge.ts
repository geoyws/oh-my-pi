/**
 * Host-side handler for the eval `tool.$stub()` helper: Code Mode typed stubs
 * served on demand.
 *
 * Under `tools.codeModeStubs: on-demand` the eval description lists each
 * bridged tool on one line instead of embedding every signature. A cell fetches
 * the typed signature and full docs of the tools it is about to call. The stub
 * arrives as eval output (message content), so the provider tool block stays
 * byte-identical for the whole session whichever stubs the model reads.
 */
import { type Tool as AiTool, jsonSchemaToTypeScript, toolWireSchema } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { Tool, ToolSession } from "../tools";
import { promptCatalogSummary, XDEV_EXTERNAL_DESCRIPTION_CAP } from "../tools/xdev";

/** Synthetic bridge name reserved for the `tool.$stub()` helper. */
export const EVAL_STUB_BRIDGE_NAME = "__stub__";

const TS_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Tools reachable only through the eval bridge while Code Mode is active, in
 * bridge-allowlist order. Empty when Code Mode is inactive.
 */
export function codeModeBridgedTools(session: ToolSession): Tool[] {
	const directToolNames = session.getCodeModeDirectToolNames?.();
	if (!directToolNames) return [];
	const direct = new Set(directToolNames);
	const names = session.getEvalBridgeToolNames?.() ?? [...(session.toolRegistry?.keys() ?? [])];
	return names.flatMap(name => {
		if (direct.has(name)) return [];
		const tool = session.toolRegistry?.get(name);
		return tool ? [tool] : [];
	});
}

/** One line per bridged tool: name and a bounded one-line summary. */
export function renderCodeModeIndex(tools: readonly Tool[]): string {
	return tools.map(tool => `- ${tool.name} — ${promptCatalogSummary(tool, XDEV_EXTERNAL_DESCRIPTION_CAP)}`).join("\n");
}

/** Typed TypeScript stub for one tool: its full description as JSDoc plus the argument type. */
export function renderCodeModeStub(tool: Tool): string {
	const printedName = TS_IDENTIFIER.test(tool.name) ? tool.name : JSON.stringify(tool.name);
	const args = jsonSchemaToTypeScript(toolWireSchema(tool as AiTool));
	const description = (tool.description ?? "").trim().replaceAll("*/", "*\\/");
	const doc =
		description.length === 0
			? ""
			: `/**\n${description
					.split("\n")
					.map(line => ` * ${line}`.trimEnd())
					.join("\n")}\n */\n`;
	return `${doc}${printedName}(args: ${args}): Promise<unknown>;`;
}

function parseStubNames(args: unknown): string[] {
	const names = isRecord(args) ? args.names : undefined;
	if (names === undefined) return [];
	if (!Array.isArray(names) || names.some(name => typeof name !== "string" || name.length === 0)) {
		throw new ToolError('tool.$stub() takes tool names as strings, e.g. tool.$stub("task", "web_search")');
	}
	return names as string[];
}

/**
 * Serve typed stubs for the named bridged tools, or the bridged-tool index when
 * no name is given. Names resolve through the same allowlist and permission gate
 * as `tool.<name>()` calls, so a stub never documents an uncallable tool.
 */
export function runEvalStub(args: unknown, options: { session: ToolSession }): string {
	const { session } = options;
	const names = parseStubNames(args);
	if (names.length === 0) return renderCodeModeIndex(codeModeBridgedTools(session));
	return names
		.map(name => {
			const tool = session.getToolForEvalBridge ? session.getToolForEvalBridge(name) : session.getToolByName?.(name);
			if (!tool) throw new ToolError(`Unknown bridged tool: ${name}. Call tool.$stub() to list bridged tools.`);
			return renderCodeModeStub(tool as Tool);
		})
		.join("\n\n");
}
