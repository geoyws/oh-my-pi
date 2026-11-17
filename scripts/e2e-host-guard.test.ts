import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	assertE2eHost,
	E2E_HOST_REFUSED_EXIT,
	type E2eHostProbe,
	E2eHostRefusedError,
	e2eHostRefusal,
	liveE2eHostProbe,
	runE2eHostGuardCli,
} from "./e2e-host-guard";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A PATH directory holding only the given shell scripts. */
function fakeBin(scripts: Record<string, string>): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-host-guard-"));
	tempDirs.push(dir);
	for (const [name, body] of Object.entries(scripts)) {
		fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	}
	return dir;
}

/** A Linux host (bare metal, VM or container) with a local Debian docker engine. */
function linuxHost(overrides: Partial<E2eHostProbe> = {}): E2eHostProbe {
	return {
		platform: "linux",
		hostname: "hal",
		env: {},
		dockerEngine: () => ({ operatingSystem: "Debian GNU/Linux 13 (trixie)", name: "hal" }),
		...overrides,
	};
}

/** @@mbp native: Darwin driving OrbStack's docker engine. */
function mbp(overrides: Partial<E2eHostProbe> = {}): E2eHostProbe {
	return linuxHost({
		platform: "darwin",
		hostname: "geoywsMBP",
		dockerEngine: () => ({ operatingSystem: "OrbStack", name: "orbstack" }),
		...overrides,
	});
}

const BYPASS_ATTEMPTS = {
	OMP_E2E_ALLOW_MBP: "1",
	OMP_E2E_HOST_GUARD: "0",
	MEDIC_GATE_DISABLE: "1",
	E2E_FORCE: "1",
	CI: "true",
};

const DARWIN_E2E = "native Darwin host: run e2e in a Linux container (OrbStack on @@mbp)";

describe("e2eHostRefusal", () => {
	test("admits any Linux host for e2e: @@hal bare metal, an OrbStack container on @@mbp, the IFCA host shape", () => {
		expect(e2eHostRefusal("e2e", linuxHost())).toBeNull();
		expect(e2eHostRefusal("e2e", linuxHost({ hostname: "8f2c1a9e0b7d" }))).toBeNull();
		expect(e2eHostRefusal("e2e", linuxHost({ hostname: "hig" }))).toBeNull();
	});

	test("admits container work on @@hal and on @@mbp through OrbStack", () => {
		expect(e2eHostRefusal("container", linuxHost())).toBeNull();
		expect(e2eHostRefusal("container", linuxHost({ env: { DOCKER_HOST: "unix:///var/run/docker.sock" } }))).toBeNull();
		expect(e2eHostRefusal("container", mbp())).toBeNull();
		expect(
			e2eHostRefusal("container", mbp({ env: { DOCKER_HOST: "unix:///Users/geoyws/.orbstack/run/docker.sock" } })),
		).toBeNull();
	});

	test("refuses native Darwin e2e whatever the environment says", () => {
		expect(e2eHostRefusal("e2e", mbp({ env: BYPASS_ATTEMPTS }))).toBe(DARWIN_E2E);
	});

	test("e2e work never asks for the docker engine", () => {
		let dockerAsked = false;
		const host = linuxHost({
			dockerEngine: () => {
				dockerAsked = true;
				return null;
			},
			env: { DOCKER_HOST: "ssh://geoyws@hal" },
		});
		expect(e2eHostRefusal("e2e", host)).toBeNull();
		expect(dockerAsked).toBe(false);
	});

	test.each(["win32", "freebsd"] as const)("refuses unsupported platform %s for both kinds", platform => {
		expect(e2eHostRefusal("e2e", linuxHost({ platform }))).toBe(`unsupported platform ${platform}`);
		expect(e2eHostRefusal("container", linuxHost({ platform }))).toBe(`unsupported platform ${platform}`);
	});

	test.each(["ssh://geoyws@geoywsMBP.local", "tcp://10.0.0.5:2375", " tcp://hal:2376 "])(
		"refuses a docker client pointed at remote engine %s",
		dockerHost => {
			expect(e2eHostRefusal("container", linuxHost({ env: { DOCKER_HOST: dockerHost } }))).toBe(
				`DOCKER_HOST points away from this machine (${dockerHost.trim()})`,
			);
			expect(e2eHostRefusal("container", mbp({ env: { DOCKER_HOST: dockerHost } }))).toBe(
				`DOCKER_HOST points away from this machine (${dockerHost.trim()})`,
			);
		},
	);

	test("refuses container work when the docker engine cannot be read", () => {
		expect(e2eHostRefusal("container", linuxHost({ dockerEngine: () => null }))).toBe(
			"cannot read the docker engine identity",
		);
		expect(e2eHostRefusal("container", mbp({ dockerEngine: () => null }))).toBe(
			"cannot read the docker engine identity",
		);
	});

	test("checks DOCKER_HOST before asking the engine", () => {
		let dockerAsked = false;
		const host = linuxHost({
			env: { DOCKER_HOST: "tcp://10.0.0.5:2375" },
			dockerEngine: () => {
				dockerAsked = true;
				return { operatingSystem: "Debian GNU/Linux 13 (trixie)", name: "hal" };
			},
		});
		expect(e2eHostRefusal("container", host)).not.toBeNull();
		expect(dockerAsked).toBe(false);
	});
});

describe("assertE2eHost", () => {
	test("throws a refusal naming the entrypoint, reason and placement policy", () => {
		expect(() => assertE2eHost("e2e", "eval/run.ts", mbp())).toThrow(E2eHostRefusedError);
		try {
			assertE2eHost("e2e", "eval/run.ts", mbp());
		} catch (err) {
			const refusal = err as E2eHostRefusedError;
			expect(refusal.entrypoint).toBe("eval/run.ts");
			expect(refusal.reason).toBe(DARWIN_E2E);
			expect(refusal.message).toContain("@@mbp first");
			expect(refusal.message).toContain("a-80d0010b");
		}
	});

	test("returns on an admitted host", () => {
		expect(() => assertE2eHost("container", "omp-gate", linuxHost())).not.toThrow();
		expect(() => assertE2eHost("container", "omp-gate", mbp())).not.toThrow();
	});
});

describe("runE2eHostGuardCli", () => {
	test("exits 0 when admitted and EX_NOPERM when refused", () => {
		expect(runE2eHostGuardCli(["e2e", "test:e2e"], linuxHost())).toBe(0);
		expect(runE2eHostGuardCli(["container", "pi:image"], mbp())).toBe(0);
		expect(runE2eHostGuardCli(["e2e", "test:e2e"], mbp())).toBe(E2E_HOST_REFUSED_EXIT);
		expect(runE2eHostGuardCli(["container", "pi:image"], linuxHost({ dockerEngine: () => null }))).toBe(
			E2E_HOST_REFUSED_EXIT,
		);
	});

	test.each([[[]], [["e2e"]], [["vm", "x"]], [["e2e", "x", "extra"]]])("rejects usage %j", argv => {
		expect(runE2eHostGuardCli(argv, linuxHost())).toBe(2);
	});

	test("rethrows anything that is not a refusal", () => {
		const broken = linuxHost({
			dockerEngine: () => {
				throw new Error("probe bug");
			},
		});
		expect(() => runE2eHostGuardCli(["container", "x"], broken)).toThrow("probe bug");
	});

	test.if(process.platform === "darwin")("the real CLI refuses native Darwin e2e even with bypass variables set", () => {
		const result = Bun.spawnSync(["bun", path.join(import.meta.dir, "e2e-host-guard.ts"), "e2e", "probe"], {
			env: { ...process.env, ...BYPASS_ATTEMPTS },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(E2E_HOST_REFUSED_EXIT);
		expect(result.stderr.toString()).toContain(DARWIN_E2E);
	});
});

describe.skipIf(process.platform === "win32")("liveE2eHostProbe", () => {
	test("reports this process's platform and hostname", () => {
		const probe = liveE2eHostProbe();
		expect(probe.platform).toBe(process.platform);
		expect(probe.hostname).toBe(os.hostname());
	});

	test("reads the docker engine identity", () => {
		const printf = (out: string) => ({ docker: `printf '${out}\\n'` });
		expect(liveE2eHostProbe(fakeBin(printf("Debian GNU/Linux 13 (trixie)\\thal"))).dockerEngine()).toEqual({
			operatingSystem: "Debian GNU/Linux 13 (trixie)",
			name: "hal",
		});
		expect(liveE2eHostProbe(fakeBin(printf("OrbStack\\torbstack"))).dockerEngine()).toEqual({
			operatingSystem: "OrbStack",
			name: "orbstack",
		});
		expect(liveE2eHostProbe(fakeBin(printf("OrbStack"))).dockerEngine()).toBeNull();
		expect(liveE2eHostProbe(fakeBin({ docker: "echo 'Cannot connect' >&2; exit 1" })).dockerEngine()).toBeNull();
		expect(liveE2eHostProbe(fakeBin({})).dockerEngine()).toBeNull();
	});
});
