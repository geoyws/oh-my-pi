import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { capabilityTokenMatches, isRebindingSafeHost, loadOrCreateCapabilityToken } from "../src/local-capability";

const posix = process.platform !== "win32";

describe("loadOrCreateCapabilityToken", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-cap-"));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("creates a private 0600 token in a new 0700 directory and returns the same token on reload", () => {
		const file = path.join(dir, "nested", "cap.token");
		const token = loadOrCreateCapabilityToken(file);
		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(loadOrCreateCapabilityToken(file)).toBe(token);
		if (posix) {
			expect(fs.statSync(file).mode & 0o777).toBe(0o600);
			expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
		}
	});

	it.if(posix)("replaces a token that group or other could read", () => {
		const file = path.join(dir, "cap.token");
		const leaked = loadOrCreateCapabilityToken(file);
		fs.chmodSync(file, 0o644);
		const fresh = loadOrCreateCapabilityToken(file);
		expect(fresh).not.toBe(leaked);
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
	});

	it.if(posix)("never follows a symlink planted at the token path", () => {
		const target = path.join(dir, "attacker-owned");
		fs.writeFileSync(target, `${"A".repeat(43)}\n`, { mode: 0o600 });
		const file = path.join(dir, "cap.token");
		fs.symlinkSync(target, file);
		const token = loadOrCreateCapabilityToken(file);
		expect(token).not.toBe("A".repeat(43));
		expect(fs.lstatSync(file).isSymbolicLink()).toBe(false);
		expect(fs.readFileSync(target, "utf8")).toBe(`${"A".repeat(43)}\n`);
	});

	it("replaces malformed content", () => {
		const file = path.join(dir, "cap.token");
		fs.writeFileSync(file, "short\n", { mode: 0o600 });
		expect(loadOrCreateCapabilityToken(file)).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});
});

describe("capabilityTokenMatches", () => {
	it("accepts only the exact token", () => {
		expect(capabilityTokenMatches("abc", "abc")).toBe(true);
		expect(capabilityTokenMatches("abc", "abd")).toBe(false);
		expect(capabilityTokenMatches("abc", "abcd")).toBe(false);
		expect(capabilityTokenMatches("abc", "")).toBe(false);
		expect(capabilityTokenMatches("abc", null)).toBe(false);
	});
});

describe("isRebindingSafeHost", () => {
	it("accepts localhost and IP literals with or without a port", () => {
		for (const host of ["127.0.0.1:9224", "127.0.0.1", "localhost:3847", "LOCALHOST", "[::1]:9224", "10.0.0.5:80"]) {
			expect(isRebindingSafeHost(host)).toBe(true);
		}
	});

	it("refuses domain names, which DNS rebinding needs, and malformed or missing hosts", () => {
		for (const host of ["evil.example:9224", "127.0.0.1.nip.io:9224", "localhost.evil.com", "", "a b", "x@127.0.0.1", null]) {
			expect(isRebindingSafeHost(host)).toBe(false);
		}
	});
});
