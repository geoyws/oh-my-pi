/**
 * `omp trust`: review and approve the repository-controlled behaviour of one
 * project directory (kb omp t-f77ec1f5).
 *
 * Three surfaces are gated until approved, each by a content fingerprint:
 *   mcp         project MCP servers (commands OMP would launch, URLs it would call)
 *   extensions  project extension and hook code OMP would import
 *   env         project `.env` names that route provider/proxy/OAuth traffic
 * Approval records the CURRENT fingerprint of every non-empty surface; any later
 * content change needs a new approval.
 */
import * as path from "node:path";
import * as readline from "node:readline";
import { parseEnvFile } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { CliUsageError } from "@oh-my-pi/pi-utils/cli";
import {
	approveProjectSurfaces,
	EMPTY_SURFACE_FINGERPRINT,
	fingerprintProjectRoutingEnv,
	isProjectRoutingEnvName,
	isProjectSurfaceTrusted,
	PROJECT_TRUST_SURFACES,
	type ProjectTrustSurface,
	projectTrustKey,
	revokeProjectTrust,
} from "@oh-my-pi/pi-utils/project-trust";
import { Settings } from "../config/settings";
import { initializeWithSettings } from "../discovery";
import { loadAmbientExtensionEntries } from "../extensibility/extensions/loader";
import { loadAllMCPConfigs } from "../mcp/config";
import { promptLine } from "./oauth-terminal";

export interface TrustCommandArgs {
	dir: string;
	yes: boolean;
	revoke: boolean;
	json: boolean;
}

interface SurfaceReport {
	surface: ProjectTrustSurface;
	fingerprint: string;
	trusted: boolean;
	/** Human-readable lines naming exactly what approval would allow. */
	items: string[];
}

async function measureSurfaces(dir: string): Promise<SurfaceReport[]> {
	const settings = await Settings.init({ cwd: dir });
	initializeWithSettings(settings);

	const mcp = await loadAllMCPConfigs(dir, { enableProjectConfig: true, filterExa: false });
	const mcpFingerprint = mcp.projectTrust?.fingerprint ?? EMPTY_SURFACE_FINGERPRINT;
	const mcpItems = (mcp.projectTrust?.servers ?? []).map(({ name, source, config }) => {
		const target =
			config.type === "http" || config.type === "sse"
				? `${config.type} ${config.url}`
				: `stdio ${[config.command, ...(config.args ?? [])].join(" ")}`;
		return `${name}: ${target}  (${source})`;
	});

	const extensions = await loadAmbientExtensionEntries(dir);

	const projectEnv = parseEnvFile(path.join(dir, ".env"));
	const envFingerprint = fingerprintProjectRoutingEnv(projectEnv);
	// Values are routing targets (URLs, proxies), not secrets; show them so the
	// user sees where traffic would go.
	const envItems = Object.keys(projectEnv)
		.filter(isProjectRoutingEnvName)
		.map(name => `${name}=${projectEnv[name]}`);

	const measured: Array<Omit<SurfaceReport, "trusted">> = [
		{ surface: "mcp", fingerprint: mcpFingerprint, items: mcpItems },
		{ surface: "extensions", fingerprint: extensions.projectFingerprint, items: extensions.projectPaths },
		{ surface: "env", fingerprint: envFingerprint, items: envItems },
	];
	return measured.map(report => ({
		...report,
		trusted: isProjectSurfaceTrusted(dir, report.surface, report.fingerprint),
	}));
}

async function confirm(question: string): Promise<boolean> {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = await promptLine(rl, question);
		return /^y(es)?$/i.test(answer.trim());
	} finally {
		rl.close();
	}
}

export async function runTrustCommand(args: TrustCommandArgs): Promise<void> {
	const dir = projectTrustKey(path.resolve(args.dir));

	if (args.revoke) {
		const removed = revokeProjectTrust(dir);
		if (args.json) process.stdout.write(`${JSON.stringify({ dir, revoked: removed })}\n`);
		else process.stdout.write(removed ? `Revoked trust for ${dir}\n` : `No trust recorded for ${dir}\n`);
		return;
	}

	const reports = await measureSurfaces(dir);
	const pending = reports.filter(r => r.fingerprint !== EMPTY_SURFACE_FINGERPRINT && !r.trusted);

	if (args.json && !args.yes) {
		process.stdout.write(`${JSON.stringify({ dir, surfaces: reports }, null, 2)}\n`);
		return;
	}

	if (!args.json) {
		process.stdout.write(`${chalk.bold("Project")} ${dir}\n`);
		for (const report of reports) {
			const state =
				report.fingerprint === EMPTY_SURFACE_FINGERPRINT
					? chalk.dim("nothing supplied")
					: report.trusted
						? chalk.green("approved")
						: chalk.yellow("NOT approved");
			process.stdout.write(`\n${chalk.bold(report.surface)}  ${state}\n`);
			for (const item of report.items) process.stdout.write(`  ${item}\n`);
		}
		process.stdout.write("\n");
	}

	if (pending.length === 0) {
		if (args.json) process.stdout.write(`${JSON.stringify({ dir, approved: [], surfaces: reports })}\n`);
		else process.stdout.write("Nothing awaits approval.\n");
		return;
	}

	if (!args.yes) {
		if (!process.stdin.isTTY) {
			throw new CliUsageError(
				"Approval needs an interactive terminal or --yes. Review the listing above first: approving lets this project's code run with your credentials.",
			);
		}
		const names = pending.map(r => r.surface).join(", ");
		if (!(await confirm(`Approve ${names} for this project? This lets the code above run as you. [y/N] `))) {
			process.stdout.write("Not approved.\n");
			return;
		}
	}

	const fingerprints: Partial<Record<ProjectTrustSurface, string>> = {};
	for (const report of pending) fingerprints[report.surface] = report.fingerprint;
	approveProjectSurfaces(dir, fingerprints);
	const approved = PROJECT_TRUST_SURFACES.filter(surface => fingerprints[surface] !== undefined);
	if (args.json) process.stdout.write(`${JSON.stringify({ dir, approved, surfaces: reports })}\n`);
	else process.stdout.write(`Approved ${approved.join(", ")}. Restart omp in ${dir} to load them.\n`);
}
