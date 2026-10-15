import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { setWorktreesDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import {
	canAutoCreateWorktree,
	cleanSourceCheckoutIfConfigured,
	createSessionWorktree,
	decideWorktreeExit,
	formatSessionWorktreeSummary,
	inspectSessionWorktree,
	planWorktreeExit,
	removeExitWorktrees,
	removeSessionWorktree,
	type SessionWorktreeState,
	type WorktreeExitAction,
} from "../../src/session/session-worktree";

const clean: SessionWorktreeState = { dirty: false, moved: false, offBranch: false };

const rows: [
	name: string,
	policy: "keep" | "ask" | "remove",
	state: SessionWorktreeState,
	expected: WorktreeExitAction,
][] = [
	["keep ignores state", "keep", { dirty: true, moved: true, offBranch: true }, "keep"],
	["ask prompts even when clean", "ask", clean, "prompt"],
	["remove removes a clean worktree", "remove", clean, "remove"],
	["remove prompts when dirty", "remove", { ...clean, dirty: true }, "prompt"],
	["remove prompts when the branch moved", "remove", { ...clean, moved: true }, "prompt"],
	["remove prompts when HEAD left the branch", "remove", { ...clean, offBranch: true }, "prompt"],
];

describe("decideWorktreeExit", () => {
	it.each(rows)("%s", (_name, policy, state, action) => {
		expect(decideWorktreeExit(policy, state)).toBe(action);
	});
});

function git(cwd: string, ...args: string[]): string {
	const r = Bun.spawnSync(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
	return r.stdout.toString().trim();
}

function worktreePaths(repo: string): string[] {
	return git(repo, "worktree", "list", "--porcelain")
		.split("\n")
		.filter(line => line.startsWith("worktree "))
		.map(line => path.resolve(line.slice("worktree ".length)));
}

function branchSha(repo: string, branch: string): string | null {
	const r = Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
		cwd: repo,
		stdout: "pipe",
	});
	return r.exitCode === 0 ? r.stdout.toString().trim() : null;
}

const exists = (p: string) =>
	fs.stat(p).then(
		() => true,
		() => false,
	);

/** Resolve a `.git` gitfile to its absolute target dir. */
async function readGitfile(gitfile: string): Promise<string> {
	const content = await fs.readFile(gitfile, "utf8");
	const pointer = (content.split("\n", 1)[0] ?? "").trim();
	const match = /^gitdir:[ \t]*(.+?)\s*$/.exec(pointer);
	if (!match) throw new Error(`${gitfile} is not a gitfile: ${pointer}`);
	return path.resolve(path.dirname(gitfile), match[1]);
}

const commitFile = async (cwd: string, name: string) => {
	await Bun.write(path.join(cwd, name), "x\n");
	git(cwd, "add", ".");
	git(cwd, "commit", "-q", "-m", `add ${name}`);
};

describe("session worktree helpers (real git)", () => {
	let root: string;
	let repo: string;
	let savedEnv: string | undefined;
	let savedCwd: string;
	const branch = "wt/test-session";

	beforeEach(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-wt-")));
		repo = path.join(root, "repo");
		await fs.mkdir(repo);
		savedEnv = process.env.OMP_WORKTREE_DIR;
		savedCwd = process.cwd();
		delete process.env.OMP_WORKTREE_DIR;
		setWorktreesDir(path.join(root, "wt"));
		git(repo, "init", "-q", "-b", "main");
		git(repo, "config", "core.autocrlf", "false");
		await Bun.write(path.join(repo, "tracked.txt"), "base\n");
		git(repo, "add", ".");
		git(repo, "commit", "-q", "-m", "init");
	});

	afterEach(async () => {
		process.chdir(savedCwd);
		setWorktreesDir(undefined);
		if (savedEnv === undefined) delete process.env.OMP_WORKTREE_DIR;
		else process.env.OMP_WORKTREE_DIR = savedEnv;
		await fs.rm(root, { recursive: true, force: true });
	});

	const create = (keepChanges = true, name = branch) =>
		createSessionWorktree(repo, Settings.isolated(), name, { keepChanges });

	it("offers a worktree only in a primary checkout with commits", async () => {
		const plain = path.join(root, "plain");
		const unborn = path.join(root, "unborn");
		await fs.mkdir(plain);
		await fs.mkdir(unborn);
		git(unborn, "init", "-q");
		await expect(createSessionWorktree(unborn, Settings.isolated(), branch)).rejects.toThrow("has no commits");
		expect(await exists(path.join(root, "wt"))).toBe(false);
		const wt = await create();
		expect(await canAutoCreateWorktree(repo)).toBe(true);
		expect(await canAutoCreateWorktree(plain)).toBe(false);
		expect(await canAutoCreateWorktree(unborn)).toBe(false);
		expect(await canAutoCreateWorktree(wt.path)).toBe(false);
	});

	it("removes a clean worktree and deletes its branch", async () => {
		const wt = await create();
		expect(worktreePaths(repo)).toContain(wt.path);
		expect(await inspectSessionWorktree(wt)).toEqual(clean);
		await removeSessionWorktree(wt, false);
		expect(await exists(wt.path)).toBe(false);
		expect(worktreePaths(repo)).not.toContain(wt.path);
		expect(branchSha(repo, branch)).toBeNull();
	});

	it("keeps the branch at the new commit when the worktree moved", async () => {
		const wt = await create();
		await commitFile(wt.path, "new.txt");
		const tip = git(wt.path, "rev-parse", "HEAD");
		expect(await inspectSessionWorktree(wt)).toEqual({ ...clean, moved: true });
		await removeSessionWorktree(wt, true);
		expect(await exists(wt.path)).toBe(false);
		expect(worktreePaths(repo)).not.toContain(wt.path);
		expect(branchSha(repo, branch)).toBe(tip);
	});

	it("prompts instead of removing when commits exist only on a detached HEAD", async () => {
		const wt = await create();
		git(wt.path, "switch", "-q", "--detach");
		await commitFile(wt.path, "detached.txt");
		expect(await inspectSessionWorktree(wt)).toEqual({ ...clean, offBranch: true });
		const prompts: string[] = [];
		const plan = await planWorktreeExit(
			[wt],
			"remove",
			async (_title, message) => {
				prompts.push(message);
				return false;
			},
			() => {},
		);
		expect(plan).toEqual([]);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain(`HEAD is not on ${branch}`);
		expect(await exists(wt.path)).toBe(true);
	});

	it("reports moved from the source repo when the worktree dir was deleted externally", async () => {
		const wt = await create();
		await commitFile(wt.path, "new.txt");
		await fs.rm(wt.path, { recursive: true, force: true });
		git(repo, "worktree", "prune");
		expect(worktreePaths(repo)).not.toContain(wt.path);
		expect(await inspectSessionWorktree(wt)).toEqual({ ...clean, moved: true });
	});

	it("rejects and keeps the branch when git cannot remove the worktree", async () => {
		const wt = await create();
		await fs.rm(wt.path, { recursive: true, force: true });
		git(repo, "worktree", "prune");
		await expect(removeSessionWorktree(wt, false)).rejects.toThrow(`branch '${branch}' kept`);
		expect(branchSha(repo, branch)).toBe(wt.baseCommit);
	});

	it("starts from clean HEAD with keepChanges:false and reports worktree edits as dirty", async () => {
		await Bun.write(path.join(repo, "tracked.txt"), "edited\n");
		await Bun.write(path.join(repo, "untracked.txt"), "u\n");
		const wt = await create(false);
		expect(wt.keptChanges).toBe(false);
		expect(wt.baseCommit).toBe(git(repo, "rev-parse", "HEAD"));
		expect(await Bun.file(path.join(wt.path, "tracked.txt")).text()).toBe("base\n");
		expect(await exists(path.join(wt.path, "untracked.txt"))).toBe(false);
		expect(git(wt.path, "status", "--porcelain")).toBe("");
		expect(git(repo, "diff", "--name-only")).toBe("tracked.txt");
		expect(git(repo, "ls-files", "--others", "--exclude-standard")).toBe("untracked.txt");
		expect(await inspectSessionWorktree(wt)).toEqual(clean);
		await Bun.write(path.join(wt.path, "tracked.txt"), "wt edit\n");
		expect(await inspectSessionWorktree(wt)).toEqual({ ...clean, dirty: true });
	});

	it("plans newest first and removes from inside the newest worktree", async () => {
		const older = await create(true, "wt/older");
		const newer = await create(true, "wt/newer");
		const plan = await planWorktreeExit(
			[older, newer],
			"remove",
			async () => {
				throw new Error("clean worktrees must not prompt");
			},
			() => {},
		);
		expect(plan.map(p => p.worktree.branch)).toEqual(["wt/newer", "wt/older"]);
		process.chdir(newer.path);
		expect(await removeExitWorktrees(plan)).toEqual([
			`Removed worktree ${shortenPath(newer.path)}. Resuming opens in the directory you launch omp from.`,
		]);
		expect(await fs.realpath(process.cwd())).toBe(repo);
		expect(worktreePaths(repo)).toEqual([repo]);
		expect(branchSha(repo, "wt/newer")).toBeNull();
		expect(branchSha(repo, "wt/older")).toBeNull();
	});

	it("keeps a worktree removed without a prompt that changed after planning", async () => {
		const wt = await create();
		const plan = await planWorktreeExit(
			[wt],
			"remove",
			async () => true,
			() => {},
		);
		expect(plan.map(p => p.worktree)).toEqual([wt]);
		await Bun.write(path.join(wt.path, "late.txt"), "written during teardown\n");
		const messages = await removeExitWorktrees(plan);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("changed while the session was closing");
		expect(await Bun.file(path.join(wt.path, "late.txt")).text()).toBe("written during teardown\n");
	});

	it("keeps a confirmed dirty worktree that got more uncommitted edits after the prompt", async () => {
		const wt = await create();
		await Bun.write(path.join(wt.path, "dirty.txt"), "d\n");
		const plan = await planWorktreeExit(
			[wt],
			"ask",
			async () => true,
			() => {},
		);
		expect(plan.map(p => p.worktree)).toEqual([wt]);
		await Bun.write(path.join(wt.path, "dirty.txt"), "more work written during teardown\n");
		const messages = await removeExitWorktrees(plan);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("changed while the session was closing");
		expect(await exists(wt.path)).toBe(true);
	});

	it("removes a confirmed dirty worktree, keeps a moved branch, and names it in the resume note", async () => {
		const wt = await create();
		await commitFile(wt.path, "work.txt");
		const tip = git(wt.path, "rev-parse", "HEAD");
		await Bun.write(path.join(wt.path, "dirty.txt"), "d\n");
		const plan = await planWorktreeExit(
			[wt],
			"ask",
			async () => true,
			() => {},
		);
		expect(plan.map(p => p.worktree)).toEqual([wt]);
		process.chdir(wt.path);
		expect(await removeExitWorktrees(plan)).toEqual([
			`Removed worktree ${shortenPath(wt.path)}. Resuming opens in the directory you launch omp from; its commits are on branch ${branch}.`,
		]);
		expect(await exists(wt.path)).toBe(false);
		expect(branchSha(repo, branch)).toBe(tip);
	});

	it("returns a message instead of throwing when removal fails", async () => {
		const wt = await create();
		const plan = await planWorktreeExit(
			[wt],
			"remove",
			async () => true,
			() => {},
		);
		await fs.rm(wt.path, { recursive: true, force: true });
		git(repo, "worktree", "prune");
		const messages = await removeExitWorktrees(plan);
		expect(messages).toEqual([`Failed to remove worktree ${wt.path}; branch '${branch}' kept.`]);
		expect(branchSha(repo, branch)).toBe(wt.baseCommit);
	});

	it("initializes nested parent→mid→leaf submodules privately at every depth", async () => {
		const leafSrc = path.join(root, "leaf-src");
		await fs.mkdir(leafSrc);
		git(leafSrc, "init", "-q", "-b", "main");
		await commitFile(leafSrc, "leaf.txt");
		const midSrc = path.join(root, "mid-src");
		await fs.mkdir(midSrc);
		git(midSrc, "init", "-q", "-b", "main");
		await commitFile(midSrc, "mid.txt");
		git(midSrc, "-c", "protocol.file.allow=always", "submodule", "add", "-q", leafSrc, "leaf");
		git(midSrc, "commit", "-q", "-m", "add leaf");
		const nested = path.join(root, "nested");
		await fs.mkdir(nested);
		git(nested, "init", "-q", "-b", "main");
		git(nested, "config", "core.autocrlf", "false");
		await commitFile(nested, "main.txt");
		git(nested, "-c", "protocol.file.allow=always", "submodule", "add", "-q", midSrc, "mid");
		git(nested, "commit", "-q", "-m", "add mid");
		git(nested, "-c", "protocol.file.allow=always", "submodule", "update", "-q", "--init", "--recursive");
		const midHead = git(path.join(nested, "mid"), "rev-parse", "HEAD");
		const leafHead = git(path.join(nested, "mid", "leaf"), "rev-parse", "HEAD");

		const wt = await createSessionWorktree(nested, Settings.isolated(), "wt/nested-sub", { keepChanges: true });
		expect(wt.submodulesNotCarried).toEqual([]);
		for (const rel of ["", "mid", "mid/leaf"]) {
			expect(git(path.join(wt.path, rel), "status", "--porcelain")).toBe("");
		}
		expect(git(path.join(wt.path, "mid"), "rev-parse", "HEAD")).toBe(midHead);
		expect(git(path.join(wt.path, "mid", "leaf"), "rev-parse", "HEAD")).toBe(leafHead);
		const admin = await readGitfile(path.join(wt.path, ".git"));
		for (const rel of ["mid", "mid/leaf"]) {
			const moduleDir = await readGitfile(path.join(wt.path, rel, ".git"));
			expect((await fs.stat(moduleDir)).isDirectory()).toBe(true);
			expect(moduleDir === admin || moduleDir.startsWith(`${admin}${path.sep}`)).toBe(true);
		}
		expect(await readGitfile(path.join(wt.path, "mid", ".git"))).not.toBe(
			await readGitfile(path.join(nested, "mid", ".git")),
		);
	});

	it("reports dirty submodules as not carried and never cleans the source", async () => {
		const subSrc = path.join(root, "sub-src");
		await fs.mkdir(subSrc);
		git(subSrc, "init", "-q", "-b", "main");
		await commitFile(subSrc, "lib.txt");
		const dirtyParent = path.join(root, "dirty-parent");
		await fs.mkdir(dirtyParent);
		git(dirtyParent, "init", "-q", "-b", "main");
		git(dirtyParent, "config", "core.autocrlf", "false");
		await commitFile(dirtyParent, "main.txt");
		git(dirtyParent, "-c", "protocol.file.allow=always", "submodule", "add", "-q", subSrc, "sub");
		git(dirtyParent, "commit", "-q", "-m", "add sub");
		git(dirtyParent, "-c", "protocol.file.allow=always", "submodule", "update", "-q", "--init");
		const pin = git(path.join(dirtyParent, "sub"), "rev-parse", "HEAD");
		await Bun.write(path.join(dirtyParent, "sub", "lib.txt"), "x\ndirty edit\n");
		await Bun.write(path.join(dirtyParent, "sub", "scratch-new.txt"), "untracked\n");
		const before = git(path.join(dirtyParent, "sub"), "status", "--porcelain");
		expect(before).not.toBe("");

		const wt = await createSessionWorktree(dirtyParent, Settings.isolated(), "wt/dirty-sub", { keepChanges: true });
		expect(wt.submodulesNotCarried).toEqual(["sub"]);
		expect(git(path.join(wt.path, "sub"), "rev-parse", "HEAD")).toBe(pin);
		expect(formatSessionWorktreeSummary(wt, false)).toContain("sub");

		const cleaning = Settings.isolated({ "worktree.cleanSource": true });
		const cleanup = await cleanSourceCheckoutIfConfigured(dirtyParent, cleaning, {
			preserveSubmodules: wt.submodulesNotCarried,
		});
		expect(cleanup.cleaned).toBe(false);
		expect(cleanup.skipped ?? "").toContain("sub");
		expect(await Bun.file(path.join(dirtyParent, "sub", "lib.txt")).text()).toBe("x\ndirty edit\n");
		expect(await exists(path.join(dirtyParent, "sub", "scratch-new.txt"))).toBe(true);
		expect(git(path.join(dirtyParent, "sub"), "status", "--porcelain")).toBe(before);
	});
});
