import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getConfigRootDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { approveProjectSurfaces, revokeProjectTrust } from "@oh-my-pi/pi-utils/project-trust";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";

const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
let agentDir = "";
let projectDir = "";

beforeEach(async () => {
	agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ctx-trust-agent-"));
	projectDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-ctx-trust-project-")));
	setAgentDir(agentDir);
});

afterEach(async () => {
	if (originalAgentDirEnv) {
		setAgentDir(originalAgentDirEnv);
	} else {
		setAgentDir(path.join(getConfigRootDir(), "agent"));
		delete process.env.PI_CODING_AGENT_DIR;
	}
	await removeWithRetries(agentDir);
	await removeWithRetries(projectDir);
});

describe("ExtensionContext project trust (kb omp t-81f67b33)", () => {
	it("reflects the `omp trust` store for the session's directory", () => {
		const runner = new ExtensionRunner(
			[],
			{} as never,
			projectDir,
			{ getCwd: () => projectDir } as never,
			{} as never,
		);
		const ctx = runner.createContext();

		expect(ctx.isProjectTrusted()).toBe(false);
		approveProjectSurfaces(projectDir, { tools: "sha256:approved" });
		expect(ctx.isProjectTrusted()).toBe(true);
		revokeProjectTrust(projectDir);
		expect(ctx.isProjectTrusted()).toBe(false);
	});
});
