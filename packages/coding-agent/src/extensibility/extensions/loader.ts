/**
 * Extension loader - loads TypeScript extension modules using native Bun import.
 */
import type * as fs1 from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import * as zod from "@oh-my-pi/omptype/zod";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type {
	ImageContent,
	Model,
	ServiceTier,
	ServiceTierByFamily,
	ServiceTierFamily,
	TextContent,
	TSchema,
} from "@oh-my-pi/pi-ai";
import { isBuiltinComposerStyle, type KeyId } from "@oh-my-pi/pi-tui";
import { hasFsCode, isEacces, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { fingerprintProjectSurface, isProjectSurfaceTrusted } from "@oh-my-pi/pi-utils/project-trust";
import { boundSettings } from "../../capability";
import { type ExtensionModule, extensionModuleCapability } from "../../capability/extension-module";
import { type Hook, hookCapability } from "../../capability/hook";
import { isServiceTierFamily, isServiceTierForFamily } from "../../config/service-tier";
import { loadCapability } from "../../discovery";
import { getExtensionNameFromPath } from "../../discovery/helpers";
import type { ExecOptions } from "../../exec/exec";
import { execCommand } from "../../exec/exec";
import { getCodingAgentApi } from "../host-api";
import type { SendUserMessageOptions } from "../../session/agent-session";
import type { CustomMessagePayload } from "../../session/messages";
import type { FileDeleteFallbackHandler, FileWriteFallbackHandler } from "../../tools/file-write-fallback";
import { isFilesystemSourcePath } from "../../tools/path-utils";
import { InternalUrlRouter } from "../../internal-urls/router";
import { EventBus } from "../../utils/event-bus";
import * as TypeBox from "../legacy-typebox";
import { resolveExtensionDirectory } from "./directory-resolution";
import { installLegacyPiSpecifierShim, loadLegacyPiModule } from "../plugins/legacy-pi-compat";
import { getAllPluginExtensionPaths } from "../plugins/loader";
import { cfgDisabledExtensions } from "../settings";

import { resolvePath, withHostGuard } from "../utils";
import type { ComposerShapeDefinition } from "@oh-my-pi/pi-tui/overlays/composer-shape-registry";
import type {
	AssistantTextRenderer,
	AssistantThinkingRenderer,
	Extension,
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ExtensionRuntime as IExtensionRuntime,
	LoadExtensionsResult,
	MessageRenderer,
	PreparedExtension,
	ProviderConfig,
	RegisteredCommand,
	SourceInfo,
	ToolDefinition,
	ToolInfo,
} from "./types";

installLegacyPiSpecifierShim();

type HandlerFn = (...args: unknown[]) => Promise<unknown>;
type LoadedExtensionModule = ExtensionFactory | { default?: ExtensionFactory };

/** RFC 3986 scheme syntax, lowercased, two characters at least so `c` cannot capture `C:/` paths. */
const LINK_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]+$/;

/** Standard schemes an extension may not claim: web, file and mail links. omp's internal URLs are refused too. */
const STANDARD_LINK_SCHEMES: Readonly<Record<string, true>> = {
	about: true,
	blob: true,
	data: true,
	file: true,
	ftp: true,
	http: true,
	https: true,
	javascript: true,
	mailto: true,
	ssh: true,
	ws: true,
	wss: true,
};

function getExtensionFactory(module: LoadedExtensionModule): ExtensionFactory | null {
	const candidate = typeof module === "function" ? module : module.default;
	return typeof candidate === "function" ? candidate : null;
}

/**
 * Upstream-shaped provenance for an extension-registered tool. Consumers that
 * read `sourceInfo` off `getAllRegisteredTools()` (e.g. pi-fabric) receive an
 * absolute on-disk path: the tool's own `sourcePath` when it is filesystem-
 * absolute, otherwise the extension's resolved entry (`fallbackPath`). A tool
 * with no absolute origin at all falls back to the synthetic `<extension:name>`.
 */
export function extensionToolSourceInfo(
	definition: Pick<ToolDefinition, "name" | "sourcePath">,
	fallbackPath: string,
): SourceInfo {
	const sourcePath = definition.sourcePath;
	const path =
		sourcePath && isFilesystemSourcePath(sourcePath)
			? sourcePath
			: isFilesystemSourcePath(fallbackPath)
				? fallbackPath
				: `<extension:${definition.name}>`;
	return { path, source: "extension", scope: "temporary", origin: "top-level" };
}

export class ExtensionRuntimeNotInitializedError extends Error {
	constructor() {
		super("Extension runtime not initialized. Action methods cannot be called during extension loading.");
	}
}

/**
 * Extension runtime with throwing stubs for action methods.
 * These are replaced with real implementations during initialization.
 */
export class ExtensionRuntime implements IExtensionRuntime {
	flagValues = new Map<string, boolean | string>();
	pendingProviderRegistrations: Array<{ name: string; config: ProviderConfig; sourceId: string }> = [];

	registerProvider(name: string, config: ProviderConfig, sourceId: string): void {
		this.pendingProviderRegistrations.push({ name, config, sourceId });
	}

	unregisterProvider(name: string): void {
		const remaining = this.pendingProviderRegistrations.filter(registration => registration.name !== name);
		this.pendingProviderRegistrations.splice(0, this.pendingProviderRegistrations.length, ...remaining);
	}

	sendMessage(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	sendUserMessage(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	appendEntry(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setLabel(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getActiveTools(): string[] {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getAllTools(): ToolInfo[] {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setActiveTools(): Promise<void> {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getCommands(): never {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setModel(): Promise<boolean> {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getThinkingLevel(): ThinkingLevel {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setThinkingLevel(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getServiceTiers(): ServiceTierByFamily {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setServiceTier(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getSessionName(): string | undefined {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setSessionName(): Promise<void> {
		throw new ExtensionRuntimeNotInitializedError();
	}
}

/**
 * ExtensionAPI implementation for an extension.
 * Registration methods write to the extension object.
 * Action methods delegate to the shared runtime.
 */
class ConcreteExtensionAPI implements ExtensionAPI, IExtensionRuntime {
	readonly logger = logger;
	readonly typebox = TypeBox;
	readonly arktype = type;
	readonly zod = zod;
	readonly flagValues = new Map<string, boolean | string>();
	readonly pendingProviderRegistrations: Array<{
		name: string;
		config: ProviderConfig;
		sourceId: string;
	}> = [];

	get pi() {
		return getCodingAgentApi();
	}

	constructor(
		private readonly extension: Extension,
		private readonly runtime: IExtensionRuntime,
		private readonly cwd: string,
		public readonly events: EventBus,
	) {
		// Extensions destructure `pi.on` or forward API methods as callbacks, so every
		// prototype method must keep its receiver when detached. Walk the prototype
		// rather than listing methods: a new method is bound without touching this.
		const prototype = ConcreteExtensionAPI.prototype;
		for (const name of Object.getOwnPropertyNames(prototype)) {
			if (name === "constructor") continue;
			const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
			if (typeof descriptor?.value !== "function") continue;
			Object.defineProperty(this, name, { value: descriptor.value.bind(this), writable: true, configurable: true });
		}
	}

	on<F extends HandlerFn>(event: string, handler: F): void {
		const list = this.extension.handlers.get(event) ?? [];
		list.push(handler);
		this.extension.handlers.set(event, list);
	}

	registerTool<TParams extends TSchema = TSchema, TDetails = unknown>(tool: ToolDefinition<TParams, TDetails>): void {
		const registered = {
			definition: tool,
			extensionPath: this.extension.path,
			sourceInfo: extensionToolSourceInfo(tool, this.extension.resolvedPath),
		};
		this.extension.tools.set(tool.name, registered);
		for (const listener of this.extension.toolRegistrationListeners ?? []) listener(tool.name);
	}

	registerFileWriteFallback(handler: FileWriteFallbackHandler): void {
		this.extension.fileWriteFallbackHandlers.push(handler);
	}

	registerFileDeleteFallback(handler: FileDeleteFallbackHandler): void {
		this.extension.fileDeleteFallbackHandlers.push(handler);
	}

	registerCommand(
		name: string,
		options: {
			description?: string;
			getArgumentCompletions?: RegisteredCommand["getArgumentCompletions"];
			handler: RegisteredCommand["handler"];
		},
	): void {
		this.extension.commands.set(name, { name, ...options });
	}

	setLabel(label: string): void {
		this.extension.label = label;
	}

	registerShortcut(
		shortcut: KeyId,
		options: {
			description?: string;
			handler: (ctx: ExtensionContext) => Promise<void> | void;
		},
	): void {
		this.extension.shortcuts.set(shortcut, { shortcut, extensionPath: this.extension.path, ...options });
	}

	registerFlag(
		name: string,
		options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
	): void {
		this.extension.flags.set(name, { name, extensionPath: this.extension.path, ...options });
		if (options.default !== undefined) {
			this.runtime.flagValues.set(name, options.default);
		}
	}

	registerMessageRenderer<T>(customType: string, renderer: MessageRenderer<T>): void {
		this.extension.messageRenderers.set(customType, renderer as MessageRenderer);
	}

	registerAssistantThinkingRenderer(renderer: AssistantThinkingRenderer): void {
		this.extension.assistantThinkingRenderers.push(renderer);
	}

	registerAssistantTextRenderer(renderer: AssistantTextRenderer): void {
		if (typeof renderer !== "function") {
			throw new TypeError(
				`registerAssistantTextRenderer expects a function, got ${typeof renderer} (extension ${this.extension.path})`,
			);
		}
		this.extension.assistantTextRenderers.push(renderer);
	}

	registerLinkScheme(scheme: string): void {
		const normalized = scheme.toLowerCase();
		if (!LINK_SCHEME_PATTERN.test(normalized)) {
			throw new Error(
				`registerLinkScheme: "${scheme}" is not a URL scheme of two or more characters (letters, digits, "+", "-", ".")`,
			);
		}
		// `=== true`: inherited keys such as `constructor` are not reserved.
		if (STANDARD_LINK_SCHEMES[normalized] === true || InternalUrlRouter.instance().isBuiltin(normalized)) {
			throw new Error(`registerLinkScheme: "${scheme}" is reserved for standard or omp-internal links`);
		}
		if (!this.extension.linkSchemes.includes(normalized)) this.extension.linkSchemes.push(normalized);
	}

	registerComposerShape(definition: ComposerShapeDefinition): void {
		const id = definition.style.id;
		if (id.length === 0 || id !== id.trim()) {
			throw new TypeError("Composer shape id must be a non-empty trimmed string");
		}
		if (definition.label.trim().length === 0) {
			throw new TypeError(`Composer shape "${id}" must have a label`);
		}
		if (isBuiltinComposerStyle(id)) {
			throw new Error(`Cannot replace built-in composer shape "${id}"`);
		}
		this.extension.composerShapes.set(id, definition);
	}

	getFlag(name: string): boolean | string | undefined {
		if (!this.extension.flags.has(name)) return undefined;
		return this.runtime.flagValues.get(name);
	}

	sendMessage<T = unknown>(
		message: CustomMessagePayload<T>,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" | "aside" },
	): void {
		this.runtime.sendMessage(message, options);
	}

	sendUserMessage(content: string | (TextContent | ImageContent)[], options?: SendUserMessageOptions): void {
		this.runtime.sendUserMessage(content, options);
	}

	appendEntry(customType: string, data?: unknown): void {
		this.runtime.appendEntry(customType, data);
	}

	exec(command: string, args: string[], options?: ExecOptions) {
		return execCommand(command, args, options?.cwd ?? this.cwd, options);
	}

	getActiveTools(): string[] {
		return this.runtime.getActiveTools();
	}

	getAllTools(): ToolInfo[] {
		return this.runtime.getAllTools();
	}

	setActiveTools(toolNames: string[]): Promise<void> {
		return this.runtime.setActiveTools(toolNames);
	}

	getCommands() {
		return this.runtime.getCommands();
	}

	setModel(model: Model): Promise<boolean> {
		return this.runtime.setModel(model);
	}

	getThinkingLevel(): ThinkingLevel | undefined {
		return this.runtime.getThinkingLevel();
	}

	setThinkingLevel(level: ThinkingLevel, persist?: boolean): void {
		this.runtime.setThinkingLevel(level, persist);
	}

	getServiceTiers(): Readonly<ServiceTierByFamily> {
		return { ...this.runtime.getServiceTiers() };
	}

	setServiceTier(family: ServiceTierFamily, tier: ServiceTier | undefined): void {
		if (!isServiceTierFamily(family) || (tier !== undefined && !isServiceTierForFamily(family, tier))) {
			throw new TypeError(`Invalid service tier "${String(tier)}" for family "${String(family)}"`);
		}
		this.runtime.setServiceTier(family, tier);
	}

	getSessionName(): string | undefined {
		return this.runtime.getSessionName();
	}

	setSessionName(name: string): Promise<void> {
		return this.runtime.setSessionName(name);
	}

	registerProvider(name: string, config: ProviderConfig): void {
		this.extension.registersProviders = true;
		this.runtime.registerProvider(name, config, this.extension.path);
	}

	unregisterProvider(name: string): void {
		this.runtime.unregisterProvider(name, this.extension.path);
	}
}

/**
 * Create an Extension object with empty collections.
 */
function createExtension(extensionPath: string, resolvedPath: string): Extension {
	return {
		path: extensionPath,
		resolvedPath,
		handlers: new Map(),
		tools: new Map(),
		toolRegistrationListeners: new Set(),
		assistantThinkingRenderers: [],
		assistantTextRenderers: [],
		linkSchemes: [],
		fileWriteFallbackHandlers: [],
		fileDeleteFallbackHandlers: [],
		messageRenderers: new Map(),
		composerShapes: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}

/**
 * Runs an extension factory with provider registration rollback on failure.
 * Restores the complete registration queue when the factory throws because an
 * extension may unregister entries queued by an earlier extension.
 */
async function runExtensionFactory(
	factory: ExtensionFactory,
	api: ExtensionAPI,
	runtime: IExtensionRuntime,
): Promise<void> {
	const providerRegistrationCheckpoint = [...runtime.pendingProviderRegistrations];

	try {
		await factory(api);
	} catch (error) {
		runtime.pendingProviderRegistrations.splice(
			0,
			runtime.pendingProviderRegistrations.length,
			...providerRegistrationCheckpoint,
		);
		throw error;
	}
}

async function importExtensionModule(extensionPath: string, cwd: string): Promise<PreparedExtension> {
	const resolvedPath = resolvePath(extensionPath, cwd);
	try {
		const module = (await withHostGuard(() => loadLegacyPiModule(resolvedPath))) as LoadedExtensionModule;
		const factory = getExtensionFactory(module);

		if (typeof factory !== "function") {
			return {
				path: extensionPath,
				factory: null,
				resolvedPath,
				error: `Extension does not export a valid factory function: ${extensionPath}`,
			};
		}

		return { path: extensionPath, factory, resolvedPath, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { path: extensionPath, factory: null, resolvedPath, error: `Failed to load extension: ${message}` };
	}
}

async function bindExtension(
	extensionPath: string,
	imported: PreparedExtension,
	cwd: string,
	eventBus: EventBus,
	runtime: IExtensionRuntime,
): Promise<{ extension: Extension | null; error: string | null }> {
	const factory = imported.factory;
	if (imported.error !== null || factory === null) {
		return { extension: null, error: imported.error };
	}
	try {
		const extension = createExtension(extensionPath, imported.resolvedPath);
		const api = new ConcreteExtensionAPI(extension, runtime, cwd, eventBus);
		await withHostGuard(() => runExtensionFactory(factory, api, runtime));

		return { extension, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { extension: null, error: `Failed to load extension: ${message}` };
	}
}

/**
 * Create an Extension from an inline factory function.
 */
export async function loadExtensionFromFactory(
	factory: ExtensionFactory,
	cwd: string,
	eventBus: EventBus,
	runtime: IExtensionRuntime,
	name = "<inline>",
): Promise<Extension> {
	const extension = createExtension(name, name);
	const api = new ConcreteExtensionAPI(extension, runtime, cwd, eventBus);
	await runExtensionFactory(factory, api, runtime);
	return extension;
}

/**
 * Load extensions from paths.
 *
 * Module import (the dominant cold-start cost — file I/O plus module
 * evaluation) runs concurrently across extensions; factory binding then runs
 * sequentially in the original path order, so registration semantics
 * (last-wins collisions, shared runtime flag defaults) stay deterministic.
 */
export async function loadExtensions(
	paths: string[],
	cwd: string,
	eventBus?: EventBus,
	runtime?: IExtensionRuntime,
): Promise<LoadExtensionsResult> {
	const preparedExtensions = await Promise.all(paths.map(extPath => importExtensionModule(extPath, cwd)));
	return bindPreparedExtensions(preparedExtensions, cwd, eventBus, runtime);
}

/**
 * Bind previously imported extension factories. A fresh session runtime is
 * created unless `runtime` is given: deferred startup extensions bind into the
 * live session's runtime so they share its flag values and wired actions.
 */
export async function bindPreparedExtensions(
	preparedExtensions: readonly PreparedExtension[],
	cwd: string,
	eventBus?: EventBus,
	runtime: IExtensionRuntime = new ExtensionRuntime(),
): Promise<LoadExtensionsResult> {
	const extensions: Extension[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const resolvedEventBus = eventBus ?? new EventBus();

	for (const prepared of preparedExtensions) {
		const { extension, error } = await bindExtension(prepared.path, prepared, cwd, resolvedEventBus, runtime);

		if (error) {
			errors.push({ path: prepared.path, error });
			continue;
		}

		if (extension) {
			extensions.push(extension);
		}
	}

	return {
		extensions,
		errors,
		runtime,
		preparedExtensions: [...preparedExtensions],
	};
}

function isExtensionFile(name: string): boolean {
	return name.endsWith(".ts") || name.endsWith(".js");
}

const CONFIGURED_EXTENSION_DIRECTORY_OPTIONS = {
	indexNames: ["index.ts", "index.js"],
	isScanFile: isExtensionFile,
	throwUnexpectedStatErrors: true,
	onReadError: (filePath: string, error: unknown) => {
		logger.warn("Failed to resolve extension directory", { path: filePath, error: String(error) });
	},
};

async function discoverHooksInPackageRoot(root: string): Promise<string[]> {
	const hooks: string[] = [];
	for (const hookType of ["pre", "post"]) {
		const hookDir = path.join(root, "hooks", hookType);
		let entries: fs1.Dirent[];
		try {
			entries = await fs.readdir(hookDir, { withFileTypes: true });
		} catch (err) {
			if (isEnoent(err) || isEacces(err) || hasFsCode(err, "ENOTDIR") || hasFsCode(err, "EPERM")) continue;
			throw err;
		}
		for (const entry of entries) {
			if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
				hooks.push(path.join(hookDir, entry.name));
			}
		}
	}
	return hooks;
}

const EXTENSION_ROOT_DIR_NAMES: Record<string, true> = { extensions: true, hooks: true, pre: true, post: true };

/**
 * Every file an extension entry can pull in from its own directory: the entry's
 * extension root (the folder directly under an `extensions`/`hooks` dir inside
 * `projectDir`, else the entry itself). Everything under the root counts,
 * dot-directories and `node_modules` included, because an approved entry can
 * import any of it; only `.git` metadata is skipped. Each file is recorded by
 * its SHA-256. A symlinked directory below the root is recorded by its link
 * target, not walked. Imports reaching outside the root are not covered.
 */
async function collectExtensionCodeFiles(projectDir: string, entry: string, into: Map<string, string>): Promise<void> {
	let root = entry;
	let candidate = entry;
	for (let dir = path.dirname(entry); dir.startsWith(projectDir + path.sep); dir = path.dirname(dir)) {
		if (Object.hasOwn(EXTENSION_ROOT_DIR_NAMES, path.basename(dir))) {
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
 * What a configured `extensions:` path names: a directory's entry files
 * (`directory: true`), else the path itself.
 */
async function expandConfiguredExtensionPath(
	configuredPath: string,
	cwd: string,
): Promise<{ resolved: string; directory: boolean; files: string[] }> {
	const resolved = resolvePath(configuredPath, cwd);
	let stat: fs1.Stats | null = null;
	try {
		stat = await fs.stat(resolved);
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}
	if (stat?.isDirectory()) {
		return {
			resolved,
			directory: true,
			files: resolveExtensionDirectory(resolved, CONFIGURED_EXTENSION_DIRECTORY_OPTIONS).files,
		};
	}
	return { resolved, directory: false, files: [resolved] };
}

export interface AmbientExtensionEntries {
	/** Native extension modules then hook factories, in load order, with their source level. */
	entries: Array<{ path: string; level: "user" | "project" }>;
	/**
	 * Repository-supplied entry points: level-`project` ambient entries, then
	 * the `projectConfiguredEntries`.
	 */
	projectPaths: string[];
	/** Entry points named by an `extensions:` setting that a project settings file supplied. */
	projectConfiguredEntries: string[];
	/** Fingerprint of every file those entries can load from their own roots. */
	projectFingerprint: string;
	/** Whether `omp trust` approved exactly that fingerprint for `cwd`. */
	projectTrusted: boolean;
}

type AmbientEntry = AmbientExtensionEntries["entries"][number];
type AmbientLoadOptions = { cwd: string; disabledExtensions?: string[] };

/** Native extension modules for `loadOptions`. */
async function listNativeExtensionEntries(loadOptions: AmbientLoadOptions): Promise<AmbientEntry[]> {
	// Native provider only — the extension-module capability also has
	// claude/codex/gemini/opencode providers whose items were discarded here
	// anyway (see #4198); the filter skips those walks entirely.
	const discovered = await loadCapability<ExtensionModule>(extensionModuleCapability.id, {
		...loadOptions,
		providers: ["native"],
	});
	return discovered.items.map(ext => ({ path: ext.path, level: ext.level }));
}

/** JS/TS hook factories for `loadOptions`. */
async function listHookEntries(loadOptions: AmbientLoadOptions): Promise<AmbientEntry[]> {
	const hooks = await loadCapability<Hook>(hookCapability.id, loadOptions);
	return hooks.items
		.filter(hook => isExtensionFile(path.basename(hook.path)))
		.map(hook => ({ path: hook.path, level: hook.level }));
}

/**
 * Ambient extension entry points for `cwd` and the approval state of the
 * repository-supplied ones (kb omp t-f77ec1f5). Shared by startup discovery
 * and `omp trust`, so both fingerprint the same code. `projectConfiguredPaths`
 * is the `extensions:` list when a project settings file supplied it
 * (`Settings.extensionsSourceLevel() === "project"`): repository-controlled
 * code under the same approval as `.omp/extensions`.
 *
 * The fingerprint always covers every project entry, hooks included and none
 * disabled: `omp trust` approves the whole surface, so disabling one extension
 * or skipping hooks for a read-only command must not revoke that approval. A
 * capability is walked a second time only when the disabled list names its
 * ids or its entries were skipped.
 */
export async function loadAmbientExtensionEntries(
	cwd: string,
	loadOptions: AmbientLoadOptions = { cwd },
	includeHooks = true,
	projectConfiguredPaths: readonly string[] = [],
): Promise<AmbientExtensionEntries> {
	// Same fallback as loadCapability: no explicit list means the settings' list.
	const settings = boundSettings();
	const disabled =
		loadOptions.disabledExtensions ?? (settings ? cfgDisabledExtensions.get(settings) : undefined) ?? [];
	const unfilteredOptions = { cwd: loadOptions.cwd, disabledExtensions: [] };
	const nativeEntries = await listNativeExtensionEntries(loadOptions);
	const hookEntries = includeHooks ? await listHookEntries(loadOptions) : [];
	const entries = [...nativeEntries, ...hookEntries];
	const surfaceEntries = [
		...(disabled.some(id => id.startsWith("extension-module:"))
			? await listNativeExtensionEntries(unfilteredOptions)
			: nativeEntries),
		...(includeHooks && !disabled.some(id => id.startsWith("hook:"))
			? hookEntries
			: await listHookEntries(unfilteredOptions)),
	];
	const projectConfiguredEntries: string[] = [];
	// A configured directory is hashed whole: its entry files can import anything in it.
	const hashRoots = surfaceEntries.filter(entry => entry.level === "project").map(entry => entry.path);
	for (const configuredPath of projectConfiguredPaths) {
		const { resolved, files } = await expandConfiguredExtensionPath(configuredPath, cwd);
		projectConfiguredEntries.push(...files);
		hashRoots.push(resolved);
	}
	const projectPaths = [
		...entries.filter(entry => entry.level === "project").map(entry => entry.path),
		...projectConfiguredEntries,
	];
	const files = new Map<string, string>();
	if (hashRoots.length > 0) {
		// Compare real paths: discovery may report /private/var where cwd says /var.
		const realProjectDir = await fs.realpath(cwd).catch(() => path.resolve(cwd));
		for (const entry of hashRoots) {
			const realEntry = await fs.realpath(entry).catch(() => path.resolve(entry));
			await collectExtensionCodeFiles(realProjectDir, realEntry, files);
		}
	}
	const projectFingerprint = fingerprintProjectSurface([...files]);
	return {
		entries,
		projectPaths,
		projectConfiguredEntries,
		projectFingerprint,
		projectTrusted: isProjectSurfaceTrusted(cwd, "extensions", projectFingerprint),
	};
}

/**
 * Discover absolute paths of extensions to load, without importing or
 * binding factories. Hot path on session startup — the scan walks native
 * `.omp`/`.pi` extension capabilities, JS/TS hook factories, the
 * installed-plugin tree, and any configured paths.
 *
 * The root session imports these paths once and forwards prepared factories to
 * subagents. Each child rebinds fresh Extension instances to its OWN
 * ExtensionAPI (cwd, eventBus, runtime) without re-evaluating the module graph.
 */
export interface DiscoverExtensionPathOptions {
	/** Include ambient native extensions, hooks, and installed plugins. */
	ambient?: boolean;
	/** Include ambient hook factories. Disable for read-only catalog commands. */
	includeAmbientHooks?: boolean;
	/**
	 * The `extensions:` setting when a project settings file supplied it. These
	 * load only when the project is trusted for extensions; keep them out of
	 * `configuredPaths`, which load unconditionally (kb omp t-f77ec1f5).
	 */
	projectConfiguredPaths?: readonly string[];
}

export async function discoverExtensionPaths(
	configuredPaths: string[],
	cwd: string,
	disabledExtensionIds?: string[],
	options: DiscoverExtensionPathOptions = {},
): Promise<string[]> {
	const allPaths: string[] = [];
	const seen = new Set<string>();
	const disabled = new Set(disabledExtensionIds ?? []);
	const loadOptions = disabledExtensionIds ? { cwd, disabledExtensions: disabledExtensionIds } : { cwd };

	const isDisabledName = (name: string): boolean => disabled.has(`extension-module:${name}`);

	// Key on the real file so a symlink and its target load once, e.g. an
	// extensions/ symlink plus the same file passed with --extension. Missing
	// paths keep their lexical key so the loader still reports them.
	const addPath = async (extPath: string): Promise<void> => {
		const resolved = path.resolve(extPath);
		const key = await fs.realpath(resolved).catch(() => resolved);
		if (!seen.has(key)) {
			seen.add(key);
			allPaths.push(extPath);
		}
	};

	const addPaths = async (paths: string[]): Promise<void> => {
		for (const extPath of paths) {
			if (isDisabledName(getExtensionNameFromPath(extPath))) continue;
			await addPath(extPath);
		}
	};

	const ambient = options.ambient !== false;
	let projectConfiguredEntries: string[] = [];
	if (ambient) {
		// 1. Native extension modules, then 2. JS/TS hook factories, in that
		// order. Repository-supplied (project-level) entries load only when the
		// user approved this exact code with `omp trust` (kb omp t-f77ec1f5).
		const ambientEntries = await loadAmbientExtensionEntries(
			cwd,
			loadOptions,
			options.includeAmbientHooks !== false,
			options.projectConfiguredPaths,
		);
		if (!ambientEntries.projectTrusted) {
			logger.warn(
				`Project extensions not loaded: ${ambientEntries.projectPaths.join(", ")} — this project is not trusted for extensions. Review the code, then run \`omp trust\` in ${cwd}.`,
			);
		}
		for (const entry of ambientEntries.entries) {
			if (entry.level === "project" && !ambientEntries.projectTrusted) continue;
			addPath(entry.path);
		}
		projectConfiguredEntries = ambientEntries.projectTrusted ? ambientEntries.projectConfiguredEntries : [];
	} else {
		// Non-ambient discovery scans only this invocation's configured package
		// roots; it must not consult settings, installed packages, or
		// process-global CLI injection state.
		for (const configuredPath of configuredPaths) {
			await addPaths(await discoverHooksInPackageRoot(resolvePath(configuredPath, cwd)));
		}
	}

	// 3. Discover extension entry points from installed plugins.
	if (ambient) {
		await addPaths(await getAllPluginExtensionPaths(cwd));
	}

	// 4. Explicitly configured paths, then project-supplied ones that passed trust.
	for (const configuredPath of configuredPaths) {
		const { directory, files } = await expandConfiguredExtensionPath(configuredPath, cwd);
		if (directory) addPaths(files);
		else addPath(files[0]);
	}
	addPaths(projectConfiguredEntries);

	return allPaths;
}

/**
 * Discover and load extensions from standard locations. Composed of
 * {@link discoverExtensionPaths} (FS scan) + {@link loadExtensions}
 * (per-session binding).
 */
export async function discoverAndLoadExtensions(
	configuredPaths: string[],
	cwd: string,
	eventBus?: EventBus,
	disabledExtensionIds?: string[],
	options: DiscoverExtensionPathOptions = {},
): Promise<LoadExtensionsResult> {
	const paths = await discoverExtensionPaths(configuredPaths, cwd, disabledExtensionIds, options);
	return loadExtensions(paths, cwd, eventBus);
}
