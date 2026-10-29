/**
 * Review and approve a project's repository-controlled MCP servers, extensions
 * and provider-routing `.env` names.
 */
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { getProjectDir } from "@oh-my-pi/pi-utils/dirs";
import { trustHelp as commandHelp } from "../cli/command-help";
import { runTrustCommand } from "../cli/trust-cli";

export default class Trust extends Command {
	static description = commandHelp.description;

	static flags = {
		dir: Flags.string({ description: "Project directory (default: current directory)" }),
		yes: Flags.boolean({ char: "y", description: "Approve without the interactive confirmation" }),
		revoke: Flags.boolean({ description: "Remove every approval recorded for the project" }),
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON" }),
	};

	static examples = ["omp trust", "omp trust --dir ~/src/repo", "omp trust --yes", "omp trust --revoke"];

	async run(): Promise<void> {
		const { flags } = await this.parse(Trust);
		await runTrustCommand({
			dir: flags.dir ?? getProjectDir(),
			yes: flags.yes ?? false,
			revoke: flags.revoke ?? false,
			json: flags.json ?? false,
		});
	}
}
