import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { addWorktree } from "@oh-my-pi/pi-coding-agent/cli/worktree-cli";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgWorktreeClone } from "@oh-my-pi/pi-coding-agent/task/settings";
import { initWorktreeSubmodules } from "@oh-my-pi/pi-coding-agent/task/worktree";
const tempRoots: string[] = [];
const ALLOW_FILE = ["-c", "protocol.file.allow=always"];
/** Commits also happen in trees omp creates (no local identity); pin it so the suite never reads the host's global config. */
const GIT_IDENTITY = {
	GIT_AUTHOR_NAME: "wt-test",
	GIT_AUTHOR_EMAIL: "wt-test@example.com",
	GIT_COMMITTER_NAME: "wt-test",
	GIT_COMMITTER_EMAIL: "wt-test@example.com",
};

async function runGit(dir: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd: dir,
		env: { ...process.env, ...GIT_IDENTITY },
		stdout: "pipe",
		stderr: "pipe",
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
	await fs.mkdir(dir, { recursive: true });
	await runGit(dir, ["init", "-q", "-b", branch]);
	await runGit(dir, ["config", "core.autocrlf", "false"]);
	await runGit(dir, ["config", "user.email", "wt-test@example.com"]);
	await runGit(dir, ["config", "user.name", "wt-test"]);
	await runGit(dir, ["config", "commit.gpgsign", "false"]);
	await runGit(dir, ["config", "protocol.file.allow", "always"]);
}

async function commitFile(dir: string, name: string, content: string, message: string): Promise<void> {
	await Bun.write(path.join(dir, name), content);
	await runGit(dir, ["add", name]);
	await runGit(dir, ["commit", "-q", "-m", message]);
}

/** Parent repo with one initialized submodule; returns { parent, sub }. */
async function makeParentWithSubmodule(root: string): Promise<{ parent: string; subSrc: string }> {
	const subSrc = path.join(root, "sub-src");
	await initRepo(subSrc);
	await commitFile(subSrc, "lib.txt", "v1\n", "sub v1");

	const parent = path.join(root, "parent");
	await initRepo(parent);
	await commitFile(parent, "main.txt", "main\n", "main v1");
	await runGit(parent, [...ALLOW_FILE, "submodule", "add", "-q", subSrc, "sub"]);
	await runGit(parent, ["commit", "-q", "-m", "add sub"]);
	return { parent, subSrc };
}

/** Parent → mid → leaf, every level initialized; returns pins recorded in the parent. */
async function makeNestedSubmodules(root: string): Promise<{ parent: string; midHead: string; leafHead: string }> {
	const leafSrc = path.join(root, "leaf-src");
	await initRepo(leafSrc);
	await commitFile(leafSrc, "leaf.txt", "leaf v1\n", "leaf v1");

	const midSrc = path.join(root, "mid-src");
	await initRepo(midSrc);
	await commitFile(midSrc, "mid.txt", "mid v1\n", "mid v1");
	await runGit(midSrc, [...ALLOW_FILE, "submodule", "add", "-q", leafSrc, "leaf"]);
	await runGit(midSrc, ["commit", "-q", "-m", "add leaf"]);

	const parent = path.join(root, "parent");
	await initRepo(parent);
	await commitFile(parent, "main.txt", "main\n", "main v1");
	await runGit(parent, [...ALLOW_FILE, "submodule", "add", "-q", midSrc, "mid"]);
	await runGit(parent, ["commit", "-q", "-m", "add mid"]);
	await runGit(parent, [...ALLOW_FILE, "submodule", "update", "-q", "--init", "--recursive"]);
	const midHead = await runGit(path.join(parent, "mid"), ["rev-parse", "HEAD"]);
	const leafHead = await runGit(path.join(parent, "mid", "leaf"), ["rev-parse", "HEAD"]);
	return { parent, midHead, leafHead };
}

/** Resolve a `<checkout>/sub/.git` gitfile to its absolute module dir. */
async function submoduleGitdir(checkoutSub: string): Promise<string> {
	const content = await fs.readFile(path.join(checkoutSub, ".git"), "utf8");
	const pointer = (content.split("\n", 1)[0] ?? "").trim();
	const match = /^gitdir:[ \t]*(.+?)\s*$/.exec(pointer);
	if (!match) throw new Error(`${checkoutSub}/.git is not a gitfile: ${pointer}`);
	return path.resolve(checkoutSub, match[1]);
}

/** Resolve a worktree root's own `.git` file to its absolute admin dir. */
async function worktreeGitdir(checkout: string): Promise<string> {
	const content = await fs.readFile(path.join(checkout, ".git"), "utf8");
	const pointer = (content.split("\n", 1)[0] ?? "").trim();
	const match = /^gitdir:[ \t]*(.+?)\s*$/.exec(pointer);
	if (!match) throw new Error(`${checkout}/.git is not a gitfile: ${pointer}`);
	return path.resolve(checkout, match[1]);
}

beforeEach(async () => {
	// Exercise the clone-first path even where the host policy pins
	// `worktree.clone: false` (this checkout's estate does): a runtime-only
	// override, cleared after each case.
	cfgWorktreeClone.override(await Settings.init({}), true);
});

afterEach(async () => {
	(await Settings.init({})).clearOverrideValue(cfgWorktreeClone);
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

/**
 * Clone-first `omp worktree add` used to APFS-copy initialized submodule
 * gitfiles verbatim. From a main checkout the copy's `sub/.git` dangles
 * (`gitdir: ../.git/modules/sub` with no `.git` dir in the new tree), so even
 * top-level `git status` fails; from a linked worktree it points into the
 * source tree's module dir, so the new tree shares submodule HEAD/index with
 * the source. Both cases must now start from a plain checkout with privately
 * initialized submodules.
 */
describe("omp worktree add with submodules", () => {
	it("case A: source is the main checkout, new tree gets working private submodules", async () => {
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-wt-sub-a-")));
		tempRoots.push(root);
		const { parent } = await makeParentWithSubmodule(root);
		const sourceSubHead = await runGit(path.join(parent, "sub"), ["rev-parse", "HEAD"]);
		const sourceStatus = await runGit(parent, ["status", "--porcelain"]);

		const copy = path.join(root, "case-a-copy");
		await addWorktree({ path: copy, cwd: parent, detach: false, quiet: true });

		// The new tree is a usable checkout, including its submodule.
		expect(await runGit(copy, ["status", "--porcelain"])).toBe("");
		expect(await runGit(path.join(copy, "sub"), ["status", "--porcelain"])).toBe("");
		expect(await runGit(path.join(copy, "sub"), ["rev-parse", "HEAD"])).toBe(sourceSubHead);

		// The submodule's module dir belongs to the new tree: it exists under
		// the new tree's own worktree admin dir and differs from the source's
		// module dir. (Linked-worktree admins live in the shared common dir,
		// so "inside the parent checkout" alone cannot discriminate.)
		const sourceGitdir = await submoduleGitdir(path.join(parent, "sub"));
		const copyGitdir = await submoduleGitdir(path.join(copy, "sub"));
		expect((await fs.stat(copyGitdir)).isDirectory()).toBe(true);
		const copyAdmin = await worktreeGitdir(copy);
		expect(copyGitdir === copyAdmin || copyGitdir.startsWith(`${copyAdmin}${path.sep}`)).toBe(true);
		expect(copyGitdir).not.toBe(sourceGitdir);

		// Editing and committing in the new tree's submodule leaves the
		// source checkout's submodule HEAD and index alone.
		await commitFile(path.join(copy, "sub"), "lib.txt", "v1\ncopy edit\n", "copy sub edit");
		expect(await runGit(path.join(parent, "sub"), ["rev-parse", "HEAD"])).toBe(sourceSubHead);
		expect(await runGit(parent, ["status", "--porcelain"])).toBe(sourceStatus);
	});

	it("case B: source is a linked worktree, new tree does not share submodule state", async () => {
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-wt-sub-b-")));
		tempRoots.push(root);
		const { parent } = await makeParentWithSubmodule(root);

		const sourceWt = path.join(root, "src-wt");
		await runGit(parent, ["worktree", "add", "-q", "-b", "src-branch", sourceWt]);
		await runGit(sourceWt, [...ALLOW_FILE, "submodule", "update", "-q", "--init"]);
		// Sanity: the source worktree's submodule really does live in the
		// source tree's module dir (the shape the clone used to copy).
		const sourceSubGitdir = await submoduleGitdir(path.join(sourceWt, "sub"));
		expect((await fs.stat(sourceSubGitdir)).isDirectory()).toBe(true);

		const sourceSubHead = await runGit(path.join(sourceWt, "sub"), ["rev-parse", "HEAD"]);
		const sourceStatus = await runGit(sourceWt, ["status", "--porcelain"]);

		const copy = path.join(root, "case-b-copy");
		await addWorktree({ path: copy, cwd: sourceWt, detach: false, quiet: true });

		expect(await runGit(copy, ["status", "--porcelain"])).toBe("");
		expect(await runGit(path.join(copy, "sub"), ["status", "--porcelain"])).toBe("");
		expect(await runGit(path.join(copy, "sub"), ["rev-parse", "HEAD"])).toBe(sourceSubHead);

		// Not dangling, owned by the new tree's own worktree admin, and a
		// different module dir than the source worktree's submodule.
		const copyGitdir = await submoduleGitdir(path.join(copy, "sub"));
		expect((await fs.stat(copyGitdir)).isDirectory()).toBe(true);
		const copyAdmin = await worktreeGitdir(copy);
		expect(copyGitdir === copyAdmin || copyGitdir.startsWith(`${copyAdmin}${path.sep}`)).toBe(true);
		expect(copyGitdir).not.toBe(sourceSubGitdir);

		await commitFile(path.join(copy, "sub"), "lib.txt", "v1\ncopy edit\n", "copy sub edit");
		expect(await runGit(path.join(sourceWt, "sub"), ["rev-parse", "HEAD"])).toBe(sourceSubHead);
		expect(await runGit(sourceWt, ["status", "--porcelain"])).toBe(sourceStatus);
	});

	it("nested: parent→mid→leaf submodules initialize privately at every depth", async () => {
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-wt-sub-n-")));
		tempRoots.push(root);
		const { parent, midHead, leafHead } = await makeNestedSubmodules(root);
		const sourceMidGitdir = await submoduleGitdir(path.join(parent, "mid"));
		const sourceLeafGitdir = await submoduleGitdir(path.join(parent, "mid", "leaf"));

		const copy = path.join(root, "nested-copy");
		await addWorktree({ path: copy, cwd: parent, detach: false, quiet: true });

		// Every depth is a usable checkout at the source pins.
		for (const rel of ["", "mid", "mid/leaf"]) {
			expect(await runGit(path.join(copy, rel), ["status", "--porcelain"])).toBe("");
		}
		expect(await runGit(path.join(copy, "mid"), ["rev-parse", "HEAD"])).toBe(midHead);
		expect(await runGit(path.join(copy, "mid", "leaf"), ["rev-parse", "HEAD"])).toBe(leafHead);

		// Every depth is owned by the new tree's own worktree admin and
		// differs from the source's module dirs.
		const copyAdmin = await worktreeGitdir(copy);
		for (const [rel, sourceGitdir] of [
			["mid", sourceMidGitdir],
			["mid/leaf", sourceLeafGitdir],
		] as const) {
			const copyGitdir = await submoduleGitdir(path.join(copy, rel));
			expect((await fs.stat(copyGitdir)).isDirectory()).toBe(true);
			expect(copyGitdir === copyAdmin || copyGitdir.startsWith(`${copyAdmin}${path.sep}`)).toBe(true);
			expect(copyGitdir).not.toBe(sourceGitdir);
		}

		// Committing in the copy's leaf leaves the source leaf alone.
		await commitFile(path.join(copy, "mid", "leaf"), "leaf.txt", "leaf v1\ncopy edit\n", "copy leaf edit");
		expect(await runGit(path.join(parent, "mid", "leaf"), ["rev-parse", "HEAD"])).toBe(leafHead);
	});

	it("skips source submodules missing at the target ref instead of aborting", async () => {
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-wt-sub-m-")));
		tempRoots.push(root);
		const { parent } = await makeNestedSubmodules(root);
		// A ref whose tree has no `mid` at all (e.g. a PR branch that
		// removed it): the plain tree there knows neither `mid` nor `mid/leaf`.
		await runGit(parent, ["checkout", "-q", "-b", "nosub"]);
		await runGit(parent, ["rm", "-q", "mid"]);
		await runGit(parent, ["commit", "-q", "-m", "drop mid"]);
		const plain = path.join(root, "plain-nosub");
		await runGit(parent, ["worktree", "add", "-q", "--detach", plain, "nosub"]);

		const result = await initWorktreeSubmodules(plain, ["mid", "mid/leaf"]);
		expect(result.initialized).toEqual([]);
		expect(result.skipped).toEqual(["mid", "mid/leaf"]);
		expect(await runGit(plain, ["status", "--porcelain"])).toBe("");
	});
});
