import { describe, expect, it } from "bun:test";
import { handleEntryFailure } from "../src/cli";
import { PressureAdmissionError } from "../src/session/pressure-admission";

// A new-agent admission refusal reaching the process entry must exit with the
// refusal's own status and print one line, so a launcher can tell pressure (75)
// from an unavailable adapter (78). Other failures keep the fatal dump and exit 1.

const childFlag = "--admission-refusal-child";

if (process.argv.includes(childFlag)) {
	const kind = process.argv[process.argv.indexOf(childFlag) + 1];
	const error =
		kind === "crash"
			? new Error("unrelated crash")
			: new PressureAdmissionError(Number(kind) as 75 | 78, `refusal ${kind}`);
	await handleEntryFailure(error);
}

async function runChild(kind: string): Promise<{ code: number; stderr: string }> {
	const proc = Bun.spawn([process.execPath, import.meta.path, childFlag, kind], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, NO_COLOR: "1" },
	});
	const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	return { code, stderr };
}

if (!process.argv.includes(childFlag)) {
	describe("process entry failure boundary", () => {
		for (const code of [75, 78]) {
			it(`exits ${code} with one line for an admission refusal`, async () => {
				const result = await runChild(String(code));
				expect(result.code).toBe(code);
				expect(result.stderr).toBe(
					`error: New agent refused: refusal ${code}. Existing sessions can finish and checkpoint; no session was killed.\n`,
				);
			});
		}

		it("keeps the fatal dump and exit 1 for any other failure", async () => {
			const result = await runChild("crash");
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("unrelated crash");
			expect(result.stderr.split("\n").length).toBeGreaterThan(2);
		});
	});
}
