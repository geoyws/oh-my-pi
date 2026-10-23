import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import type { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";

const dirs: string[] = [];
const managers: SessionManager[] = [];
const lifecycles: AgentLifecycleManager[] = [];
afterEach(async () => {
	for (const lifecycle of lifecycles.splice(0)) await lifecycle.dispose();
	for (const manager of managers.splice(0)) await manager.close();
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "omp-pressure-reclaim-"));
	dirs.push(dir);
	const manager = SessionManager.create(dir, join(dir, "sessions"));
	managers.push(manager);
	const registry = new AgentRegistry();
	const lifecycle = new AgentLifecycleManager(registry);
	lifecycles.push(lifecycle);
	let disposed = false;
	const state = {
		sessionManager: manager, isStreaming: false, hasAdmittedSubmission: false,
		queuedMessageCount: 0, isCompacting: false, isGeneratingHandoff: false,
		hasPendingAsyncWork: () => false,
		dispose: async () => { disposed = true; await manager.close(); },
	};
	const ref = registry.register({ id: "worker", displayName: "worker", kind: "sub", status: "idle",
		session: state as unknown as AgentSession, sessionFile: manager.getSessionFile() });
	lifecycle.adopt(ref.id, { idleTtlMs: 0 }, ref);
	return { registry, lifecycle, ref, state, manager, disposed: () => disposed };
}

describe("pressure reclaim", () => {
	it("parks only adopted idle generations and leaves a resumable file", async () => {
		const f = await fixture();
		await f.lifecycle.reclaimIdle();
		expect(f.ref.status).toBe("parked");
		expect(f.ref.session).toBeNull();
		expect(f.disposed()).toBe(true);
		const reopened = await SessionManager.open(f.ref.sessionFile!);
		managers.push(reopened);
		expect(reopened.getSessionId()).toBe(f.manager.getSessionId());
	});
	it.each(["isStreaming", "hasAdmittedSubmission", "isCompacting", "isGeneratingHandoff"] as const)("does not reclaim %s work", async field => {
		const f = await fixture();
		f.state[field] = true;
		await f.lifecycle.reclaimIdle();
		expect(f.ref.status).toBe("idle");
		expect(f.disposed()).toBe(false);
	});
	it("preserves an agent which becomes active during the parking cancel window", async () => {
		const f = await fixture();
		const reclaim = f.lifecycle.reclaimIdle();
		f.registry.setStatus(f.ref.id, "running", f.ref);
		await reclaim;
		expect(f.ref.status).toBe("running");
		expect(f.disposed()).toBe(false);
	});
	it("does not detach a replacement generation", async () => {
		const f = await fixture();
		const reclaim = f.lifecycle.reclaimIdle();
		f.registry.unregister(f.ref.id, f.ref);
		const replacement = f.registry.register({ id: f.ref.id, displayName: "new", kind: "sub", status: "running", session: null });
		await reclaim;
		expect(f.registry.get(f.ref.id)).toBe(replacement);
		expect(replacement.status).toBe("running");
	});
	it("does not reclaim idle sessions this manager does not own", async () => {
		const f = await fixture();
		const foreign = f.registry.register({ id: "foreign", displayName: "foreign", kind: "sub", status: "idle", session: f.state as unknown as AgentSession });
		await f.lifecycle.reclaimIdle();
		expect(foreign.session).toBe(f.state as unknown as AgentSession);
		expect(foreign.status).toBe("idle");
	});
	it("coalesces concurrent owner reclaim requests", async () => {
		const f = await fixture();
		await Promise.all([f.lifecycle.reclaimIdle(), f.lifecycle.reclaimIdle()]);
		expect(f.ref.status).toBe("parked");
		expect(f.disposed()).toBe(true);
	});
});
