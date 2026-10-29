/**
 * Per-project trust for repository-controlled code and credential routing.
 *
 * A repository can ship content that OMP would otherwise act on the moment it
 * starts in that checkout: project MCP servers (launched as subprocesses with
 * the user's environment), project extensions and hooks (imported into the
 * agent process), and project `.env` names that redirect provider traffic
 * (base URLs, proxies, CA bundles) to a host the repository chooses. None of
 * these may run or apply until the user approves them for that exact project
 * directory AND that exact content. An approval records one fingerprint per
 * surface; any change to a surface's content invalidates its approval, so a
 * later commit cannot slip new code in under an old "yes".
 *
 * The store is `<agentDir>/trusted-projects.json` (mode 0600). It is read
 * synchronously because the env surface is decided while `env.ts` loads,
 * before any async startup runs.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "./dirs";

/** The independently approved kinds of project-controlled behaviour. */
export type ProjectTrustSurface = "mcp" | "extensions" | "env";

export const PROJECT_TRUST_SURFACES: readonly ProjectTrustSurface[] = ["mcp", "extensions", "env"];

interface ProjectTrustEntry {
	/** Approved fingerprint per surface. A missing surface is untrusted. */
	surfaces: Partial<Record<ProjectTrustSurface, { fingerprint: string; approvedAt: string }>>;
}

interface ProjectTrustStore {
	version: 1;
	projects: Record<string, ProjectTrustEntry>;
}

/** Fingerprint of a surface that has no content: nothing to approve, always allowed. */
export const EMPTY_SURFACE_FINGERPRINT = "empty";

export function getProjectTrustStorePath(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, "trusted-projects.json");
}

/** Canonical key for a project: its resolved real path (symlinks cannot alias an approval). */
export function projectTrustKey(projectDir: string): string {
	const resolved = path.resolve(projectDir);
	try {
		return fs.realpathSync(resolved);
	} catch {
		return resolved;
	}
}

/**
 * Stable fingerprint of a surface's content. `entries` are (identity, content)
 * pairs; order does not matter. An empty list is {@link EMPTY_SURFACE_FINGERPRINT}.
 */
export function fingerprintProjectSurface(entries: ReadonlyArray<readonly [string, string]>): string {
	if (entries.length === 0) return EMPTY_SURFACE_FINGERPRINT;
	const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const hash = createHash("sha256");
	for (const [identity, content] of sorted) {
		hash.update(`${identity.length}:${identity}\0${content.length}:${content}\0`);
	}
	return `sha256:${hash.digest("hex")}`;
}

function readStore(storePath: string): ProjectTrustStore {
	let raw: string;
	try {
		raw = fs.readFileSync(storePath, "utf-8");
	} catch {
		return { version: 1, projects: {} };
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (
			parsed &&
			typeof parsed === "object" &&
			"version" in parsed &&
			parsed.version === 1 &&
			"projects" in parsed &&
			parsed.projects &&
			typeof parsed.projects === "object" &&
			!Array.isArray(parsed.projects)
		) {
			// Entry contents are re-checked at every read site (optional chaining).
			const store: ProjectTrustStore = {
				version: 1,
				projects: parsed.projects as Record<string, ProjectTrustEntry>,
			};
			return store;
		}
	} catch {
		// Fall through: an unreadable store trusts nothing (fail closed).
	}
	return { version: 1, projects: {} };
}

function writeStore(storePath: string, store: ProjectTrustStore): void {
	fs.mkdirSync(path.dirname(storePath), { recursive: true, mode: 0o700 });
	const tmp = `${storePath}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, storePath);
}

/**
 * Whether `fingerprint` is the approved content for `surface` in `projectDir`.
 * A surface with no content ({@link EMPTY_SURFACE_FINGERPRINT}) is always allowed.
 */
export function isProjectSurfaceTrusted(
	projectDir: string,
	surface: ProjectTrustSurface,
	fingerprint: string,
	storePath: string = getProjectTrustStorePath(),
): boolean {
	if (fingerprint === EMPTY_SURFACE_FINGERPRINT) return true;
	const entry = readStore(storePath).projects[projectTrustKey(projectDir)];
	return entry?.surfaces?.[surface]?.fingerprint === fingerprint;
}

/** Record approval of the given surface fingerprints for `projectDir`. */
export function approveProjectSurfaces(
	projectDir: string,
	fingerprints: Partial<Record<ProjectTrustSurface, string>>,
	storePath: string = getProjectTrustStorePath(),
	now: Date = new Date(),
): void {
	const store = readStore(storePath);
	const key = projectTrustKey(projectDir);
	const prior = store.projects[key]?.surfaces;
	const surfaces: ProjectTrustEntry["surfaces"] = prior && typeof prior === "object" ? { ...prior } : {};
	for (const surface of PROJECT_TRUST_SURFACES) {
		const fingerprint = fingerprints[surface];
		if (fingerprint === undefined || fingerprint === EMPTY_SURFACE_FINGERPRINT) continue;
		surfaces[surface] = { fingerprint, approvedAt: now.toISOString() };
	}
	store.projects[key] = { surfaces };
	writeStore(storePath, store);
}

/** Remove every approval recorded for `projectDir`. Returns whether one existed. */
export function revokeProjectTrust(projectDir: string, storePath: string = getProjectTrustStorePath()): boolean {
	const store = readStore(storePath);
	const key = projectTrustKey(projectDir);
	if (!(key in store.projects)) return false;
	delete store.projects[key];
	writeStore(storePath, store);
	return true;
}

/** Approved fingerprints currently recorded for `projectDir`. */
export function getProjectTrust(
	projectDir: string,
	storePath: string = getProjectTrustStorePath(),
): Partial<Record<ProjectTrustSurface, { fingerprint: string; approvedAt: string }>> {
	return readStore(storePath).projects[projectTrustKey(projectDir)]?.surfaces ?? {};
}

const ROUTING_ENV_EXACT: Record<string, true> = {
	HTTP_PROXY: true,
	HTTPS_PROXY: true,
	ALL_PROXY: true,
	NO_PROXY: true,
	NODE_EXTRA_CA_CERTS: true,
	NODE_TLS_REJECT_UNAUTHORIZED: true,
	NODE_OPTIONS: true,
	BUN_OPTIONS: true,
	SSL_CERT_FILE: true,
	SSL_CERT_DIR: true,
	REQUESTS_CA_BUNDLE: true,
	CURL_CA_BUNDLE: true,
	HOME: true,
	PATH: true,
};

/**
 * Whether a project `.env` name can redirect where OMP sends credentials or
 * where it reads its own configuration from: provider/proxy/OAuth endpoints,
 * TLS trust, OMP's own `PI_*`/`OMP_*` settings (agent dir, profile, endpoints)
 * and XDG directory roots. Such names apply only after `env` approval.
 */
export function isProjectRoutingEnvName(name: string): boolean {
	const upper = name.toUpperCase();
	if (Object.hasOwn(ROUTING_ENV_EXACT, upper)) return true;
	if (/^(PI|OMP|XDG)_/.test(upper)) return true;
	if (/(_URL|_URI|_BASE|_ENDPOINT|_HOST|_PROXY|_ORIGIN|_DOMAIN|_REGION)$/.test(upper)) return true;
	return /(BASE_?URL|API_?BASE|TOKEN_?URL|AUTH_?URL|ISSUER)/.test(upper);
}

/** Fingerprint of the routing names a project `.env` defines (names and values). */
export function fingerprintProjectRoutingEnv(env: Record<string, string>): string {
	return fingerprintProjectSurface(
		Object.keys(env)
			.filter(isProjectRoutingEnvName)
			.map(name => [name, env[name]!] as const),
	);
}
