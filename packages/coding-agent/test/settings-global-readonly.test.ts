import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { YAML } from "bun";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { getAgentDbPath, getLastChangelogVersionPath, getProjectAgentDir, isRecord, TempDir } from "@oh-my-pi/pi-utils";
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

function readProjectConfig(file: string): { autoResume: unknown; modelRoles: Record<string, unknown> } {
	const parsed: unknown = YAML.parse(fs.readFileSync(file, "utf8"));
	if (!isRecord(parsed)) throw new Error(`${file} is not a YAML mapping`);
	const modelRoles = parsed.modelRoles;
	if (!isRecord(modelRoles)) throw new Error(`${file} has no modelRoles mapping`);
	return { autoResume: parsed.autoResume, modelRoles };
}

/** Agent-dir entries other than runtime storage (agent.db and its WAL/SHM sidecars). */
function configEntries(): string[] {
	return fs
		.readdirSync(agentDir)
		.filter(entry => !/^agent\.db(-wal|-shm)?$/.test(entry))
		.sort();
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
			expect(configEntries()).toEqual(["config.yml", "settings.json"]);
		});

		it("keeps runtime storage recording and reopening without touching global config, legacy rows, or markers", async () => {
			const bytes = source();
			fs.writeFileSync(config, bytes);
			const legacy = path.join(agentDir, "settings.json");
			const legacyBytes = '{"queueMode":"one-at-a-time"}\n';
			fs.writeFileSync(legacy, legacyBytes);
			// Seed a legacy agent.db settings row; writable startup would migrate and clear it.
			const dbPath = getAgentDbPath(agentDir);
			await AgentStorage.open(dbPath);
			AgentStorage.close();
			const db = new Database(dbPath);
			db.run("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, 0)", ["autoResume", "false"]);
			db.close();

			const settings = await load();
			expect(settings.isGlobalConfigReadOnly()).toBe(true);
			const storage = settings.getStorage();
			if (!storage) throw new Error("runtime storage unavailable under the global read-only policy");
			storage.recordModelUsage("provider/mru");
			expect(storage.getModelUsageOrder()).toEqual(["provider/mru"]);
			storage.recordCommandUsage("model");
			storage.recordCommandUsage("model");
			expect(storage.listCommandUsage()).toEqual({ model: 2 });
			settings.cancelPendingSaves();
			AgentStorage.close();

			const reopened = await load();
			const reopenedStorage = reopened.getStorage();
			if (!reopenedStorage) throw new Error("runtime storage unavailable after reopen");
			expect(reopenedStorage.getModelUsageOrder()).toEqual(["provider/mru"]);
			expect(reopenedStorage.listCommandUsage()).toEqual({ model: 2 });
			expect(reopenedStorage.getSettings()).toEqual({ autoResume: false });
			await reopened.flush();

			expect(fs.readFileSync(config, "utf8")).toBe(bytes);
			expect(fs.readFileSync(legacy, "utf8")).toBe(legacyBytes);
			expect(fs.existsSync(getLastChangelogVersionPath(agentDir))).toBe(false);
			expect(configEntries()).toEqual(["config.yml", "settings.json"]);
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
			const project = readProjectConfig(projectConfig);
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
			try {
				settings.setModelRole("smol", "provider/project:low");
			} catch (caught) {
				error = caught;
			}
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toContain("modelRoles.smol");
			expect((error as Error).message).toContain(fs.realpathSync(target));
			expect(settings.getProjectModelRole("smol")).toBeUndefined();
			await settings.flush();
			expect(fs.existsSync(getProjectAgentDir(cwd))).toBe(false);
			expect(fs.readFileSync(target, "utf8")).toBe(bytes);
		});

		it("refuses an initially missing global config through an existing project-directory alias", async () => {
			const policy = temp.join("policy.yml");
			fs.writeFileSync(policy, source());
			fs.symlinkSync(agentDir, getProjectAgentDir(cwd), "dir");
			const settings = await load({ configFiles: [policy] });
			expect(settings.isGlobalConfigReadOnly()).toBe(true);
			expect(() => settings.setModelRole("smol", "provider/project:high")).toThrow("modelRoles.smol");
			await settings.flush();
			expect(fs.existsSync(config)).toBe(false);
			expect(configEntries()).toEqual([]);
		});

		for (const alias of [
			"project directory",
			"global directory",
			"file chain",
			"dangling directory target",
		] as const) {
			it(`refuses a missing global target reached through a ${alias} alias`, async () => {
				const bytes = source();
				fs.writeFileSync(config, bytes);
				const settings = await load();
				fs.unlinkSync(config);
				const projectDir = getProjectAgentDir(cwd);
				let protectedTarget = config;
				if (alias === "project directory") {
					fs.symlinkSync(agentDir, projectDir, "dir");
				} else if (alias === "global directory") {
					fs.mkdirSync(projectDir);
					fs.rmdirSync(agentDir);
					fs.symlinkSync(projectDir, agentDir, "dir");
					protectedTarget = path.join(projectDir, "config.yml");
				} else {
					fs.mkdirSync(projectDir);
					const intermediate = temp.join("intermediate.yml");
					fs.symlinkSync(intermediate, path.join(projectDir, "config.yml"));
					if (alias === "file chain") {
						fs.symlinkSync(config, intermediate);
					} else {
						const missingDir = temp.join("not-created");
						const directoryAlias = temp.join("directory-alias");
						fs.symlinkSync(missingDir, directoryAlias, "dir");
						protectedTarget = path.join(missingDir, "managed.yml");
						fs.symlinkSync(path.join(directoryAlias, "managed.yml"), config);
						fs.symlinkSync(protectedTarget, intermediate);
					}
				}
				for (const value of ["provider/project:high", undefined]) {
					let error: unknown;
					try {
						settings.setModelRole("smol", value);
					} catch (caught) {
						error = caught;
					}
					expect(error).toBeInstanceOf(Error);
					expect((error as Error).message).toContain("modelRoles.smol");
					expect((error as Error).message).toContain("global config is read-only");
					expect((error as Error).message).toContain(
						path.join(fs.realpathSync(temp.join()), path.relative(temp.join(), protectedTarget)),
					);
				}
				await settings.flush();
				expect(fs.existsSync(protectedTarget)).toBe(false);
				expect(settings.getProjectModelRole("smol")).toBeUndefined();
				// Restore the managed source and reopen: refused saves left no project role behind.
				fs.mkdirSync(path.dirname(protectedTarget), { recursive: true });
				fs.writeFileSync(protectedTarget, bytes);
				const reopened = await load();
				expect(reopened.getProjectModelRole("smol")).toBeUndefined();
				expect(fs.readFileSync(config, "utf8")).toBe(bytes);
			});
		}

		for (const alias of ["directory", "dangling file"] as const) {
			it(`saves and reopens a safe project ${alias} alias`, async () => {
				const bytes = source();
				fs.writeFileSync(config, bytes);
				const projectDir = getProjectAgentDir(cwd);
				const safeDir = temp.join("safe-project");
				fs.mkdirSync(safeDir);
				const target = path.join(safeDir, "config.yml");
				if (alias === "directory") {
					fs.symlinkSync(safeDir, projectDir, "dir");
				} else {
					fs.mkdirSync(projectDir);
					fs.symlinkSync(target, path.join(projectDir, "config.yml"));
				}
				const settings = await load();
				settings.setModelRole("smol", "provider/project:high");
				await settings.flush();
				expect(readProjectConfig(target).modelRoles.smol).toBe("provider/project:high");
				expect((await load()).getModelRole("smol")).toBe("provider/project:high");
				expect(fs.readFileSync(config, "utf8")).toBe(bytes);
				expect(
					fs.lstatSync(alias === "directory" ? projectDir : path.join(projectDir, "config.yml")).isSymbolicLink(),
				).toBe(true);
			});
		}

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
	expect(configEntries()).toEqual(["settings.json"]);
	expect(fs.existsSync(getLastChangelogVersionPath(agentDir))).toBe(false);
});

it("retains writable project-directory creation", async () => {
	fs.writeFileSync(config, "{}\n");
	const settings = await load();
	settings.setProjectModelRole("default", "provider/project:high");
	await settings.flush();
	expect(readProjectConfig(path.join(getProjectAgentDir(cwd), "config.yml")).modelRoles.default).toBe(
		"provider/project:high",
	);
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
