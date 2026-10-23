import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PressureAdmissionError, requireNewAgentAdmission } from "../../src/session/pressure-admission";

const allow = JSON.stringify({ schema: 1, admitted: true, reason: "ok", measuredAt: "2026-10-23T00:00:00Z", memory: {}, pressureLevel: 1 });
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function helper(body: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "omp-admission-"));
	dirs.push(dir);
	const command = join(dir, "policy");
	await writeFile(command, `#!/bin/sh\n${body}\n`);
	await chmod(command, 0o700);
	return command;
}

describe("new-session admission", () => {
	it("does not need the Darwin policy on Linux", async () => {
		await requireNewAgentAdmission("linux", async () => { throw new Error("must not execute"); });
	});
	it("accepts a consistent medic allow report from the actual adapter process", async () => {
		await requireNewAgentAdmission("darwin", undefined, await helper(`printf '%s' '${allow}'`));
	});
	it.each([75, 78] as const)("preserves refusal exit %s and its reason", async code => {
		const command = await helper(`printf '%s' 'committed: preserve live owners' >&2\nexit ${code}`);
		try {
			await requireNewAgentAdmission("darwin", undefined, command);
			throw new Error("admitted pressured work");
		} catch (error) {
			expect(error).toBeInstanceOf(PressureAdmissionError);
			expect((error as PressureAdmissionError).exitCode).toBe(code);
			expect(String(error)).toContain("committed");
		}
	});
	it("fails closed for a missing helper", async () => {
		await expect(requireNewAgentAdmission("darwin", undefined, "/nonexistent/omp-admit")).rejects.toMatchObject({ exitCode: 78 });
	});
	it.each(["", "null", "garbage", "{}", '{"schema":1,"admitted":false}',
		JSON.stringify({ schema: 1, admitted: true, reason: "ok", measuredAt: 7, memory: {}, pressureLevel: 1 }),
		JSON.stringify({ schema: 1, admitted: true, reason: 2, measuredAt: "now", memory: {}, pressureLevel: 1 }),
		JSON.stringify({ schema: 1, admitted: true, reason: "ok", measuredAt: "now", pressureLevel: 1 }),
		JSON.stringify({ schema: 1, admitted: true, reason: "ok", measuredAt: "now", memory: {} }),
	])("never interprets an invalid successful response as permission: %s", async stdout => {
		await expect(requireNewAgentAdmission("darwin", async () => ({ code: 0, stdout, stderr: "" }))).rejects.toMatchObject({ exitCode: 78 });
	});
	it("does not accept allow JSON when its process failed", async () => {
		await expect(requireNewAgentAdmission("darwin", async () => ({ code: 64, stdout: allow, stderr: "" }))).rejects.toMatchObject({ exitCode: 78 });
	});
	it("refuses each concurrent launch independently", async () => {
		let attempts = 0;
		const results = await Promise.allSettled(Array.from({ length: 24 }, () => requireNewAgentAdmission("darwin", async () => {
			attempts++;
			return { code: 75, stdout: "", stderr: "" };
		})));
		expect(attempts).toBe(24);
		expect(results.every(result => result.status === "rejected" && result.reason.exitCode === 75)).toBe(true);
	});
	it("bounds a wedged adapter and remains fail closed", async () => {
		const command = await helper("exec sleep 20");
		await expect(requireNewAgentAdmission("darwin", undefined, command)).rejects.toMatchObject({ exitCode: 78 });
	}, 15_000);
});
