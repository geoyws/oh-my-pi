import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { YAML } from "bun";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

describe("settings YAML source preservation", () => {
	let state: SettingsTestState | undefined;
	let directory: TempDir;
	let agentDir: string;
	let cwd: string;
	let config: string;
	let projectConfig: string;

	beforeEach(() => {
		state = beginSettingsTest();
		directory = TempDir.createSync("@pi-settings-source-");
		agentDir = directory.join("agent");
		cwd = directory.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(cwd), { recursive: true });
		config = path.join(agentDir, "config.yml");
		projectConfig = path.join(getProjectAgentDir(cwd), "config.yml");
	});

	afterEach(async () => {
		AgentStorage.close();
		restoreSettingsTestState(state);
		state = undefined;
		await directory.remove();
	});

	it("updates a scalar role alias without touching its anchored value", async () => {
		const source = 'shared: &model "old/model"\nmodelRoles:\n    default: *model # local\n    smol: *model\n';
		await Bun.write(config, source);
		const settings = await Settings.init({ cwd, agentDir });
		settings.setModelRole("default", "new/model");
		await settings.flush();
		expect(await Bun.file(config).text()).toBe(source.replace("default: *model", "default: new/model"));
	});
	for (const project of [false, true]) {
		for (const remove of [false, true]) {
			it(
				"preserves scalar aliases after " +
					(remove ? (project ? "clearing" : "deleting") : "editing") +
					" their anchor in " +
					(project ? "project" : "global") +
					" YAML",
				async () => {
					const source =
						'# header\nmodelRoles:\n    default: &model "old/model"\n    smol: *model # retain meaning\n\ncustom: [*model]\n';
					const target = project ? projectConfig : config;
					await Bun.write(target, source);
					const settings = await Settings.init({ cwd, agentDir });
					if (project) {
						if (remove) settings.clearProjectModelRole("default");
						else settings.setProjectModelRole("default", "new/model");
					} else settings.setModelRole("default", remove ? undefined : "new/model");
					await settings.flush();
					const output = await Bun.file(target).text();
					const parsed = YAML.parse(output) as { modelRoles: Record<string, unknown>; custom: unknown };
					expect(parsed.custom).toEqual(["old/model"]);
					expect(parsed.modelRoles.smol).toBe("old/model");
					// Global deletion removes the key; project clearing persists a tombstone.
					if (!project || !remove) {
						expect(parsed.modelRoles).toEqual(
							remove ? { smol: "old/model" } : { default: "new/model", smol: "old/model" },
						);
					}
					expect(output).toContain("# header\n");
					expect(output).toContain("# retain meaning\n\ncustom:");
					const reopened = await Settings.loadIsolated({ cwd, agentDir });
					expect(reopened.getModelRole("smol")).toBe("old/model");
					expect(reopened.getModelRole("default")).toBe(remove ? undefined : "new/model");
				},
			);
		}
		for (const action of ["edit", "add", "delete"] as const) {
			for (const mapping of ['&roles { default: "old/model" }', '&roles\n    default: "old/model"']) {
				it(
					"preserves map aliases after anchor " +
						(action === "delete" && project ? "clear" : action) +
						" in " +
						(project ? "project" : "global") +
						" YAML: " +
						mapping,
					async () => {
						const source = "# header\nmodelRoles: " + mapping + "\ncustom: *roles # retain meaning\n";
						const target = project ? projectConfig : config;
						await Bun.write(target, source);
						const settings = await Settings.init({ cwd, agentDir });
						const role = action === "add" ? "smol" : "default";
						if (project) {
							if (action === "delete") settings.clearProjectModelRole(role);
							else settings.setProjectModelRole(role, "new/model");
						} else settings.setModelRole(role, action === "delete" ? undefined : "new/model");
						await settings.flush();
						const output = await Bun.file(target).text();
						const parsed = YAML.parse(output) as Record<string, unknown>;
						expect(parsed.custom).toEqual({ default: "old/model" });
						// Global deletion removes the key; project clearing persists a tombstone.
						if (!project || action !== "delete") {
							expect(parsed.modelRoles ?? {}).toEqual(
								action === "delete"
									? {}
									: action === "add"
										? { default: "old/model", smol: "new/model" }
										: { default: "new/model" },
							);
						}
						expect(output).toContain("# header\n");
						expect(output).toContain("# retain meaning\n");
						const reopened = await Settings.loadIsolated({ cwd, agentDir });
						expect(reopened.getModelRole(role)).toBe(action === "delete" ? undefined : "new/model");
						if (action === "add") expect(reopened.getModelRole("default")).toBe("old/model");
					},
				);
			}
		}
		// A multiline flow end indicator must be indented past its parent key.
		for (const tail of [", }", ",\n    # trailing comma, not a second separator\n  }"]) {
			it(
				"adds a role to a trailing-comma flow map in " +
					(project ? "project" : "global") +
					" YAML: " +
					JSON.stringify(tail),
				async () => {
					const source = '# header\nmodelRoles: {default: "old/model"' + tail + " # roles\n";
					const target = project ? projectConfig : config;
					await Bun.write(target, source);
					const settings = await Settings.init({ cwd, agentDir });
					if (project) settings.setProjectModelRole("smol", "new/model");
					else settings.setModelRole("smol", "new/model");
					await settings.flush();
					const output = await Bun.file(target).text();
					expect(YAML.parse(output)).toEqual({ modelRoles: { default: "old/model", smol: "new/model" } });
					expect(output).toContain('default: "old/model"');
					expect(output).toContain(tail + " # roles\n");
					const reopened = await Settings.loadIsolated({ cwd, agentDir });
					expect(reopened.getModelRole("smol")).toBe("new/model");
					// A subsequent write must also parse and reconcile the persisted source.
					if (project) settings.setProjectModelRole("smol", "next/model");
					else settings.setModelRole("smol", "next/model");
					await settings.flush();
					expect(YAML.parse(await Bun.file(target).text())).toEqual({
						modelRoles: { default: "old/model", smol: "next/model" },
					});
				},
			);
		}
		for (const keepSibling of [false, true]) {
			it(
				(project ? "clears" : "removes") +
					" the last entry of a trailing-comma flow map and adds a role in " +
					(project ? "project" : "global") +
					" YAML, retained sibling: " +
					keepSibling,
				async () => {
					const source =
						"# header\nmodelRoles: {" +
						(keepSibling ? 'advisor: "keep/model", ' : "") +
						'default: "old/model", } # roles\n';
					const target = project ? projectConfig : config;
					await Bun.write(target, source);
					const settings = await Settings.init({ cwd, agentDir });
					if (project) {
						settings.clearProjectModelRole("default");
						settings.setProjectModelRole("smol", "new/model");
					} else {
						settings.setModelRole("default", undefined);
						settings.setModelRole("smol", "new/model");
					}
					await settings.flush();
					const expected = keepSibling ? { advisor: "keep/model", smol: "new/model" } : { smol: "new/model" };
					const parsed = YAML.parse(await Bun.file(target).text()) as { modelRoles: Record<string, unknown> };
					// Global deletion removes the key; project clearing persists a tombstone.
					if (project) expect(parsed.modelRoles).toMatchObject(expected);
					else expect(parsed).toEqual({ modelRoles: expected });
					const reopened = await Settings.loadIsolated({ cwd, agentDir });
					expect(reopened.getModelRole("smol")).toBe("new/model");
					expect(reopened.getModelRole("default")).toBeUndefined();
					if (keepSibling) expect(reopened.getModelRole("advisor")).toBe("keep/model");
				},
			);
		}
	}

	it("preserves flow-map sibling bytes while changing a role", async () => {
		const source = "modelRoles: {default: \"old/model\",  smol: 'keep/smol'} # roles\n";
		await Bun.write(config, source);
		const settings = await Settings.init({ cwd, agentDir });
		settings.setModelRole("default", "new/model");
		await settings.flush();
		expect(await Bun.file(config).text()).toBe(source.replace('"old/model"', '"new/model"'));
	});

	it("preserves project source reread from an external symlink target", async () => {
		const target = directory.join("managed-project.yml");
		await Bun.write(target, 'modelRoles:\n    default: "old/model"\n');
		fs.symlinkSync(target, projectConfig, "file");
		const settings = await Settings.init({ cwd, agentDir });
		settings.setProjectModelRole("default", "new/model");
		const external =
			'# external project\nmodelRoles:\n    default: "old/model" # role\n    smol: \'external/smol\'\n\ncustom: { x: "keep" }';
		await Bun.write(target, external);
		await settings.flush();
		expect(await Bun.file(target).text()).toBe(external.replace('"old/model"', '"new/model"'));
		expect(fs.lstatSync(projectConfig).isSymbolicLink()).toBe(true);
	});

	for (const newline of ["\n", "\r\n"]) {
		for (const eof of [false, true]) {
			it("changes only a quoted theme leaf with " + JSON.stringify({ newline, eof }), async () => {
				const source =
					[
						"# hand-authored settings",
						"theme:",
						'    dark: "titanium"  # selected theme',
						"    light: 'paper'",
						"",
						"extension:",
						"    prose: |-",
						"          indented prose",
						"    list: [one, 'two']",
						"# tail",
					].join(newline) + (eof ? newline : "");
				await Bun.write(config, source);
				const settings = await Settings.init({ cwd, agentDir });
				settings.set("theme.dark", "anthracite");
				await settings.flush();
				expect(await Bun.file(config).text()).toBe(source.replace('"titanium"', '"anthracite"'));
			});
		}
	}

	for (const project of [false, true]) {
		it("changes only a role leaf in " + (project ? "project" : "global") + " YAML", async () => {
			const source =
				'# roles\nmodelRoles:\n    default: "old/model" # retain\n    smol: \'keep/smol\'\n\nother: { x: "keep" }';
			const target = project ? projectConfig : config;
			await Bun.write(target, source);
			const settings = await Settings.init({ cwd, agentDir });
			if (project) settings.setProjectModelRole("default", "new/model");
			else settings.setModelRole("default", "new/model");
			await settings.flush();
			expect(await Bun.file(target).text()).toBe(source.replace('"old/model"', '"new/model"'));
		});

		for (const anchor of [
			'&roles { default: "old/model", smol: keep/smol }',
			'&roles\n    default: "old/model"\n    smol: keep/smol',
		]) {
			it(
				"detaches an edited " + (project ? "project" : "global") + " alias without anchor collateral: " + anchor,
				async () => {
					const source =
						"# shared role defaults\ndefaults: " +
						anchor +
						"\nmodelRoles: *roles # local assignment\nuntouched: *roles\n";
					const target = project ? projectConfig : config;
					await Bun.write(target, source);
					const settings = await Settings.init({ cwd, agentDir });
					if (project) settings.setProjectModelRole("default", "new/model");
					else settings.setModelRole("default", "new/model");
					await settings.flush();
					const output = await Bun.file(target).text();
					expect(output).toBe(
						source.replace("modelRoles: *roles", "modelRoles: { default: new/model, smol: keep/smol }"),
					);
					expect(YAML.parse(output)).toEqual({
						defaults: { default: "old/model", smol: "keep/smol" },
						modelRoles: { default: "new/model", smol: "keep/smol" },
						untouched: { default: "old/model", smol: "keep/smol" },
					});
				},
			);
		}
	}

	it("adds and removes roles using authored four-space collection indentation", async () => {
		const source = "# header\nmodelRoles:\n    default: 'keep/default'\n\n# footer\nother: true\n";
		await Bun.write(config, source);
		const settings = await Settings.init({ cwd, agentDir });
		settings.setModelRole("smol", "new/smol");
		await settings.flush();
		expect(await Bun.file(config).text()).toBe(
			source.replace("    default: 'keep/default'\n", "    default: 'keep/default'\n    smol: new/smol\n"),
		);
		settings.setModelRole("smol", undefined);
		await settings.flush();
		expect(await Bun.file(config).text()).toBe(source);
	});

	it("preserves an existing config.yaml filename and its source", async () => {
		const target = path.join(agentDir, "config.yaml");
		const source = "# alternate filename\ntheme: { dark: \"titanium\", light: 'paper' }\n";
		await Bun.write(target, source);
		const settings = await Settings.init({ cwd, agentDir });
		settings.set("theme.dark", "anthracite");
		await settings.flush();
		expect(await Bun.file(target).text()).toBe(source.replace('"titanium"', '"anthracite"'));
		expect(fs.existsSync(config)).toBe(false);
	});

	for (const symlink of [false, true]) {
		it("reconciles freshly reread external source" + (symlink ? " through a symlink" : ""), async () => {
			const target = symlink ? directory.join("managed.yml") : config;
			await Bun.write(target, 'theme:\n    dark: "titanium"\n');
			if (symlink) fs.symlinkSync(target, config, "file");
			const settings = await Settings.init({ cwd, agentDir });
			settings.set("theme.dark", "anthracite");
			const external =
				'# external comment\ntheme:\n    dark: "titanium" # still old\n    light: \'paper\'\n\ncustom: [a, "b"]';
			await Bun.write(target, external);
			await settings.flush();
			expect(await Bun.file(target).text()).toBe(external.replace('"titanium"', '"anthracite"'));
			if (symlink) expect(fs.lstatSync(config).isSymbolicLink()).toBe(true);
		});
	}

	it("preserves an external same-leaf winner and merges a disjoint role", async () => {
		await Bun.write(config, 'theme:\n    dark: "titanium"\n');
		const settings = await Settings.init({ cwd, agentDir });
		settings.set("theme.dark", "anthracite");
		settings.setModelRole("default", "new/model");
		const external = '# winner\ntheme:\n    dark: "external"\n';
		await Bun.write(config, external);
		await settings.flush();
		expect(await Bun.file(config).text()).toBe(external + "modelRoles:\n    default: new/model\n");
	});

	it("recreates a dangling symlink target without replacing its link", async () => {
		const target = directory.join("managed.yml");
		fs.symlinkSync(target, config, "file");
		const settings = await Settings.init({ cwd, agentDir });
		settings.setModelRole("default", "new/model");
		await settings.flush();
		expect(fs.lstatSync(config).isSymbolicLink()).toBe(true);
		expect(YAML.parse(await Bun.file(target).text())).toEqual({ modelRoles: { default: "new/model" } });
	});

	it("quarantines malformed source and uses fresh serialization on recovery", async () => {
		await Bun.write(config, "modelRoles:\n  default: keep/default\n");
		const settings = await Settings.init({ cwd, agentDir });
		const malformed = '# do not lose\nmodelRoles: ["unterminated\n';
		await Bun.write(config, malformed);
		settings.set("theme.dark", "anthracite");
		await expect(settings.flush()).rejects.toThrow("Settings config is invalid");
		const backups = fs.readdirSync(agentDir).filter(name => name.startsWith("config.yml.broken-"));
		expect(backups).toHaveLength(1);
		expect(await Bun.file(path.join(agentDir, backups[0])).text()).toBe(malformed);
		await settings.flush();
		expect(YAML.parse(await Bun.file(config).text())).toEqual({
			modelRoles: { default: "keep/default" },
			theme: { dark: "anthracite" },
		});
		expect(await Bun.file(path.join(agentDir, backups[0])).text()).toBe(malformed);
	});

	it("removes migrated legacy keys without reformatting unrelated source", async () => {
		const source =
			'# keep heading\nqueueMode: one-at-a-time\nlastChangelogVersion: "18.0.0"\n\ntheme:\n    dark: "titanium"\n# tail\n';
		await Bun.write(config, source);
		const settings = await Settings.init({ cwd, agentDir });
		settings.set("theme.dark", "anthracite");
		await settings.flush();
		expect(await Bun.file(config).text()).toBe(
			'# keep heading\n\ntheme:\n    dark: "anthracite"\nsteeringMode: one-at-a-time\n# tail\n',
		);
	});

	for (const newline of ["\n", "\r\n"]) {
		for (const eof of [false, true]) {
			it("keeps nested migration additions before parent siblings " + JSON.stringify({ newline, eof }), async () => {
				const source =
					["# header", "task:", "    isolation:", "        mode: none"].join(newline) + (eof ? newline : "");
				await Bun.write(config, source);
				const settings = await Settings.init({ cwd, agentDir });
				settings.set("display.showTokenUsage", true);
				await settings.flush();
				const output = await Bun.file(config).text();
				expect(YAML.parse(output)).toEqual({
					task: { isolation: { enabled: false } },
					display: { showTokenUsage: true },
				});
				expect(output).toContain("# header" + newline);
				expect(output.endsWith(newline)).toBe(eof);
				const reopened = await Settings.loadIsolated({ cwd, agentDir });
				expect(reopened.get("task.isolation.enabled")).toBe(false);
				expect(reopened.get("display.showTokenUsage")).toBe(true);
			});
			it(
				"persists consent/reminder migrations alongside a parent sibling " + JSON.stringify({ newline, eof }),
				async () => {
					const source =
						[
							"# header",
							"dev:",
							"    autoqa:",
							"        consent: denied",
							"todo:",
							"    reminders:",
							"        max: 1",
						].join(newline) + (eof ? newline : "");
					await Bun.write(config, source);
					const settings = await Settings.init({ cwd, agentDir });
					settings.set("display.showTokenUsage", true);
					await settings.flush();
					const output = await Bun.file(config).text();
					expect(YAML.parse(output)).toEqual({
						dev: { autoqaConsent: "denied" },
						todo: { remindersMax: 1 },
						display: { showTokenUsage: true },
					});
					expect(output).toContain("# header" + newline);
					expect(output.endsWith(newline)).toBe(eof);
					const reopened = await Settings.loadIsolated({ cwd, agentDir });
					expect(reopened.get("dev.autoqaConsent")).toBe("denied");
					expect(reopened.isConfigured("dev.autoqa")).toBe(false);
					expect(reopened.get("todo.remindersMax")).toBe(1);
					expect(reopened.get("todo.reminders")).toBe(true);
				},
			);
		}
	}

	it("keeps legacy JSON migration on the fresh-file path", async () => {
		const legacy = path.join(agentDir, "settings.json");
		const source = '{"theme":{"dark":"titanium"}}';
		await Bun.write(legacy, source);
		const settings = await Settings.init({ cwd, agentDir });
		expect(YAML.parse(await Bun.file(config).text())).toEqual({ theme: { dark: "titanium" } });
		expect(await Bun.file(legacy + ".bak").text()).toBe(source);
		settings.set("theme.dark", "anthracite");
		await settings.flush();
		expect(YAML.parse(await Bun.file(config).text())).toEqual({ theme: { dark: "anthracite" } });
	});
});
