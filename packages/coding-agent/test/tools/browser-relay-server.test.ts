import { afterEach, describe, expect, it } from "bun:test";
import { findFreeCdpPort } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { relayCdpClientsOf } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/probe";
import {
	type RelayServer,
	type RelayUnavailableInfo,
	startRelayServer,
} from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";

const EXTENSION_HELLO = {
	t: "hello",
	userAgent: "test",
	browserVersion: "Chrome/151.0.0.0",
	discardedTabsProtocol: 1,
	tabs: [],
	attachedTabIds: [],
} as const;

/** Test capability; never the user's real token file. */
const CDP_TOKEN = "t".repeat(43);
const AUTH = `token=${CDP_TOKEN}`;

async function rawGet(port: number, requestBytes: string): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	let response = "";
	await Bun.connect({
		hostname: "127.0.0.1",
		port,
		socket: {
			open(socket) {
				socket.write(requestBytes);
			},
			data(_socket, chunk) {
				response += chunk.toString("latin1");
			},
			error(_socket, error) {
				reject(error);
			},
			close() {
				resolve(response);
			},
		},
	});
	return promise;
}

function decodeChunkedBody(body: string): string {
	let decoded = "";
	let offset = 0;
	while (true) {
		const lineEnd = body.indexOf("\r\n", offset);
		if (lineEnd === -1) throw new Error("Invalid chunked response: missing chunk size");
		const lengthText = body.slice(offset, lineEnd).split(";", 1)[0]!;
		const length = Number.parseInt(lengthText, 16);
		if (!Number.isFinite(length) || length < 0) throw new Error("Invalid chunked response: invalid chunk size");
		offset = lineEnd + 2;
		if (length === 0) return decoded;
		if (body.length < offset + length + 2) throw new Error("Invalid chunked response: truncated chunk");
		decoded += body.slice(offset, offset + length);
		offset += length;
		if (body.slice(offset, offset + 2) !== "\r\n")
			throw new Error("Invalid chunked response: missing chunk terminator");
		offset += 2;
	}
}

function parseVersion(response: string): Record<string, string> {
	const boundary = response.indexOf("\r\n\r\n");
	if (boundary === -1) throw new Error("Invalid HTTP response: missing header boundary");
	const headers = response.slice(0, boundary);
	const body = response.slice(boundary + 4);
	expect(headers).toContain("200");
	return JSON.parse(/\r\ntransfer-encoding:\s*chunked\b/i.test(headers) ? decodeChunkedBody(body) : body) as Record<
		string,
		string
	>;
}

async function connectExtension(port: number): Promise<WebSocket> {
	const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ext`);
	ws.addEventListener(
		"open",
		() => {
			ws.send(JSON.stringify(EXTENSION_HELLO));
			resolve(ws);
		},
		{ once: true },
	);
	ws.addEventListener("error", () => reject(new Error("Extension socket failed to connect")), { once: true });
	return promise;
}

async function waitForDiscovery(port: number): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (Date.now() < deadline) {
		const response = await fetch(`http://127.0.0.1:${port}/json/version?${AUTH}`);
		if (response.status === 200) return;
	}
	throw new Error("Relay discovery endpoint did not become ready");
}

describe("browser relay discovery endpoint", () => {
	let relay: RelayServer | undefined;
	let extension: WebSocket | undefined;

	afterEach(() => {
		extension?.close();
		relay?.stop();
		extension = undefined;
		relay = undefined;
	});

	async function startReadyRelay(): Promise<number> {
		const port = await findFreeCdpPort();
		relay = startRelayServer({ port, cdpToken: CDP_TOKEN });
		extension = await connectExtension(port);
		await waitForDiscovery(port);
		return port;
	}

	it("advertises the requested Host authority, with the capability, so a remote Puppeteer client dials the relay", async () => {
		const port = await startReadyRelay();
		const response = await rawGet(
			port,
			`GET /json/version?${AUTH} HTTP/1.1\r\nHost: 100.100.92.97:12803\r\nConnection: close\r\n\r\n`,
		);
		expect(parseVersion(response).webSocketDebuggerUrl).toBe(`ws://100.100.92.97:12803/cdp?${AUTH}`);
	});

	it("uses the loopback discovery URL when an HTTP/1.0 request has no Host header", async () => {
		const port = await startReadyRelay();
		const response = await rawGet(port, `GET /json/version?${AUTH} HTTP/1.0\r\n\r\n`);
		expect(parseVersion(response).webSocketDebuggerUrl).toBe(`ws://127.0.0.1:${port}/cdp?${AUTH}`);
	});

	it("uses the loopback discovery URL when Host is empty", async () => {
		const port = await startReadyRelay();
		const response = await rawGet(port, `GET /json/version?${AUTH} HTTP/1.1\r\nHost: \r\nConnection: close\r\n\r\n`);
		expect(parseVersion(response).webSocketDebuggerUrl).toBe(`ws://127.0.0.1:${port}/cdp?${AUTH}`);
	});

	it("refuses a Host that names a domain, even with the capability (DNS rebinding)", async () => {
		const port = await startReadyRelay();
		for (const host of ["evil.example:9224", "127.0.0.1.nip.io:9224", "bad/host@evil"]) {
			const response = await rawGet(
				port,
				`GET /json/version?${AUTH} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
			);
			expect(response).toStartWith("HTTP/1.1 403");
		}
	});

	it("refuses discovery without the capability or with a wrong one, before and after the extension connects", async () => {
		const port = await findFreeCdpPort();
		relay = startRelayServer({ port, cdpToken: CDP_TOKEN });
		const unauthorized = async () => {
			for (const query of ["", "?token=", `?token=${"x".repeat(43)}`]) {
				for (const path of ["/json/version", "/json", "/json/list"]) {
					const response = await fetch(`http://127.0.0.1:${port}${path}${query}`);
					expect(response.status).toBe(401);
					const body = await response.text();
					expect(body).not.toContain(CDP_TOKEN);
					expect(body).not.toContain("webSocketDebuggerUrl");
				}
			}
		};
		await unauthorized();
		extension = await connectExtension(port);
		await waitForDiscovery(port);
		await unauthorized();
	});

	it("accepts the capability as a Bearer header on discovery", async () => {
		const port = await startReadyRelay();
		const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
			headers: { Authorization: `Bearer ${CDP_TOKEN}` },
		});
		expect(response.status).toBe(200);
	});

	it("refuses discovery from a web page (any Origin), even with the capability", async () => {
		const port = await startReadyRelay();
		const response = await fetch(`http://127.0.0.1:${port}/json/version?${AUTH}`, {
			headers: { Origin: "http://127.0.0.1:8080" },
		});
		expect(response.status).toBe(403);
	});

	it("refuses a /cdp WebSocket without the capability and accepts the advertised URL", async () => {
		const port = await startReadyRelay();
		for (const query of ["", `?token=${"x".repeat(43)}`]) {
			const rejected = new WebSocket(`ws://127.0.0.1:${port}/cdp${query}`);
			const outcome = Promise.withResolvers<"open" | "refused">();
			rejected.addEventListener("open", () => outcome.resolve("open"), { once: true });
			rejected.addEventListener("error", () => outcome.resolve("refused"), { once: true });
			expect(await outcome.promise).toBe("refused");
			expect(relay!.bridge.cdpClientCount).toBe(0);
		}
		const advertised = (await (await fetch(`http://127.0.0.1:${port}/json/version?${AUTH}`)).json()) as {
			webSocketDebuggerUrl: string;
		};
		const client = new WebSocket(advertised.webSocketDebuggerUrl);
		const opened = Promise.withResolvers<void>();
		client.addEventListener("open", () => opened.resolve(), { once: true });
		client.addEventListener("error", () => opened.reject(new Error("advertised /cdp URL refused")), { once: true });
		await opened.promise;
		client.close();
	});

	it("reports 503 with extensionSeen=false while no extension has ever handshaken", async () => {
		const port = await findFreeCdpPort();
		relay = startRelayServer({ port, cdpToken: CDP_TOKEN });
		const response = await fetch(`http://127.0.0.1:${port}/json/version?${AUTH}`);
		expect(response.status).toBe(503);
		const info = (await response.json()) as RelayUnavailableInfo;
		expect(info.extensionSeen).toBeFalse();
		expect(info.uptimeMs).toBeGreaterThanOrEqual(0);
	});

	it("keeps extensionSeen=true across an extension disconnect so clients wait for the service-worker revival", async () => {
		const port = await startReadyRelay();
		extension!.close();
		const deadline = Date.now() + 1_000;
		let response = await fetch(`http://127.0.0.1:${port}/json/version?${AUTH}`);
		while (response.status !== 503 && Date.now() < deadline) {
			response = await fetch(`http://127.0.0.1:${port}/json/version?${AUTH}`);
		}
		expect(response.status).toBe(503);
		const info = (await response.json()) as RelayUnavailableInfo;
		expect(info.extensionSeen).toBeTrue();
		// Clients measure the redial window from the disconnect.
		expect(info.disconnectedMs).toBeGreaterThanOrEqual(0);
	});

	it("reports how many CDP clients are connected, both while waiting for the extension and once ready", async () => {
		const port = await findFreeCdpPort();
		relay = startRelayServer({ port, cdpToken: CDP_TOKEN });
		const discovery = async () => {
			const response = await fetch(`http://127.0.0.1:${port}/json/version?${AUTH}`);
			const body: unknown = await response.json();
			return {
				status: response.status,
				clients: typeof body === "object" && body !== null ? relayCdpClientsOf(body) : null,
			};
		};
		expect(await discovery()).toEqual({ status: 503, clients: 0 });
		const client = new WebSocket(`ws://127.0.0.1:${port}/cdp?${AUTH}`);
		const opened = Promise.withResolvers<void>();
		client.addEventListener("open", () => opened.resolve(), { once: true });
		await opened.promise;
		expect(await discovery()).toEqual({ status: 503, clients: 1 });
		extension = await connectExtension(port);
		await waitForDiscovery(port);
		expect(await discovery()).toEqual({ status: 200, clients: 1 });
		client.close();
		const deadline = Date.now() + 1_000;
		let after = await discovery();
		while (after.clients !== 0 && Date.now() < deadline) after = await discovery();
		expect(after).toEqual({ status: 200, clients: 0 });
	});
});
