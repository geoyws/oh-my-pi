/**
 * Post-build script: reads the napi-rs generated `index.d.ts`, rewrites
 * TypeScript-only enum declarations to runtime-backed declarations, writes
 * `native/index.js` from the checked-in ESM loader template, and writes
 * `native/required-surface.js`, the native API the loader requires of an addon.
 *
 * Why explicit ESM exports matter (issue #892):
 *
 * Consumers import named symbols from `@oh-my-pi/pi-natives`. The native addon
 * loader returns most values dynamically, while napi-rs `#[napi(string_enum)]`
 * emits `const enum` in the .d.ts — a TypeScript-only construct with no JS
 * runtime value. This script renders the ESM loader template and emits one
 * explicit `export const X = …` per public class/function declared in
 * `index.d.ts`, plus literal runtime objects for each enum.
 *
 * Why a required surface: an addon's release stamp only says which release it
 * was built for, not from which sources. A same-release addon built before a
 * function or class method was added loads cleanly and then fails as a bare
 * `x is not a function` at the first call. The loader compares the addon to
 * this list instead (see `missingNativeSurface` in `loader-state.js`).
 *
 * Run after `napi build`: `bun packages/natives/scripts/gen-enums.ts`
 */
import * as path from "node:path";

const nativeDir = path.resolve(import.meta.dir, "../native");
const dtsPath = path.join(nativeDir, "index.d.ts");
const jsPath = path.join(nativeDir, "index.js");
const surfacePath = path.join(nativeDir, "required-surface.js");

const MARKER_START = "// --- generated native exports (do not edit) ---";
const MARKER_END = "// --- end generated native exports ---";

// Match each `export declare const enum Name { ... }` block. The closing `}`
// is matched only at line start (enum bodies are indented).
const CONST_ENUM_RE = /export declare (?:const )?enum (\w+)\s*\{(.*?)\n\}/gs;

// Match `export declare class Name` (signatures or block headers). napi-rs
// always emits these as top-level declarations; we just need the name.
const CLASS_RE = /^export declare class (\w+)/gm;

// Match `export declare function name(...)`. Same shape rationale.
const FUNCTION_RE = /^export declare function (\w+)/gm;

// Match a whole `export declare class Name { ... }` block. The closing `}` is
// matched only at line start (member declarations are indented).
const CLASS_BLOCK_RE = /^export declare class (\w+)[^{\n]*\{(.*?)\n\}/gms;

// A prototype method inside a class body (comments stripped): napi-rs emits
// members at two-space indent as `name(...)` or `name<T>(...)`. Constructors
// are filtered by name; `static name(` (constructor-level factories) and
// `get name(` / `set name(` (prototype accessors, which are not callable
// methods) never match because a keyword separates the indent from the name.
const METHOD_RE = /^ {2}(\w+)\s*[(<]/gm;

// JSDoc bodies may contain lines that look like members (napi copies Rust doc
// comments verbatim, including unprefixed continuation lines).
const BLOCK_COMMENT_RE = /\/\*.*?\*\//gs;

/**
 * The release identity export (`__piNativesBuildVersion`, and the legacy
 * per-release `__piNativesV*` names) answers "which build is this addon?", so
 * it must stay a raw passthrough: a stub there would report presence for an
 * addon that has it not, defeating the loader's own staleness diagnosis.
 */
const RELEASE_IDENTITY_NAME_RE = /^__piNatives(?:BuildVersion$|V)/;

interface EnumExport {
	name: string;
	entries: string[];
}

function collectEnums(dts: string): EnumExport[] {
	const enums: EnumExport[] = [];
	CONST_ENUM_RE.lastIndex = 0;
	for (;;) {
		const match = CONST_ENUM_RE.exec(dts);
		if (match === null) break;
		const name = match[1]!;
		const body = match[2]!;
		const entries: string[] = [];
		for (const line of body.split("\n")) {
			const m = line.match(/^\s*(\w+)\s*=\s*'([^']*)'/) ?? line.match(/^\s*(\w+)\s*=\s*(\d+)/);
			if (m) {
				const rawValue = m[2]!;
				const value = rawValue.match(/^\d+$/) ? rawValue : JSON.stringify(rawValue);
				entries.push(`\t${m[1]}: ${value},`);
			}
		}
		if (entries.length > 0) {
			enums.push({ name, entries });
		}
	}
	return enums;
}

function collectMatches(dts: string, re: RegExp): string[] {
	const names: string[] = [];
	re.lastIndex = 0;
	for (;;) {
		const match = re.exec(dts);
		if (match === null) break;
		names.push(match[1]!);
	}
	return names;
}

export interface RequiredNativeSurface {
	functions: string[];
	classes: Record<string, string[]>;
}

/**
 * Every function and every class prototype method declared in `index.d.ts`,
 * in declaration order. Release-identity functions are excluded: the release
 * check owns them, and pre-stamp addons legitimately lack the current name.
 */
export function collectRequiredSurface(dts: string): RequiredNativeSurface {
	const functions = collectMatches(dts, FUNCTION_RE).filter(name => !RELEASE_IDENTITY_NAME_RE.test(name));
	const classes: Record<string, string[]> = {};
	CLASS_BLOCK_RE.lastIndex = 0;
	for (;;) {
		const match = CLASS_BLOCK_RE.exec(dts);
		if (match === null) break;
		const body = match[2]!.replace(BLOCK_COMMENT_RE, "");
		const methods = collectMatches(body, METHOD_RE).filter(name => name !== "constructor");
		classes[match[1]!] = [...new Set(methods)];
	}
	return { functions: [...new Set(functions)], classes };
}

export function renderRequiredSurface(surface: RequiredNativeSurface): string {
	const lines = [
		"// --- generated by scripts/gen-enums.ts from index.d.ts (do not edit) ---",
		"// Every function and class prototype method the loader requires of an addon;",
		"// see `missingNativeSurface` in `./loader-state.js`.",
		"export const requiredNativeSurface = {",
		"\tfunctions: [",
		...surface.functions.map(name => `\t\t${JSON.stringify(name)},`),
		"\t],",
		"\tclasses: {",
	];
	for (const [name, methods] of Object.entries(surface.classes)) {
		if (methods.length === 0) {
			lines.push(`\t\t${name}: [],`);
			continue;
		}
		lines.push(`\t\t${name}: [`, ...methods.map(method => `\t\t\t${JSON.stringify(method)},`), "\t\t],");
	}
	lines.push("\t},", "};", "");
	return lines.join("\n");
}

function buildGeneratedBlock(dts: string): string {
	const classes = collectMatches(dts, CLASS_RE);
	const functions = collectMatches(dts, FUNCTION_RE);
	const enums = collectEnums(dts);

	if (classes.length === 0 && functions.length === 0 && enums.length === 0) {
		throw new Error("No public symbols found in index.d.ts — check napi build output");
	}

	const lines: string[] = [];
	if (classes.length > 0) {
		lines.push("// classes");
		for (const name of classes) {
			const binding =
				name === "DesktopSession" ? `adaptDesktopSession(nativeBindings.${name})` : `nativeBindings.${name}`;
			lines.push(`export const ${name} = ${binding};`);
		}
	}
	if (functions.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push("// functions");
		for (const name of functions) {
			// `missingNativeExport` returns `undefined` on a current addon and a
			// throwing stub on a stale one, so capability probes
			// (`typeof native.x === "function"`) keep their meaning and only the
			// stale case gains an actionable failure. See `loader-state.js`.
			const fallback = RELEASE_IDENTITY_NAME_RE.test(name) ? "" : ` ?? missingNativeExport("${name}")`;
			lines.push(`export const ${name} = nativeBindings.${name}${fallback};`);
		}
	}
	if (enums.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push("// string/numeric enums (napi-rs string_enum produces TS-only const enum)");
		for (const e of enums) {
			lines.push(`export const ${e.name} = {\n${e.entries.join("\n")}\n};`);
		}
	}

	return `${MARKER_START}\n${lines.join("\n")}\n${MARKER_END}`;
}

export async function generateEnumExports(): Promise<void> {
	const dts = await Bun.file(dtsPath).text();
	const existing = await Bun.file(jsPath).text();
	const generatedBlock = buildGeneratedBlock(dts);

	// Patch the generated block in place. `native/index.js` is the hand-edited
	// loader; only the block between MARKER_START and MARKER_END is owned by
	// this script. The markers are committed to disk so the patch is purely
	// content replacement — no scaffold, no template file.
	const blockStart = existing.indexOf(MARKER_START);
	const blockEnd = existing.indexOf(MARKER_END);
	if (blockStart === -1 || blockEnd === -1 || blockEnd < blockStart) {
		throw new Error(
			`gen-enums: ${jsPath} is missing the generated marker block. ` +
				`Add\n\n${MARKER_START}\n${MARKER_END}\n\nplaceholders before running.`,
		);
	}
	const js = existing.slice(0, blockStart) + generatedBlock + existing.slice(blockEnd + MARKER_END.length);

	await Bun.write(jsPath, js);

	const surface = collectRequiredSurface(dts);
	await Bun.write(surfacePath, renderRequiredSurface(surface));

	// Also fix the .d.ts: replace `const enum` with `enum` so TS allows
	// assigning string literals to enum types without casts.
	const constEnumCount = (dts.match(/export (?:declare )?const enum/g) ?? []).length;
	const dtsContent = dts
		.replaceAll("export const enum", "export declare enum")
		.replaceAll("export declare const enum", "export declare enum");
	await Bun.write(dtsPath, dtsContent);

	const symbolCount = (generatedBlock.match(/^export const /gm) ?? []).length;
	const methodCount = Object.values(surface.classes).reduce((sum, methods) => sum + methods.length, 0);
	console.log(
		`Generated ${symbolCount} explicit ESM exports in index.js, fixed ${constEnumCount} const enums in index.d.ts, ` +
			`required ${surface.functions.length} functions and ${methodCount} class methods in required-surface.js`,
	);
}

if (import.meta.main) {
	await generateEnumExports();
}
