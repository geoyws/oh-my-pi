import { afterAll, beforeAll } from "bun:test";

/**
 * Make the browser relay and its clients in this test file use `token` instead of the user's real
 * capability file (`PI_BROWSER_RELAY_CDP_TOKEN` wins over the file). Returns the token.
 */
export function useTestRelayToken(token = "r".repeat(43)): string {
	const saved = process.env.PI_BROWSER_RELAY_CDP_TOKEN;
	beforeAll(() => {
		process.env.PI_BROWSER_RELAY_CDP_TOKEN = token;
	});
	afterAll(() => {
		if (saved === undefined) delete process.env.PI_BROWSER_RELAY_CDP_TOKEN;
		else process.env.PI_BROWSER_RELAY_CDP_TOKEN = saved;
	});
	return token;
}
