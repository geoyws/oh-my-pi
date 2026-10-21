/**
 * Isolated subagent changes never land in a checkout without explicit
 * acceptance. With `task.isolation.apply` at its default, an isolated task or
 * eval `agent()` run leaves the caller tree byte-identical — even when it holds
 * unrelated dirty work — and delivers the child's changes as a patch artifact
 * that applies cleanly to a separate checkout pinned at the same base commit.
 * Only `task.isolation.apply=true` or a per-call `apply: true` integrates them,
 * and then exactly into the isolated checkout.
 *
 * Real git and real isolation (rcopy); only the child subprocess is mocked, and
 * it writes into its isolation directory like a real child would.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type EvalAgentResult, runEvalAgent } from "@oh-my-pi/pi-coding-agent/eval/agent-bridge";
import { runEvalWait } from "@oh-my-pi/pi-coding-agent/eval/handle-bridge";
import { resetRegisteredArtifactDirsForTests } from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import * as isolationRunner from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import {
	runStructuredSubagent,
	type StructuredSubagentRequest,
} from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { SingleResult, TaskParams } from "@oh-my-pi/pi-tui/tools/task";
import * as natives from "@oh-my-pi/pi-natives";
import { setWorktreesDir } from "@oh-my-pi/pi-utils";

const tempRoots: string[] = [];
const jobManagers: AsyncJobManager[] = [];

/** The child's edit to a tracked file the caller has NOT touched. */
const CHILD_TRACKED_PATH = "sub/nested.txt";
const CHILD_TRACKED_CONTENT = "nested edited by child\n";
/** A file the child creates. */
const CHILD_NEW_PATH = "added.txt";
const CHILD_NEW_CONTENT = "created by child\n";
/** Unrelated caller dirty state: a modified tracked file and an untracked file. */
const CALLER_DIRTY_TRACKED = "tracked.txt";
const CALLER_UNTRACKED = "scratch.txt";
const TOUCHED_PATHS = [CALLER_DIRTY_TRACKED, CALLER_UNTRACKED, CHILD_TRACKED_PATH, CHILD_NEW_PATH];

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
});

afterEach(async () => {
	vi.restoreAllMocks();
	setWorktreesDir(undefined);
	await Promise.all(jobManagers.splice(0).map(manager => manager.dispose()));
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	resetRegisteredArtifactDirsForTests();
	resetSettingsForTest();
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

/** Run git and return raw stdout (no trimming: porcelain lines start with spaces). */
async function gitRaw(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(stderr || `git ${args.join(" ")} failed`);
	return stdout;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
	return (await gitRaw(cwd, ...args)).trim();
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

/** Give the repo unrelated uncommitted work: a modified tracked file and an untracked file. */
async function dirty(repo: string): Promise<void> {
	await fs.writeFile(path.join(repo, CALLER_DIRTY_TRACKED), "caller wip\n");
	await fs.writeFile(path.join(repo, CALLER_UNTRACKED), "caller scratch\n");
}

/** HEAD, full porcelain status (untracked files listed individually), and bytes of every touched path. */
async function repoFingerprint(repo: string): Promise<string> {
	const head = await git(repo, "rev-parse", "HEAD");
	const status = await gitRaw(repo, "status", "--porcelain=v1", "-uall");
	const contents: string[] = [];
	for (const rel of TOUCHED_PATHS) {
		const bytes = await fs.readFile(path.join(repo, rel)).catch(() => null);
		contents.push(`${rel}=${bytes === null ? "<absent>" : bytes.toString("base64")}`);
	}
	return `${head}\n${status}\n${contents.join("\n")}`;
}

/** Porcelain status lines, sorted, so ordering between tracked/untracked sections does not matter. */
async function statusLines(repo: string): Promise<string[]> {
	return (await gitRaw(repo, "status", "--porcelain=v1", "-uall"))
		.split("\n")
		.filter(line => line.length > 0)
		.sort();
}

const CHILD_STATUS = [`?? ${CHILD_NEW_PATH}`, ` M ${CHILD_TRACKED_PATH}`].sort();

async function expectExactlyChildChanges(repo: string): Promise<void> {
	expect(await statusLines(repo)).toEqual(CHILD_STATUS);
	expect(await fs.readFile(path.join(repo, CHILD_TRACKED_PATH), "utf8")).toBe(CHILD_TRACKED_CONTENT);
	expect(await fs.readFile(path.join(repo, CHILD_NEW_PATH), "utf8")).toBe(CHILD_NEW_CONTENT);
	expect(await fs.readFile(path.join(repo, CALLER_DIRTY_TRACKED), "utf8")).toBe("base\n");
	await expect(fs.stat(path.join(repo, CALLER_UNTRACKED))).rejects.toThrow();
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
};

function childResult(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "worker",
		agentSource: "bundled",
		task: "Do work",
		assignment: "Do work",
		exitCode: 0,
		output: "child done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
	};
}

/**
 * Real isolation; the child is the only mock. It writes into whatever
 * isolation directory the runner handed it; the returned list records each
 * directory the child ran in.
 */
async function arrangeChild(): Promise<string[]> {
	setWorktreesDir(await tempDir("omp-accept-wt-"));
	mockRcopy();
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [AGENT], projectAgentsDir: null });
	const childDirs: string[] = [];
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
		const dir = options.worktree!;
		childDirs.push(dir);
		await fs.writeFile(path.join(dir, CHILD_TRACKED_PATH), CHILD_TRACKED_CONTENT);
		await fs.writeFile(path.join(dir, CHILD_NEW_PATH), CHILD_NEW_CONTENT);
		return childResult(options.id);
	});
	return childDirs;
}

function isolationSettings(overrides: Partial<Parameters<typeof Settings.isolated>[0]> = {}): Settings {
	return Settings.isolated({
		"async.enabled": false,
		"task.isolation.enabled": true,
		"isolation.backend": "rcopy",
		...overrides,
	});
}

function toolSession(cwd: string, settings: Settings): ToolSession {
	const asyncJobManager = new AsyncJobManager({});
	jobManagers.push(asyncJobManager);
	return {
		cwd,
		hasUI: false,
		settings,
		asyncJobManager,
		taskDepth: 0,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getSessionAgents: () => [],
		getPlanModeState: () => undefined,
		getArtifactsDir: () => null,
		getSessionId: () => "accept-session",
		getEvalSessionId: () => "accept-eval-session",
	} as unknown as ToolSession;
}

/** Clone the caller's committed state into a fresh checkout and pin it at `base`. */
async function pinnedIntegrationSource(caller: string, base: string): Promise<string> {
	const parent = await tempDir("omp-accept-pinned-");
	const clone = path.join(parent, "pinned");
	await git(parent, "clone", "-q", "--no-hardlinks", caller, clone);
	await git(clone, "config", "core.autocrlf", "false");
	await git(clone, "checkout", "-q", "--detach", base);
	expect(await git(clone, "rev-parse", "HEAD")).toBe(base);
	expect(await statusLines(clone)).toEqual([]);
	return clone;
}

async function runEvalAgentAndWait(args: unknown, session: ToolSession): Promise<EvalAgentResult> {
	const handle = await runEvalAgent(args, { session });
	const waited = await runEvalWait({ items: [{ kind: "agent", id: handle.id }] }, { session });
	const snapshot = waited.items[0];
	if (!snapshot || snapshot.status !== "completed") {
		throw new Error(snapshot?.error || `Agent handle ${handle.id} did not complete`);
	}
	const result = session.asyncJobManager?.getJob(handle.id)?.latestDetails?.evalResult as EvalAgentResult | undefined;
	if (!result) throw new Error(`Agent handle ${handle.id} returned no eval result`);
	return result;
}

describe("isolated changes without explicit acceptance", () => {
	it("task tool: leaves a dirty caller byte-identical and hands back a patch that applies to a pinned clean checkout", async () => {
		const caller = await makeRepo("omp-accept-task-caller-");
		const base = await git(caller, "rev-parse", "HEAD");
		await dirty(caller);
		const callerBefore = await repoFingerprint(caller);
		const childDirs = await arrangeChild();
		// Pass-through spy: observes whether any merge into a checkout was attempted.
		const mergeSpy = vi.spyOn(isolationRunner, "mergeIsolatedChanges");

		const tool = await TaskTool.create(toolSession(caller, isolationSettings()));
		const result = await tool.execute("tc-default-retain", {
			agent: "worker",
			task: "Edit sub/nested.txt and add added.txt.",
			isolated: true,
		} as TaskParams);

		expect(result.isError).not.toBe(true);
		expect(childDirs).toHaveLength(1);
		expect(childDirs[0]?.startsWith(caller)).toBe(false);
		expect(mergeSpy).not.toHaveBeenCalled();
		// The caller tree — HEAD, status (incl. its own unrelated dirty work), bytes — is untouched.
		expect(await repoFingerprint(caller)).toBe(callerBefore);

		const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
		expect(text).not.toContain("Applied patches: yes");
		const match = text.match(/changes captured at `([^`]+\.patch)`/);
		expect(match).not.toBeNull();
		const patchPath = match![1]!;
		tempRoots.push(path.dirname(patchPath));
		expect(result.details?.results[0]?.patchPath).toBe(patchPath);
		const patch = await fs.readFile(patchPath, "utf8");
		expect(patch).toContain(CHILD_TRACKED_PATH);
		expect(patch).toContain(CHILD_NEW_PATH);
		// The caller's unrelated dirty work is not part of the child's delta.
		expect(patch).not.toContain(CALLER_DIRTY_TRACKED);
		expect(patch).not.toContain(CALLER_UNTRACKED);

		const pinned = await pinnedIntegrationSource(caller, base);
		await git(pinned, "apply", "--check", patchPath);
		await git(pinned, "apply", patchPath);
		await expectExactlyChildChanges(pinned);
		expect(await git(pinned, "rev-parse", "HEAD")).toBe(base);
	});

	it("eval agent(): apply omitted at the default setting retains a patch and leaves the caller untouched", async () => {
		const caller = await makeRepo("omp-accept-eval-caller-");
		const base = await git(caller, "rev-parse", "HEAD");
		await dirty(caller);
		const callerBefore = await repoFingerprint(caller);
		const childDirs = await arrangeChild();
		const mergeSpy = vi.spyOn(isolationRunner, "mergeIsolatedChanges");

		const result = await runEvalAgentAndWait(
			{ prompt: "Edit sub/nested.txt and add added.txt.", agent: "worker", isolated: true },
			toolSession(caller, isolationSettings()),
		);

		expect(childDirs).toHaveLength(1);
		expect(mergeSpy).not.toHaveBeenCalled();
		expect(await repoFingerprint(caller)).toBe(callerBefore);
		expect(result.details.isolated).toBe(true);
		expect(result.details.changesApplied).toBeNull();
		expect(result.text).not.toContain("Applied patches: yes");
		const patchPath = result.details.patchPath;
		expect(patchPath).toBeDefined();
		tempRoots.push(path.dirname(patchPath!));
		expect(result.text).toContain(patchPath!);

		const pinned = await pinnedIntegrationSource(caller, base);
		await git(pinned, "apply", "--check", patchPath!);
		await git(pinned, "apply", patchPath!);
		await expectExactlyChildChanges(pinned);
	});
});

describe("isolated changes with explicit acceptance", () => {
	async function acceptanceFixture(): Promise<{ caller: string; target: string; targetHead: string }> {
		const caller = await makeRepo("omp-accept-yes-caller-");
		await dirty(caller);
		const target = await makeRepo("omp-accept-yes-target-");
		return { caller, target, targetHead: await git(target, "rev-parse", "HEAD") };
	}

	it("eval apply: true applies exactly the child's changes into the isolated checkout, not the caller", async () => {
		const { caller, target, targetHead } = await acceptanceFixture();
		const callerBefore = await repoFingerprint(caller);
		const childDirs = await arrangeChild();
		const mergeSpy = vi.spyOn(isolationRunner, "mergeIsolatedChanges");

		const settled = await runStructuredSubagent({
			session: toolSession(caller, isolationSettings()),
			invocationKind: "eval",
			assignment: "Edit sub/nested.txt and add added.txt.",
			agent: "worker",
			cwd: target,
			isolation: { requested: true, apply: true },
		} satisfies StructuredSubagentRequest);

		expect(settled.result.exitCode).toBe(0);
		expect(settled.result.error).toBeUndefined();
		expect(settled.policy.applyChanges).toBe(true);
		expect(settled.changesApplied).toBe(true);
		expect(childDirs).toHaveLength(1);
		expect(mergeSpy).toHaveBeenCalledTimes(1);
		await expectExactlyChildChanges(target);
		expect(await git(target, "rev-parse", "HEAD")).toBe(targetHead);
		expect(await repoFingerprint(caller)).toBe(callerBefore);
	});

	it("task tool with task.isolation.apply=true applies exactly the child's changes into the named checkout", async () => {
		const { caller, target, targetHead } = await acceptanceFixture();
		const callerBefore = await repoFingerprint(caller);
		const childDirs = await arrangeChild();
		const mergeSpy = vi.spyOn(isolationRunner, "mergeIsolatedChanges");

		const tool = await TaskTool.create(toolSession(caller, isolationSettings({ "task.isolation.apply": true })));
		const result = await tool.execute("tc-accepted", {
			agent: "worker",
			task: "Edit sub/nested.txt and add added.txt.",
			isolated: true,
			cwd: target,
		} as TaskParams);

		expect(result.isError).not.toBe(true);
		expect(childDirs).toHaveLength(1);
		expect(mergeSpy).toHaveBeenCalledTimes(1);
		const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
		expect(text).toContain("Applied patches: yes");
		await expectExactlyChildChanges(target);
		expect(await git(target, "rev-parse", "HEAD")).toBe(targetHead);
		expect(await repoFingerprint(caller)).toBe(callerBefore);
	});
});
