/**
 * Share a saved session as an encrypted link without launching the agent.
 *
 * `omp share <session>` accepts a session id (prefix) or a path to a session
 * `.jsonl` and uploads the sealed snapshot exactly like the `/share` slash
 * command, honoring `share.serverUrl`, `share.store`, and
 * `share.redactSecrets`.
 */

import { isEnoent } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { shareHelp as commandHelp } from "../cli/command-help";
import { Settings } from "../config/settings";
import { resolveShareObfuscator, shareSession } from "../export/share";
import { resolveResumableSession } from "../session/session-listing";
import { SessionManager } from "../session/session-manager";
import { cfgShareRedactSecrets, cfgShareServerUrl, cfgShareStore } from "./settings";

export default class Share extends Command {
	static description = commandHelp.description;
	static args = {
		session: Args.string({
			description: "Session id (prefix) or path to a session .jsonl",
			required: true,
		}),
	};
	static flags = {
		gist: Flags.boolean({
			description: "Upload to a secret GitHub gist instead of the share server",
			default: false,
		}),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Share);

		const sessionArg = args.session ?? "";
		let sessionPath: string | undefined = sessionArg;
		if (!sessionArg.includes("/") && !sessionArg.includes("\\") && !sessionArg.endsWith(".jsonl")) {
			const match = await resolveResumableSession(sessionArg, process.cwd());
			sessionPath = match?.session.path;
		}

		let sm: SessionManager | undefined;
		if (sessionPath) {
			try {
				sm = await SessionManager.open(sessionPath, undefined, undefined, { throwIfMissing: true });
			} catch (err) {
				if (!isEnoent(err)) throw err;
			}
		}
		if (!sm) {
			process.stderr.write(`Session "${sessionArg}" not found.\n`);
			process.exitCode = 1;
			return;
		}
		// Settings resolve against the session's own project so its
		// share.redactSecrets policy governs, not the invoking cwd's.
		const settings = await Settings.loadReadOnly({ cwd: sm.getCwd() });
		// Same leak boundary as /share: the obfuscator is built against the
		// session's own project directory (its secrets.yml, not the invoking cwd's).
		const obfuscator = await resolveShareObfuscator({
			redact: cfgShareRedactSecrets.get(settings),
			cwd: sm.getCwd(),
		});

		const result = await shareSession(sm, {
			serverUrl: cfgShareServerUrl.get(settings),
			store: flags.gist ? "gist" : cfgShareStore.get(settings),
			obfuscator,
		});
		const lines = [`Share URL: ${result.url}`];
		if (result.gistUrl) lines.push(`Gist: ${result.gistUrl}`);
		if (result.truncated) lines.push("Note: large content was trimmed to fit the share size limit.");
		console.log(lines.join("\n"));
	}
}
