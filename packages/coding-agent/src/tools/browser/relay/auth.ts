/**
 * Capability token for the relay's CDP side (discovery and `/cdp`).
 *
 * The relay drives the user's logged-in Chrome, so loopback binding alone is
 * not enough: any local OS user could connect. Every CDP-side request must
 * carry the per-user token from a 0600 file; the server and every omp client
 * of this user read the same file. The extension's `/ext` leg keeps its own
 * optional `--token`. A client on another machine (reaching the relay through
 * a port forward) cannot read that file; it sets `PI_BROWSER_RELAY_CDP_TOKEN`
 * to the file's content instead.
 */
import { getBrowserRelayCdpTokenPath, loadOrCreateCapabilityToken } from "@oh-my-pi/pi-utils";

/** This user's relay CDP token, created on first use. Read on every call so a rotated file takes effect. */
export function relayCdpToken(): string {
	return process.env.PI_BROWSER_RELAY_CDP_TOKEN?.trim() || loadOrCreateCapabilityToken(getBrowserRelayCdpTokenPath());
}

/** Discovery URL under `cdpUrl` carrying this user's token. Relays predating the token ignore the query. */
export function relayDiscoveryUrl(cdpUrl: string, endpoint: "/json" | "/json/version" | "/json/list"): string {
	return `${cdpUrl.replace(/\/+$/, "")}${endpoint}?token=${encodeURIComponent(relayCdpToken())}`;
}
