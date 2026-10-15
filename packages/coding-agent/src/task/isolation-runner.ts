/**
 * Reusable isolation lifecycle for subagent execution.
 *
 * Both `TaskTool` and the eval `agent()` bridge spawn subagents that can run
 * inside a copy-on-write worktree, capture their changes, and (optionally)
 * apply those changes back to the parent repo. The orchestration is identical
 * for both callers; this module hosts the shared lifecycle so eval `agent()`
 * does not need to round-trip through `TaskTool.#runSpawn`.
 *
 * Shape:
 *   1. {@link prepareIsolationContext} — resolve the git root.
 *   2. {@link runIsolatedSubprocess}    — start worktree, capture its
 *                                        baseline, run, capture changes, and
 *                                        transfer cleanup ownership.
 *   3. {@link mergeIsolatedChanges}     — apply captured changes back to the
 *                                        parent repo (skip when the caller
 *                                        opted out).
 *
 * Step 1 happens once per top-level call; steps 2 and 3 are per-spawn.
 */
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type * as natives from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { prompt } from "@oh-my-pi/pi-utils";
import isolationErrorTemplate from "../prompts/tools/isolation-error.md" with { type: "text" };
import isolationSummaryTemplate from "../prompts/tools/isolation-summary.md" with { type: "text" };
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry } from "../registry/agent-registry";
import type { ToolSession } from "../tools";
import { generateCommitMessage } from "../utils/commit-message-generator";
import { trackLateCleanup } from "../utils/late-cleanup";
import type { ExecutorOptions } from "./executor";
import { runSubprocess } from "./executor";
import { needsNativeTeardown, writeRetainedBackend } from "./isolation-ownership";
import type { NestedRepoPatch, SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import {
	applyNestedPatches,
	captureDeltaPatch,
	captureIsolationBaseline,
	cleanupIsolation,
	cleanupTaskBranches,
	type CommitToBranchResult,
	commitToBranch,
	ensureIsolation,
	getRepoRoot,
	type IsolationHandle,
	mergeTaskBranches,
	type WorktreeBaseline,
} from "./worktree";

import { cfgTaskIsolationCommits } from "./settings";

type IsoBackendKind = natives.IsoBackendKind;

/** Which isolation outcome `isolation-summary.md` should describe. */
export type IsolationSummaryKind =
	| "captured"
	| "capture-error"
	| "nested-apply-failed"
	| "not-applied"
	| "branch-merge-failed"
	| "branch-capture-failed"
	| "merge-error";

/** Context for `isolation-summary.md`; unused fields are simply absent. */
export interface IsolationSummaryContext {
	kind: IsolationSummaryKind;
	branchName?: string;
	/** Root patch path, only when it holds changes. */
	rootPatchPath?: string;
	nestedCount?: number;
	nestedPatchPaths?: string[];
	error?: string;
	conflict?: string;
}

/**
 * Render one isolation outcome as the model-facing suffix appended to a task
 * result. Always starts with a blank line so it separates from the output it
 * follows.
 */
export function renderIsolationSummary(context: IsolationSummaryContext): string {
	return `\n\n${prompt.render(isolationSummaryTemplate, { ...context })}`;
}

/** Record artifact locations for `agent://` and mark the result as an isolated run. */
function rememberAgentArtifacts(result: SingleResult): SingleResult {
	AgentRegistry.global().setHistory(result.id, {
		outputPath: result.outputPath,
		patchPath: result.patchPath,
		branchName: result.branchName,
		nestedPatchPaths: result.nestedPatchPaths,
	});
	return { ...result, isolated: true };
}

/**
 * Decide the fate of a half-built task branch after apply-back threw.
 *
 * Returns the branch name when it carries at least one commit past `baseSha`
 * — the caller must keep it, because the isolation worktree that also held
 * those objects is about to be torn down. Returns `undefined` after deleting
 * a branch that is absent, empty, or still pinned at the baseline, preserving
 * the original stale-branch cleanup for the cases where nothing is at stake.
 *
 * `revList.range` throws when the branch does not exist, which is the common
 * "commitToBranch failed before it created anything" path; that is treated as
 * "nothing to rescue" only after confirming the ref is absent. Other probe
 * failures preserve the branch because deleting it could lose the only reachable
 * copy of the agent's commits.
 */
async function rescueTaskBranch(repoRoot: string, branchName: string, baseSha: string): Promise<string | undefined> {
	const repo = vcs.git(repoRoot);
	try {
		const carriedCommits = (await vcs.requireGit(repoRoot).revListRange(baseSha, branchName)).length;
		if (carriedCommits > 0) return branchName;
	} catch {
		try {
			if (await repo?.refExists(`refs/heads/${branchName}`)) return branchName;
		} catch {
			// An inconclusive recovery probe must never risk deleting the only ref.
			return branchName;
		}
	}
	try {
		await repo?.deleteBranch(branchName, true);
	} catch {
		// Best-effort cleanup matches the old façade's tryDelete semantics.
	}
	return undefined;
}

/** Resolved repo shared by every isolated spawn in a single call. */
export interface IsolationContext {
	repoRoot: string;
	/**
	 * `repoRoot`-relative start directory for the child (`""` at the root).
	 * Set when the task named a subdirectory via `cwd`; the child runs in the
	 * matching subdirectory of the isolation copy.
	 */
	workdirOffset?: string;
	/**
	 * Canonical child start directory in the parent checkout (realpath of the
	 * requested `cwd`, or the caller cwd when absent). Merge-back re-resolves
	 * it and refuses to write anywhere but {@link IsolationContext.repoRoot}.
	 */
	childCwd?: string;
}

/** Canonical child checkout selected by a task `cwd` override. */
export interface ResolvedTaskCwd {
	/** Git root the child is isolated from and merged back into. */
	repoRoot: string;
	/** Canonical child start directory (realpath of the requested `cwd`, or the caller cwd when absent). */
	childCwd: string;
	/** `repoRoot`-relative offset of `childCwd` (`""` at the root). */
	workdirOffset: string;
}

function taskCwdError(requested: string, reason: string): Error {
	return new Error(`Invalid task "cwd" ${JSON.stringify(requested)}: ${reason}.`);
}

/**
 * Police symlinks along the requested path: every link at or below the repo
 * root must resolve inside that root. Ancestors above the root (e.g. macOS
 * `/tmp` → `/private/tmp`) are the caller's checkout alias and are ignored —
 * the walk follows them so a link hidden behind such an alias is still
 * checked against the canonical root.
 */
async function assertNoRepoEscape(requested: string, repoRoot: string): Promise<void> {
	const parts = path.relative(path.parse(requested).root, requested).split(path.sep).filter(Boolean);
	let resolved = path.parse(requested).root;
	for (const part of parts) {
		const prefix = path.join(resolved, part);
		let stat: Stats;
		try {
			stat = await fs.lstat(prefix);
		} catch {
			return;
		}
		if (stat.isSymbolicLink()) {
			const target = await fs.readlink(prefix);
			const absoluteTarget = path.resolve(path.dirname(prefix), target);
			const prefixInside = prefix === repoRoot || !path.relative(repoRoot, prefix).startsWith("..");
			if (prefixInside) {
				let targetReal = absoluteTarget;
				try {
					targetReal = await fs.realpath(absoluteTarget);
				} catch {}
				if (targetReal !== repoRoot && path.relative(repoRoot, targetReal).startsWith("..")) {
					throw taskCwdError(
						requested,
						`resolves through a symlink (${prefix} -> ${target}) that points outside its git repository ${JSON.stringify(repoRoot)}; pass the canonical path inside the target checkout instead`,
					);
				}
			}
			resolved = absoluteTarget;
		} else {
			resolved = prefix;
		}
	}
}

/**
 * Find the checkout root the caller lexically named: the deepest ancestor of
 * `normalized` (itself included) that is a real directory containing a `.git`
 * file or directory. Ancestors are probed with `lstat`, so a symlink never
 * counts as a checkout root even though the OS resolves it when probing for
 * `.git` — `<target>/leak`, pointing at another repo, is skipped and the walk
 * climbs to `<target>`. Symlinks strictly above the checkout root (e.g. macOS
 * `/tmp` → `/private/tmp`) survive: they resolve to the real checkout dir,
 * which still carries `.git`. Returns `undefined` when no ancestor qualifies
 * (e.g. the whole checkout is named through a symlinked alias); callers then
 * fall back to the resolved-root checks.
 */
async function findLexicalCheckoutRoot(normalized: string): Promise<string | undefined> {
	let dir: string | undefined = normalized;
	while (dir !== undefined) {
		let stat: Stats | undefined;
		try {
			stat = await fs.lstat(dir);
		} catch {
			stat = undefined;
		}
		if (stat !== undefined && stat.isDirectory()) {
			try {
				await fs.lstat(path.join(dir, ".git"));
				return dir;
			} catch {
				// No checkout marker here; keep climbing.
			}
		}
		const parent = path.dirname(dir);
		dir = parent === dir ? undefined : parent;
	}
	return undefined;
}

/**
 * Refuse a `cwd` that reaches another repo through a symlink at or below the
 * lexically named checkout root. `<target>/leak/sub` with `<target>/leak` →
 * caller resolves into the caller repo, so the resolved-root checks alone
 * accept it and the patch would merge into the caller. The lexical root here
 * is `<target>` (a symlink is never a checkout root), whose realpath
 * disagrees with the git root of the resolved path — and the `leak` component
 * itself resolves outside the named checkout. Either condition refuses the
 * path. Links inside the checkout that stay inside (e.g. `link` → `sub`) and
 * aliases above the root keep working.
 */
async function assertLexicalCheckoutAgreement(normalized: string, repoRoot: string): Promise<void> {
	const lexicalRoot = await findLexicalCheckoutRoot(normalized);
	if (lexicalRoot === undefined) return;
	const lexicalReal = await fs.realpath(lexicalRoot);
	if (lexicalReal !== repoRoot) {
		throw taskCwdError(
			normalized,
			`names checkout ${JSON.stringify(lexicalRoot)} but resolves into a different git repository ${JSON.stringify(repoRoot)} through a symlink that points outside its git repository; pass the canonical path inside the target checkout instead`,
		);
	}
	const rel = path.relative(lexicalRoot, normalized);
	if (rel === "") return;
	let cursor = lexicalRoot;
	for (const part of rel.split(path.sep).filter(Boolean)) {
		cursor = path.join(cursor, part);
		let stat: Stats;
		try {
			stat = await fs.lstat(cursor);
		} catch {
			return;
		}
		if (!stat.isSymbolicLink()) continue;
		const target = await fs.readlink(cursor);
		const absoluteTarget = path.resolve(path.dirname(cursor), target);
		let targetReal = absoluteTarget;
		try {
			targetReal = await fs.realpath(absoluteTarget);
		} catch {}
		if (targetReal !== lexicalReal && path.relative(lexicalReal, targetReal).startsWith("..")) {
			throw taskCwdError(
				normalized,
				`resolves through a symlink (${cursor} -> ${target}) that points outside its git repository ${JSON.stringify(lexicalReal)}; pass the canonical path inside the target checkout instead`,
			);
		}
	}
}

/**
 * Refuse a path whose lexical checkout disagrees with its resolved repo: the
 * caller named a path inside one checkout but it resolves into another
 * through a symlink. `getRepoRoot` discovers lexically (a `<link>/.git`
 * probe follows the link), so a canonical mismatch against the resolved root
 * exposes the hop. When the requested path itself is a link into the repo,
 * the tree naming the link must be that same repo.
 */
async function assertSameRepoThroughLexicalTree(normalized: string, repoRoot: string): Promise<void> {
	let lexicalRoot: string;
	try {
		lexicalRoot = await getRepoRoot(normalized);
	} catch {
		// No checkout names this path lexically; the resolved root governs.
		return;
	}
	const lexicalCanonical = await fs.realpath(lexicalRoot);
	if (lexicalCanonical !== repoRoot) {
		throw taskCwdError(
			normalized,
			`names ${JSON.stringify(lexicalRoot)} but resolves into a different git repository ${JSON.stringify(repoRoot)} through a symlink that points outside its git repository; pass the canonical path inside the target checkout instead`,
		);
	}
	if ((await fs.lstat(normalized)).isSymbolicLink()) {
		let parentRoot: string | undefined;
		try {
			parentRoot = await getRepoRoot(path.dirname(normalized));
		} catch {
			parentRoot = undefined;
		}
		if (parentRoot !== undefined) {
			const parentCanonical = await fs.realpath(parentRoot);
			if (parentCanonical !== repoRoot) {
				throw taskCwdError(
					normalized,
					`resolves through a symlink into ${JSON.stringify(repoRoot)} from a different checkout ${JSON.stringify(parentCanonical)} that points outside its git repository; pass the canonical path inside the target checkout instead`,
				);
			}
		}
	}
}

/**
 * Resolve the checkout a task `cwd` names. Absent (or empty) keeps the
 * caller cwd untouched. Present resolves to realpath and must exist, be a
 * directory, and sit inside a git work tree; a symlink hop that leaves the
 * named checkout — along the path or where the path itself is the link — is
 * refused. Fails closed before allocating any isolation or touching either
 * tree — no fallback to the caller cwd.
 */
export async function resolveTaskCwd(callerCwd: string, requestedCwd?: string): Promise<ResolvedTaskCwd> {
	if (requestedCwd === undefined || requestedCwd === "") {
		return { repoRoot: await getRepoRoot(callerCwd), childCwd: callerCwd, workdirOffset: "" };
	}
	if (typeof requestedCwd !== "string" || !path.isAbsolute(requestedCwd)) {
		throw taskCwdError(String(requestedCwd), "must be an absolute path");
	}
	const normalized = path.normalize(requestedCwd);
	let stat: Stats;
	try {
		stat = await fs.stat(normalized);
	} catch (error) {
		throw taskCwdError(
			requestedCwd,
			`path does not exist${error instanceof Error && error.message ? ` (${error.message})` : ""}`,
		);
	}
	if (!stat.isDirectory()) {
		throw taskCwdError(requestedCwd, "path is not a directory");
	}
	const real = await fs.realpath(normalized);
	let repoRoot: string;
	try {
		repoRoot = await getRepoRoot(real);
	} catch (error) {
		throw taskCwdError(
			requestedCwd,
			`not inside a git work tree${error instanceof Error && error.message ? `: ${error.message}` : ""}`,
		);
	}
	const offset = path.relative(repoRoot, real);
	if (offset === ".." || offset.startsWith(`..${path.sep}`) || path.isAbsolute(offset)) {
		throw taskCwdError(requestedCwd, `not inside a git work tree (resolved outside ${JSON.stringify(repoRoot)})`);
	}
	await assertNoRepoEscape(normalized, repoRoot);
	await assertSameRepoThroughLexicalTree(normalized, repoRoot);
	await assertLexicalCheckoutAgreement(normalized, repoRoot);
	return { repoRoot, childCwd: real, workdirOffset: offset === "" ? "" : offset };
}

/**
 * Resolve the git repo root isolated spawns are copied from and merged back
 * into. Without `requestedCwd` this is the caller cwd's repo (unchanged
 * behaviour); with it, the git root of that path, with the child starting in
 * the matching subdirectory of the isolation. Throws before allocating any
 * isolation when the path is unusable; callers surface the error as a
 * task-tool failure. Each spawn captures its own baseline from its isolation
 * copy (see {@link captureIsolationBaseline}).
 */
export async function prepareIsolationContext(callerCwd: string, requestedCwd?: string): Promise<IsolationContext> {
	const resolved = await resolveTaskCwd(callerCwd, requestedCwd);
	return {
		repoRoot: resolved.repoRoot,
		...(resolved.workdirOffset === "" ? {} : { workdirOffset: resolved.workdirOffset }),
		childCwd: resolved.childCwd,
	};
}

/** Fingerprint of a captured delta, used to skip re-committing an unchanged workspace on release. */
function deltaFingerprint(rootPatch: string, nestedPatches: readonly NestedRepoPatch[]): bigint | number {
	let key = rootPatch;
	for (const { relativePath, patch } of nestedPatches) key += `\0${relativePath}\0${patch}`;
	return Bun.hash(key);
}

/** Build a commit-message callback for branch/nested commits; `undefined` ⇒ fall back to generic message. */
export type BuildCommitMessage = () => undefined | ((diff: string) => Promise<string | null>);

/**
 * Construct the commit-message factory used by isolation branch commits and
 * nested-repo patch commits. Returns a closure that, each time it's called,
 * either yields an AI-backed `(diff) => Promise<string|null>` callback (when
 * `task.isolation.commits === "ai"` and a model registry is available) or
 * `undefined` so the caller falls back to a generic commit message.
 *
 * Centralized so `TaskTool` and the eval `agent()` bridge share one wiring;
 * a drift here previously meant the two callers built subtly different
 * generators for the same setting.
 */
export function makeIsolationCommitMessage(session: ToolSession): BuildCommitMessage {
	return () => {
		const style = cfgTaskIsolationCommits.get(session.settings);
		if (style !== "ai" || !session.modelRegistry) return undefined;
		const registry = session.modelRegistry;
		const settings = session.settings;
		const sessionId = session.getSessionId?.() ?? undefined;
		return async (diff: string) => generateCommitMessage(diff, registry, settings, sessionId);
	};
}

export interface IsolatedRunOptions {
	/**
	 * Base run options handed to the subagent subprocess. This helper sets
	 * `worktree`, clears prepared/path extension preloads and custom-tool paths
	 * (isolated runs re-discover inside the worktree), and forwards everything
	 * else unchanged.
	 */
	baseOptions: ExecutorOptions;
	/** Context returned by {@link prepareIsolationContext}. */
	context: IsolationContext;
	/** PAL backend hint from `parseIsolationBackend(...)` (undefined ⇒ resolver picks). */
	preferredBackend: IsoBackendKind | undefined;
	/** Stable id used as the isolation worktree namespace and as the branch suffix. */
	agentId: string;
	/** Merge mode driving how changes are captured ("branch" commits, "patch" diffs). */
	mergeMode: "patch" | "branch";
	/** Output dir for `${agentId}.patch` artifacts (patch mode and branch-mode commit failures). */
	artifactsDir: string;
	/** Human description carried onto the branch commit (branch mode). */
	description?: string;
	/** Build a commit-message callback (`task.isolation.commits === "ai"`). */
	buildCommitMessage?: BuildCommitMessage;
	/**
	 * Construct a `SingleResult` when isolation setup throws — the caller has
	 * the full metadata (index, agent, assignment, modelOverride) needed to
	 * build a result shape consistent with their non-isolated path.
	 */
	buildFailureResult: (err: unknown) => SingleResult;
	/** Observe the real child result before post-run isolation work. */
	onSubprocessResult?: (result: SingleResult) => void;
}

/**
 * Write each nested-repo patch to `${artifactsDir}/${agentId}.nested-<n>-<path>.patch`
 * and return the paths. Throws on the first write failure: the caller must
 * then keep the isolation workspace alive, because it is the only other copy.
 * Every attempted destination is removed best-effort on failure — including
 * the in-progress file, which `Bun.write` may have created or truncated
 * before rejecting — so a half-written set cannot be mistaken for the
 * complete capture by the persisted-agent scanner.
 */
export async function persistNestedPatches(
	artifactsDir: string,
	agentId: string,
	nestedPatches: readonly NestedRepoPatch[],
): Promise<string[]> {
	const saved: string[] = [];
	try {
		for (const [index, nestedPatch] of nestedPatches.entries()) {
			const destination = path.join(
				artifactsDir,
				`${agentId}.nested-${index}-${nestedPatch.relativePath.replace(/[^a-zA-Z0-9._-]/g, "_") || "root"}.patch`,
			);
			// Track before writing: a mid-write failure (ENOSPC, quota) can
			// leave a truncated file behind, and `force: true` makes removing
			// a never-created path a no-op.
			saved.push(destination);
			await Bun.write(destination, nestedPatch.patch);
		}
	} catch (error) {
		await Promise.all(saved.map(file => fs.rm(file, { force: true }).catch(() => undefined)));
		throw error;
	}
	return saved;
}

interface IsolationPatchArtifacts {
	patchPath: string;
	hasRootChanges: boolean;
	nestedPatches: NestedRepoPatch[];
	nestedPatchPaths: string[];
}

interface IsolationPatchCapture {
	artifacts: IsolationPatchArtifacts;
	/** {@link deltaFingerprint} of the written delta. */
	fingerprint: bigint | number;
}

/**
 * Capture the isolation delta and write every part of it to disk — the root
 * patch and one file per nested repo — before the caller tears the workspace
 * down. Throws when any write fails so nothing captured is ever the only copy.
 */
async function writeIsolationPatch(
	isolationDir: string,
	baseline: WorktreeBaseline,
	artifactsDir: string,
	agentId: string,
): Promise<IsolationPatchCapture> {
	const delta = await captureDeltaPatch(isolationDir, baseline);
	const patchPath = path.join(artifactsDir, `${agentId}.patch`);
	await Bun.write(patchPath, delta.rootPatch);
	const nestedPatchPaths = await persistNestedPatches(artifactsDir, agentId, delta.nestedPatches);
	return {
		artifacts: {
			patchPath,
			hasRootChanges: delta.rootPatch.trim().length > 0,
			nestedPatches: delta.nestedPatches,
			nestedPatchPaths,
		},
		fingerprint: deltaFingerprint(delta.rootPatch, delta.nestedPatches),
	};
}

/**
 * Move a retained isolation workspace out of its deterministic
 * (`repoRoot` + agent id) slot into a globally unique sibling, so a later
 * isolated run with the same id cannot wipe it: `ensureIsolation`
 * unconditionally removes the deterministic base dir before writing its
 * owner marker. The owner marker, `m` mount, and backend sidecar move along,
 * so `omp worktree clear` still classifies and reclaims the workspace with
 * native teardown. Backends needing it (mounts, Btrfs subvolumes) record the
 * sidecar BEFORE the move so it travels atomically — a crash between rename
 * and a later write would leave a mounted workspace with a dead owner and
 * no metadata, and cleanup would traverse the live mount.
 */
export interface RetainedWorkspace {
	/** Workspace path to report (unique sibling on success, original dir when the move fails). */
	dir: string;
	/**
	 * False when cleanup metadata is missing that `clear` would need: the
	 * sidecar could not be written (plausible under the same disk pressure
	 * that forced retention). The error must then say the mount needs a
	 * manual unmount instead of advertising plain `worktree clear`.
	 */
	sidecarOk: boolean;
}

export async function retainIsolationWorkspace(
	isolationDir: string,
	backend?: natives.IsoBackendKind,
): Promise<RetainedWorkspace> {
	const baseDir = path.dirname(isolationDir);
	const retainedBase = `${baseDir}.retained-${Date.now().toString(36)}-${Math.floor(Math.random() * 2 ** 32).toString(16)}`;
	const needsSidecar = backend !== undefined && needsNativeTeardown(backend);
	let sidecarOk = !needsSidecar;
	if (needsSidecar && backend !== undefined) {
		try {
			await writeRetainedBackend(baseDir, backend);
			sidecarOk = true;
		} catch {
			sidecarOk = false;
		}
	}
	// A valid move can still fail transiently (Windows AV/indexer locks);
	// retry briefly before conceding the deterministic slot.
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			await fs.rename(baseDir, retainedBase);
			return { dir: path.join(retainedBase, path.basename(isolationDir)), sidecarOk };
		} catch {
			if (attempt === 2) return { dir: isolationDir, sidecarOk };
			await Bun.sleep(25);
		}
	}
	return { dir: isolationDir, sidecarOk };
}
/** Context for `isolation-error.md`: the `result.error` text for a run whose changes could not be captured or landed. */
interface IsolationErrorContext {
	kind: "merge-failed" | "patch-capture-failed" | "nested-capture-failed";
	message: string;
	captureError?: string;
	rescueBranch?: string;
	/** Set when the workspace was kept because its changes could not be written out. */
	retainedDir?: string;
	/**
	 * Set when the retained mount's unmount metadata is missing: cleanup
	 * cannot unmount before removal, so the message must direct a manual
	 * unmount instead of advertising plain `worktree clear`.
	 */
	sidecarMissing?: boolean;
}

function renderIsolationError(context: IsolationErrorContext): string {
	return prompt.render(isolationErrorTemplate, { ...context });
}

/**
 * Run a subagent inside an isolation worktree and capture its changes.
 *
 * Branch mode: on success, commits the diff onto `omp/task/${agentId}` and
 * returns `branchName` + `nestedPatches` (+ `nestedPatchPaths`). On commit
 * failure the still-live isolation diff is written to
 * `${artifactsDir}/${agentId}.patch`, the task branch is kept when it already
 * carries commits (deleted otherwise), and `result.error` carries the
 * merge-failure message plus recovery hint.
 *
 * Patch mode: on success, writes `${artifactsDir}/${agentId}.patch` plus one
 * `${agentId}.nested-<n>-<path>.patch` per nested repo and returns
 * `patchPath` + `nestedPatches` + `nestedPatchPaths`.
 *
 * Failure paths preserve the underlying `SingleResult` whenever possible so
 * the caller can still surface the subagent's output; only isolation setup
 * itself routes through {@link IsolatedRunOptions.buildFailureResult}.
 *
 * Kept-alive runs retain the isolation handle through idle/parked lifecycle
 * transitions, then capture final changes and clean up on release. One-shot
 * and failed startup paths clean up in `finally`. If captured changes cannot
 * be written to disk, the workspace is retained under a unique `.retained-*`
 * sibling and its path is named in the resulting error.
 */
export async function runIsolatedSubprocess(opts: IsolatedRunOptions): Promise<SingleResult> {
	let taskBaseline: WorktreeBaseline | undefined;
	/** Fingerprint of the delta already handed to the caller at run end; release only re-captures on change. */
	let handedOff: bigint | number | undefined;
	let handle: IsolationHandle | undefined;
	let deferredCleanup: Promise<void> | undefined;
	let retainWorkspace = false;
	let baseReleasePromise: Promise<void> | undefined;
	let cleanupPromise: Promise<void> | undefined;
	let releasePromise: Promise<void> | undefined;
	/** What a lifecycle release captured before it tore the workspace down. */
	let released: { artifacts: IsolationPatchArtifacts; branchName?: string } | undefined;
	const releaseBase = (): Promise<void> => {
		baseReleasePromise ??= opts.baseOptions.onRelease?.() ?? Promise.resolve();
		return baseReleasePromise;
	};
	const cleanupHandle = (): Promise<void> => {
		cleanupPromise ??= (async () => {
			await releaseBase();
			if (handle && !retainWorkspace) await cleanupIsolation(handle);
		})();
		return cleanupPromise;
	};
	const releaseIsolation = (): Promise<void> => {
		releasePromise ??= (async () => {
			if (!handle || !taskBaseline || retainWorkspace) {
				await cleanupHandle();
				return;
			}
			try {
				let capture: IsolationPatchCapture;
				try {
					capture = await writeIsolationPatch(handle.mergedDir, taskBaseline, opts.artifactsDir, opts.agentId);
				} catch (captureErr) {
					retainWorkspace = true;
					const retained = await retainIsolationWorkspace(handle.mergedDir, handle.backend);
					throw new Error(
						renderIsolationError({
							kind: "patch-capture-failed",
							message: captureErr instanceof Error ? captureErr.message : String(captureErr),
							retainedDir: retained.dir,
							sidecarMissing: !retained.sidecarOk,
						}),
					);
				}
				const patchResult = capture.artifacts;
				released = { artifacts: patchResult };
				AgentRegistry.global().setHistory(opts.agentId, {
					patchPath: patchResult.patchPath,
					nestedPatchPaths: patchResult.nestedPatchPaths,
				});
				// Nothing changed since the run-end capture the caller already
				// merged or applied: a branch now would only duplicate that work.
				if (capture.fingerprint === handedOff) return;
				const commitResult = await commitToBranch(
					handle.mergedDir,
					taskBaseline,
					opts.agentId,
					opts.description,
					undefined,
				);
				released.branchName = commitResult?.branchName;
				AgentRegistry.global().setHistory(opts.agentId, {
					patchPath: patchResult.patchPath,
					branchName: commitResult?.branchName,
					nestedPatchPaths: patchResult.nestedPatchPaths,
				});
			} finally {
				await cleanupHandle();
			}
		})();
		return releasePromise;
	};
	try {
		handle = await ensureIsolation(opts.context.repoRoot, opts.agentId, opts.preferredBackend);
		const isolationDir = handle.mergedDir;
		const isolationBackend = handle.backend;
		const baseline = await captureIsolationBaseline(isolationDir, opts.context.repoRoot);
		taskBaseline = baseline;
		// A task `cwd` naming a subdirectory starts the child in the matching
		// subdirectory of the isolation copy; capture and merge-back still run
		// at the repo root, so the offset never widens the write boundary.
		const childWorktree =
			opts.context.workdirOffset !== undefined && opts.context.workdirOffset !== ""
				? path.join(isolationDir, opts.context.workdirOffset)
				: isolationDir;
		const result = await runSubprocess({
			...opts.baseOptions,
			worktree: childWorktree,
			preloadedExtensionPaths: undefined,
			preloadedPreparedExtensions: undefined,
			preloadedCustomToolPaths: undefined,
			onCleanupDeferred: completion => {
				deferredCleanup = completion;
				opts.baseOptions.onCleanupDeferred?.(completion);
			},
			// One-shot runs get `releaseBase` (never touches the worktree): their
			// `finalizeSubagentLifecycle` calls `onRelease` before this function's
			// post-run capture, so the handle must survive until the `finally`
			// below cleans it up. Only kept-alive runs hand full capture+cleanup
			// (`releaseIsolation`) to the agent lifecycle.
			onRelease: opts.baseOptions.keepAlive === false ? releaseBase : releaseIsolation,
		});
		opts.onSubprocessResult?.(result);
		// An aborted kept-alive child is released by its lifecycle before
		// runSubprocess returns: the release already captured the workspace,
		// committed any change to `omp/task/<id>`, and tore the workspace down.
		// Name what it kept; there is nothing left here to capture.
		if (releasePromise) {
			let releaseError: string | undefined;
			await releasePromise.catch(error => {
				releaseError = error instanceof Error ? error.message : String(error);
			});
			const kept =
				released && (released.artifacts.hasRootChanges || released.artifacts.nestedPatches.length > 0)
					? { ...released.artifacts, branchName: released.branchName }
					: {};
			const error = releaseError ? (result.error ? `${result.error}\n${releaseError}` : releaseError) : result.error;
			return rememberAgentArtifacts({ ...result, ...kept, error, isolationError: releaseError });
		}
		// A successful result cannot be captured while deferred owner jobs or
		// shutdown hooks may still write the worktree. A failed run is captured
		// as it stands below, so its cleanup remains asynchronous.
		if (deferredCleanup && result.exitCode === 0) {
			await deferredCleanup;
		}
		if (opts.mergeMode === "branch" && result.exitCode === 0) {
			let commitResult: CommitToBranchResult | null;
			try {
				commitResult = await commitToBranch(
					isolationDir,
					baseline,
					opts.agentId,
					opts.description,
					opts.buildCommitMessage?.(),
				);
			} catch (mergeErr) {
				// Agent succeeded but the branch commit failed. `commitToBranch`
				// is not atomic: the clean-baseline path fetches the agent's
				// commits into the parent ODB and creates `omp/task/<id>` before
				// it commits the leftover working-tree delta, so a throw from
				// that trailing step leaves behind a branch that already holds
				// every commit the agent made. The isolation worktree — the only
				// other copy of those objects — is destroyed by the `finally`
				// below, so deleting the branch unconditionally turned a
				// recoverable merge conflict into permanent loss of committed
				// work (#8868). Delete only when nothing is at stake.
				const baseSha = baseline.root.headCommit;
				const branchName = `omp/task/${opts.agentId}`;
				const rescueBranch = await rescueTaskBranch(opts.context.repoRoot, branchName, baseSha);
				const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
				try {
					const capture = await writeIsolationPatch(isolationDir, baseline, opts.artifactsDir, opts.agentId);
					return rememberAgentArtifacts({
						...result,
						...capture.artifacts,
						error: renderIsolationError({ kind: "merge-failed", message: msg, rescueBranch }),
					});
				} catch (patchErr) {
					retainWorkspace = true;
					const retained = await retainIsolationWorkspace(isolationDir, isolationBackend);
					return rememberAgentArtifacts({
						...result,
						error: renderIsolationError({
							kind: "merge-failed",
							message: msg,
							captureError: patchErr instanceof Error ? patchErr.message : String(patchErr),
							rescueBranch,
							retainedDir: retained.dir,
							sidecarMissing: !retained.sidecarOk,
						}),
					});
				}
			}
			handedOff = deltaFingerprint(commitResult?.rootPatch ?? "", commitResult?.nestedPatches ?? []);
			// The branch holds the root-repo work, but nested-repo patches exist
			// only in memory until written; the workspace goes away in `finally`.
			try {
				const nestedPatchPaths = await persistNestedPatches(
					opts.artifactsDir,
					opts.agentId,
					commitResult?.nestedPatches ?? [],
				);
				return rememberAgentArtifacts({
					...result,
					branchName: commitResult?.branchName,
					branchBaseSha: commitResult?.baseSha,
					nestedPatches: commitResult?.nestedPatches,
					nestedPatchPaths,
				});
			} catch (persistErr) {
				retainWorkspace = true;
				const retained = await retainIsolationWorkspace(isolationDir, isolationBackend);
				return rememberAgentArtifacts({
					...result,
					branchName: commitResult?.branchName,
					branchBaseSha: commitResult?.baseSha,
					nestedPatches: commitResult?.nestedPatches,
					error: renderIsolationError({
						kind: "nested-capture-failed",
						message: persistErr instanceof Error ? persistErr.message : String(persistErr),
						retainedDir: retained.dir,
						sidecarMissing: !retained.sidecarOk,
					}),
				});
			}
		}
		if (result.exitCode === 0) {
			try {
				const capture = await writeIsolationPatch(isolationDir, baseline, opts.artifactsDir, opts.agentId);
				handedOff = capture.fingerprint;
				return rememberAgentArtifacts({ ...result, ...capture.artifacts });
			} catch (patchErr) {
				retainWorkspace = true;
				const retained = await retainIsolationWorkspace(isolationDir, isolationBackend);
				return rememberAgentArtifacts({
					...result,
					error: renderIsolationError({
						kind: "patch-capture-failed",
						message: patchErr instanceof Error ? patchErr.message : String(patchErr),
						retainedDir: retained.dir,
						sidecarMissing: !retained.sidecarOk,
					}),
				});
			}
		}
		// A failed or cancelled child's edits are the only copy of its work once
		// the workspace is torn down. Keep them as a recovery artifact; every
		// merge path refuses to apply a result that did not succeed.
		try {
			const capture = await writeIsolationPatch(isolationDir, baseline, opts.artifactsDir, opts.agentId);
			if (!capture.artifacts.hasRootChanges && capture.artifacts.nestedPatches.length === 0) {
				await fs.rm(capture.artifacts.patchPath, { force: true });
				return rememberAgentArtifacts(result);
			}
			handedOff = capture.fingerprint;
			return rememberAgentArtifacts({ ...result, ...capture.artifacts });
		} catch (patchErr) {
			retainWorkspace = true;
			const retained = await retainIsolationWorkspace(isolationDir, isolationBackend);
			const captureError = renderIsolationError({
				kind: "patch-capture-failed",
				message: patchErr instanceof Error ? patchErr.message : String(patchErr),
				retainedDir: retained.dir,
				sidecarMissing: !retained.sidecarOk,
			});
			return rememberAgentArtifacts({
				...result,
				error: result.error ? `${result.error}\n${captureError}` : captureError,
				isolationError: captureError,
			});
		}
	} catch (err) {
		return rememberAgentArtifacts(opts.buildFailureResult(err));
	} finally {
		if (
			handle &&
			!retainWorkspace &&
			!releasePromise &&
			!(opts.baseOptions.keepAlive !== false && AgentLifecycleManager.global().has(opts.agentId))
		) {
			if (deferredCleanup) {
				trackLateCleanup(deferredCleanup.then(cleanupHandle), {
					agentId: opts.agentId,
					resource: "isolation",
				});
			} else {
				await cleanupHandle();
			}
		}
	}
}

export interface IsolationMergeOptions {
	result: SingleResult;
	repoRoot: string;
	mergeMode: "patch" | "branch";
	/**
	 * The isolation repo root this run was captured from. When present the
	 * merge refuses to write anywhere else, so a task `cwd` naming another
	 * checkout can never land in the caller tree.
	 */
	expectedRepoRoot?: string;
}

/**
 * Fail closed when a merge is aimed at any repo but the one the isolation
 * was captured from. String comparison is exact on purpose: both sides are
 * canonical roots from {@link resolveTaskCwd}, so any difference means a
 * wrong-tree apply.
 */
function assertMergeTarget(repoRoot: string, expectedRepoRoot: string | undefined): void {
	if (expectedRepoRoot !== undefined && path.resolve(repoRoot) !== path.resolve(expectedRepoRoot)) {
		throw new Error(
			`Refusing to apply isolated changes to ${JSON.stringify(repoRoot)}: the task was isolated from ${JSON.stringify(expectedRepoRoot)}.`,
		);
	}
}

export interface IsolationMergeOutcome {
	/** Trailing summary appended to the subagent's result text. May be empty. */
	summary: string;
	/**
	 * Tri-state apply outcome:
	 * - `true`  — merge ran (or had nothing to apply) and left the repo clean.
	 * - `false` — merge attempted and failed; artifacts are preserved.
	 * - `null`  — caller skipped the merge phase entirely (e.g. `apply=false`).
	 */
	changesApplied: boolean | null;
	hadAnyChanges: boolean;
	/** True iff the root branch actually merged — gates nested-repo patch application. */
	mergedBranchForNestedPatches: boolean;
}

/**
 * Apply changes captured by {@link runIsolatedSubprocess} back to the parent
 * repo: patch apply (patch mode) or cherry-pick + cleanup (branch mode).
 *
 * The caller decides whether to run this at all — eval `agent()` with
 * `apply=False` skips this step and surfaces the patch artifact / branch name
 * instead.
 */
export async function mergeIsolatedChanges(opts: IsolationMergeOptions): Promise<IsolationMergeOutcome> {
	const { result, repoRoot, mergeMode } = opts;
	assertMergeTarget(repoRoot, opts.expectedRepoRoot);
	const repo = vcs.requireGit(repoRoot);
	try {
		if (mergeMode === "branch") {
			if (!result.branchName && result.exitCode === 0 && !result.aborted && result.error) {
				return {
					summary: renderIsolationSummary({
						kind: "branch-capture-failed",
						error: result.error,
						rootPatchPath: result.patchPath,
						nestedPatchPaths: result.nestedPatchPaths,
					}),
					changesApplied: false,
					hadAnyChanges: false,
					mergedBranchForNestedPatches: false,
				};
			}
			const canApplyNestedOnly =
				!result.branchName && result.exitCode === 0 && !result.aborted && (result.nestedPatches?.length ?? 0) > 0;
			if (!result.branchName || result.exitCode !== 0 || result.aborted) {
				return {
					summary: canApplyNestedOnly
						? "\n\nNo root changes to apply; nested repository patches captured."
						: "\n\nNo changes to apply.",
					changesApplied: true,
					hadAnyChanges: canApplyNestedOnly,
					mergedBranchForNestedPatches: canApplyNestedOnly,
				};
			}
			const mergeResult = await mergeTaskBranches(repoRoot, [
				{
					branchName: result.branchName,
					taskId: result.id,
					description: result.description,
					baseSha: result.branchBaseSha,
				},
			]);
			const mergedBranchForNestedPatches = mergeResult.merged.includes(result.branchName);
			const changesApplied = mergeResult.failed.length === 0;
			const hadAnyChanges = changesApplied && mergeResult.merged.length > 0;

			let summary: string;
			if (changesApplied) {
				summary = hadAnyChanges ? `\n\nMerged branch: ${result.branchName}` : "\n\nNo changes to apply.";
			} else {
				// The nested patches are skipped when the branch did not merge; name
				// their files so the parent can recover them alongside the branch.
				summary = renderIsolationSummary({
					kind: "branch-merge-failed",
					branchName: result.branchName,
					conflict: mergeResult.conflict,
					nestedPatchPaths: result.nestedPatchPaths,
				});
			}

			// Clean up the merged branch (keep failed ones for manual resolution)
			if (changesApplied) {
				await cleanupTaskBranches(repoRoot, [result.branchName]);
			}
			return { summary, changesApplied, hadAnyChanges, mergedBranchForNestedPatches };
		}

		// Patch mode: apply the patch from a successful run. A failed or
		// aborted run has nothing to apply and must not block the result.
		let changesApplied: boolean;
		let hadAnyChanges: boolean;
		const succeeded = result.exitCode === 0 && !result.error && !result.aborted;
		if (!succeeded) {
			changesApplied = true;
			hadAnyChanges = false;
		} else if (!result.patchPath) {
			changesApplied = false;
			hadAnyChanges = false;
		} else {
			const patchText = await Bun.file(result.patchPath).text();
			if (!patchText.trim()) {
				changesApplied = true;
				hadAnyChanges = false;
			} else {
				const normalized = patchText.endsWith("\n") ? patchText : `${patchText}\n`;
				// Idempotence: declare a no-op only when the reverse patch applies AND
				// the forward patch does not. `--reverse --check` alone can theoretically
				// succeed if the file happens to carry the postimage at another location
				// via git-apply's fuzz factor; requiring the forward check to fail
				// removes that ambiguity while still catching true already-applied
				// runs. Reads only — neither call touches the worktree, unlike
				// `--3way --check`, which exits 0 even when the real apply would
				// leave conflict markers and unmerged index entries.
				const [alreadyApplied, forwardApplies] = await Promise.all([
					repo.canApplyPatch(normalized, { reverse: true }).catch(() => false),
					repo.canApplyPatch(normalized, {}).catch(() => false),
				]);
				hadAnyChanges = false;
				if (alreadyApplied && !forwardApplies) {
					changesApplied = true;
				} else if (forwardApplies) {
					changesApplied = true;
					try {
						await repo.applyPatch(normalized, {});
						hadAnyChanges = true;
					} catch {
						changesApplied = false;
					}
				} else {
					changesApplied = false;
				}
			}
		}

		let summary: string;
		if (changesApplied) {
			summary = hadAnyChanges ? "\n\nApplied patches: yes" : "\n\nNo changes to apply.";
		} else {
			// Nested apply is skipped when the root patch did not apply; the
			// persisted nested patches are the parent's only pointer to that work.
			summary = renderIsolationSummary({
				kind: "not-applied",
				rootPatchPath: result.patchPath,
				nestedPatchPaths: result.nestedPatchPaths,
			});
		}
		return { summary, changesApplied, hadAnyChanges, mergedBranchForNestedPatches: false };
	} catch (mergeErr) {
		return {
			summary: renderIsolationSummary({
				kind: "merge-error",
				error: mergeErr instanceof Error ? mergeErr.message : String(mergeErr),
				branchName: result.branchName,
				rootPatchPath: result.patchPath,
				nestedPatchPaths: result.nestedPatchPaths,
			}),
			changesApplied: false,
			hadAnyChanges: false,
			mergedBranchForNestedPatches: false,
		};
	}
}

export interface NestedPatchApplyOptions {
	/** Subagent result carrying `nestedPatches`/`exitCode`/`aborted`. */
	result: SingleResult;
	repoRoot: string;
	mergeMode: "patch" | "branch";
	/** Parent merge outcome — patch mode skips nested apply when this is `false`. */
	changesApplied: boolean | null;
	/** Branch mode gates nested apply on whether the root branch merged. */
	mergedBranchForNestedPatches: boolean;
	/** Isolation repo root the run was captured from; refuses to write anywhere else. */
	expectedRepoRoot?: string;
	/** Optional AI commit-message callback for nested commits; falls back to a generic message. */
	commitMessage?: (diff: string) => Promise<string | null>;
}

/**
 * Apply nested-repo patches after the parent merge phase. Centralizes the
 * three-way gate (exitCode/aborted, patch-mode failed parent, branch-mode
 * branch-merged) and the non-fatal failure handling so `TaskTool` and the
 * eval `agent()` bridge use one implementation.
 *
 * Returns a system-notification suffix to append to the parent merge summary,
 * or an empty string when nothing was applied or the nested apply succeeded.
 */
export async function applyEligibleNestedPatches(opts: NestedPatchApplyOptions): Promise<string> {
	const { result, repoRoot, mergeMode, changesApplied, mergedBranchForNestedPatches, commitMessage } = opts;
	assertMergeTarget(repoRoot, opts.expectedRepoRoot);
	if (mergeMode === "patch" && changesApplied === false) return "";
	const nestedPatches = result.nestedPatches ?? [];
	const eligible =
		nestedPatches.length > 0 &&
		result.exitCode === 0 &&
		!result.aborted &&
		(mergeMode !== "branch" || mergedBranchForNestedPatches);
	if (!eligible) return "";
	try {
		const warnings = await applyNestedPatches(repoRoot, nestedPatches, commitMessage);
		if (warnings.length === 0) return "";
		return `\n\n<system-notification>${warnings.join("\n")}</system-notification>`;
	} catch (applyErr) {
		// Nested patch failures are non-fatal to the parent merge, but the patch
		// files are the only surviving copy of that work — name them.
		return renderIsolationSummary({
			kind: "nested-apply-failed",
			error: applyErr instanceof Error ? applyErr.message : String(applyErr),
			nestedPatchPaths: result.nestedPatchPaths,
		});
	}
}
