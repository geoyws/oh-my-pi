import { afterEach, describe, expect, it } from "bun:test";
import { filterChildEnv, isCredentialEnvName, setChildEnvPassthrough } from "@oh-my-pi/pi-utils/child-env";

afterEach(() => setChildEnvPassthrough([]));

// The names the 2026-10-28 @@mbp audit found in the bash tool env (kb omp t-2b5e0f2c).
const AUDITED_CREDENTIALS = [
	"ARK_API_KEY",
	"ARK_API_KEY_IFCA",
	"CF_API_TOKEN",
	"CI_WEBHOOK_SECRET",
	"DEEPSEEK_API_KEY",
	"ELEVENLABS_API_KEY",
	"GOOGLE_MAPS_API_KEY",
	"HF_TOKEN",
	"HQ_GEORGEYWS_GIT_PASSWORD",
	"IFCA_DOCS_PASSWORD",
	"MINIMAX_API_KEY",
	"MINIMAX_CODE_API_KEY",
	"OPENROUTER_API_KEY",
	"SEEDANCE_API_KEY",
	"UNUM_DEV_DB_PASSWORD",
	"ZAI_API_KEY",
	"AUTH_TOTP_KEY_RING",
];

describe("filterChildEnv", () => {
	it("drops every audited credential and keeps what a shell needs", () => {
		const env: Record<string, string> = {
			PATH: "/usr/bin",
			HOME: "/home/u",
			LANG: "en_US.UTF-8",
			LC_ALL: "C",
			SSH_AUTH_SOCK: "/tmp/agent.sock",
			PI_CODING_AGENT_DIR: "/home/u/.omp/agent",
			UNRELATED_APP_SETTING: "x",
		};
		for (const name of AUDITED_CREDENTIALS) env[name] = "secret-value";

		const child = filterChildEnv(env);
		for (const name of AUDITED_CREDENTIALS) expect(child[name], name).toBeUndefined();
		expect(child).toEqual({
			PATH: "/usr/bin",
			HOME: "/home/u",
			LANG: "en_US.UTF-8",
			LC_ALL: "C",
			SSH_AUTH_SOCK: "/tmp/agent.sock",
			PI_CODING_AGENT_DIR: "/home/u/.omp/agent",
		});
	});

	it("does not let an allowed prefix carry a credential", () => {
		expect(filterChildEnv({ PI_GATEWAY_TOKEN: "t", npm_config__authToken: "t", OMP_API_KEY: "k" })).toEqual({});
	});

	it("admits exactly the names the user lists for passthrough", () => {
		setChildEnvPassthrough(["CF_API_TOKEN"]);
		expect(filterChildEnv({ CF_API_TOKEN: "t", HF_TOKEN: "h" })).toEqual({ CF_API_TOKEN: "t" });
	});
});

describe("isCredentialEnvName", () => {
	it("matches whole name segments, not substrings", () => {
		expect(isCredentialEnvName("GITHUB_TOKEN")).toBe(true);
		expect(isCredentialEnvName("DB_PASSWORD")).toBe(true);
		expect(isCredentialEnvName("MONKEY_COUNT")).toBe(false);
		expect(isCredentialEnvName("TOKENIZER_PATH")).toBe(false);
	});
});
