import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	__resetDirsFromEnvForTests,
	getStatsDashboardTokenPath,
	loadOrCreateCapabilityToken,
	TempDir,
} from "@oh-my-pi/pi-utils";
import {
	recoverStatsPort,
	STATS_DASHBOARD_CHALLENGE_HEADER,
	STATS_DASHBOARD_HEADER,
	STATS_DASHBOARD_HOSTNAME,
	STATS_DASHBOARD_HOSTNAME_HEADER,
	STATS_DASHBOARD_PROOF_HEADER,
	STATS_DASHBOARD_SECURITY_VERSION,
	statsDashboardProof,
} from "../src/port-conflict";
import { startServer } from "../src/server";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-auth-");

// The dashboard token is profile-independent (base root), so point XDG state
// at a temp dir to keep the token file out of the real home. The `omp`
// app root must exist for the resolver to accept the XDG override.
let xdgDir: TempDir | null = null;

beforeEach(() => {
	xdgDir = TempDir.createSync("@pi-stats-auth-xdg-");
	fs.mkdirSync(path.join(xdgDir.path(), "omp"), { recursive: true });
	process.env.XDG_STATE_HOME = xdgDir.path();
	__resetDirsFromEnvForTests();
});

afterEach(() => {
	delete process.env.XDG_STATE_HOME;
	__resetDirsFromEnvForTests();
	xdgDir?.removeSync();
	xdgDir = null;
});

function dashboardToken(): string {
	return loadOrCreateCapabilityToken(getStatsDashboardTokenPath());
}

describe("stats dashboard auth", () => {
	it("rejects unauthenticated API and SSE reads with 401", async () => {
		const server = await startServer(0);
		try {
			const base = `http://${server.hostname}:${server.port}`;
			for (const target of ["/api/stats/models", "/api/session/entry?file=x&id=y", "/api/sessions", "/api/events"]) {
				const response = await fetch(`${base}${target}`);
				expect(response.status).toBe(401);
				expect(response.headers.get(STATS_DASHBOARD_HEADER)).toBe(STATS_DASHBOARD_SECURITY_VERSION);
				expect(response.headers.get(STATS_DASHBOARD_HOSTNAME_HEADER)).toBe(server.hostname);
				await response.body?.cancel();
			}
		} finally {
			server.stop();
		}
	});

	it("authorises bearer requests", async () => {
		const server = await startServer(0);
		try {
			const response = await fetch(`http://${server.hostname}:${server.port}/api/stats/models`, {
				headers: { Authorization: `Bearer ${dashboardToken()}` },
			});
			expect(response.status).toBe(200);
			expect(response.headers.get(STATS_DASHBOARD_HEADER)).toBe(STATS_DASHBOARD_SECURITY_VERSION);
			await response.body?.cancel();
		} finally {
			server.stop();
		}
	});

	it("never puts the capability in a host-wide cookie, and a cookie does not authenticate", async () => {
		const server = await startServer(0);
		try {
			const base = `http://${server.hostname}:${server.port}`;
			const page = await fetch(`${base}/?token=${dashboardToken()}`, { redirect: "manual" });
			expect(page.status).not.toBe(401);
			expect(page.headers.get("set-cookie")).toBeNull();
			expect(page.headers.get("referrer-policy")).toBe("no-referrer");
			await page.body?.cancel();

			const cookieOnly = await fetch(`${base}/api/stats/models`, {
				headers: { Cookie: `omp_stats_token=${dashboardToken()}` },
			});
			expect(cookieOnly.status).toBe(401);
			await cookieOnly.body?.cancel();
		} finally {
			server.stop();
		}
	});

	it("accepts a ?token= query only for the event stream", async () => {
		const server = await startServer(0);
		try {
			const base = `http://${server.hostname}:${server.port}`;
			const events = await fetch(`${base}/api/events?token=${dashboardToken()}`);
			expect(events.status).toBe(200);
			await events.body?.cancel();

			const wrong = await fetch(`${base}/api/events?token=wrong-token`);
			expect(wrong.status).toBe(401);
			await wrong.body?.cancel();

			const otherApi = await fetch(`${base}/api/stats/models?token=${dashboardToken()}`);
			expect(otherApi.status).toBe(401);
			await otherApi.body?.cancel();
		} finally {
			server.stop();
		}
	});

	it("answers a reuse challenge with a port-bound proof, never the token", async () => {
		const server = await startServer(0);
		try {
			const challenge = "c".repeat(32);
			const response = await fetch(`http://${server.hostname}:${server.port}/api/stats/models`, {
				headers: { [STATS_DASHBOARD_CHALLENGE_HEADER]: challenge },
			});
			expect(response.status).toBe(401);
			const proof = response.headers.get(STATS_DASHBOARD_PROOF_HEADER);
			expect(proof).toBe(statsDashboardProof(dashboardToken(), server.hostname, server.port, challenge));
			expect(proof).not.toBe(statsDashboardProof(dashboardToken(), server.hostname, server.port + 1, challenge));
			for (const [, value] of response.headers) expect(value).not.toContain(dashboardToken());
			expect(await response.text()).not.toContain(dashboardToken());
		} finally {
			server.stop();
		}
	});

	it("never sends the capability to whatever holds the port", async () => {
		const seen: string[] = [];
		const holder = Bun.serve({
			port: 0,
			hostname: STATS_DASHBOARD_HOSTNAME,
			fetch: request => {
				for (const [name, value] of request.headers) seen.push(`${name}: ${value}`);
				return Response.json([], {
					headers: {
						[STATS_DASHBOARD_HEADER]: STATS_DASHBOARD_SECURITY_VERSION,
						[STATS_DASHBOARD_HOSTNAME_HEADER]: STATS_DASHBOARD_HOSTNAME,
					},
				});
			},
		});
		try {
			// Held by this process, so the probe ends in a refusal; what matters is what it sent.
			await expect(recoverStatsPort(holder.port)).rejects.toThrow();
			expect(seen.length).toBeGreaterThan(0);
			expect(seen.join("\n")).not.toContain(dashboardToken());
			expect(seen.some(line => line.startsWith("authorization:"))).toBe(false);
		} finally {
			holder.stop(true);
		}
	});

	it("does not reuse a listener relaying a genuine dashboard's proof from another port", async () => {
		const genuine = await startServer(0);
		const relay = Bun.serve({
			port: 0,
			hostname: STATS_DASHBOARD_HOSTNAME,
			fetch: async request => {
				const upstream = await fetch(`http://${genuine.hostname}:${genuine.port}/api/stats/models`, {
					headers: { [STATS_DASHBOARD_CHALLENGE_HEADER]: request.headers.get(STATS_DASHBOARD_CHALLENGE_HEADER) ?? "" },
				});
				await upstream.body?.cancel();
				return new Response("relayed", { status: 401, headers: upstream.headers });
			},
		});
		try {
			await expect(recoverStatsPort(relay.port)).rejects.toThrow();
		} finally {
			relay.stop(true);
			genuine.stop();
		}
	});

	it("refuses a rebinding Host even with a valid bearer", async () => {
		const server = await startServer(0);
		try {
			const response = await fetch(`http://${server.hostname}:${server.port}/api/stats/models`, {
				headers: { Authorization: `Bearer ${dashboardToken()}`, Host: `evil.example:${server.port}` },
			});
			expect(response.status).toBe(403);
			expect(response.headers.get(STATS_DASHBOARD_HEADER)).toBe(STATS_DASHBOARD_SECURITY_VERSION);
			await response.body?.cancel();
		} finally {
			server.stop();
		}
	});

	it("refuses a foreign Origin but passes a same-origin one", async () => {
		const server = await startServer(0);
		try {
			const base = `http://${server.hostname}:${server.port}`;
			const bearer = `Bearer ${dashboardToken()}`;
			const evil = await fetch(`${base}/api/stats/models`, {
				headers: { Authorization: bearer, Origin: "http://evil.example" },
			});
			expect(evil.status).toBe(403);
			expect(evil.headers.get(STATS_DASHBOARD_HEADER)).toBe(STATS_DASHBOARD_SECURITY_VERSION);
			await evil.body?.cancel();

			const sameOrigin = await fetch(`${base}/api/stats/models`, {
				headers: { Authorization: bearer, Origin: `http://${server.hostname}:${server.port}` },
			});
			expect(sameOrigin.status).toBe(200);
			await sameOrigin.body?.cancel();
		} finally {
			server.stop();
		}
	});

	it("classifies a live dashboard proving the same token as reusable", async () => {
		const server = await startServer(0);
		try {
			expect(STATS_DASHBOARD_HOSTNAME).toBe(server.hostname);
			expect(await recoverStatsPort(server.port)).toBe("reuse");
		} finally {
			server.stop();
		}
	});
});
