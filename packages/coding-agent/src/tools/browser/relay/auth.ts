/**
 * Capability token for the relay's CDP side (discovery and `/cdp`).
 *
 * The relay drives the user's logged-in Chrome, so loopback binding alone is
 * not enough: any local OS user could connect. Every CDP-side request must be
 * authorized by the per-user token from a 0600 file; the server and every omp
 * client of this user read the same file. The extension's `/ext` leg keeps its
 * own optional `--token`. A client on another machine (reaching the relay
 * through a port forward to `127.0.0.1` that keeps the relay's port number)
 * cannot read that file; it sets `PI_BROWSER_RELAY_CDP_TOKEN` to the file's
 * content instead.
 *
 * omp clients never send the token itself: another OS user may hold the
 * address they dial. A token-less discovery request is answered with a
 * single-use nonce, and the client proves the token with an HMAC over that
 * nonce, the authority (`host:port`) it dialled and the endpoint. The relay
 * checks the HMAC against the one authority it listens on, `127.0.0.1:<port>`,
 * so a squatter on any other address or port that relays the exchange to the
 * genuine relay is refused and never sees a ticket, and nothing it sees can be
 * replayed. The WebSocket URL the relay then advertises carries a ticket, not
 * the token: Puppeteer reconnects through that URL (tab workers), so a ticket
 * is reusable, but only for as long as that relay process runs.
 */
import * as crypto from "node:crypto";
import { capabilityTokenMatches, getBrowserRelayCdpTokenPath, loadOrCreateCapabilityToken } from "@oh-my-pi/pi-utils";

/** The only address the relay listens on; HMACs are bound to it. */
export const RELAY_LISTEN_HOST = "127.0.0.1";

/** Body field of a token-less discovery answer carrying a single-use nonce. */
export const RELAY_NONCE_FIELD = "ompRelayNonce";

export type RelayDiscoveryEndpoint = "/json" | "/json/version" | "/json/list";

/** This user's relay CDP token, created on first use. Read on every call so a rotated file takes effect. */
export function relayCdpToken(): string {
	return process.env.PI_BROWSER_RELAY_CDP_TOKEN?.trim() || loadOrCreateCapabilityToken(getBrowserRelayCdpTokenPath());
}

/** HMAC a client presents for `nonce` on `endpoint`, bound to the relay authority (`host:port`) it dialled. */
export function relayRequestMac(
	token: string,
	authority: string,
	nonce: string,
	endpoint: RelayDiscoveryEndpoint,
): string {
	return crypto
		.createHmac("sha256", token)
		.update(`omp-relay-auth\n${authority}\n${nonce}\n${endpoint}`)
		.digest("base64url");
}

const NONCE_TTL_MS = 30_000;
/** Outstanding nonces kept per relay; the oldest is dropped beyond it. */
const MAX_OUTSTANDING = 256;

/** Single-use random values with a time to live, oldest evicted first. */
class SingleUseStore {
	readonly #entries = new Map<string, number>();
	constructor(readonly ttlMs: number) {}

	issue(): string {
		const value = crypto.randomBytes(24).toString("base64url");
		this.#entries.set(value, Date.now() + this.ttlMs);
		while (this.#entries.size > MAX_OUTSTANDING) {
			const oldest = this.#entries.keys().next().value;
			if (oldest === undefined) break;
			this.#entries.delete(oldest);
		}
		return value;
	}

	/** True once for an issued, unexpired value; it is spent either way. */
	consume(value: string | null | undefined): boolean {
		if (!value) return false;
		const expires = this.#entries.get(value);
		if (expires === undefined) return false;
		this.#entries.delete(value);
		return expires >= Date.now();
	}
}

/** Server side of the relay's CDP authentication. */
export class RelayCdpAuth {
	readonly #nonces = new SingleUseStore(NONCE_TTL_MS);
	/** Signs tickets; lives and dies with this relay process. */
	readonly #ticketKey = crypto.randomBytes(32);

	constructor(
		readonly token: string,
		/** The relay's own listen authority, `127.0.0.1:<port>`. */
		readonly authority: () => string,
	) {}

	/** A fresh single-use nonce for a token-less discovery request. */
	issueNonce(): string {
		return this.#nonces.issue();
	}

	/** A `/cdp` ticket valid while this relay process runs. */
	issueTicket(): string {
		const id = crypto.randomBytes(16).toString("base64url");
		return `${id}.${this.#signTicket(id)}`;
	}

	#signTicket(id: string): string {
		return crypto.createHmac("sha256", this.#ticketKey).update(id).digest("base64url");
	}

	/**
	 * True when `params` carry a valid `nonce`+`mac` for `endpoint` (the nonce is spent), or the
	 * token itself as `token`/`bearer` (manual clients such as the smoke script).
	 */
	authorizesDiscovery(endpoint: RelayDiscoveryEndpoint, params: URLSearchParams, bearer: string | undefined): boolean {
		if (capabilityTokenMatches(this.token, params.get("token") ?? bearer)) return true;
		const nonce = params.get("nonce");
		const mac = params.get("mac");
		if (!nonce || !mac || !this.#nonces.consume(nonce)) return false;
		return capabilityTokenMatches(relayRequestMac(this.token, this.authority(), nonce, endpoint), mac);
	}

	/** True for a ticket this relay process issued, or the token itself. */
	authorizesCdp(params: URLSearchParams, bearer: string | undefined): boolean {
		if (capabilityTokenMatches(this.token, params.get("token") ?? bearer)) return true;
		const [id, signature, extra] = (params.get("ticket") ?? "").split(".");
		if (!id || !signature || extra !== undefined) return false;
		return capabilityTokenMatches(this.#signTicket(id), signature);
	}
}
