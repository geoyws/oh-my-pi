/**
 * Fail-closed host admission for e2e and container entrypoints.
 *
 * Placement (George 2026-11-17, medic attention a-80d0010b "all-mbp"; skill
 * /placement "mbp builds and tests first"): omp e2e runs on @@mbp first, in
 * an OrbStack Linux container, with @@hal only as overflow on a measured
 * @@mbp floor breach. Which host runs is gate-slot's call, not this guard's.
 * This replaces the 2026-10-20 physical-Mac ban (kb registry rule g-ca3365d2,
 * omp t-f4235ef8) and its @@hal-only allowlist (omp t-caa0cdeb).
 *
 * What the guard still refuses: e2e work outside Linux (native Darwin runs it
 * in a Linux container instead), any platform it does not know, and container
 * work whose docker client points at a remote engine or whose engine it cannot
 * read. Any probe it cannot read is a refusal. There is deliberately no
 * override: no flag or environment variable admits a refused host.
 *
 * Callers run it before creating any workload (scratch, clone, image,
 * container, agent process). CLI:
 *
 *   bun scripts/e2e-host-guard.ts <e2e|container> <entrypoint>
 *
 * exits 0 when admitted and 77 (EX_NOPERM) when refused.
 */
import * as os from "node:os";

/** `e2e` checks the host; `container` checks the Docker engine it would drive. */
export type E2eWorkloadKind = "e2e" | "container";

export interface DockerEngineIdentity {
	/** `docker info` OperatingSystem, e.g. "Debian GNU/Linux 13 (trixie)" or "OrbStack". */
	readonly operatingSystem: string;
	/** `docker info` Name: the engine host's hostname. */
	readonly name: string;
}

/** Everything the guard reads about the host. Injected so tests never depend on the machine they run on. */
export interface E2eHostProbe {
	readonly platform: NodeJS.Platform;
	readonly hostname: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** Identity of the engine `docker` would talk to; null when it cannot be read. */
	dockerEngine(): DockerEngineIdentity | null;
}

/** Exit status for a refused host (sysexits EX_NOPERM). */
export const E2E_HOST_REFUSED_EXIT = 77;

const POLICY =
	"omp e2e runs in a Linux container on @@mbp first, @@hal only as overflow on a measured @@mbp floor breach (medic a-80d0010b, /placement)";

/** A docker endpoint on this machine: a unix socket (/var/run/docker.sock, OrbStack's ~/.orbstack/run/docker.sock). */
const LOCAL_DOCKER_HOST = /^unix:\/\//;

export class E2eHostRefusedError extends Error {
	constructor(
		readonly entrypoint: string,
		readonly reason: string,
	) {
		super(`${entrypoint}: refused before any workload: ${reason}. ${POLICY}.`);
		this.name = "E2eHostRefusedError";
	}
}

/** Why this host may not run `kind` work, or null when it is admitted. Pure over the probe. */
export function e2eHostRefusal(kind: E2eWorkloadKind, probe: E2eHostProbe): string | null {
	if (probe.platform !== "linux" && probe.platform !== "darwin") return `unsupported platform ${probe.platform}`;
	if (kind === "e2e")
		return probe.platform === "linux" ? null : "native Darwin host: run e2e in a Linux container (OrbStack on @@mbp)";

	const dockerHost = probe.env.DOCKER_HOST?.trim();
	if (dockerHost && !LOCAL_DOCKER_HOST.test(dockerHost))
		return `DOCKER_HOST points away from this machine (${dockerHost})`;
	if (!probe.dockerEngine()) return "cannot read the docker engine identity";
	return null;
}

/** Trimmed stdout of `argv`, or null when it cannot run or exits non-zero. */
function runText(argv: string[], searchPath: string | undefined): string | null {
	try {
		const result = Bun.spawnSync(argv, {
			env: { ...process.env, PATH: searchPath },
			stdout: "pipe",
			stderr: "pipe",
			timeout: 20_000,
		});
		if (result.exitCode !== 0) return null;
		return result.stdout.toString("utf-8").trim();
	} catch {
		return null;
	}
}

/** The probe for the machine this process runs on; `searchPath` locates docker. */
export function liveE2eHostProbe(searchPath: string | undefined = process.env.PATH): E2eHostProbe {
	return {
		platform: process.platform,
		hostname: os.hostname(),
		env: process.env,
		dockerEngine: () => {
			const out = runText(["docker", "info", "--format", "{{.OperatingSystem}}\t{{.Name}}"], searchPath);
			if (!out) return null;
			const [operatingSystem, name] = out.split("\t");
			if (!operatingSystem || !name) return null;
			return { operatingSystem, name };
		},
	};
}

/** Throw E2eHostRefusedError unless this host may run `kind` work for `entrypoint`. */
export function assertE2eHost(
	kind: E2eWorkloadKind,
	entrypoint: string,
	probe: E2eHostProbe = liveE2eHostProbe(),
): void {
	const reason = e2eHostRefusal(kind, probe);
	if (reason !== null) throw new E2eHostRefusedError(entrypoint, reason);
}

/** CLI body; returns the exit status. */
export function runE2eHostGuardCli(argv: string[], probe: E2eHostProbe = liveE2eHostProbe()): number {
	const [kind, entrypoint, ...rest] = argv;
	if ((kind !== "e2e" && kind !== "container") || !entrypoint || rest.length > 0) {
		console.error("usage: e2e-host-guard.ts <e2e|container> <entrypoint>");
		return 2;
	}
	try {
		assertE2eHost(kind, entrypoint, probe);
	} catch (err) {
		if (!(err instanceof E2eHostRefusedError)) throw err;
		console.error(err.message);
		return E2E_HOST_REFUSED_EXIT;
	}
	console.error(`${entrypoint}: ${kind} host admitted (${probe.hostname}, ${probe.platform})`);
	return 0;
}

if (import.meta.main) process.exit(runE2eHostGuardCli(process.argv.slice(2)));
