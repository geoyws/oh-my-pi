/**
 * Task `cwd`: an isolated child works in the named checkout — never the
 * caller tree — and an unusable path fails closed before any isolation is
 * allocated or either tree is touched.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	artifactsDirsFromRegistry,
	resetRegisteredArtifactDirsForTests,
} from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import {
	mergeIsolatedChanges,
	prepareIsolationContext,
	runIsolatedSubprocess,
} from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import {
	runStructuredSubagent,
	type StructuredSubagentRequest,
} from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import { getTaskSchema, taskSchema, type AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import * as natives from "@oh-my-pi/pi-natives";
import { setWorktreesDir } from "@oh-my-pi/pi-utils";

const tempRoots: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	setWorktreesDir(undefined);
	resetRegisteredArtifactDirsForTests();
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(stderr || `git ${args.join(" ")} failed`);
	return stdout.trim();
}

async function tempDir(prefix: string): Promise<string> {
	const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
	tempRoots.push(dir);
	return dir;
}

async function makeRepo(prefix: string): Promise<string> {
	const repo = await tempDir(prefix);
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "core.autocrlf", "false");
	await git(repo, "config", "commit.gpgsign", "false");
	await fs.mkdir(path.join(repo, "sub"), { recursive: true });
	await fs.writeFile(path.join(repo, "tracked.txt"), "base\n");
	await fs.writeFile(path.join(repo, "sub", "nested.txt"), "nested base\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-q", "-m", "base");
	return repo;
}

function mockRcopy(): void {
	vi.spyOn(natives, "isoResolve").mockResolvedValue({
		kind: natives.IsoBackendKind.Rcopy,
		candidates: [natives.IsoBackendKind.Rcopy],
		fellBack: false,
		reason: undefined,
	});
}

const AGENT: AgentDefinition = {
	name: "worker",
	description: "Test worker",
	systemPrompt: "Do the assigned work.",
	source: "bundled",
	tools: ["read", "write", "ast_grep"],
	output: { type: "object", properties: { agent: { type: "boolean" } } },
};

function mockDiscovery(): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [AGENT], projectAgentsDir: null });
}

function session(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({
			"task.maxRecursionDepth": 2,
			"task.isolation.enabled": true,
			"isolation.backend": "rcopy",
			"task.enableLsp": true,
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getSessionAgents: () => [],
		getPlanModeState: () => undefined,
	} as unknown as ToolSession;
}

function childResult(id: string, outcome: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id,
		agent: "worker",
		agentSource: "bundled",
		task: "Do work",
		assignment: "Do work",
		exitCode: 0,
		output: '{"ok":true}',
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
		...outcome,
	};
}

/** Repo state fingerprint: HEAD plus porcelain plus every tracked content hash. */
async function repoFingerprint(repo: string): Promise<string> {
	const [head, status, ls] = await Promise.all([
		git(repo, "rev-parse", "HEAD"),
		git(repo, "status", "--porcelain"),
		git(repo, "ls-files", "-s"),
	]);
	return `${head}\n${status}\n${ls}`;
}

describe("task cwd wire schema", () => {
	it("keeps cwd on the flat shape instead of deleting it as a stale key", () => {
		const parsed = taskSchema({
			agent: "task",
			task: "x",
			solutionSpace: "c",
			isolated: true,
			cwd: "/repo-b",
		});
		expect(parsed instanceof type.errors).toBe(false);
		if (!(parsed instanceof type.errors)) {
			expect(parsed.cwd).toBe("/repo-b");
			expect(parsed.isolated).toBe(true);
		}
	});

	it("keeps per-item cwd on the batch shape", () => {
		const batch = getTaskSchema({ isolationEnabled: true, batchEnabled: true });
		const out = batch({
			context: "ctx",
			tasks: [{ task: "x", solutionSpace: "c", isolated: true, cwd: "/repo-b" }],
		});
		expect(out instanceof type.errors).toBe(false);
		if (!(out instanceof type.errors) && out && typeof out === "object" && "tasks" in out) {
			const tasks = out.tasks as Array<{ cwd?: unknown }>;
			expect(tasks[0]?.cwd).toBe("/repo-b");
		}
	});
});

describe("task cwd isolation", () => {
	it("isolates and merges the named checkout, leaving the caller repo untouched", async () => {
		const caller = await makeRepo("omp-cwd-caller-");
		const target = await makeRepo("omp-cwd-target-");
		const callerBefore = await repoFingerprint(caller);
		const targetHead = await git(target, "rev-parse", "HEAD");
		const wtDir = await tempDir("omp-cwd-wt-");
		setWorktreesDir(wtDir);
		mockRcopy();
		mockDiscovery();
		let childDir = "";
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			childDir = options.worktree!;
			await fs.writeFile(path.join(childDir, "tracked.txt"), "target edit\n");
			return childResult("Writer");
		});

		const settled = await runStructuredSubagent({
			session: session(caller),
			invocationKind: "task",
			assignment: "Edit the assigned worktree.",
			solutionSpace: "one fix",
			agent: "worker",
			cwd: target,
			isolation: { requested: true },
		} satisfies StructuredSubagentRequest);

		expect(settled.result.exitCode).toBe(0);
		expect(settled.result.error).toBeUndefined();
		// The child ran in an isolation copy under the worktrees dir, not in
		// either checkout directly.
		expect(childDir.startsWith(`${wtDir}${path.sep}`)).toBe(true);
		// The edit landed in the named checkout (same HEAD: patch apply, no commit).
		expect(await fs.readFile(path.join(target, "tracked.txt"), "utf8")).toBe("target edit\n");
		expect(await git(target, "rev-parse", "HEAD")).toBe(targetHead);
		// The caller tree is identical: status, HEAD, and tracked content.
		expect(await repoFingerprint(caller)).toBe(callerBefore);
		expect(await fs.readFile(path.join(caller, "tracked.txt"), "utf8")).toBe("base\n");
	});

	it("refuses a mismatched merge target instead of writing the caller tree", async () => {
		const caller = await makeRepo("omp-cwd-merge-a-");
		const target = await makeRepo("omp-cwd-merge-b-");
		const callerBefore = await repoFingerprint(caller);
		const fake = childResult("Writer", { patchPath: path.join(caller, "nope.patch") });
		await expect(
			mergeIsolatedChanges({ result: fake, repoRoot: caller, mergeMode: "patch", expectedRepoRoot: target }),
		).rejects.toThrow("Refusing to apply isolated changes");
		expect(await repoFingerprint(caller)).toBe(callerBefore);
	});

	it("starts the child in the matching subdirectory of the isolation", async () => {
		const caller = await makeRepo("omp-cwd-sub-caller-");
		const target = await makeRepo("omp-cwd-sub-target-");
		setWorktreesDir(await tempDir("omp-cwd-sub-wt-"));
		mockRcopy();
		let childDir = "";
		let isolationRoot = "";
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			childDir = options.worktree!;
			isolationRoot = path.dirname(childDir);
			await fs.writeFile(path.join(childDir, "nested.txt"), "nested edit\n");
			return childResult("SubWriter");
		});
		const artifactsDir = await tempDir("omp-cwd-sub-artifacts-");

		const context = await prepareIsolationContext(caller, path.join(target, "sub"));
		expect(context.repoRoot).toBe(target);
		expect(context.workdirOffset).toBe("sub");
		expect(context.childCwd).toBe(path.join(target, "sub"));

		const result = await runIsolatedSubprocess({
			baseOptions: {
				cwd: caller,
				agent: { name: "task", description: "Task agent", systemPrompt: "test", source: "bundled" },
				task: "Do work",
				index: 0,
				id: "SubWriter",
				keepAlive: false,
			},
			context,
			preferredBackend: undefined,
			agentId: "SubWriter",
			mergeMode: "patch",
			artifactsDir,
			buildFailureResult: error => childResult("SubWriter", { exitCode: 1, error: String(error) }),
		});
		expect(result.exitCode).toBe(0);
		expect(childDir).toBe(path.join(isolationRoot, "sub"));
		expect(isolationRoot).not.toBe(target);

		const outcome = await mergeIsolatedChanges({
			result,
			repoRoot: context.repoRoot,
			mergeMode: "patch",
			expectedRepoRoot: context.repoRoot,
		});
		expect(outcome.changesApplied).toBe(true);
		expect(await fs.readFile(path.join(target, "sub", "nested.txt"), "utf8")).toBe("nested edit\n");
		expect(await git(caller, "status", "--porcelain")).toBe("");
	});

	for (const [label, leaf, reason] of [
		["relative path", "some/relative/path", "must be an absolute path"],
		["missing path", "DOES-NOT-EXIST", "does not exist"],
		["file, not directory", "tracked.txt", "not a directory"],
		["outside any repo", "OUTSIDE", "not inside a git work tree"],
		["symlink escaping its repo", "leak", "outside its git repository"],
	] as const) {
		it(`refuses ${label} without allocating isolation or touching either tree`, async () => {
			const caller = await makeRepo("omp-cwd-refuse-caller-");
			const target = await makeRepo("omp-cwd-refuse-target-");
			let requested: string;
			if (leaf === "OUTSIDE") {
				requested = path.join(await tempDir("omp-cwd-outside-"), "work");
				await fs.mkdir(requested, { recursive: true });
			} else if (leaf === "leak") {
				requested = path.join(target, "leak");
				await fs.symlink(caller, requested);
			} else if (leaf === "some/relative/path") {
				requested = leaf;
			} else if (leaf === "DOES-NOT-EXIST") {
				requested = path.join(caller, "does-not-exist");
			} else {
				requested = path.join(caller, leaf);
			}
			const callerBefore = await repoFingerprint(caller);
			const targetBefore = await repoFingerprint(target);
			const wtDir = await tempDir("omp-cwd-refuse-wt-");
			setWorktreesDir(wtDir);
			mockRcopy();
			mockDiscovery();
			const runSpy = vi.spyOn(executorModule, "runSubprocess");

			const error = await prepareIsolationContext(caller, requested).then(
				() => null,
				(err: unknown) => err,
			);
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toContain(requested);
			expect((error as Error).message).toContain(reason);

			await expect(
				runStructuredSubagent({
					session: session(caller),
					invocationKind: "task",
					assignment: "Edit the assigned worktree.",
					solutionSpace: "one fix",
					agent: "worker",
					cwd: requested,
					isolation: { requested: true },
				} satisfies StructuredSubagentRequest),
			).rejects.toThrow(reason);
			expect(runSpy).not.toHaveBeenCalled();
			expect(await fs.readdir(wtDir)).toEqual([]);
			expect(artifactsDirsFromRegistry()).toEqual([]);
			expect(await repoFingerprint(caller)).toBe(callerBefore);
			expect(await repoFingerprint(target)).toBe(targetBefore);
		});
	}
});

describe("task cwd submodule caller", () => {
	async function makeSubmoduleFixture(): Promise<{ superRepo: string; subCheckout: string; superHead: string }> {
		const sub = await makeRepo("omp-cwd-submod-sub-");
		const superRepo = await makeRepo("omp-cwd-submod-super-");
		await git(superRepo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "mod");
		await git(superRepo, "commit", "-q", "-m", "pin mod");
		const subCheckout = path.join(superRepo, "mod");
		expect((await fs.readFile(path.join(subCheckout, ".git"), "utf8")).trim().startsWith("gitdir:")).toBe(true);
		return { superRepo, subCheckout, superHead: await git(superRepo, "rev-parse", "HEAD") };
	}

	async function runWriter(callerCwd: string, requestedCwd: string | undefined, id: string): Promise<SingleResult> {
		setWorktreesDir(await tempDir("omp-cwd-submod-wt-"));
		mockRcopy();
		mockDiscovery();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			await fs.writeFile(path.join(options.worktree!, "tracked.txt"), "submodule edit\n");
			return childResult(id);
		});
		const settled = await runStructuredSubagent({
			session: session(callerCwd),
			invocationKind: "task",
			assignment: "Edit the assigned worktree.",
			solutionSpace: "one fix",
			agent: "worker",
			...(requestedCwd === undefined ? {} : { cwd: requestedCwd }),
			isolation: { requested: true },
		} satisfies StructuredSubagentRequest);
		return settled.result;
	}

	it("isolates a gitfile submodule checkout as the caller cwd", async () => {
		const { superRepo, subCheckout, superHead } = await makeSubmoduleFixture();
		const result = await runWriter(subCheckout, undefined, "SubmodCaller");
		expect(result.exitCode).toBe(0);
		expect(result.error).toBeUndefined();
		expect(await fs.readFile(path.join(subCheckout, "tracked.txt"), "utf8")).toBe("submodule edit\n");
		expect(await git(superRepo, "rev-parse", "HEAD")).toBe(superHead);
	});

	it("isolates an explicitly named gitfile submodule checkout from a superproject caller", async () => {
		const { superRepo, subCheckout, superHead } = await makeSubmoduleFixture();
		const result = await runWriter(superRepo, subCheckout, "SubmodNamed");
		expect(result.exitCode).toBe(0);
		expect(result.error).toBeUndefined();
		expect(await fs.readFile(path.join(subCheckout, "tracked.txt"), "utf8")).toBe("submodule edit\n");
		expect(await fs.readFile(path.join(superRepo, "tracked.txt"), "utf8")).toBe("base\n");
		expect(await git(superRepo, "rev-parse", "HEAD")).toBe(superHead);
	});
});
