import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

interface AdmissionResult {
	code: number;
	stdout: string;
	stderr: string;
}

type AdmissionRunner = (command: string) => Promise<AdmissionResult>;

/** Only the medic adapter owns policy. No thresholds, cached samples or environment bypass. */
function runAdmission(command: string): Promise<AdmissionResult> {
	const { promise, resolve, reject } = Promise.withResolvers<AdmissionResult>();
	execFile(command, [], { timeout: 12_000, maxBuffer: 65_536, encoding: "utf8" }, (error, stdout, stderr) => {
		if (error && (typeof error.code !== "number" || error.killed)) {
			reject(error);
			return;
		}
		resolve({ code: error?.code ?? 0, stdout, stderr });
	});
	return promise;
}

export class PressureAdmissionError extends Error {
	constructor(readonly exitCode: 75 | 78, detail: string) {
		super(`New agent refused: ${detail}. Existing sessions can finish and checkpoint; no session was killed.`);
		this.name = "PressureAdmissionError";
	}
}

/** Called before every new live session, including cold revival, not before existing turns/tools. */
export async function requireNewAgentAdmission(
	platform: NodeJS.Platform = process.platform,
	run: AdmissionRunner = runAdmission,
	command: string = join(homedir(), "bin", "omp-admit"),
): Promise<void> {
	if (platform !== "darwin") return;
	let result: AdmissionResult;
	try {
		result = await run(command);
	} catch (error) {
		throw new PressureAdmissionError(78, `medic admission unavailable (${String(error)})`);
	}
	if (result.code === 75 || result.code === 78) {
		throw new PressureAdmissionError(result.code, result.stderr.trim() || "medic policy refused admission");
	}
	try {
		const report = JSON.parse(result.stdout);
		if (
			result.code !== 0 || report?.schema !== 1 || report.admitted !== true ||
			typeof report.reason !== "string" || typeof report.measuredAt !== "string" ||
			!("memory" in report) || !("pressureLevel" in report)
		) throw new Error("invalid policy response or exit status");
	} catch (error) {
		throw new PressureAdmissionError(78, `medic admission unavailable (${String(error)})`);
	}
}
