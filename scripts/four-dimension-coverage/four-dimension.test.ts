import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { measure, type ScopeManifest } from "./four-dimension";

setDefaultTimeout(120_000);

const SUBJECT = `export function classify(n: number): string {
	if (n > 0) {
		return "positive";
	}
	return "non-positive";
}

export const pick = (flag: boolean): string => (flag ? "a" : "b");
`;

const UNLOADED = `export function never(): number {
	return 1;
}
`;

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture(tests: Record<string, string>, files: Record<string, string> = {}): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "four-dim-"));
	roots.push(root);
	await Bun.write(path.join(root, "src/subject.ts"), SUBJECT);
	await Bun.write(path.join(root, "src/unloaded.ts"), UNLOADED);
	for (const [name, body] of Object.entries({ ...files, ...tests })) await Bun.write(path.join(root, name), body);
	return root;
}

const manifest: ScopeManifest = {
	tracked: ["src/subject.ts", "src/unloaded.ts"],
	suites: [{ name: "unit", cwd: ".", tests: ["test/*.test.ts"] }],
};

const testFile = (calls: string) => `import { expect, test } from "bun:test";
import { classify, pick } from "../src/subject";
test("subject", () => {
${calls}
});
`;

describe("four-dimension coverage negative control", () => {
	test("an untaken branch reports below 100% and taking it reports 100% on every dimension", async () => {
		const partialRoot = await fixture({
			"test/partial.test.ts": testFile(`	expect(classify(1)).toBe("positive");\n	expect(pick(true)).toBe("a");`),
		});
		const partial = await measure(manifest, partialRoot, path.join(partialRoot, "out"));
		expect(partial.suitesGreen).toBe(true);
		const partialSubject = partial.files.find(file => file.file === "src/subject.ts")!;
		expect(partialSubject.branches).toMatchObject({ covered: 2, total: 4 });
		expect(partialSubject.statements.covered).toBeLessThan(partialSubject.statements.total);
		expect(partialSubject.lines.covered).toBeLessThan(partialSubject.lines.total);
		expect(partialSubject.functions).toMatchObject({ covered: 2, total: 2 });

		const fullRoot = await fixture({
			"test/full.test.ts": testFile(
				`	expect(classify(1)).toBe("positive");\n	expect(classify(0)).toBe("non-positive");\n	expect(pick(true)).toBe("a");\n	expect(pick(false)).toBe("b");`,
			),
		});
		const full = await measure(manifest, fullRoot, path.join(fullRoot, "out"));
		const fullSubject = full.files.find(file => file.file === "src/subject.ts")!;
		for (const dimension of [
			fullSubject.lines,
			fullSubject.functions,
			fullSubject.branches,
			fullSubject.statements,
		]) {
			expect(dimension.covered).toBe(dimension.total);
			expect(dimension.total).toBeGreaterThan(0);
		}
		expect(fullSubject.bun.unionLines).not.toBeNull();
		expect(fullSubject.bun.unionLines?.covered).toBe(fullSubject.bun.unionLines?.total);
	});

	test("a tracked file no test loads is reported at zero, never omitted", async () => {
		const root = await fixture({ "test/partial.test.ts": testFile(`	expect(classify(1)).toBe("positive");`) });
		const result = await measure(manifest, root, path.join(root, "out"));
		const unloaded = result.files.find(file => file.file === "src/unloaded.ts")!;
		expect(unloaded.functions).toEqual({ covered: 0, total: 1, pct: 0 });
		expect(unloaded.statements).toEqual({ covered: 0, total: 1, pct: 0 });
		expect(unloaded.bun.unionLines).toBeNull();
		expect(result.full).toBe(false);
	});

	test("a re-run into the same --out reports only the new run's hits", async () => {
		const root = await fixture({
			"test/a.test.ts": testFile(
				`	expect(classify(1)).toBe("positive");\n	expect(classify(0)).toBe("non-positive");\n	expect(pick(true)).toBe("a");\n	expect(pick(false)).toBe("b");`,
			),
		});
		const out = path.join(root, "out");
		const first = await measure(manifest, root, out);
		expect(first.files.find(file => file.file === "src/subject.ts")!.branches).toMatchObject({
			covered: 4,
			total: 4,
		});

		await Bun.write(
			path.join(root, "test/a.test.ts"),
			testFile(`	expect(classify(1)).toBe("positive");\n	expect(pick(true)).toBe("a");`),
		);
		const second = await measure(manifest, root, out);
		const subject = second.files.find(file => file.file === "src/subject.ts")!;
		expect(subject.branches).toMatchObject({ covered: 2, total: 4 });
		expect(subject.bun.unionLines!.covered).toBeLessThan(subject.bun.unionLines!.total);
	});

	test("a coverage ignore hint in a tracked file is refused", async () => {
		const root = await fixture(
			{ "test/partial.test.ts": testFile(`	expect(classify(1)).toBe("positive");`) },
			{ "src/unloaded.ts": `/* istanbul ignore next */\n${UNLOADED}` },
		);
		await expect(measure(manifest, root, path.join(root, "out"))).rejects.toThrow("coverage ignore hint");
	});
});
