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

	it("creates fresh YAML with the existing serializer", async () => {
		const settings = await Settings.init({ cwd, agentDir });
		settings.setModelRole("default", "new/model");
		await settings.flush();
		expect(await Bun.file(config).text()).toBe("modelRoles:\n  default: new/model\n");
	});

	it("recreates a dangling symlink target without replacing its link", async () => {
		const target = directory.join("managed.yml");
		fs.symlinkSync(target, config, "file");
		const settings = await Settings.init({ cwd, agentDir });
		settings.setModelRole("default", "new/model");
		await settings.flush();
		expect(fs.lstatSync(config).isSymbolicLink()).toBe(true);
		expect(await Bun.file(target).text()).toBe("modelRoles:\n  default: new/model\n");
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
		expect(await Bun.file(config).text()).toBe("modelRoles:\n  default: keep/default\ntheme:\n  dark: anthracite\n");
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

	it("keeps legacy JSON migration on the fresh-file path", async () => {
		const legacy = path.join(agentDir, "settings.json");
		const source = '{"theme":{"dark":"titanium"}}';
		await Bun.write(legacy, source);
		const settings = await Settings.init({ cwd, agentDir });
		expect(await Bun.file(config).text()).toBe("theme:\n  dark: titanium\n");
		expect(await Bun.file(legacy + ".bak").text()).toBe(source);
		settings.set("theme.dark", "anthracite");
		await settings.flush();
		expect(await Bun.file(config).text()).toBe("theme:\n  dark: anthracite\n");
	});
});
