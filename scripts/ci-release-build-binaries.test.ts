import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import { $ } from "bun";
import { resolveCrossBuild } from "../packages/coding-agent/scripts/build-binary";
import { compileCodingAgent } from "../packages/coding-agent/scripts/compile-binary";

const repoRoot = path.join(import.meta.dir, "..");

describe("Windows release binary target", () => {
	it("builds both Windows architecture release assets with their native runtimes", async () => {
		const result = await $`bun scripts/ci-release-build-binaries.ts --dry-run --targets win32-x64,win32-arm64`
			.cwd(repoRoot)
			.quiet()
			.nothrow();
		expect(result.exitCode).toBe(0);
		const output = result.text();

		expect(output).toContain("Building packages/coding-agent/binaries/omp-windows-x64.exe...");
		expect(output).toContain(
			"DRY RUN Bun.build target=bun-windows-x64-baseline outfile=packages/coding-agent/binaries/omp-windows-x64.exe",
		);
		expect(output).toContain("Building packages/coding-agent/binaries/omp-windows-arm64.exe...");
		expect(output).toContain(
			"DRY RUN Bun.build target=bun-windows-arm64 outfile=packages/coding-agent/binaries/omp-windows-arm64.exe",
		);
		expect(output).toContain("external=fastembed,onnxruntime-node");
		expect(output).not.toContain("bun-windows-x64-modern");
	});

	it("resolves local Windows cross-build aliases for both architectures", () => {
		expect(resolveCrossBuild("win32-x64")).toEqual({
			id: "win32-x64",
			platform: "win32",
			arch: "x64",
			target: "bun-windows-x64-baseline",
		});
		expect(resolveCrossBuild("windows-x64")).toEqual({
			id: "windows-x64",
			platform: "win32",
			arch: "x64",
			target: "bun-windows-x64-baseline",
		});
		expect(resolveCrossBuild("win32-arm64")).toEqual({
			id: "win32-arm64",
			platform: "win32",
			arch: "arm64",
			target: "bun-windows-arm64",
		});
		expect(resolveCrossBuild("windows-arm64")).toEqual({
			id: "windows-arm64",
			platform: "win32",
			arch: "arm64",
			target: "bun-windows-arm64",
		});
	});
});

/**
 * Bytecode compilation is only observable in the artifact: Bun writes a JSC
 * code cache keyed by a synthetic `$bunfs` source URL that renames the
 * entrypoint to `.js`, and a bundle of the same graph without `bytecode: true`
 * never contains that record. Comparing the two executables therefore proves
 * real precompiled bytecode rather than merely a working ESM bundle. Only the
 * basename is matched because the `$bunfs` prefix and separators differ on
 * Windows.
 */
it("compiles dependency import.meta.resolve calls into runnable precompiled bytecode", async () => {
	using temp = TempDir.createSync("@omp-bytecode-");
	const entryName = "bytecode-probe-entry";
	const executableSuffix = process.platform === "win32" ? ".exe" : "";
	const dependency = temp.join("bytecode-probe-dep.ts");
	const entrypoint = temp.join(`${entryName}.ts`);
	const outfile = temp.join(`probe${executableSuffix}`);
	const plainOutfile = temp.join(`probe-without-bytecode${executableSuffix}`);
	await Bun.write(dependency, 'export const resolved = import.meta.resolve("node:fs");\n');
	await Bun.write(entrypoint, 'import { resolved } from "./bytecode-probe-dep.ts";\nconsole.log(resolved);\n');

	await compileCodingAgent({
		repoRoot: temp.path(),
		entrypoint,
		outfile,
		transformersVersion: "unused",
	});
	// Same module graph minus `bytecode`. The fixture imports no external or
	// legacy-Pi module, so the remaining compile options cannot account for the
	// artifact difference measured below.
	const plain = await Bun.build({
		entrypoints: [entrypoint],
		root: temp.path(),
		format: "esm",
		compile: {
			outfile: plainOutfile,
			autoloadBunfig: false,
			autoloadDotenv: false,
			autoloadTsconfig: false,
			autoloadPackageJson: false,
		},
		throw: false,
	});
	expect(plain.success).toBe(true);

	const result = await $`${outfile}`.quiet().nothrow();
	expect(result.exitCode).toBe(0);
	expect(result.text().trim()).toBe("node:fs");

	const codeCacheRecord = Buffer.from(`${entryName}.js`);
	const withBytecode = Buffer.from(await Bun.file(outfile).arrayBuffer());
	const withoutBytecode = Buffer.from(await Bun.file(plainOutfile).arrayBuffer());
	expect(withoutBytecode.includes(codeCacheRecord)).toBe(false);
	expect(withBytecode.includes(codeCacheRecord)).toBe(true);
}, 30_000);
