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
 *
 * A client never sends the token to a listener it has not verified: another
 * OS user can bind the relay port first. Discovery starts with a token-less
 * `/json/version?challenge=<random>`, and only a relay that answers with
 * {@link relayListenerProof} for this port is sent the token.
 */
import * as crypto from "node:crypto";
import { getBrowserRelayCdpTokenPath, loadOrCreateCapabilityToken } from "@oh-my-pi/pi-utils";

/** Body field of a relay's `/json/version` answer carrying the challenge proof. */
export const RELAY_PROOF_FIELD = "ompRelayProof";
/** Body field naming the port the proving relay listens on. */
export const RELAY_PORT_FIELD = "ompRelayPort";

const CHALLENGE_RE = /^[A-Za-z0-9_-]{22,128}$/;

/** This user's relay CDP token, created on first use. Read on every call so a rotated file takes effect. */
export function relayCdpToken(): string {
	return process.env.PI_BROWSER_RELAY_CDP_TOKEN?.trim() || loadOrCreateCapabilityToken(getBrowserRelayCdpTokenPath());
}

/**
 * Proof that a relay holds `token`, bound to the port it answers on: a squatter that forwards the
 * challenge to a genuine relay on another port gets that port's proof, which the client rejects.
 * The token itself never leaves the relay. Null for a malformed challenge.
 */
export function relayListenerProof(token: string, port: number, challenge: string): string | null {
	if (!CHALLENGE_RE.test(challenge)) return null;
	return crypto.createHmac("sha256", token).update(`omp-relay-proof\n${port}\n${challenge}`).digest("base64url");
}

/** A fresh random challenge for {@link relayListenerProof}. */
export function newRelayChallenge(): string {
	return crypto.randomBytes(24).toString("base64url");
}

/**
 * True when a challenge answer proves this user's relay listens on `urlPort`. A client using the
 * local token file requires the proof for its own URL port. One with `PI_BROWSER_RELAY_CDP_TOKEN`
 * set reaches a relay on another machine through a port forward, whose port differs, so it checks
 * the proof against the port the relay reports instead; no genuine relay of its user can serve on
 * this machine to be relayed from.
 */
export function relayProofMatches(urlPort: number, challenge: string, answer: Record<string, unknown>): boolean {
	const presented = answer[RELAY_PROOF_FIELD];
	if (typeof presented !== "string") return false;
	const remote = Boolean(process.env.PI_BROWSER_RELAY_CDP_TOKEN?.trim());
	const reported = answer[RELAY_PORT_FIELD];
	const port = remote && typeof reported === "number" && Number.isSafeInteger(reported) ? reported : urlPort;
	const expected = relayListenerProof(relayCdpToken(), port, challenge);
	if (expected === null || presented.length !== expected.length) return false;
	return crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
}
