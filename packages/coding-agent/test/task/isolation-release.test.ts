/**
 * Isolated children cannot be resumed or messaged, so nothing may keep their
 * workspace past the run: a kept-alive isolated child used to sit parked with
 * its `~/.omp/wt` copy on disk until the parent process exited.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { runIsolatedSubprocess } from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import { setWorktreesDir } from "@oh-my-pi/pi-utils";
import * as natives from "@oh-my-pi/pi-natives";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";

const tempRoots: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	setWorktreesDir(undefined);
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
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

function result(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "Do work",
		assignment: "Do work",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
	};
}

interface ChildRun {
	repo: string;
	artifactsDir: string;
	/** Resolves with the child's workspace once it has written its edit and is still running. */
	running: Promise<string>;
	/** Lets the running child finish. */
	finish: () => void;
	/** `keepAlive` the executor received. */
	keepAlive: () => boolean | undefined;
	done: Promise<SingleResult>;
}

/**
 * Start a real rcopy-isolated child in a fresh git repo. The executor is
 * replaced by a stand-in that writes `edit` into the workspace, waits for
 * `finish`, and then settles its lifecycle through the real
 * `finalizeSubagentLifecycle` exactly as `runSubprocess` does. The task tool
 * leaves `keepAlive` unset, which the executor treats as "keep alive".
 */
async function startChild(id: string, mergeMode: "patch" | "branch", edit: string): Promise<ChildRun> {
	const repo = await tempDir("omp-isolation-release-repo-");
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await fs.writeFile(path.join(repo, "tracked.txt"), "base\n");
	await git(repo, "add", "tracked.txt");
	await git(repo, "commit", "-q", "-m", "base");
	setWorktreesDir(await tempDir("omp-isolation-release-wt-"));
	const artifactsDir = await tempDir("omp-isolation-release-artifacts-");
	vi.spyOn(natives, "isoResolve").mockResolvedValue({
		kind: natives.IsoBackendKind.Rcopy,
		candidates: [natives.IsoBackendKind.Rcopy],
		fellBack: false,
		reason: undefined,
	});

	const { promise: running, resolve: markRunning } = Promise.withResolvers<string>();
	const { promise: finished, resolve: finish } = Promise.withResolvers<void>();
	let receivedKeepAlive: boolean | undefined;
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
		receivedKeepAlive = options.keepAlive;
		const session = {
			prepareForHeadlessAdvisorDrain: () => {},
			waitForAdvisorCatchup: async () => true,
			dispose: async () => {},
		} as unknown as AgentSession;
		AgentRegistry.global().register({
			id: options.id,
			displayName: options.id,
			kind: "sub",
			session,
			sessionFile: path.join(artifactsDir, `${options.id}.jsonl`),
			status: "running",
		});
		const workspace = options.worktree!;
		await fs.writeFile(path.join(workspace, "tracked.txt"), edit);
		markRunning(workspace);
		await finished;
		await executorModule.finalizeSubagentLifecycle({
			id: options.id,
			session,
			aborted: false,
			keepAlive: options.keepAlive !== false,
			isolated: true,
			agentIdleTtlMs: 60_000,
			reviveSession: async () => session,
			onRelease: options.onRelease,
		});
		return result(options.id);
	});

	const done = runIsolatedSubprocess({
		baseOptions: {
			cwd: repo,
			agent: { name: "task", description: "Task agent", systemPrompt: "test", source: "bundled" },
			task: "Do work",
			index: 0,
			id,
		},
		context: { repoRoot: repo },
		preferredBackend: undefined,
		agentId: id,
		mergeMode,
		artifactsDir,
		buildFailureResult: error => ({ ...result(id), exitCode: 1, error: String(error) }),
	});
	return { repo, artifactsDir, running, finish, keepAlive: () => receivedKeepAlive, done };
}

describe("isolated child workspace lifetime", () => {
	it("keeps a running child's workspace", async () => {
		const child = await startChild("RunningKeep", "patch", "running edit\n");
		const workspace = await child.running;

		expect(await fs.readFile(path.join(workspace, "tracked.txt"), "utf8")).toBe("running edit\n");
		expect(AgentRegistry.global().get("RunningKeep")?.status).toBe("running");

		child.finish();
		await child.done;
	});

	it("removes a finished child's workspace while the parent lives and keeps its patch", async () => {
		const child = await startChild("PatchReap", "patch", "patch edit\n");
		const workspace = await child.running;
		child.finish();
		const settled = await child.done;

		expect(child.keepAlive()).toBe(false);
		expect(await fs.exists(workspace)).toBe(false);
		expect(AgentLifecycleManager.global().has("PatchReap")).toBe(false);
		expect(AgentRegistry.global().get("PatchReap")).toBeUndefined();
		expect(settled.patchPath).toBe(path.join(child.artifactsDir, "PatchReap.patch"));
		expect(await Bun.file(settled.patchPath!).text()).toContain("+patch edit");
		await git(child.repo, "apply", "--check", settled.patchPath!);
		expect(await git(child.repo, "status", "--porcelain")).toBe("");
	});

	it("removes a finished branch-mode child's workspace while the parent lives and keeps its branch", async () => {
		const child = await startChild("BranchReap", "branch", "branch edit\n");
		const workspace = await child.running;
		child.finish();
		const settled = await child.done;

		expect(child.keepAlive()).toBe(false);
		expect(await fs.exists(workspace)).toBe(false);
		expect(AgentLifecycleManager.global().has("BranchReap")).toBe(false);
		expect(settled.branchName).toBe("omp/task/BranchReap");
		expect(await git(child.repo, "show", "omp/task/BranchReap:tracked.txt")).toBe("branch edit");
		expect(await git(child.repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
	});
});
