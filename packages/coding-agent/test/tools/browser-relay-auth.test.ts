import { afterEach, describe, expect, it } from "bun:test";
import { authenticatedRelayDiscoveryUrl, findFreeCdpPort } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { connectPuppeteer } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { RelayCdpAuth, relayRequestMac } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/auth";
import { type RelayServer, startRelayServer } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";
import puppeteer from "puppeteer-core";
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

	it("dials localhost as 127.0.0.1 and authorizes there", async () => {
		const port = await startRelay();
		const url = await authenticatedRelayDiscoveryUrl(`http://localhost:${port}`, "/json/version", OPTS);
		expect(url).toStartWith(`http://127.0.0.1:${port}/json/version?`);
		expect((await fetch(url)).status).toBe(503);
	});

	/** Another OS user holds the address the client dials and forwards everything to the genuine relay. */
	function startForwardingSquatter(hostname: string, port: number, relayPort: number, seen: string[]) {
		squatter = Bun.serve({
			hostname,
			port,
			fetch: async request => {
				const url = new URL(request.url);
				seen.push(request.url, request.headers.get("authorization") ?? "");
				const upstream = await fetch(`http://127.0.0.1:${relayPort}${url.pathname}${url.search}`);
				return new Response(await upstream.text(), { status: upstream.status, headers: upstream.headers });
			},
		});
		return squatter;
	}

	async function expectRefusedThrough(base: string, seen: string[]): Promise<void> {
		const url = await authenticatedRelayDiscoveryUrl(base, "/json/version", OPTS);
		const response = await fetch(url);
		expect(response.status).toBe(401);
		expect(await response.text()).not.toContain("webSocketDebuggerUrl");
		expect(seen.join("\n")).not.toContain(CDP_TOKEN);
	}

	it("refuses a squatter relaying the exchange to this user's relay on another port", async () => {
		const relayPort = await startRelay();
		const seen: string[] = [];
		const held = startForwardingSquatter("127.0.0.1", 0, relayPort, seen);
		await expectRefusedThrough(`http://127.0.0.1:${held.port}`, seen);
	});

	it("refuses a squatter on another address with the relay's own port number", async () => {
		const relayPort = await startRelay();
		const seen: string[] = [];
		// The relay binds 127.0.0.1 only, so [::1] with the same port is free for another user.
		startForwardingSquatter("::1", relayPort, relayPort, seen);
		await expectRefusedThrough(`http://[::1]:${relayPort}`, seen);
		expect(seen.length).toBeGreaterThan(0);
	});

	it("never puts a relay ticket in a failed connection's error", async () => {
		const port = await findFreeCdpPort();
		const ticket = "ticket-id.ticket-signature";
		const error = await connectPuppeteer(puppeteer, {
			browserWSEndpoint: `ws://127.0.0.1:${port}/cdp?ticket=${ticket}`,
		}).then(
			() => null,
			(reason: unknown) => reason,
		);
		expect(error).toBeInstanceOf(Error);
		const serialized = `${(error as Error).message}\n${String((error as Error).cause ?? "")}`;
		expect(serialized).toContain("ticket=***");
		expect(serialized).not.toContain(ticket);
	});

	it("gives clients of anything that issues no nonce the plain URL", async () => {
		squatter = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({}, { status: 401 }) });
		const base = `http://127.0.0.1:${squatter.port}`;
		expect(await authenticatedRelayDiscoveryUrl(base, "/json", OPTS)).toBe(`${base}/json`);
	});
});

describe("RelayCdpAuth nonces", () => {
	it("drops the oldest outstanding nonce beyond the cap", () => {
		const auth = new RelayCdpAuth(CDP_TOKEN, () => "127.0.0.1:9222");
		const macFor = (nonce: string) =>
			new URLSearchParams({ nonce, mac: relayRequestMac(CDP_TOKEN, "127.0.0.1:9222", nonce, "/json") });
		const first = auth.issueNonce();
		const issued = Array.from({ length: 256 }, () => auth.issueNonce());
		expect(auth.authorizesDiscovery("/json", macFor(first), undefined)).toBeFalse();
		expect(auth.authorizesDiscovery("/json", macFor(issued[0]!), undefined)).toBeTrue();
	});
});
