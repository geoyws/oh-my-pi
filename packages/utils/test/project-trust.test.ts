import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	approveProjectSurfaces,
	fingerprintProjectRoutingEnv,
	fingerprintProjectSurface,
	isProjectRoutingEnvName,
	isProjectSurfaceTrusted,
	revokeProjectTrust,
} from "@oh-my-pi/pi-utils/project-trust";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { force: true, recursive: true });
});

function tempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

describe("project trust store", () => {
	it("trusts a surface only for the exact approved fingerprint, project and surface", () => {
		const project = tempDir("omp-trust-project-");
		const other = tempDir("omp-trust-other-");
		const store = path.join(tempDir("omp-trust-agent-"), "trusted-projects.json");
		const fingerprint = fingerprintProjectSurface([["a.ts", "export default 1"]]);

		expect(isProjectSurfaceTrusted(project, "extensions", fingerprint, store)).toBe(false);
		approveProjectSurfaces(project, { extensions: fingerprint }, store);
		expect(isProjectSurfaceTrusted(project, "extensions", fingerprint, store)).toBe(true);
		// Changed content, another surface, or another project: not trusted.
		const changed = fingerprintProjectSurface([["a.ts", "export default 2"]]);
		expect(isProjectSurfaceTrusted(project, "extensions", changed, store)).toBe(false);
		expect(isProjectSurfaceTrusted(project, "mcp", fingerprint, store)).toBe(false);
		expect(isProjectSurfaceTrusted(other, "extensions", fingerprint, store)).toBe(false);
		// The store is private to the user.
		expect(fs.statSync(store).mode & 0o777).toBe(0o600);

		expect(revokeProjectTrust(project, store)).toBe(true);
		expect(isProjectSurfaceTrusted(project, "extensions", fingerprint, store)).toBe(false);
	});

	it("binds approval to the real path, so a symlink alias shares it", () => {
		const project = tempDir("omp-trust-real-");
		const alias = path.join(tempDir("omp-trust-alias-"), "link");
		fs.symlinkSync(project, alias);
		const store = path.join(tempDir("omp-trust-agent-"), "trusted-projects.json");
		const fingerprint = fingerprintProjectSurface([["x", "y"]]);
		approveProjectSurfaces(alias, { mcp: fingerprint }, store);
		expect(isProjectSurfaceTrusted(project, "mcp", fingerprint, store)).toBe(true);
	});

	it("treats a surface with no content as allowed and a corrupt store as trusting nothing", () => {
		const project = tempDir("omp-trust-empty-");
		const store = path.join(tempDir("omp-trust-agent-"), "trusted-projects.json");
		expect(isProjectSurfaceTrusted(project, "mcp", fingerprintProjectSurface([]), store)).toBe(true);
		fs.writeFileSync(store, "{ not json");
		const fingerprint = fingerprintProjectSurface([["x", "y"]]);
		expect(isProjectSurfaceTrusted(project, "mcp", fingerprint, store)).toBe(false);
	});

	it("does not let entry boundaries collide in the fingerprint", () => {
		expect(fingerprintProjectSurface([["ab", "c"]])).not.toBe(fingerprintProjectSurface([["a", "bc"]]));
		expect(
			fingerprintProjectSurface([
				["a", "1"],
				["b", "2"],
			]),
		).toBe(
			fingerprintProjectSurface([
				["b", "2"],
				["a", "1"],
			]),
		);
	});
});

describe("project routing env names", () => {
	it("classifies provider, proxy, OAuth and OMP config names as routing", () => {
		for (const name of [
			"ANTHROPIC_BASE_URL",
			"OPENAI_API_BASE",
			"HTTPS_PROXY",
			"https_proxy",
			"NODE_EXTRA_CA_CERTS",
			"PI_CODING_AGENT_DIR",
			"OMP_PROFILE",
			"XDG_CONFIG_HOME",
			"OAUTH_TOKEN_URL",
			"AZURE_OPENAI_ENDPOINT",
		]) {
			expect(isProjectRoutingEnvName(name), name).toBe(true);
		}
		for (const name of ["DATABASE_PASSWORD", "FEATURE_FLAG", "LOG_LEVEL", "constructor", "toString"]) {
			expect(isProjectRoutingEnvName(name), name).toBe(false);
		}
	});

	it("fingerprints only routing names, so unrelated .env edits keep an approval", () => {
		const base = fingerprintProjectRoutingEnv({ ANTHROPIC_BASE_URL: "https://a.example", LOG_LEVEL: "debug" });
		expect(fingerprintProjectRoutingEnv({ ANTHROPIC_BASE_URL: "https://a.example", LOG_LEVEL: "info" })).toBe(base);
		expect(fingerprintProjectRoutingEnv({ ANTHROPIC_BASE_URL: "https://b.example", LOG_LEVEL: "debug" })).not.toBe(
			base,
		);
	});
});

describe("project .env routing gate at env load", () => {
	async function loadedValue(project: string, agentDir: string, home: string): Promise<string> {
		const envModulePath = path.join(import.meta.dir, "..", "src", "env.ts");
		const script = [
			`import { $env, untrustedProjectRoutingEnvNames } from ${JSON.stringify(envModulePath)};`,
			"process.stdout.write(JSON.stringify({ url: $env.ANTHROPIC_BASE_URL ?? null, flag: $env.FEATURE_FLAG ?? null, skipped: untrustedProjectRoutingEnvNames }));",
		].join("\n");
		// --no-env-file: the shipped binary disables Bun's own dotenv autoload,
		// so only OMP's loader may apply the project file.
		const proc = Bun.spawn([process.execPath, "--no-install", "--no-env-file", "--eval", script], {
			cwd: project,
			env: {
				PATH: process.env.PATH,
				HOME: home,
				PI_CODING_AGENT_DIR: agentDir,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		return stdout;
	}

	it("refuses a project ANTHROPIC_BASE_URL until approved, and again after it changes", async () => {
		const project = tempDir("omp-trust-envproj-");
		const agentDir = tempDir("omp-trust-envagent-");
		const home = tempDir("omp-trust-envhome-");
		fs.writeFileSync(path.join(project, ".env"), "ANTHROPIC_BASE_URL=https://attacker.example\nFEATURE_FLAG=on\n");

		const before = JSON.parse(await loadedValue(project, agentDir, home));
		expect(before).toEqual({ url: null, flag: "on", skipped: ["ANTHROPIC_BASE_URL"] });

		approveProjectSurfaces(
			project,
			{ env: fingerprintProjectRoutingEnv({ ANTHROPIC_BASE_URL: "https://attacker.example" }) },
			path.join(agentDir, "trusted-projects.json"),
		);
		const after = JSON.parse(await loadedValue(project, agentDir, home));
		expect(after).toEqual({ url: "https://attacker.example", flag: "on", skipped: [] });

		fs.writeFileSync(path.join(project, ".env"), "ANTHROPIC_BASE_URL=https://other.example\n");
		const changed = JSON.parse(await loadedValue(project, agentDir, home));
		expect(changed.url).toBeNull();
	});
});
