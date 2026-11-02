import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadAmbientExtensionEntries } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { cfgExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { approveProjectSurfaces, getProjectTrustStorePath } from "@oh-my-pi/pi-utils/project-trust";

/**
 * `omp trust --yes` for a test project (kb omp t-f77ec1f5): approve the MCP
 * servers and extension code `dir` supplies now, measured from the same inputs
 * `omp trust` measures. Call it after writing the project's config; a later
 * change to that code or config revokes the approval, as it does for a user.
 * `agentDir` names the agent dir a spawned CLI will read (`PI_CODING_AGENT_DIR`);
 * by default the approval goes to this process's agent dir.
 */
export async function approveProjectForTest(dir: string, agentDir?: string): Promise<void> {
	clearFsCache();
	const settings = await Settings.init({ inMemory: true, cwd: dir });
	const mcp = await loadAllMCPConfigs(dir, { enableProjectConfig: true, filterExa: false });
	const extensions = await loadAmbientExtensionEntries(
		dir,
		{ cwd: dir },
		true,
		settings.extensionsSourceLevel() === "project" ? cfgExtensions.get(settings) : [],
	);
	approveProjectSurfaces(
		dir,
		{ mcp: mcp.projectTrust?.fingerprint, extensions: extensions.projectFingerprint },
		agentDir === undefined ? undefined : getProjectTrustStorePath(agentDir),
	);
	clearFsCache();
}
