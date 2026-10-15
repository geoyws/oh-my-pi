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

	describe("string transitions", () => {
		// Each authored form splits into the bytes before the edited value, the value, and the bytes after it.
		const authored: Record<string, { before: string; value: string; after: string; previous: string | null }> = {
			plain: { before: "    bankMission: ", value: "old mission", after: " # mission\n", previous: "old mission" },
			double: {
				before: "    bankMission: ",
				value: '"old mission"',
				after: " # mission\n",
				previous: "old mission",
			},
			single: {
				before: "    bankMission: ",
				value: "'old mission'",
				after: " # mission\n",
				previous: "old mission",
			},
			empty: { before: "    bankMission:", value: "", after: " # mission\n", previous: null },
			literal: {
				before: "    bankMission: ",
				value: "|\n        old\n        mission\n",
				after: "",
				previous: "old\nmission\n",
			},
			folded: {
				before: "    bankMission: ",
				value: ">-\n        old\n        mission\n",
				after: "",
				previous: "old mission",
			},
		};
		const head = "# header\nshared: &shared [a, b] # anchor\nhindsight:\n";
		const tail =
			"    bankId: bank # neighbour\n    retainMission: |\n        keep\n        me\ntheme:\n    dark: titanium # tail\n";
		const values = [
			"first line\nsecond line",
			"trailing newline\n",
			"kept trailing\n\n",
			"  leading indent\nnext",
			"--- marker\n...",
			"space before \nbreak",
			"tab\tand 'quotes\" \\ # hash: colon",
			"single line",
		];
		for (const newline of ["\n", "\r\n"]) {
			for (const [form, parts] of Object.entries(authored)) {
				for (const value of values) {
					it("sets " + form + " " + JSON.stringify(value) + " with " + JSON.stringify(newline), async () => {
						const crlf = (text: string) => text.replaceAll("\n", newline);
						const before = crlf(head + parts.before);
						const after = crlf(parts.after + tail);
						await Bun.write(config, before + crlf(parts.value) + after);
						const settings = await Settings.init({ cwd, agentDir });
						expect(settings.get("hindsight.bankMission") ?? null).toBe(parts.previous);
						settings.set("hindsight.bankMission", value);
						await settings.flush();
						const output = await Bun.file(config).text();
						expect(output.startsWith(before)).toBe(true);
						expect(output.endsWith(after)).toBe(true);
						expect(YAML.parse(output)).toEqual({
							shared: ["a", "b"],
							hindsight: { bankMission: value, bankId: "bank", retainMission: "keep\nme\n" },
							theme: { dark: "titanium" },
						});
						expect(fs.readdirSync(agentDir).filter(name => name.startsWith("config.yml.broken-"))).toEqual([]);
						const reopened = await Settings.loadIsolated({ cwd, agentDir });
						expect(reopened.get("hindsight.bankMission")).toBe(value);
						expect(reopened.get("hindsight.bankId")).toBe("bank");
						expect(reopened.get("theme.dark")).toBe("titanium");
					});
				}
			}
		}

		// Header comments sit inside the block scalar's range; the values cover block
		// output, single-line output, and the library's fallback to quoting.
		for (const newline of ["\n", "\r\n"]) {
			for (const header of ["| # managed", ">- # managed", "|+2   #managed: keep"]) {
				for (const value of ["first\nsecond\n", "single", "trailing whitespace\n  ", "bell\u0007\nnext"]) {
					it(
						"keeps " +
							JSON.stringify(header) +
							" for " +
							JSON.stringify(value) +
							" with " +
							JSON.stringify(newline),
						async () => {
							const crlf = (text: string) => text.replaceAll("\n", newline);
							const comment = header.slice(header.indexOf(" "));
							const before = crlf(head + "    bankMission: ");
							const after = crlf(tail);
							await Bun.write(config, before + crlf(header + "\n        old\n        text\n") + after);
							const settings = await Settings.init({ cwd, agentDir });
							settings.set("hindsight.bankMission", value);
							await settings.flush();
							const output = await Bun.file(config).text();
							expect(output.startsWith(before)).toBe(true);
							expect(output.endsWith(after)).toBe(true);
							const edited = output.slice(before.length, output.length - after.length);
							expect(edited.split(newline)[0].endsWith(comment)).toBe(true);
							expect(edited.split(comment)).toHaveLength(2);
							expect(YAML.parse(output)).toEqual({
								shared: ["a", "b"],
								hindsight: { bankMission: value, bankId: "bank", retainMission: "keep\nme\n" },
								theme: { dark: "titanium" },
							});
							expect(fs.readdirSync(agentDir).filter(name => name.startsWith("config.yml.broken-"))).toEqual([]);
							const reopened = await Settings.loadIsolated({ cwd, agentDir });
							expect(reopened.get("hindsight.bankMission")).toBe(value);
							expect(reopened.get("hindsight.bankId")).toBe("bank");
						},
					);
				}
			}
		}

		it("sets a multiline value inside a flow mapping", async () => {
			const before = "# header\nhindsight: { bankMission: ";
			const after = ", bankId: bank } # flow\ntheme:\n    dark: titanium # tail\n";
			await Bun.write(config, before + "old" + after);
			const settings = await Settings.init({ cwd, agentDir });
			settings.set("hindsight.bankMission", "first\n  second\n");
			await settings.flush();
			const output = await Bun.file(config).text();
			expect(output.startsWith(before)).toBe(true);
			expect(output.endsWith(after)).toBe(true);
			const reopened = await Settings.loadIsolated({ cwd, agentDir });
			expect(reopened.get("hindsight.bankMission")).toBe("first\n  second\n");
			expect(reopened.get("hindsight.bankId")).toBe("bank");
		});

		it("adds a multiline value beside existing keys", async () => {
			const source = head + tail;
			await Bun.write(config, source);
			const settings = await Settings.init({ cwd, agentDir });
			settings.set("hindsight.bankMission", "--- first\nsecond\n");
			await settings.flush();
			const output = await Bun.file(config).text();
			expect(output.startsWith(head + tail.slice(0, tail.indexOf("theme:")))).toBe(true);
			expect(output.endsWith("theme:\n    dark: titanium # tail\n")).toBe(true);
			const reopened = await Settings.loadIsolated({ cwd, agentDir });
			expect(reopened.get("hindsight.bankMission")).toBe("--- first\nsecond\n");
			expect(reopened.get("hindsight.retainMission")).toBe("keep\nme\n");
		});
	});

	describe("merge keys", () => {
		const source =
			"x-common: &common\n    enabled: true\n    contextBefore: 2\ngrep:\n    <<: *common # shared\n    contextAfter: 3\ntheme:\n    dark: titanium\n";

		it("keeps merge syntax and inherited keys when editing an unrelated leaf", async () => {
			await Bun.write(config, source);
			const settings = await Settings.init({ cwd, agentDir });
			settings.set("theme.dark", "midnight");
			await settings.flush();
			const output = await Bun.file(config).text();
			expect(output).toBe(source.replace("titanium", "midnight"));
			const reopened = await Settings.loadIsolated({ cwd, agentDir });
			expect(reopened.get("theme.dark")).toBe("midnight");
			expect(reopened.get("grep.enabled")).toBe(true);
			expect(reopened.get("grep.contextBefore")).toBe(2);
			expect(reopened.get("grep.contextAfter")).toBe(3);
		});

		it("overrides an edited inherited leaf without changing its shared anchor", async () => {
			await Bun.write(config, source);
			const settings = await Settings.init({ cwd, agentDir });
			settings.set("grep.contextBefore", 5);
			await settings.flush();
			const output = await Bun.file(config).text();
			expect(output).toBe(source.replace("    contextAfter: 3\n", "    contextAfter: 3\n    contextBefore: 5\n"));
			expect(YAML.parse(output)).toEqual({
				"x-common": { enabled: true, contextBefore: 2 },
				grep: { enabled: true, contextBefore: 5, contextAfter: 3 },
				theme: { dark: "titanium" },
			});
			const reopened = await Settings.loadIsolated({ cwd, agentDir });
			expect(reopened.get("grep.enabled")).toBe(true);
			expect(reopened.get("grep.contextBefore")).toBe(5);
			expect(reopened.get("grep.contextAfter")).toBe(3);
		});

		it("materializes a merge when deleting an inherited role", async () => {
			const roles =
				"role-defaults: &roles\n    default: shared/default\n    smol: shared/smol\nmodelRoles:\n    <<: *roles # inherited roles\n    slow: local/slow\n";
			await Bun.write(config, roles);
			const settings = await Settings.init({ cwd, agentDir });
			settings.setModelRole("smol", undefined);
			await settings.flush();
			const output = await Bun.file(config).text();
			expect(output).toBe(
				roles
					.replace("    <<: *roles # inherited roles\n", "")
					.replace("    slow: local/slow\n", "    slow: local/slow\n    default: shared/default\n"),
			);
			expect(YAML.parse(output)).toEqual({
				"role-defaults": { default: "shared/default", smol: "shared/smol" },
				modelRoles: { default: "shared/default", slow: "local/slow" },
			});
			const reopened = await Settings.loadIsolated({ cwd, agentDir });
			expect(reopened.getModelRole("smol")).toBeUndefined();
			expect(reopened.getModelRole("default")).toBe("shared/default");
			expect(reopened.getModelRole("slow")).toBe("local/slow");
		});
	});

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

	describe("duplicate keys", () => {
		for (const project of [false, true]) {
			const scope = project ? "project" : "global";
			const setRole = (settings: Settings, modelId: string | undefined) => {
				if (!project) settings.setModelRole("default", modelId);
				else if (modelId === undefined) settings.clearProjectModelRole("default");
				else settings.setProjectModelRole("default", modelId);
			};

			it(`edits and clears the winning top-level duplicate in ${scope} YAML`, async () => {
				const source =
					"# head\nmodelRoles:\n    default: old/first # shadowed\nmodelRoles:\n    default: old/second\n    smol: keep/smol\n\ntheme:\n    dark: titanium\n";
				const target = project ? projectConfig : config;
				await Bun.write(target, source);
				const settings = await Settings.init({ cwd, agentDir });
				expect(settings.getModelRole("default")).toBe("old/second");
				setRole(settings, "new/model");
				await settings.flush();
				const edited = await Bun.file(target).text();
				expect(edited).toBe(source.replace("old/second", "new/model"));
				expect(YAML.parse(edited)).toEqual({
					modelRoles: { default: "new/model", smol: "keep/smol" },
					theme: { dark: "titanium" },
				});
				const reopened = await Settings.loadIsolated({ cwd, agentDir });
				expect(reopened.getModelRole("default")).toBe("new/model");
				expect(reopened.getModelRole("smol")).toBe("keep/smol");

				setRole(settings, undefined);
				await settings.flush();
				const cleared = await Bun.file(target).text();
				// The shadowed first entry stays authored and stays shadowed.
				expect(cleared.startsWith("# head\nmodelRoles:\n    default: old/first # shadowed\nmodelRoles:\n")).toBe(
					true,
				);
				expect(cleared).toContain("    smol: keep/smol\n\ntheme:\n    dark: titanium\n");
				expect(cleared).not.toContain("new/model");
				const reread = await Settings.loadIsolated({ cwd, agentDir });
				expect(reread.getModelRole("default")).toBeUndefined();
				expect(reread.getModelRole("smol")).toBe("keep/smol");
			});

			it(`edits and clears every nested duplicate in ${scope} YAML`, async () => {
				const source =
					"modelRoles:\n    default: old/first # shadowed\n    smol: keep/smol\n    default: old/second # winner\n# tail\n";
				const target = project ? projectConfig : config;
				await Bun.write(target, source);
				const settings = await Settings.init({ cwd, agentDir });
				expect(settings.getModelRole("default")).toBe("old/second");
				setRole(settings, "new/model");
				await settings.flush();
				const edited = await Bun.file(target).text();
				expect(edited).toBe(source.replace("old/second", "new/model"));
				expect((await Settings.loadIsolated({ cwd, agentDir })).getModelRole("default")).toBe("new/model");

				setRole(settings, undefined);
				await settings.flush();
				const cleared = await Bun.file(target).text();
				expect(cleared).not.toContain("old/second");
				expect(cleared).toContain("    smol: keep/smol\n");
				expect(cleared.endsWith("# tail\n")).toBe(true);
				const reopened = await Settings.loadIsolated({ cwd, agentDir });
				expect(reopened.getModelRole("default")).toBeUndefined();
				expect(reopened.getModelRole("smol")).toBe("keep/smol");
			});
		}

		it("edits the winning nested setting duplicate without touching the shadowed one", async () => {
			const source = "theme:\n    dark: shadowed # first\n    dark: titanium\n";
			await Bun.write(config, source);
			const settings = await Settings.init({ cwd, agentDir });
			expect(settings.get("theme.dark")).toBe("titanium");
			settings.set("theme.dark", "midnight");
			await settings.flush();
			const output = await Bun.file(config).text();
			expect(output).toBe(source.replace("titanium", "midnight"));
			expect(YAML.parse(output)).toEqual({ theme: { dark: "midnight" } });
			expect((await Settings.loadIsolated({ cwd, agentDir })).get("theme.dark")).toBe("midnight");
		});
	});

	it("adds a root key after a byte order mark at the authored root indentation", async () => {
		const source = "\uFEFFtheme:\n    dark: titanium # keep\n\ngrep:\n    contextAfter: 3\n";
		fs.writeFileSync(config, source, "utf8");
		const settings = await Settings.init({ cwd, agentDir });
		settings.setModelRole("default", "new/model");
		await settings.flush();
		const output = fs.readFileSync(config, "utf8");
		expect(output.startsWith("\uFEFFtheme:\n    dark: titanium # keep\n\ngrep:\n    contextAfter: 3\n")).toBe(true);
		expect(output.slice(source.length).split("\n")[0]).toBe("modelRoles:");
		expect(YAML.parse(output)).toEqual({
			theme: { dark: "titanium" },
			grep: { contextAfter: 3 },
			modelRoles: { default: "new/model" },
		});
		const reopened = await Settings.loadIsolated({ cwd, agentDir });
		expect(reopened.getModelRole("default")).toBe("new/model");
		expect(reopened.get("theme.dark")).toBe("titanium");
		expect(reopened.get("grep.contextAfter")).toBe(3);
	});

	it("adds root keys and removes entries spelled with explicit key indicators", async () => {
		const source =
			"? theme\n: { dark: titanium }\nmodelRoles:\n    ? default\n    : old/model\n    smol: keep/smol\n";
		await Bun.write(config, source);
		const settings = await Settings.init({ cwd, agentDir });
		settings.setModelRole("default", undefined);
		settings.set("grep.contextAfter", 4);
		await settings.flush();
		const output = await Bun.file(config).text();
		expect(output.startsWith("? theme\n: { dark: titanium }\nmodelRoles:\n    smol: keep/smol\n")).toBe(true);
		expect(output.slice(source.length - "    ? default\n    : old/model\n".length).split("\n")[0]).toBe("grep:");
		expect(YAML.parse(output)).toEqual({
			theme: { dark: "titanium" },
			modelRoles: { smol: "keep/smol" },
			grep: { contextAfter: 4 },
		});
		const reopened = await Settings.loadIsolated({ cwd, agentDir });
		expect(reopened.getModelRole("default")).toBeUndefined();
		expect(reopened.getModelRole("smol")).toBe("keep/smol");
		expect(reopened.get("grep.contextAfter")).toBe(4);
		expect(reopened.get("theme.dark")).toBe("titanium");
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
