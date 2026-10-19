import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { removeWithRetries, withTimeout } from "@oh-my-pi/pi-utils";
import { rejectionOf } from "./helpers/rejection";
const NOTICE = "RPC test refusal notice.";
const SECRET = "refuse: token FAKE-SECRET-NOT-REAL-0000";

describe("RPC before_user_message refusal", () => {
	let client: RpcClient;
	let directory: string;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-refusal-"));
		client = new RpcClient({
			command: [process.execPath, path.join(import.meta.dir, "fixtures", "refusal-rpc-agent.ts")],
			cwd: directory,
			env: { PI_CODING_AGENT_DIR: directory, PI_NO_TITLE: "1" },
		});
	});

	afterEach(async () => {
		await client?.stop();
		await removeWithRetries(directory);
	});

	test("refused prompt rejects with only the notice and never reaches the transcript", async () => {
		await client.start();
		const error = await rejectionOf(client.prompt(SECRET));
		expect(error instanceof Error ? error.message : String(error)).toBe(NOTICE);

		const messages = await client.getMessages();
		expect(JSON.stringify(messages)).not.toContain("FAKE-SECRET");

		const clean = await client.promptAndWait("clean rpc hello", undefined, 30_000);
		expect(clean.length).toBeGreaterThan(0);
		const after = await client.getMessages();
		expect(JSON.stringify(after)).toContain("clean rpc hello");
		expect(JSON.stringify(after)).not.toContain("FAKE-SECRET");
	}, 60_000);
	test("refused steer never reaches the transcript", async () => {
		await client.start();
		// steer is fire-and-forget client-side (no #getData on the response), so
		// the refusal surfaces as absence: drive a turn past it and read back.
		await client.steer(SECRET);
		await client.promptAndWait("clean after refused steer", undefined, 30_000);
		const messages = await client.getMessages();
		expect(JSON.stringify(messages)).toContain("clean after refused steer");
		expect(JSON.stringify(messages)).not.toContain("FAKE-SECRET");
		// A clean steer still delivers. The steer starts a turn on admission, so
		// wait for it to settle before prompting (an idle prompt would race it).
		const idle = Promise.withResolvers<void>();
		const unsubscribe = client.onEvent(event => {
			if (event.type === "agent_end") idle.resolve();
		});
		try {
			await client.steer("clean steer hello");
			await withTimeout(idle.promise, 15_000, "Clean steer turn did not finish");
		} finally {
			unsubscribe();
		}
		await client.promptAndWait("clean follow", undefined, 30_000);
		expect(JSON.stringify(await client.getMessages())).toContain("clean steer hello");
	}, 60_000);
	test("refused /skill: fails with only the notice and is never persisted", async () => {
		await client.start();
		const error = await rejectionOf(
			client.promptAndWait("/skill:reviewer please use token FAKE-SECRET-NOT-REAL-0000", undefined, 30_000),
		);
		expect(error instanceof Error ? error.message : String(error)).toBe(NOTICE);
		expect(JSON.stringify(await client.getMessages())).not.toContain("FAKE-SECRET");
		// A clean skill invocation still delivers.
		await client.promptAndWait("/skill:reviewer clean request", undefined, 30_000);
		const after = await client.getMessages();
		expect(JSON.stringify(after)).toContain("clean request");
		expect(JSON.stringify(after)).not.toContain("FAKE-SECRET");
	}, 60_000);
});
