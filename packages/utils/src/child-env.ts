/**
 * Allowlisted environment for processes OMP starts on the agent's behalf
 * (bash tool shells, JS eval workers, MCP stdio servers, plugin package
 * managers). Anything an agent runs there — a package install script, a test,
 * a prompt-injected command — can read and exfiltrate its environment, and
 * output redaction does not stop network egress. So children receive only
 * names they need to work (paths, locale, terminal, toolchain roots) plus the
 * names the user lists in `subprocess.envPassthrough`; provider and infra
 * credentials stay in the OMP process (kb omp t-2b5e0f2c).
 */

/** Exact names every child keeps. Exact names bypass the credential-name guard. */
const CHILD_ENV_ALLOW: Record<string, true> = {
	PATH: true,
	HOME: true,
	USER: true,
	LOGNAME: true,
	SHELL: true,
	PWD: true,
	LANG: true,
	LANGUAGE: true,
	TZ: true,
	TERM: true,
	TERM_PROGRAM: true,
	TERM_PROGRAM_VERSION: true,
	COLORTERM: true,
	COLUMNS: true,
	LINES: true,
	NO_COLOR: true,
	FORCE_COLOR: true,
	CLICOLOR: true,
	TMPDIR: true,
	TEMP: true,
	TMP: true,
	EDITOR: true,
	VISUAL: true,
	PAGER: true,
	LESS: true,
	MANPATH: true,
	INFOPATH: true,
	DISPLAY: true,
	WAYLAND_DISPLAY: true,
	DBUS_SESSION_BUS_ADDRESS: true,
	SSH_AUTH_SOCK: true,
	SSH_AGENT_PID: true,
	GPG_TTY: true,
	TMUX: true,
	TMUX_PANE: true,
	CI: true,
	NODE_ENV: true,
	NODE_PATH: true,
	GOPATH: true,
	GOROOT: true,
	GOBIN: true,
	CARGO_HOME: true,
	RUSTUP_HOME: true,
	JAVA_HOME: true,
	ANDROID_HOME: true,
	NVM_DIR: true,
	PNPM_HOME: true,
	BUN_INSTALL: true,
	VOLTA_HOME: true,
	DENO_DIR: true,
	PYENV_ROOT: true,
	VIRTUAL_ENV: true,
	CONDA_PREFIX: true,
	CONDA_DEFAULT_ENV: true,
	PYTHONPATH: true,
	LD_LIBRARY_PATH: true,
	DYLD_LIBRARY_PATH: true,
	HOMEBREW_PREFIX: true,
	HOMEBREW_CELLAR: true,
	HOMEBREW_REPOSITORY: true,
	DOCKER_HOST: true,
	DOCKER_CONTEXT: true,
	KUBECONFIG: true,
	GIT_AUTHOR_NAME: true,
	GIT_AUTHOR_EMAIL: true,
	GIT_COMMITTER_NAME: true,
	GIT_COMMITTER_EMAIL: true,
	GIT_EDITOR: true,
	GIT_SSH_COMMAND: true,
	// Windows
	APPDATA: true,
	COMPUTERNAME: true,
	COMSPEC: true,
	HOMEDRIVE: true,
	HOMEPATH: true,
	LOCALAPPDATA: true,
	NUMBER_OF_PROCESSORS: true,
	OS: true,
	PATHEXT: true,
	PROCESSOR_ARCHITECTURE: true,
	PROCESSOR_IDENTIFIER: true,
	PROGRAMDATA: true,
	PROGRAMFILES: true,
	"PROGRAMFILES(X86)": true,
	PROGRAMW6432: true,
	SESSIONNAME: true,
	SYSTEMDRIVE: true,
	SYSTEMROOT: true,
	USERDOMAIN: true,
	USERDOMAIN_ROAMINGPROFILE: true,
	USERPROFILE: true,
	USERNAME: true,
	WINDIR: true,
};

/** Prefixes every child keeps, unless the name looks like a credential. */
const CHILD_ENV_ALLOW_PREFIXES = ["LC_", "XDG_", "PI_", "OMP_", "npm_config_", "npm_package_"];

/** `_`-separated name segments that mark a credential. */
const CREDENTIAL_SEGMENTS: Record<string, true> = {
	KEY: true,
	KEYS: true,
	APIKEY: true,
	TOKEN: true,
	AUTHTOKEN: true,
	TOKENS: true,
	SECRET: true,
	SECRETS: true,
	PASSWORD: true,
	PASSWD: true,
	PASS: true,
	PWD: true,
	CREDENTIAL: true,
	CREDENTIALS: true,
	COOKIE: true,
	COOKIES: true,
	AUTH: true,
	PRIVATE: true,
	RING: true,
};

/** Whether `name` reads like a credential (any `_` segment such as KEY, TOKEN, SECRET, PASSWORD). */
export function isCredentialEnvName(name: string): boolean {
	return name
		.toUpperCase()
		.split("_")
		.some(segment => Object.hasOwn(CREDENTIAL_SEGMENTS, segment));
}

let passthroughNames: ReadonlySet<string> = new Set();

/**
 * Names the user explicitly lets every child inherit (`subprocess.envPassthrough`).
 * Credentials listed here reach every child; the setting says so.
 */
export function setChildEnvPassthrough(names: readonly string[]): void {
	// Settings arrive from user YAML: ignore anything that is not a name.
	passthroughNames = new Set(
		names
			.filter((name): name is string => typeof name === "string" && name.length > 0)
			.map(name => (process.platform === "win32" ? name.toUpperCase() : name)),
	);
}

/** The allowlisted subset of `env` for a child process OMP starts. */
export function filterChildEnv(env: Record<string, string | undefined>): Record<string, string> {
	const result: Record<string, string> = {};
	const caseInsensitive = process.platform === "win32";
	for (const key in env) {
		const value = env[key];
		if (value === undefined) continue;
		const name = caseInsensitive ? key.toUpperCase() : key;
		const allowed =
			Object.hasOwn(CHILD_ENV_ALLOW, name) ||
			passthroughNames.has(name) ||
			(CHILD_ENV_ALLOW_PREFIXES.some(prefix => name.startsWith(caseInsensitive ? prefix.toUpperCase() : prefix)) &&
				!isCredentialEnvName(name));
		if (allowed) result[key] = value;
	}
	return result;
}
