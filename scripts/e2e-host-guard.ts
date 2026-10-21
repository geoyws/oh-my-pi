/**
 * Fail-closed host admission for e2e and container entrypoints.
 *
 * George banned every omp e2e run on the physical MacBook (2026-10-20, kb
 * registry rule g-ca3365d2, medic t-0f16b107, omp t-f4235ef8): native Darwin,
 * OrbStack, Docker and Linux guests alike, with no automatic Mac fallback.
 * geoyws e2e runs on @@hal only, a bare-metal Linux host.
 *
 * The guard therefore admits only a host it can prove is bare-metal Linux,
 * and for container work only a local, non-VM-backed Docker engine. Any probe
 * it cannot read is a refusal. There is deliberately no override: no flag or
 * environment variable admits a refused host.
 *
 * Callers run it before creating any workload (scratch, clone, image,
 * container, agent process). CLI:
 *
 *   bun scripts/e2e-host-guard.ts <e2e|container> <entrypoint>
 *
 * exits 0 when admitted and 77 (EX_NOPERM) when refused.
 */
import * as fs from "node:fs";
import * as os from "node:os";

/** `e2e` checks the host; `container` also checks the Docker engine it would drive. */
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
	readonly kernelRelease: string;
	readonly hostname: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	exists(path: string): boolean;
	readText(path: string): string | null;
	/** `systemd-detect-virt` output (`none` on bare metal); null when it cannot be run. */
	detectVirt(): string | null;
	/** Identity of the engine `docker` would talk to; null when it cannot be read. */
	dockerEngine(): DockerEngineIdentity | null;
}

/** Exit status for a refused host (sysexits EX_NOPERM). */
export const E2E_HOST_REFUSED_EXIT = 77;

const POLICY = "omp e2e and container runs are banned on the physical Mac; run them on @@hal (kb rule g-ca3365d2)";

const GUEST_KERNEL = /orbstack|linuxkit|microsoft|wsl/i;
const GUEST_MARKERS = ["/.dockerenv", "/run/.containerenv", "/opt/orbstack-guest"];
const DMI_FILES = ["/sys/class/dmi/id/sys_vendor", "/sys/class/dmi/id/product_name"];
const GUEST_DMI = /apple|qemu|kvm|vmware|virtualbox|parallels|utm|bochs|xen|microsoft|google compute|amazon ec2/i;
const VM_BACKED_ENGINE = /orbstack|docker desktop|linuxkit|colima|rancher|lima|podman machine/i;
const LOCAL_DOCKER_SOCKET = "unix:///var/run/docker.sock";

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
	if (probe.platform === "darwin") return "native Darwin host (physical Mac)";
	if (probe.platform !== "linux") return `unsupported platform ${probe.platform}`;
	if (GUEST_KERNEL.test(probe.kernelRelease)) return `guest kernel ${probe.kernelRelease}`;
	for (const marker of GUEST_MARKERS) {
		if (probe.exists(marker)) return `container or VM guest marker ${marker}`;
	}
	for (const file of DMI_FILES) {
		const value = probe.readText(file)?.trim();
		if (value && GUEST_DMI.test(value)) return `virtual hardware ${file}=${value}`;
	}
	const virt = probe.detectVirt()?.trim();
	if (!virt) return "cannot prove bare metal: systemd-detect-virt unavailable";
	if (virt !== "none") return `virtualized host (systemd-detect-virt: ${virt})`;
	if (kind === "e2e") return null;

	const dockerHost = probe.env.DOCKER_HOST?.trim();
	if (dockerHost && dockerHost !== LOCAL_DOCKER_SOCKET) return `DOCKER_HOST points away from the local engine (${dockerHost})`;
	const dockerContext = probe.env.DOCKER_CONTEXT?.trim();
	if (dockerContext && dockerContext !== "default") return `DOCKER_CONTEXT is ${dockerContext}, not default`;
	const engine = probe.dockerEngine();
	if (!engine) return "cannot read the docker engine identity";
	if (VM_BACKED_ENGINE.test(engine.operatingSystem)) return `VM-backed docker engine (${engine.operatingSystem})`;
	if (engine.name !== probe.hostname) return `docker engine runs on ${engine.name}, not this host ${probe.hostname}`;
	return null;
}

function runText(argv: string[], searchPath: string | undefined, acceptExit: (code: number) => boolean): string | null {
	try {
		const result = Bun.spawnSync(argv, {
			env: { ...process.env, PATH: searchPath },
			stdout: "pipe",
			stderr: "pipe",
			timeout: 20_000,
		});
		if (!acceptExit(result.exitCode ?? -1)) return null;
		return result.stdout.toString("utf-8").trim();
	} catch {
		return null;
	}
}

/** The probe for the machine this process runs on; `searchPath` locates systemd-detect-virt and docker. */
export function liveE2eHostProbe(searchPath: string | undefined = process.env.PATH): E2eHostProbe {
	return {
		platform: process.platform,
		kernelRelease: os.release(),
		hostname: os.hostname(),
		env: process.env,
		exists: path => fs.existsSync(path),
		readText: path => {
			try {
				return fs.readFileSync(path, "utf-8");
			} catch {
				return null;
			}
		},
		// Exit 1 with "none" is the bare-metal answer.
		detectVirt: () => runText(["systemd-detect-virt"], searchPath, code => code === 0 || code === 1),
		dockerEngine: () => {
			const out = runText(
				["docker", "info", "--format", "{{.OperatingSystem}}\t{{.Name}}"],
				searchPath,
				code => code === 0,
			);
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
	console.error(`${entrypoint}: ${kind} host admitted (${probe.hostname}, bare-metal ${probe.platform})`);
	return 0;
}

if (import.meta.main) process.exit(runE2eHostGuardCli(process.argv.slice(2)));
