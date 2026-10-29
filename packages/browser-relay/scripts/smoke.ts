/**
 * Manual end-to-end smoke for the relay: replicates the omp browser tool's
 * connection pattern against a live relay + extension.
 *
 * The tool opens TWO puppeteer connections per driven tab — the supervisor
 * (authenticated `/json/version` discovery, then `puppeteer.connect({browserWSEndpoint})`,
 * picks a target) and a tab worker (the same advertised endpoint, adopts that target
 * by id) — so this script does exactly that, then exercises evaluate/navigate/screenshot,
 * an extra CDP session, and the createTarget/closeTarget path.
 *
 * Usage: bun scripts/smoke.ts [relay-url] [target-substring]
 * The relay capability comes from `PI_BROWSER_RELAY_CDP_TOKEN`, else `~/.omp/run/browser-relay-cdp.token`.
 */
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import type { Target } from "puppeteer-core";
import puppeteer from "puppeteer-core";

// `localhost` is dialled as 127.0.0.1, as omp does, so it cannot resolve to a squatter on ::1.
const relayUrl = (Bun.argv[2] ?? "http://127.0.0.1:9224").replace(/\/+$/, "").replace("//localhost:", "//127.0.0.1:");
const matcher = Bun.argv[3] ?? "Relay Smoke Page";

/** This user's relay capability, as omp reads it: the env override, else the token file. */
async function relayToken(): Promise<string> {
	const fromEnv = process.env.PI_BROWSER_RELAY_CDP_TOKEN?.trim();
	if (fromEnv) return fromEnv;
	return (await Bun.file(path.join(os.homedir(), ".omp", "run", "browser-relay-cdp.token")).text()).trim();
}

/**
 * The relay's `webSocketDebuggerUrl`, discovered the way omp does it: the relay hands a token-less
 * request a single-use nonce, and an HMAC over it and the authority dialled proves the token
 * without sending it.
 */
async function discoverWsEndpoint(): Promise<string> {
	const challenge = await fetch(`${relayUrl}/json/version`);
	const { ompRelayNonce: nonce } = (await challenge.json()) as { ompRelayNonce?: string };
	if (challenge.status !== 401 || !nonce) throw new Error(`${relayUrl} did not issue a relay nonce`);
	const target = new URL(relayUrl);
	const authority = `${target.hostname}:${target.port || "80"}`;
	const mac = crypto
		.createHmac("sha256", await relayToken())
		.update(`omp-relay-auth\n${authority}\n${nonce}\n/json/version`)
		.digest("base64url");
	const response = await fetch(`${relayUrl}/json/version?nonce=${encodeURIComponent(nonce)}&mac=${mac}`);
	if (!response.ok) throw new Error(`relay discovery failed: HTTP ${response.status} ${await response.text()}`);
	return ((await response.json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
}

/** Puppeteer keeps the CDP target id on an internal field; same access the omp tab supervisor uses (`targetIdForPage`). */
function targetIdOf(target: Target): string {
	// Internal puppeteer field, not on the public type.
	const raw = target as unknown as { _targetId: string };
	return raw._targetId;
}

function step(name: string): void {
	console.log(`\n== ${name}`);
}

step("supervisor: authenticated discovery, connect via browserWSEndpoint");
const supervisor = await puppeteer.connect({
	browserWSEndpoint: await discoverWsEndpoint(),
	defaultViewport: null,
	protocolTimeout: 20_000,
});
console.log("version:", await supervisor.version());

step("supervisor: discover targets");
const pages = (
	await Promise.all(
		supervisor
			.targets()
			.map(async target => (String(target.type()) === "page" ? await target.page().catch(() => null) : null)),
	)
).filter(page => page !== null);
console.log(
	"pages:",
	pages.map(page => page.url()),
);
if (pages.length === 0) throw new Error("no page targets discovered");

let picked = null;
for (const page of pages) {
	const title = await page.title().catch(() => "");
	if (page.url().includes(matcher) || title.includes(matcher)) picked = page;
}
if (!picked) throw new Error(`no page matching ${JSON.stringify(matcher)}`);
const targetId = targetIdOf(picked.target());
const wsEndpoint = supervisor.wsEndpoint();
console.log("picked target:", targetId, "ws:", wsEndpoint);

step("worker: second connection via browserWSEndpoint");
const worker = await puppeteer.connect({
	browserWSEndpoint: wsEndpoint,
	defaultViewport: null,
	protocolTimeout: 20_000,
});
const workerTarget = await worker.waitForTarget(target => targetIdOf(target) === targetId, { timeout: 10_000 });
const page = await workerTarget.page();
if (!page) throw new Error("worker could not adopt page");

step("worker: evaluate on existing tab");
console.log("title:", await page.title());
// String form: the callback body runs in the page; a function literal would need the DOM lib.
console.log("hero:", await page.evaluate(`document.querySelector("#hero")?.textContent ?? "(no hero)"`));

step("worker: extra CDP session (screenshot path)");
const session = await page.createCDPSession();
const frameTree = (await session.send("Page.getFrameTree")) as { frameTree: { frame: { url: string } } };
console.log("frame url:", frameTree.frameTree.frame.url);
await session.detach();

step("worker: navigate existing tab");
await page.goto("https://example.com/?relay-smoke", { waitUntil: "load", timeout: 20_000 });
console.log("navigated:", page.url(), "/", await page.title());

step("worker: screenshot");
const shot = await page.screenshot({ type: "png" });
console.log("screenshot bytes:", shot.byteLength);

step("supervisor: newPage (Target.createTarget) + close (Target.closeTarget)");
const fresh = await supervisor.newPage();
await fresh.goto("about:blank");
console.log("new page url:", fresh.url());
await fresh.close();
console.log("closed");

step("disconnect both");
await worker.disconnect();
await supervisor.disconnect();

console.log("\nSMOKE OK");
process.exit(0);
