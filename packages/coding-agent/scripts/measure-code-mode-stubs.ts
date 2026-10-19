/**
 * Token cost of the provider tool block under native tools vs Code Mode with
 * inline signatures vs Code Mode with on-demand stubs (`tools.codeModeStubs`).
 *
 * Counter: the repo Tokenizer in strict mode (native countTokens) with the
 * claude-v5-sonnet encoding, over each definition in isolation as
 * `{ name, description, input_schema }`. No provider count_tokens call.
 *
 *   bun packages/coding-agent/scripts/measure-code-mode-stubs.ts [--json out.json]
 */
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import { type Tool as AiTool, toolWireSchema } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	codeModeBridgedTools,
	renderCodeModeIndex,
	renderCodeModeStub,
} from "@oh-my-pi/pi-coding-agent/eval/stub-bridge";
import { CODE_MODE_KEEP_TOOLS } from "@oh-my-pi/pi-coding-agent/session/code-mode";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { createTools, type Tool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { xdevDocsAll, xdevEntries } from "@oh-my-pi/pi-coding-agent/tools/xdev";
import { generateCodeModeDeclarations } from "@oh-my-pi/pi-tui/tools/eval-format/code-mode-declarations";

const jsonOut = process.argv.includes("--json") ? process.argv[process.argv.indexOf("--json") + 1] : undefined;

await Settings.init({ inMemory: true, cwd: process.cwd() });
// The catalog tokenizer family of anthropic/claude-sonnet-5-5, the eval-suite model.
const sonnetFamily = ["claude", "v5", "sonnet"].join("-") as "claude-v5-sonnet";
const tokenizer = new Tokenizer({ tokenizer: sonnetFamily });
const count = (text: string): number => (text.length === 0 ? 0 : tokenizer.countTokens(text, "strict"));
const definitionTokens = (tool: Tool): number =>
	count(
		JSON.stringify({ name: tool.name, description: tool.description, input_schema: toolWireSchema(tool as AiTool) }),
	);

/** Direct set of the any-provider spike default (`tools.codeModeDirectTools`). */
const SPIKE_DIRECT = ["read", "bash", "edit", "grep", "glob"];

interface Arm {
	label: string;
	/** Extra direct names on top of the keep-set; undefined = Code Mode off. */
	direct: readonly string[] | undefined;
	stubs: "inline" | "on-demand";
	xdev: boolean;
}

async function buildSession(arm: Arm): Promise<{ session: ToolSession; tools: Tool[] }> {
	let direct: readonly string[] | undefined;
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "tools.xdev": arm.xdev, "tools.codeModeStubs": arm.stubs }),
		getCodeModeDirectToolNames: () => direct,
		getEvalBridgeToolNames: () => [...(session.toolRegistry?.keys() ?? [])],
		getToolForEvalBridge: name => session.toolRegistry?.get(name),
	} as ToolSession;
	const tools = await createTools(session);
	if (arm.direct !== undefined) {
		direct = tools
			.map(tool => tool.name)
			.filter(name => CODE_MODE_KEEP_TOOLS[name] === true || arm.direct?.includes(name));
	}
	return { session, tools };
}

async function systemPromptTokens(session: ToolSession, tools: Tool[], direct: readonly string[] | undefined) {
	const xdev = session.xdev;
	const built = await buildSystemPrompt({
		tools: new Map(tools.map(tool => [tool.name, tool])) as never,
		toolNames: tools.map(tool => tool.name),
		directToolNames: direct,
		xdevTools: xdev ? xdevEntries(xdev) : undefined,
		xdevDocs: xdev ? xdevDocsAll(xdev, "builtins") : undefined,
		inlineToolDescriptors: false,
		nativeTools: true,
		cwd: process.cwd(),
		skills: [],
		contextFiles: [],
		workspaceTree: { rootPath: process.cwd(), rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
	});
	return count(built.systemPrompt.join("\n"));
}

// Code Mode clears xd:// mounting (session-tools), so its arms run with xd:// off.
const arms: Arm[] = [
	{ label: "native-xdev (default today)", direct: undefined, stubs: "inline", xdev: true },
	{ label: "native-all-top-level", direct: undefined, stubs: "inline", xdev: false },
	{ label: "codemode-keepset-inline", direct: [], stubs: "inline", xdev: false },
	{ label: "codemode-keepset-ondemand", direct: [], stubs: "on-demand", xdev: false },
	{ label: "codemode-spike-inline", direct: SPIKE_DIRECT, stubs: "inline", xdev: false },
	{ label: "codemode-spike-ondemand", direct: SPIKE_DIRECT, stubs: "on-demand", xdev: false },
];

const results: Record<string, unknown> = {};
const perTool = new Map<string, Record<string, number | string>>();
console.log("arm | tools in block | block tok | eval def tok | system prompt tok | block+system tok | bridged");
for (const arm of arms) {
	const { session, tools } = await buildSession(arm);
	const directNames = session.getCodeModeDirectToolNames?.();
	const block = directNames === undefined ? tools : tools.filter(tool => directNames.includes(tool.name));
	const evalTool = tools.find(tool => tool.name === "eval");
	const blockTokens = block.reduce((sum, tool) => sum + definitionTokens(tool), 0);
	const evalTokens = evalTool ? definitionTokens(evalTool) : 0;
	const systemTokens = await systemPromptTokens(session, tools, directNames);
	const bridged = codeModeBridgedTools(session);
	results[arm.label] = {
		toolsInBlock: block.map(tool => tool.name),
		mounted: [...(session.xdev?.mountedNames ?? [])],
		blockTokens,
		evalTokens,
		systemTokens,
		total: blockTokens + systemTokens,
		bridged: bridged.map(tool => tool.name),
	};
	console.log(
		`${arm.label.padEnd(28)} ${String(block.length).padStart(2)} ${String(blockTokens).padStart(6)} ${String(evalTokens).padStart(6)} ${String(systemTokens).padStart(6)} ${String(blockTokens + systemTokens).padStart(6)}  ${bridged.length}`,
	);
	if (arm.label === "native-all-top-level") {
		for (const tool of tools) perTool.set(tool.name, { name: tool.name, nativeDef: definitionTokens(tool) });
	}
	if (arm.label === "codemode-keepset-ondemand") {
		for (const tool of tools) {
			const row = perTool.get(tool.name) ?? { name: tool.name };
			row.inlineSignature = count(generateCodeModeDeclarations([{ name: tool.name, parameters: tool.parameters }]));
			row.indexLine = count(renderCodeModeIndex([tool]));
			row.stub = count(renderCodeModeStub(tool));
			perTool.set(tool.name, row);
		}
		console.log(`\nindex as rendered (keep-set arm):\n${renderCodeModeIndex(bridged)}\n`);
	}
}

const rows = [...perTool.values()].sort((a, b) => Number(b.nativeDef) - Number(a.nativeDef));
console.log("\nper tool: name | native def | inline signature | index line | on-demand stub");
for (const row of rows) {
	console.log(
		`  ${String(row.name).padEnd(16)} ${String(row.nativeDef).padStart(6)} ${String(row.inlineSignature).padStart(6)} ${String(row.indexLine).padStart(6)} ${String(row.stub).padStart(6)}`,
	);
}
if (jsonOut) await Bun.write(jsonOut, JSON.stringify({ arms: results, perTool: rows }, null, 2));
