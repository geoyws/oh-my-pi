/**
 * An addon's release stamp names the release it was built for, not the
 * sources it was built from. A same-release addon built before
 * `Shell.terminateBackgroundJobs` existed loaded cleanly, and the bash tool
 * then threw a bare `TypeError` after every successful command. The loader now
 * compares the addon to the native API `index.d.ts` declares.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { adaptDesktopSession } from "../native/desktop-adapter.js";
import {
	checkNativeSurface,
	missingNativeExport,
	missingNativeSurface,
	type NativeAddonStatus,
} from "../native/loader-state.js";
import { type RequiredNativeSurface, requiredNativeSurface } from "../native/required-surface.js";
import { collectRequiredSurface } from "../scripts/gen-enums";

const release = "18.12.3";
const candidate = "/w/packages/natives/native/pi_natives.darwin-arm64.node";
const surface: RequiredNativeSurface = {
	functions: ["grep", "countTokens"],
	classes: { Shell: ["run", "terminateBackgroundJobs"], Process: [] },
};

function shellClass(methods: string[]) {
	const Shell = class {} as unknown as { new (): Record<string, () => unknown>; prototype: object };
	for (const method of methods) {
		Object.defineProperty(Shell.prototype, method, { value: () => method, writable: true, configurable: true });
	}
	return Shell;
}

/** Bindings reporting `version` and providing everything in `surface` except `omit`. */
function bindings(omit: string[] = [], version: string | null = release): Record<string, unknown> {
	const result: Record<string, unknown> = {
		__piNativesBuildVersion: () => version,
		grep: () => {},
		countTokens: () => {},
		Shell: shellClass(["run", "terminateBackgroundJobs"].filter(method => !omit.includes(`Shell.${method}`))),
		Process: class {},
	};
	for (const name of omit) if (!name.includes(".")) delete result[name];
	return result;
}

const ctx = (isWorkspaceLoad: boolean) => ({ isWorkspaceLoad, packageVersion: release });

describe("missingNativeSurface", () => {
	it("returns nothing for an addon providing every declared symbol", () => {
		expect(missingNativeSurface(bindings(), surface)).toEqual([]);
	});

	it("names a missing function, class method, and class", () => {
		expect(missingNativeSurface(bindings(["countTokens", "Shell.terminateBackgroundJobs"]), surface)).toEqual([
			"countTokens",
			"Shell.terminateBackgroundJobs",
		]);
		expect(missingNativeSurface(bindings(["Process"]), surface)).toEqual(["Process"]);
	});

	it("does not count an undeclared symbol as required", () => {
		const addon = bindings();
		expect("macOSSpellCheckerAvailable" in addon).toBe(false);
		expect(missingNativeSurface(addon, surface)).toEqual([]);
	});
});

describe("non-workspace loads", () => {
	it("reject a same-release addon missing a declared symbol, naming the addon, release, symbols, and fix", () => {
		const load = () =>
			checkNativeSurface(ctx(false), bindings(["countTokens", "Shell.terminateBackgroundJobs"]), candidate, surface);
		for (const expected of [
			candidate,
			`@oh-my-pi/pi-natives@${release}`,
			"countTokens",
			"Shell.terminateBackgroundJobs",
			"bun --cwd=packages/natives run build",
			"reinstall",
		]) {
			expect(load).toThrow(expected);
		}
	});

	it("name only the first missing symbols of a badly stale addon", () => {
		const functions = Array.from({ length: 13 }, (_, index) => `fn${index}`);
		const load = () => checkNativeSurface(ctx(false), bindings(), candidate, { functions, classes: {} });
		expect(load).toThrow("fn9 (+3 more)");
		expect(load).not.toThrow("fn10");
	});

	it("accept a complete addon as current", () => {
		const status = checkNativeSurface(ctx(false), bindings(), candidate, surface);
		expect(status.stale).toBe(false);
		expect(status.missing).toEqual([]);
	});
});

describe("workspace loads", () => {
	it("stub a missing prototype method with the actionable message and keep provided methods", () => {
		const addon = bindings(["Shell.terminateBackgroundJobs"]);
		const status = checkNativeSurface(ctx(true), addon, candidate, surface);
		expect(status.missing).toEqual(["Shell.terminateBackgroundJobs"]);

		const shell = new (addon.Shell as new () => Record<string, () => unknown>)();
		expect(shell.run()).toBe("run");
		for (const expected of ["Shell.terminateBackgroundJobs", candidate, release, "bun run build:native"]) {
			expect(() => shell.terminateBackgroundJobs()).toThrow(expected);
		}
		expect(() => shell.terminateBackgroundJobs()).not.toThrow(TypeError);
		// A later load of the same resident addon still sees the stand-in as missing.
		expect(missingNativeSurface(addon, surface)).toEqual(["Shell.terminateBackgroundJobs"]);
	});

	it("report a same-release addon missing a symbol as stale, so function exports get stubs", () => {
		const status: NativeAddonStatus = checkNativeSurface(ctx(true), bindings(["countTokens"]), candidate, surface);
		expect(status.version).toBe(release);
		expect(status.stale).toBe(true);
		const stub = missingNativeExport("countTokens", status);
		expect(typeof stub).toBe("function");
		expect(() => stub?.()).toThrow("built from older sources");
	});

	it("keep a complete same-release addon current, so capability probes still see undefined", () => {
		const status = checkNativeSurface(ctx(true), bindings(), candidate, surface);
		expect(status.stale).toBe(false);
		expect(missingNativeExport("macOSSpellCheckerAvailable", status)).toBeUndefined();
	});

	it("still let the desktop adapter reject a session whose required methods are only stubs", () => {
		const DesktopSession = class {
			get escapeStops() {
				return 0;
			}
		};
		const declared = requiredNativeSurface.classes.DesktopSession ?? [];
		for (const method of declared.filter(method => method !== "holdDisplayUntilReleased")) {
			Object.defineProperty(DesktopSession.prototype, method, { value: () => {}, configurable: true });
		}
		const addon = { __piNativesBuildVersion: () => release, DesktopSession };
		checkNativeSurface(ctx(true), addon, candidate, { functions: [], classes: { DesktopSession: declared } });
		const Adapted = adaptDesktopSession(DesktopSession);
		expect(() => new Adapted({ display: "active" })).toThrow(/^Unsupported: .*holdDisplayUntilReleased/);
	});
});

describe("required surface derivation", () => {
	it("keeps prototype methods and drops constructors, statics, accessors, and doc text", () => {
		const dts = [
			"export declare class Widget {",
			"  /**",
			"   * Splits on `",
			"  `) looks like a member",
			"   */",
			"  constructor(size: number)",
			"  static open(path: string): Widget",
			"  get size(): number",
			"  set size(value: number)",
			"  resize(size: number): void",
			"  map<T>(fn: () => T): T",
			"  resize(size: string): void",
			"}",
			"export declare function __piNativesBuildVersion(): string | null",
			"export declare function widgetCount(): number",
		].join("\n");
		expect(collectRequiredSurface(dts)).toEqual({
			functions: ["widgetCount"],
			classes: { Widget: ["resize", "map"] },
		});
	});

	it("matches the checked-in index.d.ts (rerun gen-enums after a native build)", () => {
		const dts = fs.readFileSync(path.join(import.meta.dir, "../native/index.d.ts"), "utf8");
		expect<unknown>(requiredNativeSurface).toEqual(collectRequiredSurface(dts));
	});
});
