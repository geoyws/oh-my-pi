import { type NestedRepoPatch } from "@oh-my-pi/pi-tui/tools/task";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { VcsCommitAuthor, VcsGitRepo } from "@oh-my-pi/pi-natives";
import * as natives from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { formatBytes, getWorktreeDir, logger, Snowflake } from "@oh-my-pi/pi-utils";
import type { SettingValueOf } from "../config/registry";

import { withRepoLock } from "../utils/repo-lock";
import { writeIsolationOwner } from "./isolation-ownership";
import { mapWithConcurrencyLimit } from "./parallel";
import type { cfgIsolationBackend } from "./settings";

const { IsoBackendKind } = natives;

const TASK_ISOLATION_DIR_PREFIX = "t";
const TASK_ISOLATION_DIR_DIGEST_CHARS = 9;
const TASK_ISOLATION_MOUNT_DIR = "m";
const GIT_NETWORK_TIMEOUT_MS = 30 * 60 * 1000;
type IsoBackendKind = natives.IsoBackendKind;
async function diffTreeOrEmpty(repo: VcsGitRepo, base: string, head: string): Promise<string> {
	try {
		return await repo.diffTree(base, head, true);
	} catch (error) {
		if (vcs.isVcsError(error)) return "";
		throw error;
	}
}

/**
 * Diff two trees while capturing a task's changes. Unlike
 * {@link diffTreeOrEmpty}, a render failure throws: an empty patch would read
 * as "no changes" and the workspace holding them would be torn down. The
 * native renderer refuses gitlink entries, so a committed submodule pin move
 * lands here.
 */
async function diffTreeForCapture(repo: VcsGitRepo, repoDir: string, base: string, head: string): Promise<string> {
	try {
		return await repo.diffTree(base, head, true);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot render the changes in ${repoDir}: ${message}`, { cause: error });
	}
}

/** Baseline state for a single git repository. */
export interface RepoBaseline {
	repoRoot: string;
	headCommit: string;
	staged: string;
	unstaged: string;
	untracked: string[];
	untrackedPatch: string;
}

/** Baseline state for the project, including any nested git repos. */
export interface WorktreeBaseline {
	root: RepoBaseline;
	/** Nested git repos (path relative to root.repoRoot). */
	nested: Array<{ relativePath: string; baseline: RepoBaseline }>;
}

export async function getRepoRoot(cwd: string): Promise<string> {
	// Pure-jj check runs first so a jj workspace nested under an unrelated
	// outer Git checkout is rejected at its own root rather than silently
	// mutating the surrounding Git tree behind jj's back.
	if (vcs.isPureJj(cwd)) {
		throw new Error(
			"Isolated task execution requires a Git checkout, but this workspace is pure Jujutsu (`.jj/` without a colocated `.git/`). Run `jj git init --colocate` to add a Git checkout, or set `task.isolation.enabled: false` to disable task isolation.",
		);
	}

	const repoRoot = vcs.git(cwd)?.info().repoRoot;
	if (repoRoot) return repoRoot;

	throw new Error("Git repository not found for isolated task execution.");
}

const GIT_NO_INDEX_NULL_PATH = process.platform === "win32" ? "NUL" : "/dev/null";

export function getGitNoIndexNullPath(): string {
	return GIT_NO_INDEX_NULL_PATH;
}

/**
 * Find every repository under `repoRoot` whose edits the root diff cannot
 * carry: each initialized submodule at every depth (the root diff never
 * renders a gitlink, let alone the submodule's files) plus every
 * non-submodule nested repo. Paths are relative to `repoRoot`; a submodule
 * always precedes the repos nested inside it.
 */
async function discoverNestedRepos(repoRoot: string): Promise<string[]> {
	// Initialized submodules, recursively; uninitialized ones have no edits.
	const submodules = await vcs.requireGit(repoRoot).submodulePaths();
	const submodulePaths = new Set(submodules);

	// Find all .git dirs/files that aren't the root or known submodules
	const result: string[] = [...submodules];
	async function walk(dir: string): Promise<void> {
		let entries: Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name === "node_modules" || entry.name === ".git") continue;
			if (!entry.isDirectory()) continue;
			const full = path.join(dir, entry.name);
			const rel = path.relative(repoRoot, full);
			// Check if this directory is itself a git repo
			const gitDir = path.join(full, ".git");
			let hasGit = false;
			try {
				await fs.access(gitDir);
				hasGit = true;
			} catch {}
			if (hasGit && !submodulePaths.has(rel)) {
				result.push(rel);
				// Don't recurse into nested repos — they manage their own tree
				continue;
			}
			await walk(full);
		}
	}
	await walk(repoRoot);
	return result;
}

/**
 * Ceiling on the working-tree content a single repo baseline may buffer in
 * memory. Baseline capture embeds every uncommitted byte — staged/unstaged
 * binary diffs plus a `--no-index` binary diff of each untracked file — into
 * in-memory strings (see {@link captureUntrackedPatch}). A binary diff is
 * ~1.3x the raw bytes, so a multi-GB working tree produces a single string
 * that blows past the engine's string limit and the process's memory, taking
 * the whole host down (issue #8939). `git ls-files --others
 * --exclude-standard` already omits gitignored bulk, so this only trips on
 * pathological non-ignored content; when it does we refuse the isolated spawn
 * with an actionable error instead of trapping the host.
 *
 * The staged and unstaged diffs are rendered under this budget inside the
 * native renderer (`diffText({ maxBytes })`): their size is unknowable before
 * rendering and can dwarf the working tree itself (index-vs-HEAD of a jj
 * conflict commit exported to git spans every conflict side), so the cap has
 * to stop the renderer rather than measure its output afterwards. The budget
 * bounds content, not RSS: a patch is briefly held twice while it crosses the
 * native boundary, and each nested repo is captured against its own budget.
 */
export const ISOLATION_BASELINE_MAX_CONTENT_BYTES = 1024 * 1024 * 1024;

/**
 * Thrown when a repo's uncommitted content exceeds the isolation-snapshot
 * budget. Surfaced verbatim so the caller can report the real cause
 * (oversized working tree) rather than masking it as a missing git repository.
 *
 * `contentBytes` is the measured total when the untracked stat pass tripped
 * the budget, and `undefined` when a staged or unstaged diff crossed it while
 * rendering — the renderer stops at the cap, so the full size is unknown.
 */
export class IsolationBaselineTooLargeError extends Error {
	constructor(
		readonly repoRoot: string,
		readonly contentBytes: number | undefined,
		readonly budgetBytes: number = ISOLATION_BASELINE_MAX_CONTENT_BYTES,
	) {
		const measured =
			contentBytes === undefined
				? `more than ${formatBytes(budgetBytes)} of uncommitted content`
				: `${formatBytes(contentBytes)} of uncommitted content, over the ${formatBytes(budgetBytes)} isolation-snapshot budget`;
		super(
			`Working tree at ${repoRoot} carries ${measured}. ` +
				`Isolated task snapshots buffer this content in memory, so proceeding would exhaust the host. ` +
				`Commit or gitignore the bulk (untracked files that aren't ignored are the usual culprit), ` +
				`or set \`task.isolation.enabled: false\` to run tasks without isolation.`,
		);
		this.name = "IsolationBaselineTooLargeError";
	}
}

/** Sum untracked entry sizes without following symlinks, skipping entries that vanished. */
async function sumUntrackedBytes(repoRoot: string, untracked: readonly string[]): Promise<number> {
	if (untracked.length === 0) return 0;
	const { results } = await mapWithConcurrencyLimit([...untracked], 16, async entry => {
		try {
			const stat = await fs.lstat(path.join(repoRoot, entry));
			return stat.isFile() ? stat.size : 0;
		} catch {
			return 0;
		}
	});
	return results.reduce((total: number, size) => total + (size ?? 0), 0);
}

async function captureUntrackedPatch(
	repoRoot: string,
	untracked: readonly string[],
	repo: VcsGitRepo = vcs.requireGit(repoRoot),
): Promise<string> {
	if (untracked.length === 0) return "";
	const nullPath = getGitNoIndexNullPath();
	// Bound concurrent native encodes so large untracked sets do not hold every
	// file and binary patch in memory at once.
	const { results: untrackedDiffs } = await mapWithConcurrencyLimit([...untracked], 8, async entry => {
		try {
			return await repo.diffNoIndex(nullPath, entry, true);
		} catch (error) {
			if (vcs.isVcsError(error)) return "";
			throw error;
		}
	});
	return untrackedDiffs.filter((diff): diff is string => !!diff?.trim()).join("\n");
}

/**
 * Capture a repo's pre-spawn baseline: head, staged and unstaged binary diffs,
 * and the untracked-file patch, keeping the buffered content under
 * `budgetBytes`. The two diffs are rendered natively under the remaining
 * budget, so an oversized change set fails inside the renderer instead of
 * after the whole patch is in memory.
 */
async function captureRepoBaseline(repoRoot: string, budgetBytes: number): Promise<RepoBaseline> {
	const repo = vcs.requireGit(repoRoot);
	const headCommit = (await repo.headSha()) ?? "";
	let staged: string;
	let unstaged: string;
	try {
		staged = await repo.diffText({ binary: true, cached: true, maxBytes: budgetBytes });
		// The renderer's cap and the budget are UTF-8 bytes; a render that
		// succeeded is at most `budgetBytes` of them, so the remainder is never
		// negative.
		unstaged = await repo.diffText({ binary: true, maxBytes: budgetBytes - Buffer.byteLength(staged) });
	} catch (error) {
		if (vcs.isVcsError(error) && error.code === "OutputTooLarge") {
			throw new IsolationBaselineTooLargeError(repoRoot, undefined, budgetBytes);
		}
		throw error;
	}
	const untracked = await repo.lsFiles(true, true);
	// Gate before capturing the untracked patch: that step embeds every
	// untracked byte into one in-memory string, so an oversized tree must be
	// refused here rather than after buffering gigabytes (#8939). Untracked
	// bytes come from stat (no reads); staged/unstaged are already rendered
	// binary diffs, charged at their byte size.
	const untrackedBytes = await sumUntrackedBytes(repoRoot, untracked);
	const contentBytes = untrackedBytes + Buffer.byteLength(staged) + Buffer.byteLength(unstaged);
	if (contentBytes > budgetBytes) {
		throw new IsolationBaselineTooLargeError(repoRoot, contentBytes, budgetBytes);
	}
	const untrackedPatch = await captureUntrackedPatch(repoRoot, untracked, repo);
	return { repoRoot, headCommit, staged, unstaged, untracked, untrackedPatch };
}

interface SyntheticTreeOptions {
	readonly threeWay?: boolean;
}

async function writeSyntheticTree(
	repoDir: string,
	baseTreeish: string,
	patches: readonly string[],
	options: SyntheticTreeOptions = {},
): Promise<string> {
	const tempIndex = path.join(os.tmpdir(), `omp-task-index-${Snowflake.next()}`);
	const repo = vcs.requireGit(repoDir);
	try {
		await repo.readTree(baseTreeish, tempIndex);
		for (const patch of patches) {
			if (!patch.trim()) continue;
			await repo.applyPatch(patch, {
				cached: true,
				indexPath: tempIndex,
				threeWay: options.threeWay,
			});
		}
		return await repo.writeTree(tempIndex);
	} finally {
		await fs.rm(tempIndex, { force: true });
	}
}

/**
 * Capture the baseline of `repoRoot` and every nested repo under it. Each repo
 * baseline may buffer at most `budgetBytes` of uncommitted content (the
 * isolation-snapshot budget, {@link ISOLATION_BASELINE_MAX_CONTENT_BYTES}).
 */
export async function captureBaseline(
	repoRoot: string,
	budgetBytes: number = ISOLATION_BASELINE_MAX_CONTENT_BYTES,
): Promise<WorktreeBaseline> {
	const [root, nestedPaths] = await Promise.all([
		captureRepoBaseline(repoRoot, budgetBytes),
		discoverNestedRepos(repoRoot),
	]);
	const nested = await Promise.all(
		nestedPaths.map(async relativePath => ({
			relativePath,
			baseline: await captureRepoBaseline(path.join(repoRoot, relativePath), budgetBytes),
		})),
	);
	return { root, nested };
}

/**
 * Capture the baseline of a freshly materialised isolation and rebind it to
 * the parent checkout at `repoRoot`.
 *
 * The isolation is a point-in-time copy of the parent's working tree, so its
 * own state is the only exact baseline: a baseline read from the live parent
 * before or after the copy also absorbs whatever other agents or merges wrote
 * in between, and that drift would surface as this task's changes.
 */
export async function captureIsolationBaseline(
	isolationDir: string,
	repoRoot: string,
	budgetBytes: number = ISOLATION_BASELINE_MAX_CONTENT_BYTES,
): Promise<WorktreeBaseline> {
	const { root, nested } = await captureBaseline(isolationDir, budgetBytes);
	return {
		root: { ...root, repoRoot },
		nested: nested.map(({ relativePath, baseline }) => ({
			relativePath,
			baseline: { ...baseline, repoRoot: path.join(repoRoot, relativePath) },
		})),
	};
}

async function captureRepoDeltaPatch(repoDir: string, rb: RepoBaseline, objectRepoDir = repoDir): Promise<string> {
	const repo = vcs.requireGit(repoDir);
	const objectRepo = objectRepoDir === repoDir ? repo : vcs.requireGit(objectRepoDir);
	const currentHead = (await repo.headSha()) ?? "";
	const currentStaged = await repo.diffText({ binary: true, cached: true });
	const currentUnstaged = await repo.diffText({ binary: true });
	const currentUntracked = await repo.lsFiles(true, true);
	const currentUntrackedPatch = await captureUntrackedPatch(repoDir, currentUntracked, repo);
	const committedPatch =
		currentHead && currentHead !== rb.headCommit
			? await diffTreeForCapture(repo, repoDir, rb.headCommit, currentHead)
			: "";

	const baselineTree = await writeSyntheticTree(objectRepoDir, rb.headCommit, [
		rb.staged,
		rb.unstaged,
		rb.untrackedPatch,
	]);
	const currentTree = await writeSyntheticTree(objectRepoDir, rb.headCommit, [
		committedPatch,
		currentStaged,
		currentUnstaged,
		currentUntrackedPatch,
	]);

	return diffTreeForCapture(objectRepo, repoDir, baselineTree, currentTree);
}

function unquoteGitDiffPath(rawPath: string): string {
	let value = rawPath;
	if (value.startsWith('"') && value.endsWith('"')) {
		try {
			value = JSON.parse(value) as string;
		} catch {
			value = value.slice(1, -1);
		}
	}
	return value.replace(/^[ab]\//, "");
}

function parseDiffGitLinePaths(line: string): string[] {
	if (!line.startsWith("diff --git ")) return [];
	const rest = line.slice("diff --git ".length);
	const quoted = rest.match(/^("(?:\\.|[^"])+"|\/dev\/null) ("(?:\\.|[^"])+"|\/dev\/null)$/);
	const parts = quoted ? [quoted[1], quoted[2]] : rest.split(" ");
	if (parts.length < 2) return [];
	const paths = parts
		.slice(0, 2)
		.map(unquoteGitDiffPath)
		.filter(file => file && file !== "/dev/null");
	return [...new Set(paths)];
}

function patchTouchedFiles(patch: string): string[] {
	const files = new Set<string>();
	for (const line of patch.split("\n")) {
		for (const file of parseDiffGitLinePaths(line)) files.add(file);
	}
	return [...files];
}

export interface DeltaPatchResult {
	rootPatch: string;
	nestedPatches: NestedRepoPatch[];
}

export async function captureDeltaPatch(isolationDir: string, baseline: WorktreeBaseline): Promise<DeltaPatchResult> {
	const rootPatch = await captureRepoDeltaPatch(isolationDir, baseline.root, baseline.root.repoRoot);
	const nestedPatches: NestedRepoPatch[] = [];

	for (const { relativePath, baseline: nb } of baseline.nested) {
		const nestedDir = path.join(isolationDir, relativePath);
		try {
			await fs.access(path.join(nestedDir, ".git"));
		} catch {
			continue;
		}
		// The isolation's own nested repo builds the synthetic trees: a submodule
		// there has a private admin over the source objects, so nothing is
		// written to the parent's admin, and the parent-side path (possibly
		// spelled through a symlink its relative gitfile cannot resolve from)
		// is never opened.
		const patch = await captureRepoDeltaPatch(nestedDir, nb);
		if (patch.trim()) nestedPatches.push({ relativePath, patch });
	}

	return { rootPatch, nestedPatches };
}

/**
 * Apply nested repo patches directly to their working directories after parent merge.
 *
 * Pre-existing dirty state in a nested repo is stashed before the patch is
 * applied and popped back (with `--index` so staged WIP stays staged) after
 * the commit, so unrelated user edits never get folded into the agent's
 * commit. A failing `git stash pop` (e.g. user edits collide with the patched
 * lines) leaves the stash entry intact, emits a `logger.warn`, and is
 * returned to the caller as a human-readable warning string — the agent
 * commit already landed, so this is a partial success the workflow needs to
 * see, not a thrown failure.
 *
 * Returns the collected stash-restore warnings (empty when every nested repo
 * was restored cleanly). Throws when the patch apply itself fails.
 *
 * @param commitMessage Optional async function to generate a commit message from the combined diff.
 *                      If omitted or returns null, falls back to a generic message.
 */
export async function applyNestedPatches(
	repoRoot: string,
	patches: NestedRepoPatch[],
	commitMessage?: (diff: string) => Promise<string | null>,
): Promise<string[]> {
	const warnings: string[] = [];
	// Group patches by target repo to apply all at once and commit
	const byRepo = new Map<string, NestedRepoPatch[]>();
	for (const p of patches) {
		if (!p.patch.trim()) continue;
		const group = byRepo.get(p.relativePath) ?? [];
		group.push(p);
		byRepo.set(p.relativePath, group);
	}

	for (const [relativePath, repoPatches] of byRepo) {
		const nestedDir = path.join(repoRoot, relativePath);
		try {
			await fs.access(path.join(nestedDir, ".git"));
		} catch {
			continue;
		}
		const repository = vcs.requireGit(nestedDir);

		const combinedDiff = repoPatches.map(p => p.patch).join("\n");
		const touchedFiles = [...new Set(repoPatches.flatMap(p => patchTouchedFiles(p.patch)))];

		// Preserve any pre-existing dirty state (tracked + untracked) so we
		// commit only the agent delta, not the user's in-flight work.
		const stashed = (await repository.isDirty())
			? await repository.stashPush(`omp-isolation-${Snowflake.next()}`)
			: false;
		try {
			for (const { patch } of repoPatches) {
				await repository.applyPatch(patch, {});
			}
			if (await repository.isDirty()) {
				if (touchedFiles.length === 0) {
					throw new Error(`Nested repo patch for ${relativePath} did not include stageable file paths.`);
				}
				const msg = (await commitMessage?.(combinedDiff)) ?? "changes from isolated task(s)";
				await repository.stageFiles(touchedFiles);
				await repository.commitCreate(msg, {});
			}
		} finally {
			if (stashed) {
				const restored = await repository.stashTryPop(true).catch(() => false);
				if (!restored) {
					logger.warn("Pre-existing nested-repo dirty state could not be auto-restored", {
						nestedDir,
					});
					warnings.push(
						`Pre-existing dirty state in nested repo \`${relativePath}\` could not be auto-restored after the agent commit; stash entry preserved.`,
					);
				}
			}
		}
	}
	return warnings;
}

// ═══════════════════════════════════════════════════════════════════════════
// Unified isolation lifecycle — picks the best backend via the PAL and
// returns the merged-view path together with the resolved kind.
// ═══════════════════════════════════════════════════════════════════════════

/** User-facing backend names exposed by the `isolation.backend` setting. */
export type IsolationBackendSetting = SettingValueOf<typeof cfgIsolationBackend>;

/**
 * Translate an {@link IsolationBackendSetting} to the native backend hint.
 * `"auto"` returns `undefined`, allowing the PAL resolver to pick.
 */
export function parseIsolationBackend(backend: IsolationBackendSetting): IsoBackendKind | undefined {
	switch (backend) {
		case "auto":
			return undefined;
		case "apfs":
			return IsoBackendKind.Apfs;
		case "btrfs":
			return IsoBackendKind.Btrfs;
		case "zfs":
			return IsoBackendKind.Zfs;
		case "reflink":
			return IsoBackendKind.LinuxReflink;
		case "overlayfs":
			return IsoBackendKind.Overlayfs;
		case "projfs":
			return IsoBackendKind.Projfs;
		case "block-clone":
			return IsoBackendKind.WindowsBlockClone;
		case "rcopy":
			return IsoBackendKind.Rcopy;
	}
}

/** Return the canonical setting label for a resolved native backend. */
export function formatIsolationBackend(backend: IsoBackendKind): Exclude<IsolationBackendSetting, "auto"> {
	switch (backend) {
		case IsoBackendKind.Apfs:
			return "apfs";
		case IsoBackendKind.Btrfs:
			return "btrfs";
		case IsoBackendKind.Zfs:
			return "zfs";
		case IsoBackendKind.LinuxReflink:
			return "reflink";
		case IsoBackendKind.Overlayfs:
			return "overlayfs";
		case IsoBackendKind.Projfs:
			return "projfs";
		case IsoBackendKind.WindowsBlockClone:
			return "block-clone";
		case IsoBackendKind.Rcopy:
			return "rcopy";
	}
}

/**
 * Initialized submodules in the source checkout, listed recursively as paths
 * relative to `sourceRoot` (`[]` when there are none or the lookup fails).
 *
 * Clone-first worktree creation copies the source checkout verbatim, including
 * every initialized submodule's `.git` gitfile. From a main checkout the copy
 * reads `gitdir: ../.git/modules/<name>`, which dangles because the new
 * tree's `.git` is a file; from a linked worktree it points into the source
 * tree's module dir, so the new tree shares submodule state with the source.
 * When this list is non-empty the caller must pass `clone: false` to
 * `worktreeAdd` and populate the new tree with {@link initWorktreeSubmodules}
 * instead.
 */
export async function initializedWorktreeSubmodules(sourceRoot: string): Promise<string[]> {
	try {
		return await vcs.requireGit(sourceRoot).submodulePaths();
	} catch {
		return [];
	}
}

/** Outcome of {@link initWorktreeSubmodules}. */
export interface WorktreeSubmoduleInit {
	/** Initialized paths, parents before children. */
	initialized: string[];
	/**
	 * Source-initialized paths with no gitlink at the target commit (removed
	 * or renamed on the checked-out ref, or under such a path); left empty.
	 */
	skipped: string[];
}

/**
 * Populate the submodules a plain (non-cloned) worktree left empty, giving
 * each its own module dir under the new tree's admin. Call with the exact
 * list from {@link initializedWorktreeSubmodules} so only submodules the
 * source had initialized are fetched.
 *
 * Initialization runs level by level, parents before children: `git submodule
 * update` only accepts paths known to the checkout it runs in, so a nested
 * path is initialized from inside its freshly initialized parent, never as a
 * nested pathspec from the root (git aborts the whole command on those).
 * Paths with no gitlink at the target commit are skipped and reported in
 * {@link WorktreeSubmoduleInit.skipped} instead of aborting the rest. Genuine
 * failures throw with git's stderr; callers downgrade to a warning because
 * the tree itself is a valid plain checkout either way.
 */
export async function initWorktreeSubmodules(
	worktreePath: string,
	submodules: string[],
): Promise<WorktreeSubmoduleInit> {
	const result: WorktreeSubmoduleInit = { initialized: [], skipped: [] };
	const byDepth = [...submodules].sort((a, b) => a.split("/").length - b.split("/").length);
	for (const relative of byDepth) {
		const slash = relative.lastIndexOf("/");
		const parent = slash < 0 ? "" : relative.slice(0, slash);
		const base = slash < 0 ? relative : relative.slice(slash + 1);
		if (parent !== "" && result.skipped.includes(parent)) {
			result.skipped.push(relative);
			continue;
		}
		const parentAbs = parent === "" ? worktreePath : path.join(worktreePath, parent);
		if (!(await isSubmoduleGitlink(parentAbs, base))) {
			result.skipped.push(relative);
			continue;
		}
		await runSubmoduleUpdate(parentAbs, base, relative);
		result.initialized.push(relative);
	}
	return result;
}

/**
 * A source submodule whose state a plain checkout plus pin initialization
 * cannot carry into a new tree.
 */
export interface SubmoduleNotCarried {
	/** Path relative to the source root. */
	path: string;
	/** Why it was not carried, e.g. "uncommitted changes" or "local commits not carried". */
	reason: string;
}

/**
 * Source-initialized submodules the new tree cannot reproduce: a plain
 * checkout followed by pin initialization resets every submodule to its
 * recorded pin, so a submodule is reported when its worktree, index, or
 * untracked files are dirty, or when its HEAD differs from the gitlink
 * recorded in the superproject's index or HEAD (a new local commit, a staged
 * pin move, or a checkout of another commit) — at any depth. Paths the check
 * cannot assess are reported too, so callers treat unverifiable state as not
 * carried rather than cleaning it away.
 */
export async function dirtyWorktreeSubmodules(
	sourceRoot: string,
	submodules: string[],
): Promise<SubmoduleNotCarried[]> {
	const notCarried: SubmoduleNotCarried[] = [];
	for (const relative of submodules) {
		const reason = await submoduleCarryBlocker(sourceRoot, relative);
		if (reason !== undefined) notCarried.push({ path: relative, reason });
	}
	return notCarried;
}

/** Why the source submodule at `relative` cannot be carried, or undefined when it can. */
async function submoduleCarryBlocker(sourceRoot: string, relative: string): Promise<string | undefined> {
	const slash = relative.lastIndexOf("/");
	const parentAbs = slash < 0 ? sourceRoot : path.join(sourceRoot, relative.slice(0, slash));
	const base = slash < 0 ? relative : relative.slice(slash + 1);
	const subAbs = path.join(sourceRoot, relative);
	let dirty: boolean;
	try {
		dirty = (await vcs.requireGit(subAbs).statusPorcelain({ untracked: "all" })).trim() !== "";
	} catch {
		return "could not assess state";
	}
	const subHead = await runGitLine(subAbs, ["rev-parse", "HEAD"]);
	const indexLine = await runGitLine(parentAbs, ["ls-files", "-s", "--", base]);
	const headLine = await runGitLine(parentAbs, ["ls-tree", "HEAD", "--", base]);
	const indexPin = indexLine
		?.split("\n")
		.find(line => line.startsWith("160000 "))
		?.split(/\s+/)[1];
	const headPin = headLine === undefined ? undefined : /^160000 commit ([0-9a-f]+)\t/.exec(headLine)?.[1];
	if (subHead === undefined || indexPin === undefined || !/^[0-9a-f]+$/.test(indexPin) || headPin === undefined) {
		return "could not assess state";
	}
	const reasons: string[] = [];
	if (dirty) reasons.push("uncommitted changes");
	if (subHead !== indexPin || subHead !== headPin) reasons.push("local commits not carried");
	return reasons.length > 0 ? reasons.join(" and ") : undefined;
}

/** First stdout line of a git command in `dir`, or undefined when git fails. */
async function runGitLine(dir: string, args: string[]): Promise<string | undefined> {
	const proc = Bun.spawn(["git", ...args], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	await new Response(proc.stderr).text();
	if ((exitCode ?? 0) !== 0) return undefined;
	return stdout.trim();
}

/** True when the checkout at `dir` registers `base` as a gitlink in its index. */
async function isSubmoduleGitlink(dir: string, base: string): Promise<boolean> {
	const proc = Bun.spawn(["git", "ls-files", "-s", "--", base], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	await new Response(proc.stderr).text();
	if ((exitCode ?? 0) !== 0) return false;
	return stdout.split("\n").some(line => line.startsWith("160000 "));
}

async function runSubmoduleUpdate(dir: string, base: string, relative: string): Promise<void> {
	// Submodule URLs are often local paths (absolute or `../relative`); git
	// refuses the `file` transport for submodule clones unless it is
	// explicitly allowed, and repo config is not honored here, so allow it on
	// the command line. The user already trusts these URLs: the same pins
	// are initialized in the source checkout.
	const proc = Bun.spawn(["git", "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--", base], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	await new Response(proc.stdout).text();
	if ((exitCode ?? 0) !== 0) {
		throw new Error(
			`git submodule update --init -- ${relative} failed: ${stderr.trim() || `exit code ${exitCode ?? 0}`}`,
		);
	}
}

export interface IsolationHandle {
	/** Merged view materialised by the backend; pass this to the task. */
	mergedDir: string;
	/** Backend the PAL actually used. */
	backend: IsoBackendKind;
	/** True when the resolver downgraded from `preferred` to `backend`. */
	fellBack: boolean;
	/** Optional reason associated with `fellBack`. */
	fallbackReason: string | null;
}

/**
 * Materialise `merged` for a single task. `preferred` is a hint — when
 * its prerequisites are missing the PAL silently falls back, and the
 * caller learns about that through `IsolationHandle.fellBack` +
 * `fallbackReason`.
 */

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function getTaskIsolationSegment(repoRoot: string, id: string): string {
	const key = `${path.resolve(repoRoot)}\0${id}`;
	const digest = Bun.hash(key).toString(16).padStart(16, "0").slice(-TASK_ISOLATION_DIR_DIGEST_CHARS);
	return `${TASK_ISOLATION_DIR_PREFIX}${digest}`;
}

/**
 * Re-anchor a copied relative gitfile on the source checkout, the directory
 * git resolved it from. Git joins a relative `gitdir:` to the gitfile's own
 * directory and lets the OS walk `..` physically, so both roots are
 * realpath'd first. A pointer that already resolves from the isolation (rcopy's
 * `git worktree add` under `worktree.useRelativePaths`), an absolute gitfile
 * and a `.git` directory are left alone.
 */
async function anchorCopiedGitfile(repoRoot: string, mergedDir: string): Promise<void> {
	const gitEntry = path.join(mergedDir, ".git");
	const stat = await fs.lstat(gitEntry).catch((err: NodeJS.ErrnoException) => {
		if (err.code === "ENOENT") return null;
		throw err;
	});
	if (!stat?.isFile()) return;
	const match = /^gitdir:[ \t]*(.+?)\s*$/.exec((await fs.readFile(gitEntry, "utf8")).split("\n", 1)[0] ?? "");
	if (!match || path.isAbsolute(match[1]!)) return;
	if (await isGitDir(path.resolve(await fs.realpath(mergedDir), match[1]!))) return;
	await fs.writeFile(gitEntry, `gitdir: ${path.resolve(await fs.realpath(repoRoot), match[1]!)}\n`);
}

/** Git's own test for a usable admin directory: a `HEAD` file inside it. */
async function isGitDir(dir: string): Promise<boolean> {
	return fs.stat(path.join(dir, "HEAD")).then(
		stat => stat.isFile(),
		() => false,
	);
}

/**
 * Sever one copied repository from its source metadata. Copy backends
 * duplicate `.git` verbatim — a linked-worktree pointer file (or the rcopy
 * `git worktree add` registration) leaves the copy sharing the source's
 * HEAD/index/ref namespace, so a task's git operations would mutate the
 * source checkout and stack parallel task branches. Detaching gives the copy
 * a private, frozen repo that still borrows the source object DB via
 * alternates.
 */
async function detachCopiedRepo(sourceRoot: string, copyRoot: string, sourceCommonDir: string): Promise<void> {
	// A checkout that is itself a submodule carries a relative gitfile
	// (`gitdir: ../.git/modules/<name>`) that resolves only from the source's
	// location; copied verbatim it points at nothing.
	await anchorCopiedGitfile(sourceRoot, copyRoot);
	const detached = await vcs.detachGitDir(copyRoot, sourceCommonDir);
	// A detached copy was a linked worktree whose submodule gitfiles point into
	// the source's `worktrees/<name>/modules`, now at a new relative depth.
	// Every initialized child needs private metadata before the native baseline
	// walks gitlinks or an agent runs. An "independent" copy already carries
	// its own `.git/modules`, which its gitfiles reach.
	if (detached !== "detached") return;
	try {
		await vcs.rebindCopiedSubmodules(sourceRoot, copyRoot);
	} catch (error) {
		// An off-pin source submodule (e.g. after a nested merge-back commit)
		// refuses the batch rebind but still mirrors the source faithfully,
		// so each copied submodule gets private metadata individually. Any
		// other rebind failure (unmerged gitlink, symlinked path, corrupt
		// admin) stays loud.
		const offPin =
			vcs.isVcsError(error) &&
			(error.message.includes("off-pin submodule") ||
				(error.stderr ? error.stderr.includes("off-pin submodule") : false));
		if (!offPin) throw error;
		await detachOffPinSubmodules(sourceRoot, copyRoot);
	}
}

/**
 * Whether the git admin reached through `dotGitPath` (a `.git` entry inside
 * the isolated copy rooted at `copyRoot`) can let git writes escape the
 * copy. Every entry kind resolves to one effective admin directory:
 * - a real directory is the admin itself;
 * - a symlink is fully resolved first, then judged by what it points at (a
 *   directory is the admin; a file is parsed as a gitfile, below);
 * - a gitfile's `gitdir:` target is resolved like git resolves it (an
 *   absolute target stands alone, a relative one joins the gitfile's own
 *   directory), following one chained file pointer when the target is
 *   itself a file.
 * The admin escapes when its realpath lies outside the copy, or when its
 * `commondir` file (resolved relative to the admin when relative, as git
 * writes it) realpaths outside the copy: a directory admin with such a
 * pointer shares HEAD/refs with the source, so `git checkout -b` in the
 * copy writes the source. A missing `commondir` means the admin is its own
 * common dir and is private when contained. Anything unresolvable,
 * unparseable, or of an unrecognized kind escapes (fail closed).
 * `objects/info/alternates` is deliberately NOT judged here: a detached
 * private admin borrows source objects through alternates read-only, and
 * that borrowing must keep passing.
 *
 * Scope: this guards the layouts git itself creates for submodules (gitfiles,
 * absorbed module dirs, linked worktrees, legacy in-tree `.git` dirs) plus
 * `commondir` pointers. It is not a sandbox against git metadata planted by
 * hand to reach outside the checkout, such as symlinked `refs/` or `objects/`
 * inside an admin, or admins outside submodule paths or under node_modules;
 * that hardening belongs with committed out-of-tree symlinks in the
 * isolation copy as a whole.
 */
export async function gitAdminEscapes(copyRoot: string, dotGitPath: string): Promise<boolean> {
	let realCopyRoot: string;
	try {
		realCopyRoot = await fs.realpath(copyRoot);
	} catch {
		return true;
	}
	const underCopy = (realPath: string): boolean =>
		realPath === realCopyRoot || realPath.startsWith(`${realCopyRoot}${path.sep}`);
	const parseGitdirTarget = (firstLine: string): string | null => {
		const match = /^gitdir:[ \t]*(.+?)\s*$/.exec(firstLine);
		return match ? match[1]! : null;
	};
	// Resolve one gitfile's content to the admin directory it names.
	const resolveGitfile = async (gitfileRealPath: string): Promise<string | null> => {
		let current = gitfileRealPath;
		for (let depth = 0; depth < 2; depth++) {
			const content = await fs.readFile(current, "utf8").catch(() => null);
			if (content === null) return null;
			const rawTarget = parseGitdirTarget(content.split("\n", 1)[0] ?? "");
			if (rawTarget === null) return null;
			const target = path.isAbsolute(rawTarget) ? rawTarget : path.join(path.dirname(current), rawTarget);
			const realTarget = await fs.realpath(target).catch(() => null);
			if (realTarget === null) return null;
			const targetStat = await fs.stat(realTarget).catch(() => null);
			if (targetStat === null) return null;
			if (targetStat.isDirectory()) return realTarget;
			if (!targetStat.isFile()) return null;
			current = realTarget;
		}
		return null;
	};
	const stat = await fs.lstat(dotGitPath).catch(() => null);
	if (stat === null) return false;
	let gitDir: string | null = null;
	if (stat.isSymbolicLink()) {
		const real = await fs.realpath(dotGitPath).catch(() => null);
		if (real === null) return true;
		const realStat = await fs.stat(real).catch(() => null);
		if (realStat === null) return true;
		if (realStat.isDirectory()) gitDir = real;
		else if (realStat.isFile()) gitDir = await resolveGitfile(real);
		else return true;
	} else if (stat.isDirectory()) {
		gitDir = await fs.realpath(dotGitPath).catch(() => null);
	} else if (stat.isFile()) {
		gitDir = await resolveGitfile(dotGitPath);
	} else {
		return true;
	}
	if (gitDir === null || !underCopy(gitDir)) return true;
	const commonRaw = await fs.readFile(path.join(gitDir, "commondir"), "utf8").catch(() => null);
	if (commonRaw === null) return false;
	const trimmed = commonRaw.trim();
	if (trimmed === "") return true;
	const commonAbs = path.isAbsolute(trimmed) ? trimmed : path.join(gitDir, trimmed);
	const realCommon = await fs.realpath(commonAbs).catch(() => null);
	if (realCommon === null) return true;
	return !underCopy(realCommon);
}

/**
 * Give every initialized submodule in a copied isolation private metadata one
 * at a time, after the batch rebind refused an off-pin layout.
 *
 * The batch rebind snapshots the source admins and refuses to proceed when
 * any source submodule HEAD differs from its recorded pin. The verbatim copy
 * is still a faithful mirror of the source, so each copied submodule is
 * repaired individually instead: its stale gitfile (which points into the
 * source checkout's module dir) is re-pointed at the source submodule's own
 * admin — read, never written — and {@link vcs.detachGitDir} snapshots that
 * live state (HEAD, index, refs) into a private admin that borrows the source
 * objects through alternates. Repair failures throw and fail the isolation:
 * nothing is left half-repaired. Entries that need no repair are left alone —
 * a missing admin (uninitialized in the copy), an already-private admin, an
 * exotic entry git cannot use, or a source entry that is not itself a
 * repository — and the fail-closed hand-out gate after every detach pass
 * refuses anything still shared.
 */
async function detachOffPinSubmodules(sourceRoot: string, copyRoot: string): Promise<void> {
	const [realSourceRoot, realCopyRoot] = await Promise.all([fs.realpath(sourceRoot), fs.realpath(copyRoot)]);
	const relativePaths = await vcs.requireGit(sourceRoot).submodulePaths();
	// Deepest first, mirroring the native rebind order.
	relativePaths.sort((a, b) => b.split("/").length - a.split("/").length || (a < b ? -1 : a > b ? 1 : 0));
	for (const relativePath of relativePaths) {
		const sourceSub = path.join(realSourceRoot, relativePath);
		const copySub = path.join(realCopyRoot, relativePath);
		const copyGitStat = await fs.lstat(path.join(copySub, ".git")).catch((err: NodeJS.ErrnoException) => {
			if (err.code === "ENOENT") return null;
			throw err;
		});
		// Judge every entry kind with the shared predicate: a directory
		// admin (or a symlink to an in-copy directory) whose `commondir`
		// points at the source admin shares HEAD/refs with the source, so
		// it needs the same re-point-and-detach repair as a stale gitfile.
		// A missing entry means uninitialized in the copy. An exotic entry
		// (fifo, socket) escapes by predicate but git cannot use it, so it
		// is left for the verification below to fail closed on.
		if (!copyGitStat) continue;
		if (!copyGitStat.isDirectory() && !copyGitStat.isSymbolicLink() && !copyGitStat.isFile()) continue;
		let escapes = true;
		try {
			escapes = await gitAdminEscapes(realCopyRoot, path.join(copySub, ".git"));
		} catch {
			escapes = true;
		}
		if (!escapes) continue;
		// Never follow the copy's stale pointer: open the source submodule
		// directly (read-only) for its admin dirs. A source entry that is not
		// itself a repository (e.g. a linked worktree nested inside the
		// checkout) is left for the nested-repo pass.
		let sourceAdmin: { gitDir: string; commonDir: string } | null = null;
		try {
			const info = vcs.requireGit(sourceSub).info();
			if ((await fs.realpath(info.repoRoot)) === (await fs.realpath(sourceSub))) {
				// Git joins a relative `gitdir:` to the gitfile's own
				// directory; mirror that so the re-pointed pointer below is
				// always absolute.
				sourceAdmin = {
					gitDir: path.isAbsolute(info.gitDir) ? info.gitDir : path.join(sourceSub, info.gitDir),
					commonDir: path.isAbsolute(info.commonDir) ? info.commonDir : path.join(sourceSub, info.commonDir),
				};
			}
		} catch {
			// Not itself a repository: left for the nested-repo pass.
		}
		if (sourceAdmin === null) continue;
		const gitEntry = path.join(copySub, ".git");
		if (copyGitStat.isSymbolicLink()) {
			// Remove the link itself (never its target): a writeFile here
			// would follow the link and land in the source admin.
			await fs.rm(gitEntry);
		} else if (copyGitStat.isDirectory()) {
			// An escaping directory admin lives inside the copy (the entry
			// itself), so removing it cannot touch the source; the shared
			// state it pointed at is re-snapshotted from the source admin
			// below, read-only.
			await fs.rm(gitEntry, { recursive: true, force: true });
		}
		// Re-point the copy's gitfile at the source submodule admin, then
		// detach: the snapshot reads the live state while the materialized
		// admin (HEAD, index, refs, alternates) belongs to the copy. The
		// back-pointer guard inside detachGitDir sees a foreign worktree
		// entry, so no source admin directory is ever removed.
		await fs.writeFile(gitEntry, `gitdir: ${sourceAdmin.gitDir}\n`);
		await vcs.detachGitDir(copySub, sourceAdmin.commonDir);
	}
}

/**
 * Fail closed when any copied submodule still shares the source checkout's
 * git metadata: handing out that copy would let task git operations mutate
 * the source. This runs once, on the final copy after every repair and
 * detach pass (submodule repair, then the nested-repo pass that privatizes
 * linked worktrees living inside submodules), so a nested pointer an
 * earlier pass had not reached yet never trips the gate. Writes through a
 * detached admin's alternates only read source objects, so private admins
 * pass. Every `.git` entry at every depth under each submodule path is
 * judged with {@link gitAdminEscapes} by lstat — independently of
 * `submodulePaths()`, which never names unlisted nested directory admins —
 * so a pointer no repair pass reached still blocks hand-out.
 * Admin-directory interiors are read only for `commondir`; the walk never
 * descends into a `.git` directory. Dependency trees are not repositories
 * by construction.
 */
async function verifyCopiedSubmodulesDetached(
	sourceRoot: string,
	realCopyRoot: string,
	relativePaths: readonly string[],
): Promise<void> {
	// One lockstep failure shape for every shared-metadata verdict below;
	// `throw` sites narrow afterwards, which a `never`-returning closure
	// does not reliably provide.
	const failure = (relativePath: string, detail: string): Error =>
		new Error(
			`Isolated copy of submodule "${relativePath}" still shares git metadata with ` +
				`${sourceRoot} (${detail.trim()}); refusing to hand out a checkout whose git ` +
				`operations could mutate the source.`,
		);
	// Human-readable pointer for the failure message; the verdict itself
	// comes from the shared predicate above.
	const describeEntry = async (dotGitPath: string): Promise<string> => {
		const stat = await fs.lstat(dotGitPath).catch(() => null);
		if (stat?.isSymbolicLink()) return fs.readlink(dotGitPath).catch(() => "<unreadable>");
		if (stat?.isDirectory()) {
			const real = await fs.realpath(dotGitPath).catch(() => null);
			const common =
				real === null ? null : await fs.readFile(path.join(real, "commondir"), "utf8").catch(() => null);
			return common === null ? "<unreadable>" : `commondir: ${common.trim()}`;
		}
		if (stat?.isFile()) return fs.readFile(dotGitPath, "utf8").catch(() => "<unreadable>");
		return "unrecognized .git entry kind";
	};
	for (const relativePath of relativePaths) {
		const copySub = path.join(realCopyRoot, relativePath);
		// Walk the copy below the submodule root for every `.git` entry,
		// including the submodule's own and any nested pointer the
		// submodule lists never mention.
		const stack = [copySub];
		while (stack.length > 0) {
			const dir = stack.pop()!;
			let entries;
			try {
				entries = await fs.readdir(dir, { withFileTypes: true });
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw err;
			}
			for (const entry of entries) {
				const full = path.join(dir, entry.name);
				if (entry.name === ".git") {
					const nestedRel = path.relative(realCopyRoot, full);
					let escapes = true;
					try {
						escapes = await gitAdminEscapes(realCopyRoot, full);
					} catch {
						escapes = true;
					}
					if (escapes) throw failure(nestedRel, await describeEntry(full));
					continue;
				}
				if (entry.isDirectory() && entry.name !== "node_modules") stack.push(full);
			}
		}
	}
}

/**
 * Detach every nested repository the copy reaches through a gitfile that is
 * not one of its submodules — typically a linked worktree kept inside the
 * checkout — so the copy never shares that tree's HEAD, index or refs.
 */
async function detachNestedGitfileRepos(repoRoot: string, mergedDir: string): Promise<void> {
	const submodules = new Set(await vcs.requireGit(repoRoot).submodulePaths());
	for (const relativePath of await discoverNestedRepos(repoRoot)) {
		if (submodules.has(relativePath)) continue;
		const copyRoot = path.join(mergedDir, relativePath);
		const stat = await fs.lstat(path.join(copyRoot, ".git")).catch((err: NodeJS.ErrnoException) => {
			if (err.code === "ENOENT") return null;
			throw err;
		});
		if (!stat?.isFile()) continue;
		const sourceRoot = path.join(repoRoot, relativePath);
		await detachCopiedRepo(sourceRoot, copyRoot, vcs.requireGit(sourceRoot).info().commonDir);
	}
}

export async function ensureIsolation(
	baseCwd: string,
	id: string,
	preferred?: IsoBackendKind,
): Promise<IsolationHandle> {
	const repoRoot = await getRepoRoot(baseCwd);
	const sourceCommonDir = vcs.requireGit(repoRoot).info().commonDir;
	const baseDir = getWorktreeDir(getTaskIsolationSegment(repoRoot, id));
	const mergedDir = path.join(baseDir, TASK_ISOLATION_MOUNT_DIR);
	const resolution = await natives.isoResolve(preferred ?? null);
	const candidates = resolution.candidates.length > 0 ? resolution.candidates : [resolution.kind];
	let fallbackReason = resolution.reason ?? null;

	for (const candidate of candidates) {
		await fs.rm(baseDir, { recursive: true, force: true });
		// Claim ownership before the backend materialises `m`. Backends only
		// create/replace `mergedDir` (and overlay upper/work), never the base
		// dir, so the marker survives `isoStart` — and a concurrent
		// `omp worktree clear` never sees this sandbox without a live owner,
		// even while a large clone is still in progress.
		await fs.mkdir(baseDir, { recursive: true });
		await writeIsolationOwner(baseDir, id);
		try {
			await natives.isoStart(candidate, repoRoot, mergedDir);
			await detachCopiedRepo(repoRoot, mergedDir, sourceCommonDir);
			await detachNestedGitfileRepos(repoRoot, mergedDir);
			// The one fail-closed hand-out gate, on the final copy: the
			// nested-repo pass above privatizes linked worktrees living
			// inside submodules, so judging only now never trips on a
			// pointer a later pass would still have detached. An
			// unresolvable copy root throws here and fails the isolation
			// rather than verifying vacuously.
			await verifyCopiedSubmodulesDetached(
				repoRoot,
				await fs.realpath(mergedDir),
				await vcs.requireGit(repoRoot).submodulePaths(),
			);
			return {
				mergedDir,
				backend: candidate,
				fellBack: candidate !== resolution.kind || resolution.fellBack,
				fallbackReason,
			};
		} catch (err) {
			await fs.rm(baseDir, { recursive: true, force: true });
			const message = errorMessage(err);
			if (!natives.isoIsUnavailableError(message)) {
				throw err;
			}
			fallbackReason ??= message;
		}
	}

	throw new Error(fallbackReason ?? "No isolation backend is available.");
}

/** Tear down a handle returned by {@link ensureIsolation}. */
export async function cleanupIsolation(handle: IsolationHandle): Promise<void> {
	try {
		try {
			await natives.isoStop(handle.backend, handle.mergedDir);
		} catch (err) {
			logger.warn("isolation backend stop failed during cleanup", {
				backend: handle.backend,
				mergedDir: handle.mergedDir,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	} finally {
		// baseDir is the parent of the merged directory
		const baseDir = path.dirname(handle.mergedDir);
		await fs.rm(baseDir, { recursive: true, force: true });
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Branch-mode isolation
// ═══════════════════════════════════════════════════════════════════════════

export interface CommitToBranchResult {
	branchName?: string;
	/** Root delta the branch was built from; lets callers detect whether a later capture changed anything. */
	rootPatch: string;
	nestedPatches: NestedRepoPatch[];
	/**
	 * SHA of the parent-repo commit the task branch was created on top of, so
	 * {@link mergeTaskBranches} can cherry-pick the range `baseSha..branchName`
	 * and preserve every agent commit's message and author.
	 */
	baseSha?: string;
}

function baselineHasRootWip(baseline: RepoBaseline): boolean {
	return !!(baseline.staged.trim() || baseline.unstaged.trim() || baseline.untrackedPatch.trim());
}

/**
 * Baseline WIP context needed to safely apply a delta patch whose hunks were
 * captured against `HEAD + WIP` (see {@link captureRepoDeltaPatch}). Passed
 * whenever {@link baselineHasRootWip} is true so {@link patchTree} can replay
 * the WIP first, then rewind WIP-only files after applying the delta.
 */
interface BaselineWipContext {
	readonly staged: string;
	readonly unstaged: string;
	readonly untrackedPatch: string;
}

function collectWipPatches(wip: BaselineWipContext | undefined): string[] {
	if (!wip) return [];
	return [wip.staged, wip.unstaged, wip.untrackedPatch].filter(p => p.trim());
}

/** Keep only the `diff --git` sections of `patch` that touch one of `files`. */
function filterPatchFiles(patch: string, files: ReadonlySet<string>): string {
	const sections = patch.split(/^(?=diff --git )/m);
	return sections.filter(section => parseDiffGitLinePaths(section.split("\n", 1)[0]).some(f => files.has(f))).join("");
}

/**
 * Resolve the tree `parentSha + patchText` in `repoDir` through a temporary
 * index — no checkout, so nothing lingers on disk if the process dies.
 *
 * Tries the two clean paths first; both yield an agent-only tree:
 *   1. Plain apply — works when the WIP context matches the parent.
 *   2. `--3way` — works when the WIP-side blob is tracked and in the ODB
 *      (captureDeltaPatch seeded it while writing the synthetic baseline
 *      tree); the 3-way merge subtracts the WIP.
 *
 * If both fail (untracked WIP files, staged-new WIP files, or overlap that
 * --3way can't resolve — see #4136), replay the WIP first so the delta's
 * context lines match, then rewind WIP-only files to the parent. Files touched
 * by BOTH WIP and delta keep their combined state; merge-back reconciles the
 * WIP side because the cherry-pick refuses to overwrite dirty paths.
 */
async function patchTree(
	repoDir: string,
	parentSha: string,
	taskId: string,
	patchText: string,
	baselineWip?: BaselineWipContext,
): Promise<string> {
	let plainErr: vcs.VcsError;
	try {
		return await writeSyntheticTree(repoDir, parentSha, [patchText]);
	} catch (err) {
		if (!vcs.isVcsError(err)) throw err;
		plainErr = err;
	}
	let threeWayErr: vcs.VcsError;
	try {
		return await writeSyntheticTree(repoDir, parentSha, [patchText], { threeWay: true });
	} catch (err) {
		if (!vcs.isVcsError(err)) throw err;
		threeWayErr = err;
	}
	const wipPatches = collectWipPatches(baselineWip);
	const logContext = {
		taskId,
		threeWayStderr: threeWayErr.stderr.slice(0, 2000),
		initialStderr: plainErr.stderr.slice(0, 2000),
		patchSize: patchText.length,
		patchHead: patchText.slice(0, 500),
	};
	if (wipPatches.length === 0) {
		logger.error("commitToBranch: git apply --3way failed", logContext);
		throw new Error(`git apply --3way failed for task ${taskId}: ${logContext.threeWayStderr}`);
	}
	try {
		const withWip = await writeSyntheticTree(repoDir, parentSha, wipPatches);
		const deltaFiles = new Set(patchTouchedFiles(patchText));
		const wipOnly = new Set(wipPatches.flatMap(patchTouchedFiles).filter(f => !deltaFiles.has(f)));
		// WIP-only files are untouched by the delta, so their post-delta state
		// is the WIP state; diffing it back to the parent rewinds them.
		const rewind =
			wipOnly.size > 0
				? filterPatchFiles(await diffTreeOrEmpty(vcs.requireGit(repoDir), withWip, parentSha), wipOnly)
				: "";
		return await writeSyntheticTree(repoDir, parentSha, [...wipPatches, patchText, rewind]);
	} catch (wipErr) {
		if (!vcs.isVcsError(wipErr)) throw wipErr;
		const stderr = wipErr.stderr.slice(0, 2000);
		logger.error("commitToBranch: git apply with baseline WIP failed", { ...logContext, stderr });
		throw new Error(`git apply with baseline WIP failed for task ${taskId}: ${stderr}`);
	}
}

/** Commit `parentSha + patchText` as a detached commit object; returns its sha. */
async function commitPatch(
	repoDir: string,
	parentSha: string,
	taskId: string,
	patchText: string,
	message: string,
	author?: VcsCommitAuthor,
	baselineWip?: BaselineWipContext,
): Promise<string> {
	const tree = await patchTree(repoDir, parentSha, taskId, patchText, baselineWip);
	return vcs.requireGit(repoDir).commitTree(tree, [parentSha], message, author);
}

interface FilteredAgentReplayOptions {
	baseline: WorktreeBaseline;
	commitMessage?: (diff: string) => Promise<string | null>;
	fallbackMessage: string;
	isolationDir: string;
	isolationHead: string;
	repoRoot: string;
	rootPatch: string;
	taskId: string;
}

/**
 * Rewrite each agent commit against the captured baseline WIP so user
 * staged/unstaged/untracked changes never enter the task history. Returns the
 * tip commit (the baseline sha when nothing survived filtering).
 */
async function replayFilteredAgentCommits(opts: FilteredAgentReplayOptions): Promise<string> {
	const baselineSha = opts.baseline.root.headCommit;
	const repo = vcs.requireGit(opts.repoRoot);
	const isolationRepo = vcs.requireGit(opts.isolationDir);
	const agentCommits = await isolationRepo.revListRange(baselineSha, opts.isolationHead);
	const baselineWip = [opts.baseline.root.staged, opts.baseline.root.unstaged, opts.baseline.root.untrackedPatch];
	// Seed the parent ODB with the dirty-side blobs needed by `git apply
	// --3way`. Isolation repositories can read parent objects, but the parent
	// cannot read objects created only inside isolation.
	await writeSyntheticTree(opts.repoRoot, baselineSha, baselineWip);
	const dirtyBaselineTree = await writeSyntheticTree(opts.isolationDir, baselineSha, baselineWip);
	let tip = baselineSha;
	let previousFilteredTree = baselineSha;

	for (const commitSha of agentCommits) {
		const taskStatePatch = await diffTreeOrEmpty(isolationRepo, dirtyBaselineTree, `${commitSha}^{tree}`);
		const currentFilteredTree = await writeSyntheticTree(opts.repoRoot, baselineSha, [taskStatePatch], {
			threeWay: true,
		});
		const commitPatchText = await diffTreeOrEmpty(repo, previousFilteredTree, currentFilteredTree);
		if (commitPatchText.trim()) {
			const details = await isolationRepo.commitDetails(commitSha);
			tip = await commitPatch(
				opts.repoRoot,
				tip,
				opts.taskId,
				commitPatchText,
				details.message || commitSha,
				details.author,
			);
		}
		previousFilteredTree = currentFilteredTree;
	}
	if (tip === baselineSha) {
		// No filtered commit landed. Synthesising `HEAD + rootPatch` fails
		// whenever rootPatch's WIP context can't be applied to a HEAD-only
		// index (untracked WIP + agent modifies, staged-new WIP + agent
		// modifies — see #4136), so collapse the isolation output onto a
		// single WIP-seeded commit, matching the no-agent-commit path. This
		// also covers an agent that committed only baseline WIP.
		if (!opts.rootPatch.trim()) return tip;
		const msg = (opts.commitMessage && (await opts.commitMessage(opts.rootPatch))) || opts.fallbackMessage;
		return commitPatch(opts.repoRoot, tip, opts.taskId, opts.rootPatch, msg, undefined, opts.baseline.root);
	}
	// Reconstruct the final HEAD-derived tree with the same dirty-side blobs
	// and 3-way synthesis used above; anything left is uncommitted work.
	const finalFilteredTree = await writeSyntheticTree(opts.repoRoot, baselineSha, [opts.rootPatch], {
		threeWay: true,
	});
	const leftoverPatch = await diffTreeOrEmpty(repo, previousFilteredTree, finalFilteredTree);
	if (!leftoverPatch.trim()) return tip;
	const msg = (opts.commitMessage && (await opts.commitMessage(leftoverPatch))) || opts.fallbackMessage;
	return commitPatch(opts.repoRoot, tip, opts.taskId, leftoverPatch, msg);
}

/**
 * Capture task-only changes from the isolation worktree onto a parent-repo
 * branch named `omp/task/${taskId}`. Only root-repo changes go on the branch;
 * nested-repo patches are returned separately because the parent git can't
 * track files inside gitlinks.
 *
 * Commits are built as detached objects through temporary indexes and the
 * branch ref is written once the whole chain exists, so no checkout is ever
 * materialised and a crash mid-capture leaves no branch or worktree behind.
 *
 * If the agent committed inside isolation (HEAD moved past
 * `baseline.root.headCommit`), clean-baseline runs fetch the raw commit range
 * into the parent repo and later cherry-pick `baseSha..branchName`, preserving
 * every message and author verbatim. Dirty-baseline runs rewrite each agent
 * commit against the captured baseline WIP before committing it to the task
 * branch, so user staged/unstaged/untracked changes present at isolation
 * start are not replayed into the parent commit history.
 *
 * If the agent did not commit, the captured delta is collapsed onto a single
 * branch commit with an AI-generated (or fallback) message.
 *
 * Returns `null` when no root or nested changes exist.
 */
export async function commitToBranch(
	isolationDir: string,
	baseline: WorktreeBaseline,
	taskId: string,
	description: string | undefined,
	commitMessage?: (diff: string) => Promise<string | null>,
): Promise<CommitToBranchResult | null> {
	const baselineSha = baseline.root.headCommit;
	const isolationRepo = vcs.requireGit(isolationDir);
	const isolationHead = (await isolationRepo.headSha()) ?? "";
	const agentCommitted = isolationHead !== "" && isolationHead !== baselineSha;

	const { rootPatch, nestedPatches } = await captureDeltaPatch(isolationDir, baseline);
	if (!rootPatch.trim() && nestedPatches.length === 0) return null;
	if (!rootPatch.trim()) return { rootPatch, nestedPatches };

	const repoRoot = baseline.root.repoRoot;
	const repo = vcs.requireGit(repoRoot);
	const branchName = `omp/task/${taskId}`;
	const fallbackMessage = description || taskId;

	let tip: string;
	if (agentCommitted && baselineHasRootWip(baseline.root)) {
		tip = await replayFilteredAgentCommits({
			baseline,
			commitMessage,
			fallbackMessage,
			isolationDir,
			isolationHead,
			repoRoot,
			rootPatch,
			taskId,
		});
	} else if (agentCommitted) {
		// Transfer the agent's commit objects (which live in isolation's `.git`,
		// stranded once `cleanupIsolation` tears the workspace down) into the
		// parent repo's object DB and create the branch at the agent's HEAD.
		// `+HEAD:…` force-overwrites a stale branch from a prior run.
		await repo.fetch(isolationDir, "HEAD", `refs/heads/${branchName}`, GIT_NETWORK_TIMEOUT_MS);
		tip = isolationHead;
		// Leftover = anything still uncommitted in isolation on top of the
		// agent's last commit (staged, unstaged, untracked). The agent didn't
		// commit it, so it goes in as one AI-summarized trailing commit.
		const leftoverPatch = await captureRepoDeltaPatch(isolationDir, {
			repoRoot: isolationDir,
			headCommit: isolationHead,
			staged: "",
			unstaged: "",
			untracked: [],
			untrackedPatch: "",
		});
		if (leftoverPatch.trim()) {
			const msg = (commitMessage && (await commitMessage(leftoverPatch))) || fallbackMessage;
			tip = await commitPatch(repoRoot, tip, taskId, leftoverPatch, msg);
		}
	} else {
		const msg = (commitMessage && (await commitMessage(rootPatch))) || fallbackMessage;
		const wip = baselineHasRootWip(baseline.root) ? baseline.root : undefined;
		tip = await commitPatch(repoRoot, baselineSha, taskId, rootPatch, msg, undefined, wip);
	}

	if (tip === baselineSha) return { rootPatch, baseSha: baselineSha, nestedPatches };
	await repo.createBranch(branchName, tip, true);
	return { branchName, baseSha: baselineSha, rootPatch, nestedPatches };
}

export interface MergeBranchResult {
	merged: string[];
	failed: string[];
	conflict?: string;
}

/**
 * Cherry-pick task branch commits sequentially onto HEAD. When `baseSha` is
 * provided the cherry-pick uses the inclusive range `baseSha..branchName`,
 * replaying every commit individually and preserving each commit's message
 * and author. When omitted, the branch is cherry-picked as a single commit
 * (legacy callers).
 *
 * The working tree is never stashed: each pick rewrites only the paths it
 * changes and is refused when one of them carries uncommitted edits, so
 * unrelated dirty files (and LFS checkouts) are left untouched.
 *
 * Stops on the first conflict and reports which branches succeeded.
 */
export async function mergeTaskBranches(
	repoRoot: string,
	branches: Array<{ branchName: string; taskId: string; description?: string; baseSha?: string }>,
): Promise<MergeBranchResult> {
	// Serialize against other in-process git mutations on this repo: concurrent
	// background merges would race on HEAD and the index.
	return withRepoLock(repoRoot, async () => {
		const repo = vcs.requireGit(repoRoot);
		const merged: string[] = [];
		for (const { branchName, baseSha } of branches) {
			try {
				const revisions = baseSha ? await repo.revListRange(baseSha, branchName) : [branchName];
				for (const revision of revisions) {
					try {
						await repo.cherryPick(revision);
					} catch (error) {
						if (!vcs.isEmptyCherryPick(error)) throw error;
					}
				}
			} catch (error) {
				const stderr = vcs.isVcsError(error)
					? error.stderr.trim()
					: error instanceof Error
						? error.message
						: String(error);
				return {
					merged,
					failed: branches.slice(merged.length).map(b => b.branchName),
					conflict: `${branchName}: ${stderr}`,
				};
			}
			merged.push(branchName);
		}
		return { merged, failed: [] };
	});
}

/** Clean up temporary task branches. */
export async function cleanupTaskBranches(repoRoot: string, branches: string[]): Promise<void> {
	const repo = vcs.requireGit(repoRoot);
	for (const branch of branches) {
		try {
			await repo.deleteBranch(branch, true);
		} catch {
			// Best-effort cleanup matches the old façade's tryDelete semantics.
		}
	}
}
