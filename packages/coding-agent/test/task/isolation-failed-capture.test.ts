/**
 * A failed or cancelled isolated child loses its workspace at teardown, so its
 * edits must survive as a recovery patch — and that patch must never be
 * applied to the parent.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { mergeIsolatedChanges, runIsolatedSubprocess } from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import { setWorktreesDir } from "@oh-my-pi/pi-utils";
import * as natives from "@oh-my-pi/pi-natives";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";

const tempRoots: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	setWorktreesDir(undefined);
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

function childResult(id: string, outcome: Partial<SingleResult>): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "Do work",
		assignment: "Do work",
		exitCode: 0,
		output: "",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
		...outcome,
	};
}

/** Run one isolated child that writes `edit` (when given) and ends with `outcome`. */
async function runChild(id: string, outcome: Partial<SingleResult>, edit?: string) {
	const repo = await tempDir("omp-failed-capture-repo-");
	await git(repo, "init", "-q", "-b", "main");
	await fs.writeFile(path.join(repo, "tracked.txt"), "base\n");
	await git(repo, "add", "tracked.txt");
	await git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "base");
	setWorktreesDir(await tempDir("omp-failed-capture-wt-"));
	const artifactsDir = await tempDir("omp-failed-capture-artifacts-");
	vi.spyOn(natives, "isoResolve").mockResolvedValue({
		kind: natives.IsoBackendKind.Rcopy,
		candidates: [natives.IsoBackendKind.Rcopy],
		fellBack: false,
		reason: undefined,
	});
	let isolationDir = "";
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
		isolationDir = options.worktree!;
		if (edit !== undefined) await fs.writeFile(path.join(isolationDir, "tracked.txt"), edit);
		return childResult(id, outcome);
	});
	const result = await runIsolatedSubprocess({
		baseOptions: {
			cwd: repo,
			agent: { name: "task", description: "Task agent", systemPrompt: "test", source: "bundled" },
			task: "Do work",
			index: 0,
			id,
			keepAlive: false,
		},
		context: { repoRoot: repo },
		preferredBackend: undefined,
		agentId: id,
		mergeMode: "patch",
		artifactsDir,
		buildFailureResult: error => childResult(id, { exitCode: 1, error: String(error) }),
	});
	return { repo, result, isolationDir };
}

describe("isolated child that does not succeed", () => {
	for (const [label, outcome] of [
		["failed", { exitCode: 1, error: "child crashed" }],
		["cancelled", { exitCode: 1, aborted: true, abortReason: "cancelled" }],
	] as const) {
		it(`keeps a ${label} child's edit as a recovery patch and never applies it`, async () => {
			const { repo, result, isolationDir } = await runChild(`Capture${label}`, outcome, "child edit\n");

			expect(result.patchPath).toBeDefined();
			expect(await Bun.file(result.patchPath!).text()).toContain("+child edit");
			// The workspace is gone; the patch is the only copy and it replays.
			expect(await fs.exists(isolationDir)).toBe(false);
			expect(await git(repo, "status", "--porcelain")).toBe("");

			const outcomeOfMerge = await mergeIsolatedChanges({ result, repoRoot: repo, mergeMode: "patch" });
			expect(outcomeOfMerge.hadAnyChanges).toBe(false);
			expect(await fs.readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("base\n");
			expect(await git(repo, "status", "--porcelain")).toBe("");

			await git(repo, "apply", "--check", result.patchPath!);
		});
	}

	it("reports no patch for a failed child that changed nothing", async () => {
		const { repo, result } = await runChild("CaptureNothing", { exitCode: 1, error: "child crashed" });
		expect(result.patchPath).toBeUndefined();
		expect(await git(repo, "status", "--porcelain")).toBe("");
	});
});
