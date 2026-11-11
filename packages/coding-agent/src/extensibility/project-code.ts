/**
 * Content fingerprints of repository-supplied code that OMP would import, for
 * the per-project trust surfaces (kb omp t-f77ec1f5, t-81f67b33).
 */
import type * as fs1 from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEacces, isEnoent } from "@oh-my-pi/pi-utils";
import { fingerprintProjectSurface } from "@oh-my-pi/pi-utils/project-trust";
import { findRepoRoot } from "../capability/fs";
import { listOmpExtensionRoots } from "../discovery/omp-extension-roots";

/** Directory names whose direct children are self-contained code roots, keyed for O(1) lookup. */
export type CodeRootDirNames = Readonly<Record<string, true>>;

/**
 * Every file an entry can pull in from its own directory: the entry's code
 * root (the folder directly under a `rootDirNames` dir inside `projectDir`,
 * else the entry itself). Everything under the root counts, dot-directories
 * and `node_modules` included, because an approved entry can import any of
 * it; only `.git` metadata is skipped. Each file is recorded by its SHA-256.
 * A symlinked directory below the root is recorded by its link target, not
 * walked. Imports reaching outside the root are not covered.
 */
async function collectCodeFiles(
	projectDir: string,
	entry: string,
	rootDirNames: CodeRootDirNames,
	into: Map<string, string>,
): Promise<void> {
	let root = entry;
	let candidate = entry;
	for (let dir = path.dirname(entry); dir.startsWith(projectDir + path.sep); dir = path.dirname(dir)) {
		if (Object.hasOwn(rootDirNames, path.basename(dir))) {
			root = candidate;
			break;
		}
		candidate = dir;
	}
	const walk = async (p: string, isRoot: boolean): Promise<void> => {
		let stat: fs1.Stats;
		try {
			stat = isRoot ? await fs.stat(p) : await fs.lstat(p);
		} catch (err) {
			if (isEnoent(err) || isEacces(err)) return;
			throw err;
		}
		if (stat.isSymbolicLink()) {
			const target = await fs.readlink(p);
			const targetStat = await fs.stat(p).catch(() => undefined);
			if (targetStat?.isFile()) into.set(p, await hashFile(p));
			else into.set(p, `symlink:${target}`);
			return;
		}
		if (stat.isDirectory()) {
			for (const name of await fs.readdir(p)) {
				if (name === ".git") continue;
				await walk(path.join(p, name), false);
			}
			return;
		}
		if (stat.isFile()) into.set(p, await hashFile(p));
	};
	await walk(root, true);
}

async function hashFile(p: string): Promise<string> {
	return new Bun.CryptoHasher("sha256").update(await fs.readFile(p)).digest("hex");
}

/**
 * Fingerprint of every file `entries` can load from their own code roots
 * (see {@link collectCodeFiles}). No entries is the empty-surface fingerprint.
 */
export async function fingerprintProjectCode(
	cwd: string,
	entries: readonly string[],
	rootDirNames: CodeRootDirNames,
): Promise<string> {
	const files = new Map<string, string>();
	if (entries.length > 0) {
		// Compare real paths: discovery may report /private/var where cwd says /var.
		const realProjectDir = await fs.realpath(cwd).catch(() => path.resolve(cwd));
		for (const entry of entries) {
			const realEntry = await fs.realpath(entry).catch(() => path.resolve(entry));
			await collectCodeFiles(realProjectDir, realEntry, rootDirNames, files);
		}
	}
	return fingerprintProjectSurface([...files]);
}

/**
 * Repository package directories that discovery scans as extension roots:
 * the directories of a project-settings `extensions:` list and the packages of
 * plugins installed at project scope. Their conventional `tools/`, `hooks/`,
 * `extensions/` and other entries can import anything in the package, so each
 * such entry is approved together with its whole package (kb omp t-81f67b33).
 * Built from the same context `loadCapability` gives the providers.
 */
export async function listProjectPackageRoots(cwd: string): Promise<string[]> {
	const roots = await listOmpExtensionRoots({ cwd, home: os.homedir(), repoRoot: await findRepoRoot(cwd) });
	return roots.filter(root => root.level === "project").map(root => root.path);
}

/** The package root in `packageRoots` that contains `entry`, if any. */
export function containingPackageRoot(entry: string, packageRoots: readonly string[]): string | undefined {
	const resolved = path.resolve(entry);
	return packageRoots.find(root => resolved.startsWith(path.resolve(root) + path.sep));
}
