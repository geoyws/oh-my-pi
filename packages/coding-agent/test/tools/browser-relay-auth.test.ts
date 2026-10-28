import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	newRelayChallenge,
	RELAY_PORT_FIELD,
	RELAY_PROOF_FIELD,
	relayCdpToken,
	relayListenerProof,
	relayProofMatches,
} from "@oh-my-pi/pi-coding-agent/tools/browser/relay/auth";
import { __resetDirsFromEnvForTests, TempDir } from "@oh-my-pi/pi-utils";

describe("relayProofMatches", () => {
	let xdg: TempDir | null = null;
	let savedToken: string | undefined;

	beforeEach(() => {
		// Local mode reads the token file: keep it out of the real home.
		savedToken = process.env.PI_BROWSER_RELAY_CDP_TOKEN;
		delete process.env.PI_BROWSER_RELAY_CDP_TOKEN;
		xdg = TempDir.createSync("@omp-relay-auth-xdg-");
		fs.mkdirSync(path.join(xdg.path(), "omp"), { recursive: true });
		process.env.XDG_STATE_HOME = xdg.path();
		__resetDirsFromEnvForTests();
	});

	afterEach(() => {
		delete process.env.XDG_STATE_HOME;
		if (savedToken === undefined) delete process.env.PI_BROWSER_RELAY_CDP_TOKEN;
		else process.env.PI_BROWSER_RELAY_CDP_TOKEN = savedToken;
		__resetDirsFromEnvForTests();
		xdg?.removeSync();
		xdg = null;
	});

	it("rejects a genuine proof relayed from another port when using the local token file", () => {
		const challenge = newRelayChallenge();
		const relayed = relayListenerProof(relayCdpToken(), 9333, challenge);
		// The squatter on 9222 forwards the genuine 9333 relay's answer, port field included.
		expect(relayProofMatches(9222, challenge, { [RELAY_PROOF_FIELD]: relayed, [RELAY_PORT_FIELD]: 9333 })).toBe(false);
		expect(relayProofMatches(9333, challenge, { [RELAY_PROOF_FIELD]: relayed, [RELAY_PORT_FIELD]: 9333 })).toBe(true);
	});

	it("rejects a proof for another challenge or another token", () => {
		const challenge = newRelayChallenge();
		const otherChallenge = relayListenerProof(relayCdpToken(), 9222, newRelayChallenge());
		const otherToken = relayListenerProof("z".repeat(43), 9222, challenge);
		expect(relayProofMatches(9222, challenge, { [RELAY_PROOF_FIELD]: otherChallenge })).toBe(false);
		expect(relayProofMatches(9222, challenge, { [RELAY_PROOF_FIELD]: otherToken })).toBe(false);
		expect(relayProofMatches(9222, challenge, {})).toBe(false);
	});

	it("checks a port-forwarded client's proof against the port the relay reports", () => {
		process.env.PI_BROWSER_RELAY_CDP_TOKEN = "f".repeat(43);
		const challenge = newRelayChallenge();
		const remote = relayListenerProof("f".repeat(43), 9222, challenge);
		// Local forward 19222 -> remote relay on 9222.
		expect(relayProofMatches(19222, challenge, { [RELAY_PROOF_FIELD]: remote, [RELAY_PORT_FIELD]: 9222 })).toBe(true);
		expect(relayProofMatches(19222, challenge, { [RELAY_PROOF_FIELD]: remote, [RELAY_PORT_FIELD]: 9333 })).toBe(false);
	});
});
