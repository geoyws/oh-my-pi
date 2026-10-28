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
	STATS_DASHBOARD_HEADER,
	STATS_DASHBOARD_HOSTNAME,
	STATS_DASHBOARD_HOSTNAME_HEADER,
	STATS_DASHBOARD_SECURITY_VERSION,
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
	it("rejects unauthenticated API, SSE, and page reads with 401", async () => {
		const server = await startServer(0);
		try {
			const base = `http://${server.hostname}:${server.port}`;
			for (const target of [
				"/api/stats/models",
				"/api/session/entry?file=x&id=y",
				"/api/sessions",
				"/api/events",
				"/",
			]) {
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

	it("bootstraps a cookie from ?token= and strips it from the URL", async () => {
		const server = await startServer(0);
		try {
			const base = `http://${server.hostname}:${server.port}`;
			const response = await fetch(`${base}/?token=${dashboardToken()}`, { redirect: "manual" });
			expect(response.status).toBe(302);
			const setCookie = response.headers.get("set-cookie") ?? "";
			expect(setCookie).toContain("omp_stats_token=");
			expect(setCookie).toContain("HttpOnly");
			expect(setCookie).toContain("SameSite=Strict");
			expect(setCookie).toContain("Path=/");
			expect(response.headers.get("cache-control")).toBe("no-store");
			const location = response.headers.get("location") ?? "";
			expect(location).not.toContain("token");
			await response.body?.cancel();

			const cookie = setCookie.split(";")[0] ?? "";
			const authed = await fetch(`${base}/api/stats/models`, { headers: { Cookie: cookie } });
			expect(authed.status).toBe(200);
			await authed.body?.cancel();
		} finally {
			server.stop();
		}
	});

	it("rejects a wrong token query with 401", async () => {
		const server = await startServer(0);
		try {
			const response = await fetch(`http://${server.hostname}:${server.port}/?token=wrong-token`, {
				redirect: "manual",
			});
			expect(response.status).toBe(401);
			expect(response.headers.get(STATS_DASHBOARD_HEADER)).toBe(STATS_DASHBOARD_SECURITY_VERSION);
			await response.body?.cancel();
		} finally {
			server.stop();
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

	it("classifies a live v4 dashboard with the same token as reusable", async () => {
		const server = await startServer(0);
		try {
			expect(STATS_DASHBOARD_HOSTNAME).toBe(server.hostname);
			expect(await recoverStatsPort(server.port)).toBe("reuse");
		} finally {
			server.stop();
		}
	});
});
