import { afterEach, describe, expect, it, setDefaultTimeout, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	applyNestedPatches,
	captureDeltaPatch,
	captureIsolationBaseline,
	cleanupIsolation,
	ensureIsolation,
	gitAdminEscapes,
} from "@oh-my-pi/pi-coding-agent/task/worktree";
import * as natives from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { removeWithRetries, setWorktreesDir } from "@oh-my-pi/pi-utils";

const tempDirs: string[] = [];

// The nested-submodule test runs three isolations plus a merge-back; APFS
// clones and native baselines need headroom on loaded CI runners.
setDefaultTimeout(120_000);

async function runGit(repo: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd: repo,
		stderr: "pipe",
		stdout: "pipe",
		windowsHide: true,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if ((exitCode ?? 0) !== 0) {
		throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed with exit code ${exitCode ?? 0}`);
	}
	return stdout.trim();
}

async function initRepo(dir: string, branch = "main"): Promise<void> {
	await runGit(dir, ["init", "-q", "-b", branch]);
	await runGit(dir, ["config", "core.autocrlf", "false"]);
}

async function commitAs(dir: string, rel: string, content: string, message: string): Promise<void> {
	await fs.writeFile(path.join(dir, rel), content);
	await runGit(dir, ["add", rel]);
	await runGit(dir, ["commit", "-q", "-m", message]);
}

async function makeRepoWithFile(name: string, content: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-isosub-${name}-`));
	tempDirs.push(dir);
	await initRepo(dir);
	await runGit(dir, ["config", "user.email", "iso@example.com"]);
	await runGit(dir, ["config", "user.name", "Isolated User"]);
	await commitAs(dir, "tracked.txt", content, name);
	return dir;
}

function mockBackend(kind: natives.IsoBackendKind): void {
	vi.spyOn(natives, "isoResolve").mockResolvedValue({
		kind,
		candidates: [kind],
		fellBack: false,
		reason: undefined,
	});
}

async function withIsolationEnv(fn: () => Promise<void>): Promise<void> {
	const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isosub-wtbase-"));
	tempDirs.push(worktreeBase);
	const originalWorktreeDir = process.env.OMP_WORKTREE_DIR;
	delete process.env.OMP_WORKTREE_DIR;
	setWorktreesDir(worktreeBase);
	try {
		await fn();
	} finally {
		setWorktreesDir(undefined);
		if (originalWorktreeDir === undefined) delete process.env.OMP_WORKTREE_DIR;
		else process.env.OMP_WORKTREE_DIR = originalWorktreeDir;
	}
}

/** Every `.git` entry under the copy must be a private admin: same verdict as the hand-out gate. */
async function assertNoExternalGitfiles(copyRoot: string): Promise<void> {
	const realCopy = await fs.realpath(copyRoot);
	const stack = [realCopy];
	while (stack.length > 0) {
		const dir = stack.pop()!;
		for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.name === ".git") {
				const rel = path.relative(realCopy, full);
				// One shared predicate with repair and verify: a directory
				// admin (or a symlink to one) whose `commondir` points at
				// the source escapes even though its own path is inside the
				// copy. `alternates` borrowing stays allowed: it is read-only.
				expect(await gitAdminEscapes(realCopy, full), `${rel} escapes the copy`).toBe(false);
				continue;
			}
			if (entry.isDirectory() && entry.name !== "node_modules") stack.push(full);
		}
	}
}

/** Snapshot of an admin dir's own files: no object storage, no nested module dirs. */
async function adminOwnSnapshot(adminDir: string): Promise<string[]> {
	const files = (await fs.readdir(adminDir, { recursive: true, withFileTypes: true }))
		.filter(entry => entry.isFile())
		.map(entry => path.join(entry.parentPath, entry.name))
		.filter(
			file =>
				!path
					.relative(adminDir, file)
					.split(path.sep)
					.some(segment => segment === "objects" || segment === "modules"),
		)
		.sort();
	return Promise.all(files.map(async file => `${file}:${Bun.hash(await fs.readFile(file))}`));
}

async function dirSizeKb(dir: string): Promise<number | null> {
	try {
		const proc = Bun.spawn(["du", "-sk", dir], { stdout: "pipe", stderr: "pipe" });
		const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		if (code !== 0) return null;
		return Number.parseInt(out.split("\t", 1)[0] ?? "", 10);
	} catch {
		return null;
	}
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
});

/** Linked worktree whose submodule is left uninitialized — the t-d38f1821 shape. */
async function makeLinkedWorktreeWithUninitSubmodule(): Promise<{ main: string; wt: string }> {
	const child = await makeRepoWithFile("child", "child\n");
	const main = await makeRepoWithFile("parent", "parent\n");
	const allow = ["-c", "protocol.file.allow=always"];
	await runGit(main, [...allow, "submodule", "add", "-q", child, "sub"]);
	await runGit(main, ["commit", "-q", "-m", "pin sub"]);
	const wt = `${main}-wt`;
	tempDirs.push(wt);
	await runGit(main, ["worktree", "add", "-q", wt, "-b", "feature/wt", "HEAD"]);
	// Never initialized in the linked worktree: an empty directory, `-` pin.
	expect(await runGit(wt, ["submodule", "status"])).toMatch(/^-/);
	return { main, wt };
}

async function runUninitializedSubmoduleCase(backend: natives.IsoBackendKind, taskId: string): Promise<void> {
	const { main, wt } = await makeLinkedWorktreeWithUninitSubmodule();
	const worktreesBefore = (await runGit(main, ["worktree", "list", "--porcelain"]))
		.split("\n")
		.filter(line => line.startsWith("worktree "));
	mockBackend(backend);
	await withIsolationEnv(async () => {
		const handle = await ensureIsolation(wt, taskId);
		try {
			// A working git tree: user-facing status/diff/submodule inspection succeed.
			expect(await runGit(handle.mergedDir, ["status", "--porcelain=v1"])).toBe("");
			expect(await runGit(handle.mergedDir, ["diff", "--no-color"])).toBe("");
			expect(await runGit(handle.mergedDir, ["submodule", "status"])).toMatch(/^-/);
			await assertNoExternalGitfiles(handle.mergedDir);

			const baseline = await captureIsolationBaseline(handle.mergedDir, wt);
			expect(baseline.nested).toEqual([]);

			await fs.writeFile(path.join(handle.mergedDir, "tracked.txt"), "isolated edit\n");
			const delta = await captureDeltaPatch(handle.mergedDir, baseline);
			expect(delta.rootPatch).toContain("+isolated edit");
			expect(delta.nestedPatches).toEqual([]);

			// Patch applies back to the source checkout.
			await vcs.requireGit(wt).applyPatch(delta.rootPatch, {});
			expect(await fs.readFile(path.join(wt, "tracked.txt"), "utf8")).toBe("isolated edit\n");
			expect(await runGit(wt, ["submodule", "status"])).toMatch(/^-/);
		} finally {
			await cleanupIsolation(handle);
		}
		// No leaked worktree registrations, no stray state in the source.
		const worktreesAfter = (await runGit(main, ["worktree", "list", "--porcelain"]))
			.split("\n")
			.filter(line => line.startsWith("worktree "));
		expect(worktreesAfter).toEqual(worktreesBefore);
	});
}

describe("isolation with an uninitialized submodule (t-d38f1821)", () => {
	it("isolated edit + patch applies back (rcopy backend)", async () => {
		await runUninitializedSubmoduleCase(natives.IsoBackendKind.Rcopy, "uninit-submodule-rcopy");
	});

	it.skipIf(process.platform !== "darwin")("isolated edit + patch applies back (apfs backend)", async () => {
		await runUninitializedSubmoduleCase(natives.IsoBackendKind.Apfs, "uninit-submodule-apfs");
	});
});

/** parent -> packages/aix-root -> packages/plugin, all initialized — the t-254d92fd shape. */
async function makeTwoDepthLinkedSource(): Promise<{ main: string; wt: string; pins: string }> {
	const plugin = await makeRepoWithFile("plugin", "plugin\n");
	const aix = await makeRepoWithFile("aix", "aix\n");
	const allow = ["-c", "protocol.file.allow=always"];
	await runGit(aix, [...allow, "submodule", "add", "-q", plugin, "packages/plugin"]);
	await runGit(aix, ["commit", "-q", "-m", "pin plugin"]);
	const main = await makeRepoWithFile("parent", "parent\n");
	await runGit(main, [...allow, "submodule", "add", "-q", aix, "packages/aix-root"]);
	await runGit(main, ["commit", "-q", "-m", "pin aix"]);
	const wt = `${main}-wt`;
	tempDirs.push(wt);
	await runGit(main, ["worktree", "add", "-q", wt, "-b", "feature/wt", "HEAD"]);
	await runGit(wt, [...allow, "submodule", "update", "-q", "--init", "--recursive"]);
	for (const sub of ["packages/aix-root", "packages/aix-root/packages/plugin"]) {
		await runGit(path.join(wt, sub), ["config", "user.email", "iso@example.com"]);
		await runGit(path.join(wt, sub), ["config", "user.name", "Isolated User"]);
	}
	return { main, wt, pins: await runGit(wt, ["submodule", "status", "--recursive"]) };
}

describe("isolation with initialized nested submodules (t-254d92fd)", () => {
	it.skipIf(process.platform !== "darwin")(
		"edits in parent and leaf capture as root + nested patches and merge back without touching source admins",
		async () => {
			const { wt, pins } = await makeTwoDepthLinkedSource();
			const aixDir = path.join(wt, "packages/aix-root");
			const pluginDir = path.join(aixDir, "packages/plugin");
			const sourceAixAdmin = await runGit(aixDir, ["rev-parse", "--absolute-git-dir"]);
			const sourcePluginAdmin = await runGit(pluginDir, ["rev-parse", "--absolute-git-dir"]);
			const sourceAixIndex = await fs.readFile(path.join(sourceAixAdmin, "index"));
			const adminsBefore = {
				// The intermediate module dir contains the leaf's module dir;
				// its own files must stay put while the leaf may advance.
				aix: await adminOwnSnapshot(sourceAixAdmin),
				plugin: await adminOwnSnapshot(sourcePluginAdmin),
			};
			const pluginCommitsBefore = await runGit(pluginDir, ["rev-list", "--count", "HEAD"]);

			mockBackend(natives.IsoBackendKind.Apfs);
			await withIsolationEnv(async () => {
				const handle = await ensureIsolation(wt, "nested-submodules-merge");
				try {
					expect(await runGit(handle.mergedDir, ["submodule", "status", "--recursive"])).toBe(pins);
					await assertNoExternalGitfiles(handle.mergedDir);
					console.log(`isolation size: ${await dirSizeKb(handle.mergedDir)} KiB`);

					const baseline = await captureIsolationBaseline(handle.mergedDir, wt);
					expect(baseline.nested.map(n => n.relativePath)).toEqual([
						"packages/aix-root",
						"packages/aix-root/packages/plugin",
					]);

					await fs.writeFile(path.join(handle.mergedDir, "tracked.txt"), "isolated parent edit\n");
					await fs.writeFile(
						path.join(handle.mergedDir, "packages/aix-root/packages/plugin/tracked.txt"),
						"isolated leaf edit\n",
					);
					// Task git operations stay inside the copy.
					await runGit(handle.mergedDir, ["checkout", "-q", "-b", "feature/task"]);
					await runGit(path.join(handle.mergedDir, "packages/aix-root/packages/plugin"), [
						"checkout",
						"-q",
						"-b",
						"feature/leaf-task",
					]);

					const delta = await captureDeltaPatch(handle.mergedDir, baseline);
					expect(delta.rootPatch).toContain("+isolated parent edit");
					expect(delta.nestedPatches.map(p => p.relativePath)).toEqual(["packages/aix-root/packages/plugin"]);
					expect(delta.nestedPatches[0]!.patch).toContain("+isolated leaf edit");
				} finally {
					await cleanupIsolation(handle);
				}

				// Capture touched only the copy: source checkout and module dirs unchanged.
				expect(await fs.readFile(path.join(sourceAixAdmin, "index"))).toEqual(sourceAixIndex);
				expect(await adminOwnSnapshot(sourceAixAdmin)).toEqual(adminsBefore.aix);
				expect(await adminOwnSnapshot(sourcePluginAdmin)).toEqual(adminsBefore.plugin);
				expect(await runGit(wt, ["submodule", "status", "--recursive"])).toBe(pins);
				expect(await runGit(wt, ["status", "--porcelain"])).toBe("");
				expect(await runGit(wt, ["branch", "--format=%(refname:short)"])).not.toContain("feature/task");

				// Merge back: root patch to the parent, nested patch committed in the leaf.
				const handle2 = await ensureIsolation(wt, "nested-submodules-remerge");
				let delta;
				try {
					const baseline = await captureIsolationBaseline(handle2.mergedDir, wt);
					await fs.writeFile(path.join(handle2.mergedDir, "tracked.txt"), "isolated parent edit\n");
					await fs.writeFile(
						path.join(handle2.mergedDir, "packages/aix-root/packages/plugin/tracked.txt"),
						"isolated leaf edit\n",
					);
					delta = await captureDeltaPatch(handle2.mergedDir, baseline);
				} finally {
					await cleanupIsolation(handle2);
				}
				await vcs.requireGit(wt).applyPatch(delta.rootPatch, {});
				await applyNestedPatches(wt, delta.nestedPatches);
				expect(await fs.readFile(path.join(wt, "tracked.txt"), "utf8")).toBe("isolated parent edit\n");
				expect(await fs.readFile(path.join(pluginDir, "tracked.txt"), "utf8")).toBe("isolated leaf edit\n");
				expect(await runGit(pluginDir, ["rev-list", "--count", "HEAD"])).toBe(
					String(Number(pluginCommitsBefore) + 1),
				);
				// The merge moved only the leaf forward: parent and intermediate admins untouched.
				expect(await adminOwnSnapshot(sourceAixAdmin)).toEqual(adminsBefore.aix);
				expect(await runGit(wt, ["branch", "--format=%(refname:short)"])).not.toContain("feature/task");
				// Land the merged parent edit so the only remaining source
				// dirt is the off-pin gitlink the nested commit produced.
				await runGit(wt, ["add", "tracked.txt"]);
				await runGit(wt, ["commit", "-q", "-m", "merge parent edit"]);
				// The source submodule is now off its recorded pin (its own
				// commit landed via merge-back): git shows the new-commits
				// gitlink as `M `. A follow-up isolation from this checkout
				// must still produce a working git tree instead of failing in
				// `ensureIsolation`.
				expect(await runGit(wt, ["status", "--porcelain"])).toBe("M packages/aix-root");
				const handle3 = await ensureIsolation(wt, "nested-submodules-off-pin");
				try {
					await assertNoExternalGitfiles(handle3.mergedDir);
					expect(await runGit(handle3.mergedDir, ["status", "--porcelain"])).toBe("M packages/aix-root");
					const baseline3 = await captureIsolationBaseline(handle3.mergedDir, wt);
					expect(baseline3.nested.map(n => n.relativePath)).toEqual([
						"packages/aix-root",
						"packages/aix-root/packages/plugin",
					]);
					await fs.writeFile(path.join(handle3.mergedDir, "tracked.txt"), "second edit\n");
					const delta3 = await captureDeltaPatch(handle3.mergedDir, baseline3);
					expect(delta3.rootPatch).toContain("+second edit");
				} finally {
					await cleanupIsolation(handle3);
				}
			});
		},
	);
});

describe("isolation with a symlinked submodule admin (review)", () => {
	it.skipIf(process.platform !== "darwin")(
		"repairs a nested .git symlink into the source module dir when an earlier submodule is off-pin",
		async () => {
			const { wt, pins } = await makeTwoDepthLinkedSource();
			const aixDir = path.join(wt, "packages/aix-root");
			const pluginDir = path.join(aixDir, "packages/plugin");
			// Move the intermediate submodule off its recorded pin first: the
			// native batch rebind refuses off-pin layouts before it ever
			// reaches the leaf's admin, so the per-submodule fallback owns
			// both repairs.
			await fs.writeFile(path.join(aixDir, "tracked.txt"), "aix moved\n");
			await runGit(aixDir, ["commit", "-q", "-am", "move aix off pin"]);
			expect(await runGit(wt, ["submodule", "status", "--recursive"])).not.toBe(pins);
			// Replace the leaf's gitfile with a symlink into the source
			// worktree's module dir: every write through it lands in the
			// source admin until the copy gives the leaf private metadata.
			const sourcePluginAdmin = await runGit(pluginDir, ["rev-parse", "--absolute-git-dir"]);
			await fs.rm(path.join(pluginDir, ".git"));
			await fs.symlink(sourcePluginAdmin, path.join(pluginDir, ".git"));
			expect((await fs.lstat(path.join(pluginDir, ".git"))).isSymbolicLink()).toBe(true);
			expect(await runGit(pluginDir, ["status", "--porcelain"])).toBe("");
			const sourceHead = await runGit(pluginDir, ["rev-parse", "HEAD"]);
			const sourceBranches = await runGit(pluginDir, ["branch", "--format=%(refname:short)"]);

			mockBackend(natives.IsoBackendKind.Apfs);
			await withIsolationEnv(async () => {
				const handle = await ensureIsolation(wt, "nested-submodule-symlink");
				try {
					// Either a private repaired admin or no hand-out at all:
					// a surviving symlink into the source fails here.
					await assertNoExternalGitfiles(handle.mergedDir);
					const isoPlugin = path.join(handle.mergedDir, "packages/aix-root/packages/plugin");
					expect((await fs.lstat(path.join(isoPlugin, ".git"))).isDirectory()).toBe(true);
					expect(await runGit(handle.mergedDir, ["status", "--porcelain"])).toBe("M packages/aix-root");
					// The write probe: a branch created in the copy must stay
					// in the copy.
					await runGit(isoPlugin, ["checkout", "-q", "-b", "pwned-from-copy"]);
					expect(await runGit(pluginDir, ["branch", "--format=%(refname:short)"])).toBe(sourceBranches);
					expect(await runGit(pluginDir, ["rev-parse", "HEAD"])).toBe(sourceHead);
				} finally {
					await cleanupIsolation(handle);
				}
				// The source checkout is untouched: same symlink, same HEAD,
				// no task branch leaked.
				expect((await fs.lstat(path.join(pluginDir, ".git"))).isSymbolicLink()).toBe(true);
				expect(await fs.readlink(path.join(pluginDir, ".git"))).toBe(sourcePluginAdmin);
				expect(await runGit(pluginDir, ["rev-parse", "HEAD"])).toBe(sourceHead);
				expect(await runGit(pluginDir, ["branch", "--format=%(refname:short)"])).toBe(sourceBranches);
				expect(await runGit(pluginDir, ["branch", "--format=%(refname:short)"])).not.toContain("pwned-from-copy");
			});
		},
	);
});

/** Byte-identical snapshot of a checkout's refs, HEAD and branch list. */
async function sourceGitIdentity(dir: string): Promise<string> {
	const head = await runGit(dir, ["rev-parse", "HEAD"]);
	const branches = await runGit(dir, ["branch", "--format=%(refname:short)"]);
	const refs = await runGit(dir, ["for-each-ref", "--format=%(objectname) %(refname)"]);
	return [head, branches, refs].join("\n");
}

/** Two-depth linked source with the intermediate submodule moved off its pin (fallback owns repairs). */
async function makeOffPinTwoDepthSource(): Promise<{
	wt: string;
	aixDir: string;
	pluginDir: string;
	sourcePluginAdmin: string;
}> {
	const { wt } = await makeTwoDepthLinkedSource();
	const aixDir = path.join(wt, "packages/aix-root");
	const pluginDir = path.join(aixDir, "packages/plugin");
	await fs.writeFile(path.join(aixDir, "tracked.txt"), "aix moved\n");
	await runGit(aixDir, ["commit", "-q", "-am", "move aix off pin"]);
	const sourcePluginAdmin = await runGit(pluginDir, ["rev-parse", "--absolute-git-dir"]);
	return { wt, aixDir, pluginDir, sourcePluginAdmin };
}

/** Plant a worktree-style directory admin (HEAD plus a `commondir` pointer at the source admin). */
async function plantLinkedDirAdmin(
	workdir: string,
	adminName: string,
	sourceAdmin: string,
	commondir: string,
): Promise<void> {
	const adminDir = path.join(workdir, adminName);
	await fs.rm(adminDir, { recursive: true, force: true });
	await fs.mkdir(adminDir, { recursive: true });
	await fs.writeFile(path.join(adminDir, "HEAD"), await fs.readFile(path.join(sourceAdmin, "HEAD"), "utf8"));
	await fs.writeFile(path.join(adminDir, "commondir"), `${commondir}\n`);
}

/**
 * A planted escaping admin must come back either repaired (private admin
 * dir, probe branch stays in the copy) or refused, with the source
 * checkout byte-identical either way.
 */
async function runRepairedAdminCase(
	taskId: string,
	branch: string,
	plant: (ctx: { pluginDir: string; sourcePluginAdmin: string }) => Promise<void>,
): Promise<void> {
	const { wt, pluginDir, sourcePluginAdmin } = await makeOffPinTwoDepthSource();
	await plant({ pluginDir, sourcePluginAdmin });
	expect(await runGit(pluginDir, ["rev-parse", "HEAD"])).not.toBe("");
	const before = await sourceGitIdentity(pluginDir);
	mockBackend(natives.IsoBackendKind.Apfs);
	await withIsolationEnv(async () => {
		const handle = await ensureIsolation(wt, taskId);
		try {
			await assertNoExternalGitfiles(handle.mergedDir);
			const isoPlugin = path.join(handle.mergedDir, "packages/aix-root/packages/plugin");
			expect((await fs.lstat(path.join(isoPlugin, ".git"))).isDirectory()).toBe(true);
			await runGit(isoPlugin, ["checkout", "-q", "-b", branch]);
			expect(await runGit(pluginDir, ["branch", "--format=%(refname:short)"])).not.toContain(branch);
		} finally {
			await cleanupIsolation(handle);
		}
		expect(await sourceGitIdentity(pluginDir)).toBe(before);
	});
}

/**
 * A planted escaping admin the repair loop never reaches (never named by
 * `submodulePaths()`) must refuse hand-out, with the source byte-identical.
 */
async function runRefusedAdminCase(
	taskId: string,
	plant: (ctx: { pluginDir: string; sourcePluginAdmin: string }) => Promise<void>,
): Promise<void> {
	const { wt, pluginDir, sourcePluginAdmin } = await makeOffPinTwoDepthSource();
	await plant({ pluginDir, sourcePluginAdmin });
	const before = await sourceGitIdentity(pluginDir);
	mockBackend(natives.IsoBackendKind.Apfs);
	await withIsolationEnv(async () => {
		await expect(ensureIsolation(wt, taskId)).rejects.toThrow(/still shares git metadata/);
		expect(await sourceGitIdentity(pluginDir)).toBe(before);
	});
}

describe("isolation with commondir escapes (review round 2)", () => {
	it.skipIf(process.platform !== "darwin")(
		"repairs a directory .git with an absolute commondir at the source admin",
		async () => {
			await runRepairedAdminCase(
				"nested-dir-admin-abs",
				"probe-dir-abs",
				async ({ pluginDir, sourcePluginAdmin }) => {
					await fs.rm(path.join(pluginDir, ".git"));
					await plantLinkedDirAdmin(pluginDir, ".git", sourcePluginAdmin, sourcePluginAdmin);
				},
			);
		},
	);

	it.skipIf(process.platform !== "darwin")(
		"repairs a directory .git with a relative commondir escaping the copy",
		async () => {
			await runRepairedAdminCase(
				"nested-dir-admin-rel",
				"probe-dir-rel",
				async ({ pluginDir, sourcePluginAdmin }) => {
					await fs.rm(path.join(pluginDir, ".git"));
					// Realpath both ends first: a relative `commondir` joins to
					// the admin dir lexically, so symlinked parents (`/var` ->
					// `/private/var`) would otherwise corrupt the pointer.
					const parentDir = await fs.realpath(pluginDir);
					const relative = path.relative(path.join(parentDir, ".git"), await fs.realpath(sourcePluginAdmin));
					await plantLinkedDirAdmin(pluginDir, ".git", sourcePluginAdmin, relative);
				},
			);
		},
	);

	it.skipIf(process.platform !== "darwin")(
		"refuses a copy with an unlisted .git symlink to an in-copy admin dir",
		async () => {
			// Never named by `submodulePaths()`: the repair loop walks
			// listed submodules only, and the old gate judged this private
			// by realpath alone without reading `commondir`.
			await runRefusedAdminCase("nested-link-dir-unlisted", async ({ pluginDir, sourcePluginAdmin }) => {
				const nested = path.join(pluginDir, "vendor/nested");
				await fs.mkdir(nested, { recursive: true });
				await plantLinkedDirAdmin(nested, ".git-real", sourcePluginAdmin, sourcePluginAdmin);
				await fs.symlink(".git-real", path.join(nested, ".git"));
			});
		},
	);

	it.skipIf(process.platform !== "darwin")("refuses a copy with an unlisted .git symlink to a gitfile", async () => {
		await runRefusedAdminCase("nested-link-file-unlisted", async ({ pluginDir, sourcePluginAdmin }) => {
			const nested = path.join(pluginDir, "vendor/nested");
			await fs.mkdir(nested, { recursive: true });
			await plantLinkedDirAdmin(nested, ".git-real", sourcePluginAdmin, sourcePluginAdmin);
			await fs.writeFile(path.join(nested, "evil.gitfile"), "gitdir: .git-real\n");
			await fs.symlink("evil.gitfile", path.join(nested, ".git"));
		});
	});

	it.skipIf(process.platform !== "darwin")("refuses a copy with an unlisted nested directory admin", async () => {
		await runRefusedAdminCase("nested-dir-admin-unlisted", async ({ pluginDir, sourcePluginAdmin }) => {
			const nested = path.join(pluginDir, "vendor/nested");
			await plantLinkedDirAdmin(nested, ".git", sourcePluginAdmin, sourcePluginAdmin);
		});
	});
});

describe("isolation with a linked worktree inside a submodule (review round 4)", () => {
	it.skipIf(process.platform !== "darwin")(
		"hands out a copy whose nested linked worktree is private when a submodule is off-pin",
		async () => {
			const { wt, aixDir } = await makeOffPinTwoDepthSource();
			// A git-created layout: a linked worktree nested inside the
			// middle submodule. Off-pin, the hand-out gate used to run
			// before the nested-repo detach pass and refuse this copy.
			await runGit(aixDir, ["worktree", "add", "-q", ".atmux/worktrees/d2", "-b", "feature/d2", "HEAD"]);
			const nestedSrc = path.join(aixDir, ".atmux/worktrees/d2");
			expect(await runGit(nestedSrc, ["rev-parse", "HEAD"])).not.toBe("");
			const beforeAix = await sourceGitIdentity(aixDir);
			const beforeNested = await sourceGitIdentity(nestedSrc);
			mockBackend(natives.IsoBackendKind.Apfs);
			await withIsolationEnv(async () => {
				const handle = await ensureIsolation(wt, "nested-worktree-off-pin");
				try {
					await assertNoExternalGitfiles(handle.mergedDir);
					const isoNested = path.join(handle.mergedDir, "packages/aix-root/.atmux/worktrees/d2");
					expect((await fs.lstat(path.join(isoNested, ".git"))).isDirectory()).toBe(true);
					const baseline = await captureIsolationBaseline(handle.mergedDir, wt);
					expect(baseline.nested.map(n => n.relativePath)).toContain("packages/aix-root/.atmux/worktrees/d2");
					// Task git operations stay inside the copy.
					await runGit(isoNested, ["checkout", "-q", "-b", "feature/task-d2"]);
					await fs.writeFile(path.join(isoNested, "tracked.txt"), "isolated d2 edit\n");
					await runGit(isoNested, [
						"-c",
						"user.email=iso@example.com",
						"-c",
						"user.name=Isolated User",
						"commit",
						"-q",
						"-am",
						"isolated d2 commit",
					]);
				} finally {
					await cleanupIsolation(handle);
				}
				expect(await sourceGitIdentity(aixDir)).toBe(beforeAix);
				expect(await sourceGitIdentity(nestedSrc)).toBe(beforeNested);
				expect(await runGit(nestedSrc, ["branch", "--format=%(refname:short)"])).not.toContain("feature/task-d2");
			});
		},
	);
});

describe("isolation with a submodule checkout as cwd (t-debc251e)", () => {
	it.skipIf(process.platform !== "darwin")("cwd is a submodule inside a linked worktree", async () => {
		const allow = ["-c", "protocol.file.allow=always"];
		const leaf = await makeRepoWithFile("leaf", "leaf\n");
		const superb = await makeRepoWithFile("super", "super\n");
		await runGit(superb, [...allow, "submodule", "add", "-q", leaf, "root"]);
		await runGit(superb, ["commit", "-q", "-m", "pin root"]);
		await runGit(superb, [...allow, "submodule", "update", "-q", "--init"]);
		const wt = `${superb}-wt`;
		tempDirs.push(wt);
		await runGit(superb, ["worktree", "add", "-q", wt, "-b", "feature/wt", "HEAD"]);
		await runGit(wt, [...allow, "submodule", "update", "-q", "--init"]);
		const source = path.join(wt, "root");
		expect((await fs.readFile(path.join(source, ".git"), "utf8")).trim()).toMatch(/^gitdir: /);
		const sourceGitfileBefore = await fs.readFile(path.join(source, ".git"), "utf8");

		mockBackend(natives.IsoBackendKind.Apfs);
		await withIsolationEnv(async () => {
			const handle = await ensureIsolation(source, "submodule-cwd-linked");
			try {
				// Detached to a real admin dir, not a gitfile into the superproject.
				expect((await fs.stat(path.join(handle.mergedDir, ".git"))).isDirectory()).toBe(true);
				expect(await runGit(handle.mergedDir, ["status", "--porcelain"])).toBe("");
				await assertNoExternalGitfiles(handle.mergedDir);

				const baseline = await captureIsolationBaseline(handle.mergedDir, source);
				await fs.writeFile(path.join(handle.mergedDir, "tracked.txt"), "isolated sub edit\n");
				const delta = await captureDeltaPatch(handle.mergedDir, baseline);
				expect(delta.rootPatch).toContain("+isolated sub edit");

				await vcs.requireGit(source).applyPatch(delta.rootPatch, {});
				expect(await fs.readFile(path.join(source, "tracked.txt"), "utf8")).toBe("isolated sub edit\n");
			} finally {
				await cleanupIsolation(handle);
			}
			expect(await fs.readFile(path.join(source, ".git"), "utf8")).toBe(sourceGitfileBefore);
			expect(await runGit(source, ["status", "--porcelain"])).toBe("M tracked.txt");
		});
	});

	it.skipIf(process.platform !== "darwin")("cwd is a linked worktree of a submodule", async () => {
		const allow = ["-c", "protocol.file.allow=always"];
		const leaf = await makeRepoWithFile("leaf", "leaf\n");
		const superb = await makeRepoWithFile("super", "super\n");
		await runGit(superb, [...allow, "submodule", "add", "-q", leaf, "root"]);
		await runGit(superb, ["commit", "-q", "-m", "pin root"]);
		await runGit(superb, [...allow, "submodule", "update", "-q", "--init"]);
		const source = path.join(superb, "root");
		const subWt = `${superb}-subwt`;
		tempDirs.push(subWt);
		await runGit(source, ["worktree", "add", "-q", subWt, "-b", "feature/subwt", "HEAD"]);
		const sourceHead = await runGit(subWt, ["rev-parse", "HEAD"]);

		mockBackend(natives.IsoBackendKind.Apfs);
		await withIsolationEnv(async () => {
			const handle = await ensureIsolation(subWt, "submodule-worktree-cwd");
			try {
				expect((await fs.stat(path.join(handle.mergedDir, ".git"))).isDirectory()).toBe(true);
				expect(await runGit(handle.mergedDir, ["status", "--porcelain"])).toBe("");
				await assertNoExternalGitfiles(handle.mergedDir);

				const baseline = await captureIsolationBaseline(handle.mergedDir, subWt);
				await fs.writeFile(path.join(handle.mergedDir, "tracked.txt"), "isolated subwt edit\n");
				await runGit(handle.mergedDir, ["commit", "-q", "-am", "isolated subwt commit"]);
				const delta = await captureDeltaPatch(handle.mergedDir, baseline);
				expect(delta.rootPatch).toContain("+isolated subwt edit");
			} finally {
				await cleanupIsolation(handle);
			}
			// The submodule worktree is untouched: same HEAD, no task branch leaked.
			expect(await runGit(subWt, ["rev-parse", "HEAD"])).toBe(sourceHead);
			expect(await runGit(subWt, ["branch", "--format=%(refname:short)"])).not.toContain("feature/task");
			expect(await fs.readFile(path.join(subWt, "tracked.txt"), "utf8")).toBe("leaf\n");
		});
	});
});
