import { afterEach, describe, expect, it } from "bun:test";
import { authenticatedRelayDiscoveryUrl, findFreeCdpPort } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { RelayCdpAuth, relayRequestMac } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/auth";
import { type RelayServer, startRelayServer } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";
import { useTestRelayToken } from "../helpers/relay-token";

const CDP_TOKEN = useTestRelayToken();
const OPTS = { timeoutMs: 2_000 };

describe("relay discovery authentication", () => {
	let relay: RelayServer | undefined;
	let squatter: Bun.Server<undefined> | undefined;

	afterEach(() => {
		relay?.stop();
		squatter?.stop(true);
		relay = undefined;
		squatter = undefined;
	});

	async function startRelay(): Promise<number> {
		const port = await findFreeCdpPort();
		relay = startRelayServer({ port, cdpToken: CDP_TOKEN });
		return port;
	}

	it("authorizes this user's client once per nonce without the token on the wire", async () => {
		const port = await startRelay();
		const url = await authenticatedRelayDiscoveryUrl(`http://127.0.0.1:${port}`, "/json/version", OPTS);
		expect(url).not.toContain(CDP_TOKEN);
		// No extension yet: authorized discovery reports 503, refused discovery 401.
		expect((await fetch(url)).status).toBe(503);
		expect((await fetch(url)).status).toBe(401);
	});

	it("binds the MAC to the endpoint it was made for", async () => {
		const port = await startRelay();
		const url = await authenticatedRelayDiscoveryUrl(`http://127.0.0.1:${port}`, "/json/version", OPTS);
		expect((await fetch(url.replace("/json/version?", "/json/list?"))).status).toBe(401);
	});

	it("refuses a squatter relaying the exchange to this user's relay on another port", async () => {
		const relayPort = await startRelay();
		const seen: string[] = [];
		// Another OS user holds the port the client dials and forwards everything to the genuine relay.
		squatter = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async request => {
				const url = new URL(request.url);
				seen.push(request.url, request.headers.get("authorization") ?? "");
				const upstream = await fetch(`http://127.0.0.1:${relayPort}${url.pathname}${url.search}`);
				return new Response(await upstream.text(), { status: upstream.status, headers: upstream.headers });
			},
		});
		const url = await authenticatedRelayDiscoveryUrl(`http://127.0.0.1:${squatter.port}`, "/json/version", OPTS);
		const response = await fetch(url);
		expect(response.status).toBe(401);
		expect(await response.text()).not.toContain("webSocketDebuggerUrl");
		expect(seen.join("\n")).not.toContain(CDP_TOKEN);
	});

	it("gives clients of anything that issues no nonce the plain URL", async () => {
		squatter = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({}, { status: 401 }) });
		const base = `http://127.0.0.1:${squatter.port}`;
		expect(await authenticatedRelayDiscoveryUrl(base, "/json", OPTS)).toBe(`${base}/json`);
	});
});

describe("RelayCdpAuth nonces", () => {
	it("drops the oldest outstanding nonce beyond the cap", () => {
		const auth = new RelayCdpAuth(CDP_TOKEN, () => 9222);
		const macFor = (nonce: string) =>
			new URLSearchParams({ nonce, mac: relayRequestMac(CDP_TOKEN, 9222, nonce, "/json") });
		const first = auth.issueNonce();
		const issued = Array.from({ length: 256 }, () => auth.issueNonce());
		expect(auth.authorizesDiscovery("/json", macFor(first), undefined)).toBeFalse();
		expect(auth.authorizesDiscovery("/json", macFor(issued[0]!), undefined)).toBeTrue();
	});
});
