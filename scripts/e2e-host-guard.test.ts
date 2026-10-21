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

/** @@hal: bare-metal Linux, its machine-id, a local Debian docker engine. */
function bareLinux(overrides: Partial<E2eHostProbe> & { files?: Record<string, string> } = {}): E2eHostProbe {
	const files: Record<string, string> = {
		"/sys/class/dmi/id/sys_vendor": "Hetzner\n",
		"/etc/machine-id": "f8916e3bb2ff407685a97b3be9b3abd1\n",
		...overrides.files,
	};
	return {
		platform: "linux",
		kernelRelease: "6.12.94+deb13-amd64",
		hostname: "hal",
		env: {},
		exists: p => p in files,
		readText: p => files[p] ?? null,
		detectVirt: () => "none",
		dockerEngine: () => ({ operatingSystem: "Debian GNU/Linux 13 (trixie)", name: "hal" }),
		...overrides,
	};
}

const BYPASS_ATTEMPTS = {
	OMP_E2E_ALLOW_MBP: "1",
	OMP_E2E_HOST_GUARD: "0",
	MEDIC_GATE_DISABLE: "1",
	E2E_FORCE: "1",
	CI: "true",
};

describe("e2eHostRefusal", () => {
	test("admits @@hal for e2e and container work", () => {
		expect(e2eHostRefusal("e2e", bareLinux())).toBeNull();
		expect(e2eHostRefusal("container", bareLinux())).toBeNull();
		expect(
			e2eHostRefusal(
				"container",
				bareLinux({ env: { DOCKER_HOST: "unix:///var/run/docker.sock", DOCKER_CONTEXT: "default" } }),
			),
		).toBeNull();
	});

	test("refuses a bare-metal Linux host that is not on the allowlist", () => {
		// The IFCA test host @@hig shape: bare metal, local engine, different identity.
		const hig = bareLinux({
			hostname: "hig",
			kernelRelease: "6.8.0-124-generic",
			files: { "/etc/machine-id": "0123456789abcdef0123456789abcdef\n" },
			dockerEngine: () => ({ operatingSystem: "Ubuntu 24.04.4 LTS", name: "hig" }),
		});
		expect(e2eHostRefusal("e2e", hig)).toBe("hig is not an approved e2e host (@@hal)");
		expect(e2eHostRefusal("container", hig)).toBe("hig is not an approved e2e host (@@hal)");
	});

	test("refuses a host named hal without hal's machine-id", () => {
		const reason = "hal is not an approved e2e host (@@hal)";
		expect(
			e2eHostRefusal("e2e", bareLinux({ files: { "/etc/machine-id": "ffffffffffffffffffffffffffffffff\n" } })),
		).toBe(reason);
		const noMachineId = bareLinux();
		expect(
			e2eHostRefusal("e2e", {
				...noMachineId,
				readText: p => (p === "/etc/machine-id" ? null : noMachineId.readText(p)),
			}),
		).toBe(reason);
	});

	test("refuses native Darwin whatever the environment says", () => {
		const mac = bareLinux({ platform: "darwin", kernelRelease: "27.0.0", env: BYPASS_ATTEMPTS });
		expect(e2eHostRefusal("e2e", mac)).toBe("native Darwin host (physical Mac)");
		expect(e2eHostRefusal("container", mac)).toBe("native Darwin host (physical Mac)");
	});

	test("refuses platforms it does not know", () => {
		expect(e2eHostRefusal("e2e", bareLinux({ platform: "win32" }))).toBe("unsupported platform win32");
	});

	test.each([
		["6.17.8-orbstack-00308-g8f9c941121b1", "OrbStack"],
		["6.10.14-linuxkit", "Docker Desktop"],
		["5.15.167.4-microsoft-standard-WSL2", "WSL"],
	])("refuses guest kernel %s (%s)", kernelRelease => {
		expect(e2eHostRefusal("e2e", bareLinux({ kernelRelease }))).toBe(`guest kernel ${kernelRelease}`);
	});

	test.each(["/.dockerenv", "/run/.containerenv", "/opt/orbstack-guest"])("refuses guest marker %s", marker => {
		expect(e2eHostRefusal("e2e", bareLinux({ files: { [marker]: "" } }))).toBe(
			`container or VM guest marker ${marker}`,
		);
	});

	test.each([
		["/sys/class/dmi/id/sys_vendor", "Apple Inc."],
		["/sys/class/dmi/id/product_name", "Apple Virtualization Generic Platform"],
		["/sys/class/dmi/id/sys_vendor", "QEMU"],
		["/sys/class/dmi/id/product_name", "VMware Virtual Platform"],
	])("refuses virtual hardware %s=%s", (file, value) => {
		expect(e2eHostRefusal("e2e", bareLinux({ files: { [file]: `${value}\n` } }))).toBe(
			`virtual hardware ${file}=${value}`,
		);
	});

	test.each(["apple", "kvm", "qemu", "docker", "podman", "wsl"])("refuses systemd-detect-virt %s", virt => {
		expect(e2eHostRefusal("e2e", bareLinux({ detectVirt: () => `${virt}\n` }))).toBe(
			`virtualized host (systemd-detect-virt: ${virt})`,
		);
	});

	test("refuses when bare metal cannot be proved", () => {
		const reason = "cannot prove bare metal: systemd-detect-virt unavailable";
		expect(e2eHostRefusal("e2e", bareLinux({ detectVirt: () => null }))).toBe(reason);
		expect(e2eHostRefusal("e2e", bareLinux({ detectVirt: () => "  " }))).toBe(reason);
	});

	test("refuses a docker client pointed away from the local engine", () => {
		expect(e2eHostRefusal("container", bareLinux({ env: { DOCKER_HOST: "ssh://geoyws@geoywsMBP.local" } }))).toBe(
			"DOCKER_HOST points away from the local engine (ssh://geoyws@geoywsMBP.local)",
		);
		expect(e2eHostRefusal("container", bareLinux({ env: { DOCKER_CONTEXT: "orbstack" } }))).toBe(
			"DOCKER_CONTEXT is orbstack, not default",
		);
		// The host-only e2e kind does not drive docker, so docker settings do not matter to it.
		expect(e2eHostRefusal("e2e", bareLinux({ env: { DOCKER_CONTEXT: "orbstack" } }))).toBeNull();
	});

	test("refuses an unreadable, VM-backed or remote docker engine", () => {
		expect(e2eHostRefusal("container", bareLinux({ dockerEngine: () => null }))).toBe(
			"cannot read the docker engine identity",
		);
		for (const operatingSystem of ["OrbStack", "Docker Desktop", "Colima"]) {
			expect(
				e2eHostRefusal("container", bareLinux({ dockerEngine: () => ({ operatingSystem, name: "hal" }) })),
			).toBe(`VM-backed docker engine (${operatingSystem})`);
		}
		expect(
			e2eHostRefusal(
				"container",
				bareLinux({ dockerEngine: () => ({ operatingSystem: "Debian GNU/Linux 13 (trixie)", name: "orbstack" }) }),
			),
		).toBe("docker engine runs on orbstack, not this host hal");
	});

	test("checks the host before the docker engine", () => {
		let dockerAsked = false;
		const mac = bareLinux({
			platform: "darwin",
			dockerEngine: () => {
				dockerAsked = true;
				return { operatingSystem: "Debian GNU/Linux 13 (trixie)", name: "hal" };
			},
		});
		expect(e2eHostRefusal("container", mac)).not.toBeNull();
		expect(dockerAsked).toBe(false);
	});
});

describe("assertE2eHost", () => {
	test("throws a refusal naming the entrypoint, reason and policy", () => {
		const mac = bareLinux({ platform: "darwin" });
		expect(() => assertE2eHost("e2e", "eval/run.ts", mac)).toThrow(E2eHostRefusedError);
		try {
			assertE2eHost("e2e", "eval/run.ts", mac);
		} catch (err) {
			const refusal = err as E2eHostRefusedError;
			expect(refusal.entrypoint).toBe("eval/run.ts");
			expect(refusal.reason).toBe("native Darwin host (physical Mac)");
			expect(refusal.message).toContain("@@hal");
			expect(refusal.message).toContain("g-ca3365d2");
		}
	});

	test("returns on an admitted host", () => {
		expect(() => assertE2eHost("container", "omp-gate", bareLinux())).not.toThrow();
	});
});

describe("runE2eHostGuardCli", () => {
	test("exits 0 when admitted and EX_NOPERM when refused", () => {
		expect(runE2eHostGuardCli(["e2e", "test:e2e"], bareLinux())).toBe(0);
		expect(runE2eHostGuardCli(["container", "pi:image"], bareLinux({ platform: "darwin" }))).toBe(
			E2E_HOST_REFUSED_EXIT,
		);
	});

	test.each([[[]], [["e2e"]], [["vm", "x"]], [["e2e", "x", "extra"]]])("rejects usage %j", argv => {
		expect(runE2eHostGuardCli(argv, bareLinux())).toBe(2);
	});

	test("rethrows anything that is not a refusal", () => {
		const broken = bareLinux({
			detectVirt: () => {
				throw new Error("probe bug");
			},
		});
		expect(() => runE2eHostGuardCli(["e2e", "x"], broken)).toThrow("probe bug");
	});

	test.if(process.platform === "darwin")("the real CLI refuses this Mac even with bypass variables set", () => {
		const result = Bun.spawnSync(["bun", path.join(import.meta.dir, "e2e-host-guard.ts"), "container", "probe"], {
			env: { ...process.env, ...BYPASS_ATTEMPTS },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(E2E_HOST_REFUSED_EXIT);
		expect(result.stderr.toString()).toContain("native Darwin host (physical Mac)");
	});
});

describe.skipIf(process.platform === "win32")("liveE2eHostProbe", () => {
	test("reports this process's platform and reads files", () => {
		const probe = liveE2eHostProbe();
		expect(probe.platform).toBe(process.platform);
		expect(probe.hostname).toBe(os.hostname());
		expect(probe.kernelRelease).toBe(os.release());
		expect(probe.exists(import.meta.path)).toBe(true);
		expect(probe.exists(path.join(import.meta.dir, "no-such-file"))).toBe(false);
		expect(probe.readText(import.meta.path)).toContain("liveE2eHostProbe");
		expect(probe.readText(path.join(import.meta.dir, "no-such-file"))).toBeNull();
	});

	test("reads systemd-detect-virt, taking exit 1 'none' as bare metal", () => {
		expect(liveE2eHostProbe(fakeBin({ "systemd-detect-virt": "echo none; exit 1" })).detectVirt()).toBe("none");
		expect(liveE2eHostProbe(fakeBin({ "systemd-detect-virt": "echo kvm" })).detectVirt()).toBe("kvm");
		expect(liveE2eHostProbe(fakeBin({ "systemd-detect-virt": "exit 2" })).detectVirt()).toBeNull();
		expect(liveE2eHostProbe(fakeBin({})).detectVirt()).toBeNull();
	});

	test("reads the docker engine identity", () => {
		const printf = (out: string) => ({ docker: `printf '${out}\\n'` });
		expect(liveE2eHostProbe(fakeBin(printf("Debian GNU/Linux 13 (trixie)\\thal"))).dockerEngine()).toEqual({
			operatingSystem: "Debian GNU/Linux 13 (trixie)",
			name: "hal",
		});
		expect(liveE2eHostProbe(fakeBin(printf("OrbStack"))).dockerEngine()).toBeNull();
		expect(liveE2eHostProbe(fakeBin({ docker: "echo 'Cannot connect' >&2; exit 1" })).dockerEngine()).toBeNull();
		expect(liveE2eHostProbe(fakeBin({})).dockerEngine()).toBeNull();
	});
});
