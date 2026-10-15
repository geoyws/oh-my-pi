/**
 * Isolation sandbox escapes (t-c7225b0b): a committed symlink that resolves
 * outside the checkout, or hand-planted git metadata (absolute `commondir`,
 * symlinked `refs/`/`objects/`, admins outside submodule prefixes or under
 * `node_modules`) must refuse hand-out at setup — never hand the child a
 * checkout it can write through into the caller or source admin.
 */
import { afterEach, describe, expect, it, setDefaultTimeout, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { cleanupIsolation, ensureIsolation, gitAdminEscapes } from "@oh-my-pi/pi-coding-agent/task/worktree";
import * as natives from "@oh-my-pi/pi-natives";
import { removeWithRetries, setWorktreesDir } from "@oh-my-pi/pi-utils";

const tempDirs: string[] = [];

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

async function initRepo(dir: string): Promise<void> {
	await runGit(dir, ["init", "-q", "-b", "main"]);
	await runGit(dir, ["config", "user.email", "iso@example.com"]);
	await runGit(dir, ["config", "user.name", "Isolated User"]);
	await runGit(dir, ["config", "commit.gpgsign", "false"]);
}

async function makeRepo(name: string): Promise<string> {
	const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `omp-isoescape-${name}-`)));
	tempDirs.push(dir);
	await initRepo(dir);
	await fs.writeFile(path.join(dir, "tracked.txt"), "base\n");
	await fs.mkdir(path.join(dir, "sub"), { recursive: true });
	await fs.writeFile(path.join(dir, "sub", "nested.txt"), "nested base\n");
	await runGit(dir, ["add", "-A"]);
	await runGit(dir, ["commit", "-q", "-m", "base"]);
	return dir;
}

function mockRcopy(): void {
	vi.spyOn(natives, "isoResolve").mockResolvedValue({
		kind: natives.IsoBackendKind.Rcopy,
		candidates: [natives.IsoBackendKind.Rcopy],
		fellBack: false,
		reason: undefined,
	});
}
function mockBackendApfs(): void {
	vi.spyOn(natives, "isoResolve").mockResolvedValue({
		kind: natives.IsoBackendKind.Apfs,
		candidates: [natives.IsoBackendKind.Apfs],
		fellBack: false,
		reason: undefined,
	});
}

async function withIsolationEnv(fn: () => Promise<void>): Promise<void> {
	const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isoescape-wtbase-"));
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

/** Byte-identical snapshot of a checkout's refs, HEAD and branch list. */
async function sourceGitIdentity(dir: string): Promise<string> {
	const head = await runGit(dir, ["rev-parse", "HEAD"]);
	const branches = await runGit(dir, ["branch", "--format=%(refname:short)"]);
	const refs = await runGit(dir, ["for-each-ref", "--format=%(objectname) %(refname)"]);
	return [head, branches, refs].join("\n");
}

async function repoFingerprint(repo: string): Promise<string> {
	const head = await runGit(repo, ["rev-parse", "HEAD"]);
	const status = await runGit(repo, ["status", "--porcelain"]);
	const tracked = await runGit(repo, ["ls-files", "-s"]);
	return [head, status, tracked].join("\n");
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
});

describe("isolation with a committed symlink to the caller (t-c7225b0b.1)", () => {
	it("refuses a checkout whose committed symlink resolves at the caller, leaving the caller untouched", async () => {
		const caller = await makeRepo("caller");
		const target = await makeRepo("target");
		await fs.mkdir(path.join(target, "target"), { recursive: true });
		// Committed symlink: target/out -> the caller dir itself.
		await fs.symlink(caller, path.join(target, "target", "out"));
		await runGit(target, ["add", "-A"]);
		await runGit(target, ["commit", "-q", "-m", "plant out-of-tree symlink"]);
		const callerBefore = await repoFingerprint(caller);
		const callerIdentity = await sourceGitIdentity(caller);

		mockRcopy();
		await withIsolationEnv(async () => {
			await expect(ensureIsolation(target, "escape-symlink-caller")).rejects.toThrow(/points outside the copy/);
		});
		expect(await repoFingerprint(caller)).toBe(callerBefore);
		expect(await sourceGitIdentity(caller)).toBe(callerIdentity);
	});

	it("refuses a committed symlink chain that resolves outside the copy", async () => {
		const caller = await makeRepo("chain-caller");
		const target = await makeRepo("chain-target");
		await fs.symlink(caller, path.join(target, "hop"));
		await fs.symlink("hop", path.join(target, "out"));
		await runGit(target, ["add", "-A"]);
		await runGit(target, ["commit", "-q", "-m", "plant symlink chain"]);
		const callerBefore = await repoFingerprint(caller);

		mockRcopy();
		await withIsolationEnv(async () => {
			await expect(ensureIsolation(target, "escape-symlink-chain")).rejects.toThrow(/points outside the copy/);
		});
		expect(await repoFingerprint(caller)).toBe(callerBefore);
	});

	it("refuses a committed dangling symlink whose target lies outside the copy", async () => {
		const caller = await makeRepo("dangling-caller");
		const target = await makeRepo("dangling-target");
		// Dangling: creating through this link would materialise the target
		// outside the copy, so it must refuse even though nothing exists there.
		await fs.symlink(path.join(caller, "never-created"), path.join(target, "out"));
		await runGit(target, ["add", "-A"]);
		await runGit(target, ["commit", "-q", "-m", "plant dangling symlink"]);
		const callerBefore = await repoFingerprint(caller);

		mockRcopy();
		await withIsolationEnv(async () => {
			await expect(ensureIsolation(target, "escape-symlink-dangling")).rejects.toThrow(/points outside the copy/);
		});
		expect(await repoFingerprint(caller)).toBe(callerBefore);
	});

	it("keeps working links: relative, chain, and dangling-inside symlinks isolate fine", async () => {
		const target = await makeRepo("links-ok");
		await fs.symlink("sub", path.join(target, "link"));
		await fs.symlink("link", path.join(target, "chain"));
		await fs.symlink(path.join("sub", "missing-yet.txt"), path.join(target, "dangling-inside"));
		await runGit(target, ["add", "-A"]);
		await runGit(target, ["commit", "-q", "-m", "in-copy links"]);

		mockRcopy();
		await withIsolationEnv(async () => {
			const handle = await ensureIsolation(target, "in-copy-links-ok");
			try {
				const realCopy = await fs.realpath(handle.mergedDir);
				// In-copy links resolve inside the copy and read through.
				expect(await fs.readFile(path.join(realCopy, "link", "nested.txt"), "utf8")).toBe("nested base\n");
				expect(await fs.readFile(path.join(realCopy, "chain", "nested.txt"), "utf8")).toBe("nested base\n");
				// Writing through an in-copy link lands in the copy, not the source.
				await fs.writeFile(path.join(realCopy, "link", "nested.txt"), "copy edit\n");
				expect(await fs.readFile(path.join(target, "sub", "nested.txt"), "utf8")).toBe("nested base\n");
				expect(await fs.readFile(path.join(realCopy, "link", "nested.txt"), "utf8")).toBe("copy edit\n");
			} finally {
				await cleanupIsolation(handle);
			}
		});
	});
	it("re-anchors a committed absolute intra-checkout symlink into the copy", async () => {
		const target = await makeRepo("links-absolute");
		// Absolute link at the source checkout: a verbatim copy would keep
		// pointing at the source, so setup re-points it at the copy.
		await fs.symlink(path.join(target, "sub"), path.join(target, "abslink"));
		await runGit(target, ["add", "-A"]);
		await runGit(target, ["commit", "-q", "-m", "absolute in-checkout link"]);

		mockRcopy();
		await withIsolationEnv(async () => {
			const handle = await ensureIsolation(target, "absolute-link-reanchored");
			try {
				const realCopy = await fs.realpath(handle.mergedDir);
				const copyLink = path.join(realCopy, "abslink");
				expect((await fs.lstat(copyLink)).isSymbolicLink()).toBe(true);
				expect(await fs.realpath(copyLink)).toBe(path.join(realCopy, "sub"));
				expect(await fs.readFile(path.join(copyLink, "nested.txt"), "utf8")).toBe("nested base\n");
				// Writing through the re-anchored link lands in the copy.
				await fs.writeFile(path.join(copyLink, "nested.txt"), "copy edit\n");
				expect(await fs.readFile(path.join(target, "sub", "nested.txt"), "utf8")).toBe("nested base\n");
				expect(await fs.readFile(path.join(realCopy, "sub", "nested.txt"), "utf8")).toBe("copy edit\n");
			} finally {
				await cleanupIsolation(handle);
			}
		});
		// The source checkout is untouched: same link, same target.
		expect(await fs.readlink(path.join(target, "abslink"))).toBe(path.join(target, "sub"));
	});
});

describe("isolation with hand-planted git metadata (t-c7225b0b.2)", () => {
	it("refuses an unlisted nested .git dir with an absolute commondir on the on-pin path", async () => {
		const source = await makeRepo("planted-commondir");
		const sourceAdmin = await runGit(source, ["rev-parse", "--absolute-git-dir"]);
		// Untracked plant outside every submodule prefix: the on-pin rebind
		// performs no pointer walk, so only the copy-wide gate can refuse it.
		const nested = path.join(source, "vendor", "nested");
		await fs.mkdir(nested, { recursive: true });
		await fs.mkdir(path.join(nested, ".git"), { recursive: true });
		await fs.writeFile(path.join(nested, ".git", "HEAD"), await fs.readFile(path.join(sourceAdmin, "HEAD"), "utf8"));
		await fs.writeFile(path.join(nested, ".git", "commondir"), `${sourceAdmin}\n`);
		const before = await sourceGitIdentity(source);

		mockRcopy();
		await withIsolationEnv(async () => {
			await expect(ensureIsolation(source, "escape-planted-commondir")).rejects.toThrow(/still shares git metadata/);
		});
		expect(await sourceGitIdentity(source)).toBe(before);
	});

	it("refuses a planted admin under node_modules", async () => {
		const source = await makeRepo("planted-node-modules");
		const sourceAdmin = await runGit(source, ["rev-parse", "--absolute-git-dir"]);
		const nested = path.join(source, "node_modules", "evil");
		await fs.mkdir(nested, { recursive: true });
		await fs.mkdir(path.join(nested, ".git"), { recursive: true });
		await fs.writeFile(path.join(nested, ".git", "HEAD"), await fs.readFile(path.join(sourceAdmin, "HEAD"), "utf8"));
		await fs.writeFile(path.join(nested, ".git", "commondir"), `${sourceAdmin}\n`);
		const before = await sourceGitIdentity(source);

		mockRcopy();
		await withIsolationEnv(async () => {
			await expect(ensureIsolation(source, "escape-planted-node-modules")).rejects.toThrow(
				/still shares git metadata/,
			);
		});
		expect(await sourceGitIdentity(source)).toBe(before);
	});

	it.skipIf(process.platform !== "darwin")(
		"refuses an admin whose refs are symlinked at the source admin",
		async () => {
			const source = await makeRepo("planted-refs");
			const sourceAdmin = await runGit(source, ["rev-parse", "--absolute-git-dir"]);
			// In-copy admin dir with an in-copy commondir: the old predicate
			// calls this private, but ref writes still land in the source.
			// The plant looks enough like a repo that git hides it from
			// untracked listings, so rcopy seed never carries it: exercise
			// the clone backend, which copies the checkout whole.
			const nested = path.join(source, "vendor", "nested-refs");
			const admin = path.join(nested, ".git");
			await fs.mkdir(admin, { recursive: true });
			await fs.writeFile(path.join(admin, "HEAD"), await fs.readFile(path.join(sourceAdmin, "HEAD"), "utf8"));
			await fs.writeFile(path.join(admin, "commondir"), ".\n");
			await fs.symlink(path.join(sourceAdmin, "refs"), path.join(admin, "refs"));
			const before = await sourceGitIdentity(source);

			mockBackendApfs();
			await withIsolationEnv(async () => {
				await expect(ensureIsolation(source, "escape-planted-refs")).rejects.toThrow(/still shares git metadata/);
			});
			expect(await sourceGitIdentity(source)).toBe(before);
		},
	);

	it.skipIf(process.platform !== "darwin")(
		"refuses an admin whose objects are symlinked at the source admin",
		async () => {
			const source = await makeRepo("planted-objects");
			const sourceAdmin = await runGit(source, ["rev-parse", "--absolute-git-dir"]);
			const nested = path.join(source, "vendor", "nested-objects");
			const admin = path.join(nested, ".git");
			await fs.mkdir(admin, { recursive: true });
			await fs.writeFile(path.join(admin, "HEAD"), await fs.readFile(path.join(sourceAdmin, "HEAD"), "utf8"));
			await fs.writeFile(path.join(admin, "commondir"), ".\n");
			await fs.symlink(path.join(sourceAdmin, "objects"), path.join(admin, "objects"));
			const before = await sourceGitIdentity(source);

			mockBackendApfs();
			await withIsolationEnv(async () => {
				await expect(ensureIsolation(source, "escape-planted-objects")).rejects.toThrow(
					/still shares git metadata/,
				);
			});
			expect(await sourceGitIdentity(source)).toBe(before);
		},
	);
});

describe("gitAdminEscapes storage verdicts (t-c7225b0b.2c)", () => {
	async function plantInCopyAdmin(
		copy: string,
		rel: string,
		sourceAdmin: string,
		linkName: string,
		linkTarget: string,
	): Promise<string> {
		const admin = path.join(copy, rel);
		await fs.mkdir(admin, { recursive: true });
		await fs.writeFile(path.join(admin, "HEAD"), await fs.readFile(path.join(sourceAdmin, "HEAD"), "utf8"));
		await fs.writeFile(path.join(admin, "commondir"), ".\n");
		await fs.symlink(linkTarget, path.join(admin, linkName));
		return admin;
	}

	it("reports escapes for symlinked refs with an in-copy commondir", async () => {
		const source = await makeRepo("verdict-refs");
		const copy = await makeRepo("verdict-refs-copy");
		const sourceAdmin = await runGit(source, ["rev-parse", "--absolute-git-dir"]);
		const dotGit = path.join(copy, "nested", ".git");
		await fs.mkdir(path.dirname(dotGit), { recursive: true });
		await plantInCopyAdmin(
			copy,
			path.relative(copy, path.dirname(dotGit)) + "/.git",
			sourceAdmin,
			"refs",
			path.join(sourceAdmin, "refs"),
		);
		expect(await gitAdminEscapes(await fs.realpath(copy), dotGit)).toBe(true);
	});

	it("reports escapes for symlinked objects with an in-copy commondir", async () => {
		const source = await makeRepo("verdict-objects");
		const copy = await makeRepo("verdict-objects-copy");
		const sourceAdmin = await runGit(source, ["rev-parse", "--absolute-git-dir"]);
		const dotGit = path.join(copy, "nested", ".git");
		await fs.mkdir(path.dirname(dotGit), { recursive: true });
		await plantInCopyAdmin(
			copy,
			path.relative(copy, path.dirname(dotGit)) + "/.git",
			sourceAdmin,
			"objects",
			path.join(sourceAdmin, "objects"),
		);
		expect(await gitAdminEscapes(await fs.realpath(copy), dotGit)).toBe(true);
	});

	it("reports escapes for a commondir pointer that is itself a symlink outside", async () => {
		const source = await makeRepo("verdict-commondir-link");
		const copy = await makeRepo("verdict-commondir-link-copy");
		const sourceAdmin = await runGit(source, ["rev-parse", "--absolute-git-dir"]);
		const admin = path.join(copy, "nested", ".git");
		await fs.mkdir(admin, { recursive: true });
		await fs.writeFile(path.join(admin, "HEAD"), await fs.readFile(path.join(sourceAdmin, "HEAD"), "utf8"));
		// The commondir file itself is a symlink reaching the source admin.
		await fs.symlink(path.join(sourceAdmin, "HEAD"), path.join(admin, "commondir-target"));
		await fs.symlink(path.join(admin, "commondir-target"), path.join(admin, "commondir"));
		expect(await gitAdminEscapes(await fs.realpath(copy), admin)).toBe(true);
	});

	it("stays private for a detached-style admin borrowing objects through alternates", async () => {
		const source = await makeRepo("verdict-alternates");
		const copy = await makeRepo("verdict-alternates-copy");
		const sourceAdmin = await runGit(source, ["rev-parse", "--absolute-git-dir"]);
		const admin = path.join(copy, "nested", ".git");
		await fs.mkdir(path.join(admin, "objects", "info"), { recursive: true });
		await fs.mkdir(path.join(admin, "refs"), { recursive: true });
		await fs.writeFile(path.join(admin, "HEAD"), await fs.readFile(path.join(sourceAdmin, "HEAD"), "utf8"));
		// Read-only object borrowing: a file, not a link — must keep passing.
		await fs.writeFile(path.join(admin, "objects", "info", "alternates"), `${path.join(sourceAdmin, "objects")}\n`);
		expect(await gitAdminEscapes(await fs.realpath(copy), admin)).toBe(false);
	});
});
