import { YAML } from "bun";
import { Document, isMap, isNode, isScalar, isSeq, type Node, parseDocument } from "yaml";

const YAML_MAPPING_HEADER_TRAILING_SPACE = /: +$/gm;

/** Serialize new config YAML without Bun's trailing space on block mapping headers. */
export function stringifyYamlConfig(value: unknown): string {
	return YAML.stringify(value, null, 2).replace(YAML_MAPPING_HEADER_TRAILING_SPACE, ":");
}

interface SourceEdit {
	start: number;
	end: number;
	text: string;
}

function isMapping(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Reconcile the locked source by node ranges, retaining untouched source bytes. */
export function reconcileYamlConfig(source: string, value: unknown): string {
	const document = parseDocument(source, { keepSourceTokens: true });
	if (document.errors.length > 0) throw document.errors[0];
	const edits: SourceEdit[] = [];
	const newline = source.includes("\r\n") ? "\r\n" : "\n";
	const lineStart = (offset: number) => source.lastIndexOf("\n", offset - 1) + 1;
	const column = (offset: number) => offset - lineStart(offset);
	// Infer indentation from collection keys, not multiline scalar content.
	let indent = 2;
	const findIndent = (node: Node | null): void => {
		if (isMap(node) && !node.flow) {
			for (const pair of node.items) {
				if (isNode(pair.key) && pair.key.range && isMap(pair.value) && !pair.value.flow) {
					const first = pair.value.items[0]?.key;
					if (isNode(first) && first.range) {
						const delta = column(first.range[0]) - column(pair.key.range[0]);
						if (delta > 0) indent = delta;
					}
				}
				if (isNode(pair.value)) findIndent(pair.value);
			}
		} else if (isSeq(node)) {
			for (const item of node.items) if (isNode(item)) findIndent(item);
		}
	};
	findIndent(document.contents);
	const render = (next: unknown, previous?: Node, flow = false): string => {
		const output = new Document(next);
		if (isScalar(previous) && isScalar(output.contents) &&
			(previous.type === "QUOTE_DOUBLE" || previous.type === "QUOTE_SINGLE")) {
			output.contents.type = previous.type;
		}
		if (flow && (isMap(output.contents) || isSeq(output.contents))) output.contents.flow = true;
		return output.toString({ indent, lineWidth: 0 }).replace(/\n$/, "").replace(/\n/g, newline);
	};
	const replace = (node: Node, next: unknown): void => {
		if (!node.range) throw new Error("YAML node has no source range");
		// Expand only the edited alias occurrence, never its shared anchor.
		let text = render(next, node, true);
		if (node.range[0] === node.range[1] && source[node.range[0] - 1] === ":") text = " " + text;
		if (source.slice(node.range[0], node.range[1]).endsWith("\n")) text += newline;
		edits.push({ start: node.range[0], end: node.range[1], text });
	};
	const reconcile = (node: Node, next: unknown): void => {
		if (Bun.deepEquals(node.toJS(document), next)) return;
		if (!isMap(node) || !isMapping(next)) {
			replace(node, next);
			return;
		}
		const keys = new Set<string>();
		if (Object.keys(next).length === 0) {
			replace(node, next);
			return;
		}
		for (let index = 0; index < node.items.length; index++) {
			const pair = node.items[index];
			if (!isScalar(pair.key) || !pair.key.range) throw new Error("Settings YAML keys must be scalars");
			const key = String(pair.key.value);
			keys.add(key);
			const child = isNode(pair.value) ? pair.value : null;
			if (Object.hasOwn(next, key) && next[key] !== undefined) {
				if (child) reconcile(child, next[key]);
				else edits.push({ start: pair.key.range[1] + 1, end: pair.key.range[1] + 1, text: " " + render(next[key], undefined, true) });
				continue;
			}
			const end = child?.range?.[node.flow ? 1 : 2] ?? pair.key.range[2];
			let start = pair.key.range[0];
			let finish = end;
			if (node.flow) {
				const following = node.items[index + 1]?.key;
				if (isNode(following) && following.range) {
					const comma = source.indexOf(",", end);
					if (comma >= end && comma < following.range[0]) finish = comma + 1;
				} else if (index > 0) {
					const comma = source.lastIndexOf(",", start);
					if (comma >= (node.range?.[0] ?? 0)) start = comma;
				}
			} else {
				const beginning = lineStart(start);
				if (/^ *$/.test(source.slice(beginning, start))) start = beginning;
			}
			edits.push({ start, end: finish, text: "" });
		}
		const added = Object.entries(next).filter(([key, item]) => !keys.has(key) && item !== undefined);
		if (added.length === 0) return;
		if (!node.range) throw new Error("YAML mapping has no source range");
		if (node.flow) {
			const offset = node.range[1] - 1;
			const retained = node.items.some(pair => isScalar(pair.key) && Object.hasOwn(next, String(pair.key.value)) && next[String(pair.key.value)] !== undefined);
			const prefix = retained ? ", " : "";
			const text = prefix + added.map(([key, item]) => render(key) + ": " + render(item, undefined, true)).join(", ");
			edits.push({ start: offset, end: offset, text });
		} else {
			const last = node.items.at(-1);
			const lastNode = isNode(last?.value) ? last.value : isNode(last?.key) ? last.key : null;
			const offset = lastNode?.range?.[2] ?? node.range[1];
			const first = node.items[0]?.key;
			const padding = " ".repeat(isNode(first) && first.range ? column(first.range[0]) : 0);
			const text = added.map(([key, item]) => render({ [key]: item }).split(newline).map(line => padding + line).join(newline)).join(newline);
			const before = offset > 0 && source[offset - 1] !== "\n" ? newline : "";
			const after = offset < source.length || source.endsWith("\n") ? newline : "";
			edits.push({ start: offset, end: offset, text: before + text + after });
		}
	};
	if (document.contents) reconcile(document.contents, value);
	else {
		const prefix = source.length > 0 && !source.endsWith("\n") ? newline : "";
		const text = stringifyYamlConfig(value).replace(/\n/g, newline);
		return source + prefix + (source.length > 0 && !source.endsWith("\n") ? text.replace(/\r?\n$/, "") : text);
	}
	// Adjacent removed flow entries can share their separating comma.
	edits.sort((left, right) => left.start - right.start || left.end - right.end);
	for (let index = 1; index < edits.length;) {
		const previous = edits[index - 1];
		const current = edits[index];
		if (previous.text === "" && current.text === "" && current.start <= previous.end) {
			previous.end = Math.max(previous.end, current.end);
			edits.splice(index, 1);
		} else index++;
	}
	edits.sort((left, right) => right.start - left.start || right.end - left.end);
	let result = source;
	let boundary = source.length;
	for (const edit of edits) {
		if (edit.end > boundary) throw new Error("Overlapping YAML source edits");
		result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
		boundary = edit.start;
	}
	return result;
}
