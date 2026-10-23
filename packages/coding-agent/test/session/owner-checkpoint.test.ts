import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "../../src/session/agent-session";
import { checkpointOwnerSession } from "../../src/session/owner-checkpoint";
import { SessionManager } from "../../src/session/session-manager";

const dirs: string[] = [];
const managers: SessionManager[] = [];
afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.close();
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "omp-checkpoint-"));
	dirs.push(dir);
	const manager = SessionManager.create(dir, join(dir, "sessions"));
	managers.push(manager);
	const state = {
		sessionManager: manager,
		isStreaming: false,
		hasAdmittedSubmission: false,
		queuedMessageCount: 0,
		isCompacting: false,
		isGeneratingHandoff: false,
		hasPendingAsyncWork: () => false,
	};
	return { state, session: state as unknown as AgentSession, manager };
}
const identity = () => ({ pid: 42, startTime: 100 });

describe("explicit owner checkpoint", () => {
	it("materializes a resumable transcript before closing the actual owner", async () => {
		const { session, manager } = await fixture();
		let reopened: SessionManager | undefined;
		await checkpointOwnerSession(
			session,
			async () => {
				expect(manager.isSessionOnDisk()).toBe(true);
				reopened = await SessionManager.open(manager.getSessionFile()!);
				managers.push(reopened);
				expect(reopened.getSessionId()).toBe(manager.getSessionId());
			},
			() => false,
		);
		expect(reopened).toBeDefined();
	});
	it.each(["isStreaming", "hasAdmittedSubmission", "isCompacting", "isGeneratingHandoff"] as const)(
		"preserves %s work",
		async field => {
			const { state, session, manager } = await fixture();
			state[field] = true;
			await expect(
				checkpointOwnerSession(
					session,
					async () => {
						throw new Error("must not close");
					},
					() => false,
					identity,
				),
			).rejects.toThrow("idle");
			expect(manager.isSessionOnDisk()).toBe(false);
		},
	);
	it.each(["queued", "async", "submission"])("preserves pending %s work", async kind => {
		const { state, session } = await fixture();
		if (kind === "queued") state.queuedMessageCount = 1;
		if (kind === "async") state.hasPendingAsyncWork = () => true;
		await expect(
			checkpointOwnerSession(
				session,
				async () => {
					throw new Error("must not close");
				},
				() => kind === "submission",
				identity,
			),
		).rejects.toThrow("idle");
	});
	it("refuses PID reuse after persistence without closing", async () => {
		const { session } = await fixture();
		let reads = 0;
		await expect(
			checkpointOwnerSession(
				session,
				async () => {
					throw new Error("must not close");
				},
				() => false,
				() => ({ pid: 42, startTime: reads++ === 0 ? 100 : 101 }),
			),
		).rejects.toThrow("identity or activity changed");
	});
	it("refuses a changed PID after persistence", async () => {
		const { session } = await fixture();
		let reads = 0;
		await expect(
			checkpointOwnerSession(
				session,
				async () => {
					throw new Error("must not close");
				},
				() => false,
				() => ({ pid: reads++ === 0 ? 42 : 43, startTime: 100 }),
			),
		).rejects.toThrow("identity or activity changed");
	});
	it("refuses an unidentifiable owner", async () => {
		const { session } = await fixture();
		await expect(
			checkpointOwnerSession(
				session,
				async () => {
					throw new Error("must not close");
				},
				() => false,
				() => undefined,
			),
		).rejects.toThrow("identifiable");
	});
	it("does not close if work arrives while the checkpoint becomes durable", async () => {
		const { state, session } = await fixture();
		let reads = 0;
		await expect(
			checkpointOwnerSession(
				session,
				async () => {
					throw new Error("must not close");
				},
				() => false,
				() => {
					if (++reads === 2) state.isStreaming = true;
					return identity();
				},
			),
		).rejects.toThrow("identity or activity changed");
	});
	it("never advertises an in-memory session as resumable", async () => {
		const { state } = await fixture();
		state.sessionManager = SessionManager.inMemory();
		managers.push(state.sessionManager);
		await expect(
			checkpointOwnerSession(
				state as unknown as AgentSession,
				async () => {
					throw new Error("must not close");
				},
				() => false,
				identity,
			),
		).rejects.toThrow("no durable transcript");
	});
});
