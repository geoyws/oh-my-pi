import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { installFourDimensionCoverage } from "./coverage-plugin";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture(files: Record<string, string>): Promise<string> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "four-dim-plugin-")));
	roots.push(root);
	for (const [name, body] of Object.entries(files)) await Bun.write(path.join(root, name), body);
	return root;
}

function install(env: Record<string, string | undefined>): () => Promise<void> {
	let dump: (() => Promise<void>) | undefined;
	installFourDimensionCoverage(env, registered => {
		dump = registered;
	});
	if (!dump) throw new Error("no dump callback registered");
	return dump;
}

// The plugin acts when Bun loads a module, so the fixtures must be loaded after it is
// installed; a runtime import of the generated fixture path is the only way to do that.
const load = (file: string): Promise<Record<string, (n: number) => number>> => import(file);

describe("four-dimension coverage plugin", () => {
	test("refuses a missing or malformed environment", () => {
		expect(() => install({})).toThrow("are required");
		expect(() => install({ OMP_FOUR_DIM_OUT: "/tmp/x" })).toThrow("are required");
		for (const track of ["{}", "[]", "[1]"]) {
			expect(() => install({ OMP_FOUR_DIM_OUT: "/tmp/x", OMP_FOUR_DIM_TRACK: track })).toThrow(
				"non-empty JSON array",
			);
		}
	});

	test("instruments tracked .ts and .tsx files as they load and dumps their counters", async () => {
		const root = await fixture({
			"plain.ts": "export function twice(n: number): number {\n\treturn n > 0 ? n * 2 : 0;\n}\n",
			"view.tsx": "export function thrice(n: number): number {\n\treturn n * 3;\n}\n",
		});
		const plain = path.join(root, "plain.ts");
		const view = path.join(root, "view.tsx");
		const out = path.join(root, "out");
		const dump = install({ OMP_FOUR_DIM_OUT: out, OMP_FOUR_DIM_TRACK: JSON.stringify([plain, view]) });

		expect((await load(plain)).twice(2)).toBe(4);
		expect((await load(view)).thrice(2)).toBe(6);
		await dump();
		const [name] = await fs.readdir(out);
		const counters = await Bun.file(path.join(out, name)).json();
		expect(Object.values(counters[plain].f)).toEqual([1]);
		expect(counters[plain].b["0"]).toEqual([1, 0]);
		expect(Object.values(counters[view].f)).toEqual([1]);

		// A process that loaded no tracked file has no counter global; the dump is then empty.
		const saved = Reflect.get(globalThis, "__coverage__");
		Reflect.deleteProperty(globalThis, "__coverage__");
		const written = dump();
		Reflect.set(globalThis, "__coverage__", saved);
		await written;
		expect(await Bun.file(path.join(out, name)).json()).toEqual({});
	});

	test("refuses to load a tracked file that carries a coverage ignore hint", async () => {
		const root = await fixture({ "hinted.ts": "/* c8 ignore next */\nexport const one = 1;\n" });
		const hinted = path.join(root, "hinted.ts");
		install({ OMP_FOUR_DIM_OUT: path.join(root, "out"), OMP_FOUR_DIM_TRACK: JSON.stringify([hinted]) });
		await expect(load(hinted)).rejects.toThrow("coverage ignore hint");
	});
});
