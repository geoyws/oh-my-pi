import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

const cliEntry = path.join(import.meta.dir, "..", "src", "cli.ts");
let temp: TempDir;
let agentDir: string;
let cwd: string;

beforeEach(() => {
	temp = TempDir.createSync("@omp-cli-global-readonly-");
	agentDir = temp.join("agent");
	cwd = temp.join("project");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(cwd);
});
afterEach(async () => { await temp.remove(); });

async function run(args: string[], readonlyEnv: string) {
	const proc = Bun.spawn([process.execPath, cliEntry, "config", ...args], {
		cwd,
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
			PI_CONFIG_READONLY: readonlyEnv,
			PI_CONFIG_FILES: "",
			NO_COLOR: "1",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, output, error] = await Promise.all([
		proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
	]);
	return { exitCode, output: Bun.stripANSI(output), error: Bun.stripANSI(error) };
}

for (const switchName of ["config.readOnly", "PI_CONFIG_READONLY"] as const) {
	describe(`${switchName} CLI refusal`, () => {
		it("config set exits nonzero, names the global target, and never reports success", async () => {
			const config = path.join(agentDir, "config.yml");
			const bytes = switchName === "config.readOnly" ? "config: { readOnly: true }\nautoResume: true\n" : "autoResume: true\n";
			fs.writeFileSync(config, bytes);
			const result = await run(["set", "autoResume", "false", "--json"], switchName === "PI_CONFIG_READONLY" ? "1" : "");
			expect(result.exitCode).not.toBe(0);
			expect(result.error).toContain("autoResume");
			expect(result.error).toContain("read-only");
			expect(result.error).toContain(fs.realpathSync(config));
			expect(result.output).not.toContain('"key":"autoResume"');
			expect(result.output).not.toContain("Set autoResume");
			expect(fs.readFileSync(config, "utf8")).toBe(bytes);
			expect(fs.existsSync(path.join(cwd, ".omp"))).toBe(false);
		}, 30_000);

		it("config reset exits nonzero without changing bytes", async () => {
			const config = path.join(agentDir, "config.yml");
			const bytes = switchName === "config.readOnly" ? "config: { readOnly: true }\n" : "# managed config\n{}\n";
			fs.writeFileSync(config, bytes);
			const result = await run(["reset", "autoResume"], switchName === "PI_CONFIG_READONLY" ? "1" : "");
			expect(result.exitCode).not.toBe(0);
			expect(result.error).toContain("Cannot persist autoResume");
			expect(result.output).not.toContain("Reset autoResume");
			expect(fs.readFileSync(config, "utf8")).toBe(bytes);
		}, 30_000);
	});
}

it("environment readonly rejects invalid YAML without quarantine in the real CLI", async () => {
	const config = path.join(agentDir, "config.yml");
	const bytes = "modelRoles: [unterminated\n";
	fs.writeFileSync(config, bytes);
	const result = await run(["set", "autoResume", "false"], "1");
	expect(result.exitCode).not.toBe(0);
	expect(fs.readFileSync(config, "utf8")).toBe(bytes);
	expect(fs.readdirSync(agentDir)).toEqual(["config.yml"]);
}, 30_000);
