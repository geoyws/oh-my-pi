/** Managed Chrome-for-Testing installation with bounded downloads and atomic publication. */
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ArchiveLimits, extractArchive } from "./ar";
import { tryAcquireFileLock, withFileLock } from "./file-lock";

const CHROME_FOR_TESTING_BASE_URL = "https://storage.googleapis.com/chrome-for-testing-public";
// Installation is outside browser/Eval operation deadlines, but a stalled CDN
// must still release the cached install promise and permit a later attempt.
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

/**
 * Archive ceilings for the managed browser download. The default archive
 * limits (64 MiB per member / 256 MiB in memory) guard against attacker-
 * controlled archives, but the Chrome-for-Testing binary is a trusted
 * first-party download whose `chrome` executable already exceeds both
 * (~269 MB and growing), so extraction gets a ceiling sized for it.
 */
const BROWSER_ARCHIVE_LIMITS: Partial<ArchiveLimits> = {
	maxMemberSize: 1024 * 1024 * 1024,
	maxInMemorySize: 1024 * 1024 * 1024,
};

/** Browser download platform identifiers. */
export enum BrowserPlatform {
	LINUX = "linux",
	LINUX_ARM = "linux_arm",
	MAC = "mac",
	MAC_ARM = "mac_arm",
	WIN32 = "win32",
	WIN64 = "win64",
}
type ChromeForTestingPlatform = Exclude<BrowserPlatform, BrowserPlatform.LINUX_ARM>;

function requireChromeForTestingPlatform(platform: BrowserPlatform): ChromeForTestingPlatform {
	if (platform === BrowserPlatform.LINUX_ARM)
		throw new Error("Chrome for Testing does not provide linux/arm64 builds");
	return platform;
}

/** Download progress reported while a browser archive is streamed to disk. */
export interface BrowserDownloadProgress {
	downloadedBytes: number;
	totalBytes: number;
}

/** Inputs used to locate an installed browser executable. */
export interface ComputeExecutablePathOptions {
	buildId: string;
	cacheDir: string;
	platform?: BrowserPlatform;
}

/** Inputs used to download and install a browser. */
export interface InstallOptions extends ComputeExecutablePathOptions {
	baseUrl?: string;
	downloadProgressCallback?: (progress: BrowserDownloadProgress) => void;
}

/** Metadata for a managed Chrome installation in Puppeteer's cache layout. */
export interface InstalledBrowser {
	buildId: string;
	platform: BrowserPlatform;
	path: string;
	executablePath: string;
}

/** Detect the current host's Puppeteer browser platform. */
export function detectBrowserPlatform(): BrowserPlatform | undefined {
	const platform = os.platform();
	const arch = os.arch();
	if (platform === "darwin") return arch === "arm64" ? BrowserPlatform.MAC_ARM : BrowserPlatform.MAC;
	if (platform === "linux") return arch === "arm64" ? BrowserPlatform.LINUX_ARM : BrowserPlatform.LINUX;
	if (platform === "win32") return arch === "ia32" ? BrowserPlatform.WIN32 : BrowserPlatform.WIN64;
	return undefined;
}

/** Return the Chrome-for-Testing archive URL for a browser build. */
export function getDownloadUrl(platform: BrowserPlatform, buildId: string, baseUrl = CHROME_FOR_TESTING_BASE_URL): URL {
	const archivePlatform = chromeArchivePlatform(platform);
	const root = baseUrl.replace(/\/$/, "");
	return new URL(`${root}/${buildId}/${archivePlatform}/chrome-${archivePlatform}.zip`);
}

/** Compute the executable path in Puppeteer's cache layout. */
export function computeExecutablePath(options: ComputeExecutablePathOptions): string {
	const detectedPlatform = options.platform ?? detectBrowserPlatform();
	if (!detectedPlatform) throw new Error("Cannot determine a browser platform for this host");
	const platform = requireChromeForTestingPlatform(detectedPlatform);
	const installDir = installationDir(options.cacheDir, platform, options.buildId);
	switch (platform) {
		case BrowserPlatform.LINUX:
			return path.join(installDir, "chrome-linux64", "chrome");
		case BrowserPlatform.MAC:
			return path.join(
				installDir,
				"chrome-mac-x64",
				"Google Chrome for Testing.app",
				"Contents",
				"MacOS",
				"Google Chrome for Testing",
			);
		case BrowserPlatform.MAC_ARM:
			return path.join(
				installDir,
				"chrome-mac-arm64",
				"Google Chrome for Testing.app",
				"Contents",
				"MacOS",
				"Google Chrome for Testing",
			);
		case BrowserPlatform.WIN32:
			return path.join(installDir, "chrome-win32", "chrome.exe");
		case BrowserPlatform.WIN64:
			return path.join(installDir, "chrome-win64", "chrome.exe");
	}
}

/** Download and unpack Chrome into Puppeteer's existing cache layout. */
export async function install(options: InstallOptions): Promise<InstalledBrowser> {
	const platform = options.platform ?? detectBrowserPlatform();
	if (!platform) throw new Error("Cannot determine a browser platform for this host");
	const executablePath = computeExecutablePath({ ...options, platform });
	const installPath = installationDir(options.cacheDir, platform, options.buildId);
	if (await pathExists(executablePath)) {
		return { buildId: options.buildId, platform, path: installPath, executablePath };
	}

	await fsp.mkdir(path.dirname(installPath), { recursive: true });
	return withFileLock(
		`${installPath}.install`,
		async () => {
			// The in-process launch promise cannot serialize separate OMP sessions.
			// Recheck under the OS lock: never replace a winner's running Chrome.
			if (!(await pathExists(executablePath))) {
				const nonce = `${process.pid}-${crypto.randomUUID()}`;
				const archivePath = path.join(options.cacheDir, `.browser-${nonce}.zip`);
				const stagingPath = path.join(options.cacheDir, `.browser-${nonce}`);
				try {
					await downloadArchive(
						getDownloadUrl(platform, options.buildId, options.baseUrl),
						archivePath,
						options.downloadProgressCallback,
					);
					await extractArchive(archivePath, stagingPath, { limits: BROWSER_ARCHIVE_LIMITS });
					if (!(await pathExists(path.join(stagingPath, path.relative(installPath, executablePath))))) {
						throw new Error(`Browser archive did not contain its expected executable: ${executablePath}`);
					}
					await fsp.rm(installPath, { recursive: true, force: true });
					await fsp.rename(stagingPath, installPath);
				} finally {
					await Promise.all([
						fsp.rm(archivePath, { force: true }).catch(() => {}),
						fsp.rm(stagingPath, { recursive: true, force: true }).catch(() => {}),
					]);
				}
			}
			return { buildId: options.buildId, platform, path: installPath, executablePath };
		},
		{ retries: Math.ceil(DOWNLOAD_TIMEOUT_MS / 100) + 1, retryDelayMs: 100 },
	);
}

/** Inputs for removing managed Chrome builds other than the current one. */
export interface PruneStaleBuildsOptions {
	cacheDir: string;
	/** Build that stays installed. */
	keepBuildId: string;
	/** True when a running process executes from this install directory; such a build is kept. */
	isInUse: (installPath: string) => boolean;
}

/**
 * Remove every managed Chrome build under `<cacheDir>/chrome` except
 * `keepBuildId` and builds a running process still executes from (deleting a
 * live browser's bundle crashes its next tab or helper). A build whose install
 * lock another process holds is skipped, so pruning never races its installer.
 * Returns the removed install directories.
 */
export async function pruneStaleBuilds(options: PruneStaleBuildsOptions): Promise<string[]> {
	const chromeDir = path.join(options.cacheDir, "chrome");
	let entries: string[];
	try {
		entries = await fsp.readdir(chromeDir);
	} catch (error) {
		if (isMissingPath(error)) return [];
		throw error;
	}
	const removed: string[] = [];
	for (const entry of entries) {
		if (entry.startsWith(".") || entry.endsWith(`-${options.keepBuildId}`)) continue;
		const installPath = path.join(chromeDir, entry);
		if (!(await fsp.stat(installPath)).isDirectory() || options.isInUse(installPath)) continue;
		// A held lock means an installer is publishing this build right now; leave it.
		const lock = tryAcquireFileLock(`${installPath}.install`);
		if (!lock) continue;
		try {
			await fsp.rm(installPath, { recursive: true, force: true });
		} finally {
			lock.release();
		}
		removed.push(installPath);
	}
	return removed;
}

function chromeArchivePlatform(platform: BrowserPlatform): string {
	switch (requireChromeForTestingPlatform(platform)) {
		case BrowserPlatform.LINUX:
			return "linux64";
		case BrowserPlatform.MAC:
			return "mac-x64";
		case BrowserPlatform.MAC_ARM:
			return "mac-arm64";
		case BrowserPlatform.WIN32:
			return "win32";
		case BrowserPlatform.WIN64:
			return "win64";
	}
}

function installationDir(cacheDir: string, platform: BrowserPlatform, buildId: string): string {
	return path.join(cacheDir, "chrome", `${platform}-${buildId}`);
}

function isMissingPath(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fsp.access(filePath);
		return true;
	} catch (error) {
		if (isMissingPath(error)) return false;
		throw error;
	}
}

async function downloadArchive(
	url: URL,
	destination: string,
	onProgress: ((progress: BrowserDownloadProgress) => void) | undefined,
): Promise<void> {
	const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
	if (!response.ok || !response.body) {
		throw new Error(`Browser download failed (${response.status} ${response.statusText}) from ${url}`);
	}
	const totalBytes = Number(response.headers.get("content-length") ?? 0);
	const file = await fsp.open(destination, "wx");
	let downloadedBytes = 0;
	try {
		const reader = response.body.getReader();
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			let offset = 0;
			while (offset < chunk.value.byteLength) {
				const write = await file.write(chunk.value, offset, chunk.value.byteLength - offset, null);
				if (write.bytesWritten === 0) throw new Error(`Browser download stalled while writing ${destination}`);
				offset += write.bytesWritten;
			}
			downloadedBytes += chunk.value.byteLength;
			onProgress?.({ downloadedBytes, totalBytes });
		}
	} finally {
		await file.close();
	}
}
