import { YAML } from "bun";
import type { Node, Pair, YAMLMap } from "yaml";
import { Document, isAlias, isMap, isNode, isScalar, isSeq, parseDocument, Scalar, visit } from "yaml";

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
	// Match Bun.YAML.parse, which expands `<<` merge keys into the desired value.
	const document = parseDocument(source, { keepSourceTokens: true, merge: true });
	if (document.errors.length > 0) throw document.errors[0];
	const edits: SourceEdit[] = [];
	const newline = source.includes("\r\n") ? "\r\n" : "\n";
	const lineStart = (offset: number) => source.lastIndexOf("\n", offset - 1) + 1;
	const column = (offset: number) => offset - lineStart(offset);
	const commaBetween = (start: number, end: number): number => {
		const tail = source.slice(start, end).replace(/#[^\r\n]*/g, comment => " ".repeat(comment.length));
		const comma = tail.indexOf(",");
		return comma < 0 ? -1 : start + comma;
	};
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
	const stringifyOptions = { indent, lineWidth: 0, doubleQuotedMinMultiLineLength: Number.POSITIVE_INFINITY };
	const render = (next: unknown, previous?: Node, flow = false): string => {
		const output = new Document(next);
		if (
			isScalar(previous) &&
			isScalar(output.contents) &&
			(previous.type === "QUOTE_DOUBLE" || previous.type === "QUOTE_SINGLE")
		) {
			output.contents.type = previous.type;
		}
		if (flow && (isMap(output.contents) || isSeq(output.contents))) output.contents.flow = true;
		// Spliced text cannot know its parent's indentation, so strings the library
		// would spread over several lines (newlines, document markers) use the
		// single-line double-quoted form that new config files already use.
		visit(output, {
			Scalar(_, scalar) {
				if (typeof scalar.value === "string" && /\n|^(?:%|---|\.\.\.)/m.test(scalar.value)) {
					scalar.type = Scalar.QUOTE_DOUBLE;
				}
			},
		});
		return output.toString(stringifyOptions).replace(/\n$/, "").replace(/\n/g, newline);
	};
	// An authored block scalar keeps its style. It is rendered as the value of a
	// column-0 key with a 2-space step: the library always writes indentation
	// indicators as 2, so only that step keeps them truthful. Content lines then
	// move to the parent key's column, plus the inferred step when no indicator
	// pins the content indentation.
	const renderBlockScalar = (next: unknown, previous: Node, parentColumn: number): string | undefined => {
		if (typeof next !== "string" || !isScalar(previous)) return undefined;
		if (previous.type !== Scalar.BLOCK_LITERAL && previous.type !== Scalar.BLOCK_FOLDED) return undefined;
		const output = new Document({ k: next });
		const value = isMap(output.contents) ? output.contents.items[0]?.value : undefined;
		if (!isScalar(value)) return undefined;
		value.type = previous.type;
		const [first, ...lines] = output
			.toString({ ...stringifyOptions, indent: 2 })
			.replace(/\n$/, "")
			.split("\n");
		// The library falls back to quoting when block style cannot represent the value.
		const header = /^k: ([|>].*)$/.exec(first)?.[1];
		if (header === undefined) return undefined;
		const padding = " ".repeat(parentColumn + (/\d/.test(header) ? 2 : indent));
		return [header, ...lines.map(line => (line === "" ? line : padding + line.slice(2)))].join(newline);
	};
	const replace = (node: Node, next: unknown, parentColumn?: number): void => {
		if (!node.range) throw new Error("YAML node has no source range");
		// Expand only the edited alias occurrence, never its shared anchor.
		let text =
			(parentColumn === undefined ? undefined : renderBlockScalar(next, node, parentColumn)) ??
			render(next, node, true);
		// A block scalar's header comment lies inside its range; carry its authored
		// bytes to the end of the replacement's first line, whatever style that is.
		if (isScalar(node) && (node.type === Scalar.BLOCK_LITERAL || node.type === Scalar.BLOCK_FOLDED)) {
			const comment = /^[|>][-+0-9]*([ \t]+#[^\r\n]*)/.exec(source.slice(node.range[0]))?.[1];
			if (comment !== undefined) {
				const firstLineEnd = text.indexOf(newline);
				text = firstLineEnd < 0 ? text + comment : text.slice(0, firstLineEnd) + comment + text.slice(firstLineEnd);
			}
		}
		if (node.range[0] === node.range[1] && source[node.range[0] - 1] === ":") text = " " + text;
		if (source.slice(node.range[0], node.range[1]).endsWith("\n")) text += newline;
		edits.push({ start: node.range[0], end: node.range[1], text });
	};
	const isMergePair = (pair: Pair): boolean =>
		isScalar(pair.key) && typeof pair.key.value === "symbol" && pair.key.value.description === "<<";
	// Earlier merge sources win; explicit keys override every merged value.
	const inheritedValues = (node: YAMLMap): Map<string, unknown> => {
		const inherited = new Map<string, unknown>();
		for (const pair of node.items) {
			if (!isMergePair(pair)) continue;
			const value = isAlias(pair.value) ? pair.value.resolve(document) : pair.value;
			for (const item of isSeq(value) ? value.items : [value]) {
				const mergeSource = isAlias(item) ? item.resolve(document) : item;
				if (!isMap(mergeSource)) throw new Error("YAML merge sources must be mappings");
				const values: unknown = mergeSource.toJS(document);
				if (!isMapping(values)) throw new Error("YAML merge sources must be mappings");
				for (const [key, merged] of Object.entries(values)) if (!inherited.has(key)) inherited.set(key, merged);
			}
		}
		return inherited;
	};
	const reconcile = (node: Node, next: unknown, parentColumn?: number): void => {
		if (Bun.deepEquals(node.toJS(document), next)) return;
		if (!isMap(node) || !isMapping(next)) {
			replace(node, next, parentColumn);
			return;
		}
		const keys = new Set<string>();
		if (Object.keys(next).length === 0) {
			replace(node, next);
			return;
		}
		const present = (key: string): boolean => Object.hasOwn(next, key) && next[key] !== undefined;
		const inherited = inheritedValues(node);
		// YAML cannot unset an inherited key, so removing one replaces this map's merges with explicit keys.
		const materialize = [...inherited.keys()].some(key => !present(key));
		const kept = (pair: Pair): boolean =>
			isMergePair(pair) ? !materialize : isScalar(pair.key) && present(String(pair.key.value));
		for (let index = 0; index < node.items.length; index++) {
			const pair: Pair = node.items[index];
			if (!isScalar(pair.key) || !pair.key.range) throw new Error("Settings YAML keys must be scalars");
			const child = isNode(pair.value) ? pair.value : null;
			if (isMergePair(pair)) {
				if (!materialize) continue;
			} else {
				const key = String(pair.key.value);
				keys.add(key);
				if (present(key)) {
					if (child) reconcile(child, next[key], node.flow ? undefined : column(pair.key.range[0]));
					else
						edits.push({
							start: pair.key.range[1] + 1,
							end: pair.key.range[1] + 1,
							text: " " + render(next[key], undefined, true),
						});
					continue;
				}
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
				if (index === node.items.length - 1 && node.range) {
					const comma = commaBetween(end, node.range[1] - 1);
					if (comma >= 0) finish = comma + 1;
				}
			} else {
				const beginning = lineStart(start);
				if (/^ *$/.test(source.slice(beginning, start))) start = beginning;
			}
			edits.push({ start, end: finish, text: "" });
		}
		// Retained merges already supply equal inherited values; differing ones need an explicit override.
		const added = Object.entries(next).filter(
			([key, item]) =>
				!keys.has(key) &&
				item !== undefined &&
				(materialize || !inherited.has(key) || !Bun.deepEquals(inherited.get(key), item)),
		);
		if (added.length === 0) return;
		if (!node.range) throw new Error("YAML mapping has no source range");
		if (node.flow) {
			let offset = node.range[1] - 1;
			const retained = node.items.some(kept);
			const last = node.items.at(-1);
			const lastValue = isNode(last?.value) ? last.value : null;
			const lastRetained = !!last && kept(last);
			const lastRange = lastValue?.range;
			const trailingComma = !!lastRange && commaBetween(lastRange[1], offset) >= 0;
			// Insert before an authored trailing comma, retaining its whitespace and comments.
			if (lastRetained && trailingComma && lastRange) offset = lastRange[1];
			const prefix = retained ? ", " : "";
			const text =
				prefix +
				added.map(([key, item]) => render(key) + ": " + render(item, undefined, true)).join(", ") +
				(trailingComma && !lastRetained ? "," : "");
			edits.push({ start: offset, end: offset, text });
		} else {
			const last = node.items.at(-1);
			const lastNode = isNode(last?.value) ? last.value : isNode(last?.key) ? last.key : null;
			const offset = lastNode?.range?.[2] ?? node.range[1];
			const first = node.items[0]?.key;
			const padding = " ".repeat(isNode(first) && first.range ? column(first.range[0]) : 0);
			const text = added
				.map(([key, item]) =>
					render({ [key]: item })
						.split(newline)
						.map(line => padding + line)
						.join(newline),
				)
				.join(newline);
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
	// Anchor edits must not change untouched aliases when the file is reopened.
	const children = (node: Node): Node[] => {
		if (isMap(node)) return node.items.flatMap(pair => [pair.key, pair.value].filter(isNode));
		if (isSeq(node)) return node.items.filter(isNode);
		return [];
	};
	const anchorEdits = edits.slice();
	const affected = (node: Node, seen = new Set<Node>()): boolean => {
		if (seen.has(node)) return false;
		seen.add(node);
		const range = node.range;
		if (
			range &&
			anchorEdits.some(
				edit =>
					(edit.start < range[1] && edit.end > range[0]) ||
					(isMap(node) && edit.start === edit.end && edit.start >= range[0] && edit.start <= range[2]),
			)
		)
			return true;
		if (isAlias(node)) {
			const target = node.resolve(document);
			return !!target && affected(target, seen);
		}
		return children(node).some(child => affected(child, seen));
	};
	const preserveAliases = (node: Node): void => {
		if (isAlias(node) && node.range) {
			const range = node.range;
			const alreadyEdited = edits.some(edit => edit.start <= range[0] && edit.end >= range[1]);
			const target = node.resolve(document);
			if (!alreadyEdited && target && affected(target)) replace(node, node.toJS(document));
		} else {
			for (const child of children(node)) preserveAliases(child);
		}
	};
	if (document.contents) preserveAliases(document.contents);
	// Nested and parent additions can share EOF. Preserve traversal order so
	// child keys precede newly added parent siblings.
	// Adjacent removed flow entries can share their separating comma.
	edits.sort((left, right) => left.start - right.start || left.end - right.end);
	for (let index = 1; index < edits.length;) {
		const previous = edits[index - 1];
		const current = edits[index];
		if (previous.start === previous.end && current.start === current.end && previous.start === current.start) {
			previous.text += current.text;
			edits.splice(index, 1);
		} else if (previous.text === "" && current.text === "" && current.start <= previous.end) {
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
