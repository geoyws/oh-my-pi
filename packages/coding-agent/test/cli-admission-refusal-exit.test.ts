import { describe, expect, it } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { handleEntryFailure } from "../src/cli";
import { PressureAdmissionError } from "../src/session/pressure-admission";

// A new-agent admission refusal must leave `omp -p` with the refusal's own
// status and exactly one stderr line, so a launcher can tell pressure (75) from
// an unavailable adapter (78). Other failures keep the fatal dump and exit 1.

const childFlag = "--admission-refusal-child";
const TAIL = "Existing sessions can finish and checkpoint; no session was killed.";

/** Child: a real print-mode launch whose session creation is refused, ending at the entry boundary. */
async function refusedPrintLaunch(error: Error): Promise<void> {
	using tempDir = TempDir.createSync("@omp-admission-refusal-");
	const authStorage = await AuthStorage.create(":memory:");
	const argv = ["--print", "hello"];
	const parsed = parseArgs(argv);
	parsed.noExtensions = true;
	parsed.noSkills = true;
	parsed.noRules = true;
	parsed.noTools = true;
	parsed.noLsp = true;
	parsed.sessionDir = tempDir.path();
	await runRootCommand(parsed, argv, {
		discoverAuthStorage: async () => authStorage,
		settings: Settings.isolated({ "marketplace.autoUpdate": "off" }),
		createAgentSession: async () => {
			throw error;
		},
	}).catch(handleEntryFailure);
}

if (process.argv.includes(childFlag)) {
	const kind = process.argv[process.argv.indexOf(childFlag) + 1];
	if (kind === "crash") await handleEntryFailure(new Error("unrelated crash"));
	else if (kind === "multiline")
		await refusedPrintLaunch(
			new PressureAdmissionError(78, "medic admission unavailable (Error: Command failed: omp-admit\na\nb\n)"),
		);
	else await refusedPrintLaunch(new PressureAdmissionError(Number(kind) as 75 | 78, `refusal ${kind}`));
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
	describe("omp -p admission refusal exit", () => {
		for (const code of [75, 78]) {
			it(`exits ${code} with one line`, async () => {
				const result = await runChild(String(code));
				expect(result.code).toBe(code);
				expect(result.stderr).toBe(`error: New agent refused: refusal ${code}. ${TAIL}\n`);
			});
		}

		it("folds a multi-line adapter failure into one line", async () => {
			const result = await runChild("multiline");
			expect(result.code).toBe(78);
			expect(result.stderr).toBe(
				`error: New agent refused: medic admission unavailable (Error: Command failed: omp-admit a b ). ${TAIL}\n`,
			);
		});

		it("keeps the fatal dump and exit 1 for any other failure", async () => {
			const result = await runChild("crash");
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("unrelated crash");
			expect(result.stderr.split("\n").length).toBeGreaterThan(2);
		});
	});
}
