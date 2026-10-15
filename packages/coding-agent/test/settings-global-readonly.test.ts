import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { YAML } from "bun";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

let state: SettingsTestState;
let temp: TempDir;
let agentDir: string;
let cwd: string;
let config: string;
let instances: Settings[];

beforeEach(() => {
	state = beginSettingsTest();
	delete process.env.PI_CONFIG_READONLY;
	delete process.env.PI_CONFIG_FILES;
	temp = TempDir.createSync("@omp-global-readonly-");
	agentDir = temp.join("agent");
	cwd = temp.join("project");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(cwd, { recursive: true });
	config = path.join(agentDir, "config.yml");
	instances = [];
});

afterEach(async () => {
	for (const instance of instances) instance.cancelPendingSaves();
	AgentStorage.close();
	restoreSettingsTestState(state);
	await temp.remove();
});

async function load(options: Parameters<typeof Settings.loadIsolated>[0] = {}): Promise<Settings> {
	const settings = await Settings.loadIsolated({ cwd, agentDir, ...options });
	instances.push(settings);
	return settings;
}

for (const switchName of ["config.readOnly", "PI_CONFIG_READONLY"] as const) {
	describe(switchName, () => {
		function source(): string {
			if (switchName === "PI_CONFIG_READONLY") process.env.PI_CONFIG_READONLY = "1";
			return `${switchName === "config.readOnly" ? "config:\n  readOnly: true\n" : ""}# managed bytes\nmodelRoles:\n  default: provider/global:high\nqueueMode: all\nlastChangelogVersion: 'old'\n`;
		}

		it("preserves startup bytes, legacy files, and all refused ordinary writes", async () => {
			const bytes = source();
			fs.writeFileSync(config, bytes);
			const legacy = path.join(agentDir, "settings.json");
			fs.writeFileSync(legacy, '{"queueMode":"one-at-a-time"}\n');
			const settings = await load();
			expect(settings.isGlobalConfigReadOnly()).toBe(true);
			expect(settings.get("steeringMode")).toBe("all");
			expect(() => settings.set("autoResume", false)).toThrow("autoResume");
			expect(() => settings.set("config.readOnly", false)).toThrow("read-only");
			expect(() => settings.set("modelRoles", { default: "provider/other" })).toThrow("modelRoles");
			await settings.flush();
			expect(fs.readFileSync(config, "utf8")).toBe(bytes);
			expect(fs.readFileSync(legacy, "utf8")).toBe('{"queueMode":"one-at-a-time"}\n');
			expect(fs.readdirSync(agentDir).sort()).toEqual(["config.yml", "settings.json"]);
		});

		it("routes role assignment and clearing to an existing project without losing thinking suffixes", async () => {
			const bytes = source();
			fs.writeFileSync(config, bytes);
			fs.mkdirSync(getProjectAgentDir(cwd));
			const projectConfig = path.join(getProjectAgentDir(cwd), "config.yml");
			fs.writeFileSync(projectConfig, "autoResume: false\nmodelRoles:\n  smol: provider/keep:low\n");
			const settings = await load();
			expect(settings.getModelRoleStorage()).toBe("project");
			settings.setModelRole("default", "provider/project:high");
			await settings.flush();
			const project = YAML.parse(fs.readFileSync(projectConfig, "utf8"));
			expect(project.modelRoles.default).toBe("provider/project:high");
			expect(project.modelRoles.smol).toBe("provider/keep:low");
			expect(project.autoResume).toBe(false);
			settings.setModelRole("default", undefined);
			await settings.flush();
			expect(settings.getModelRole("default")).toBe("provider/global:high");
			expect(fs.readFileSync(config, "utf8")).toBe(bytes);
		});

		it("refuses absent cwd/.omp with one setting-specific resolved-target error", async () => {
			const bytes = source();
			const target = temp.join("managed.yml");
			fs.writeFileSync(target, bytes);
			fs.symlinkSync(target, config);
			const settings = await load();
			let error: unknown;
			try { settings.setModelRole("smol", "provider/project:low"); } catch (caught) { error = caught; }
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toContain("modelRoles.smol");
			expect((error as Error).message).toContain(fs.realpathSync(target));
			expect(settings.getProjectModelRole("smol")).toBeUndefined();
			await settings.flush();
			expect(fs.existsSync(getProjectAgentDir(cwd))).toBe(false);
			expect(fs.readFileSync(target, "utf8")).toBe(bytes);
		});

		it("preserves overlay precedence across role writes and cwd clones", async () => {
			fs.writeFileSync(config, source());
			fs.mkdirSync(getProjectAgentDir(cwd));
			const overlay = temp.join("overlay.yml");
			const overlayBytes = "modelRoles:\n  default: provider/overlay:low\n";
			fs.writeFileSync(overlay, overlayBytes);
			process.env.PI_CONFIG_FILES = overlay;
			const settings = await load();
			settings.setModelRole("default", "provider/project:high");
			await settings.flush();
			expect(settings.getModelRole("default")).toBe("provider/overlay:low");
			const clone = await settings.cloneForCwd(cwd);
			instances.push(clone);
			expect(clone.isGlobalConfigReadOnly()).toBe(true);
			expect(clone.getModelRole("default")).toBe("provider/overlay:low");
			expect(fs.readFileSync(overlay, "utf8")).toBe(overlayBytes);
		});
	});
}

it("does not quarantine invalid global YAML under the environment policy", async () => {
	process.env.PI_CONFIG_READONLY = "1";
	const bytes = "modelRoles: [broken\n";
	fs.writeFileSync(config, bytes);
	await expect(load()).rejects.toThrow();
	expect(fs.readFileSync(config, "utf8")).toBe(bytes);
	expect(fs.readdirSync(agentDir)).toEqual(["config.yml"]);
});

it("does not migrate or archive a legacy-only global source", async () => {
	process.env.PI_CONFIG_READONLY = "1";
	const legacy = path.join(agentDir, "settings.json");
	const bytes = '{"autoResume":false}\n';
	fs.writeFileSync(legacy, bytes);
	await load();
	expect(fs.readFileSync(legacy, "utf8")).toBe(bytes);
	expect(fs.readdirSync(agentDir)).toEqual(["settings.json"]);
});

it("retains writable project-directory creation", async () => {
	fs.writeFileSync(config, "{}\n");
	const settings = await load();
	settings.setProjectModelRole("default", "provider/project:high");
	await settings.flush();
	expect(YAML.parse(fs.readFileSync(path.join(getProjectAgentDir(cwd), "config.yml"), "utf8")).modelRoles.default).toBe("provider/project:high");
});

it("keeps programmatic readOnly stronger than the named policy", async () => {
	fs.writeFileSync(config, "config: { readOnly: true }\n");
	for (const settings of [await load({ readOnly: true }), await Settings.loadReadOnly({ cwd, agentDir })]) {
		instances.push(settings);
		settings.set("autoResume", false);
		settings.setProjectModelRole("default", "provider/memory:high");
		await settings.flush();
	}
	expect(fs.existsSync(getProjectAgentDir(cwd))).toBe(false);
	expect(fs.readFileSync(config, "utf8")).toBe("config: { readOnly: true }\n");
});
