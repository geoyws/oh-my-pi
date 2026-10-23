/**
 * Descriptors omp holds for its own lifetime — session/advisor transcripts and
 * the rotating log — must not reach the commands the bash tool runs.
 *
 * The bash tool executes through the natives brush shell, which `fork`/`exec`s
 * external commands and therefore hands every inheritable descriptor to them
 * (the same property pinned by `config-value-fd-inheritance.test.ts`). Before
 * #13224, an external command could hold a writable transcript or log handle
 * for its whole life.
 *
 * Oracle: list the child's descriptor table. `sh -c` is required — a bare `ls`
 * resolves to an in-process builtin, whose `$$` is omp itself. Pass a control
 * descriptor explicitly to a probe process as fd 3, rather than assuming the
 * host runtime opens files without close-on-exec. The probe opens real storage
 * and logs before invoking the native shell. /proc makes this Linux-only.
 */
import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const ROOTS: string[] = [];

afterAll(async () => {
	for (const root of ROOTS) await removeWithRetries(root).catch(() => {});
});

test.skipIf(process.platform !== "linux")("bash tool children never inherit session or log descriptors", async () => {
	const root = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-session-fd-"));
	ROOTS.push(root);

	const transcript = path.join(root, "session.jsonl");
	const control = path.join(root, "control.jsonl");
	const controlFd = fs.openSync(control, "a");
	const storageUrl = new URL("../src/session/session-storage.ts", import.meta.url).href;
	const script = `
import { Shell } from "@oh-my-pi/pi-natives";
import { RotatingFileSink } from "@oh-my-pi/pi-utils/logger/rotating-file";
import { FileSessionStorage } from ${JSON.stringify(storageUrl)};
import * as fs from "node:fs/promises";
const root = ${JSON.stringify(root)};
const writer = new FileSessionStorage().openWriter(${JSON.stringify(transcript)});
await writer.append("session-start\\n");
const logsDir = root + "/logs";
await fs.mkdir(logsDir, { recursive: true });
const sink = new RotatingFileSink({ directory: logsDir, filenamePrefix: "omp", filenameSuffix: String(process.pid), maxBytes: 1 << 20, maxFiles: 2 });
sink.write("entry");
try {
  await new Shell().run({ command: "sh -c 'ls -l /proc/$$/fd'", cwd: root }, (_err, chunk) => process.stdout.write(chunk));
} finally {
  sink.close();
  await writer.close();
}
`;
	let output: string;
	try {
		const child = Bun.spawn({
			cmd: [process.execPath, "--eval", script],
			cwd: path.resolve(import.meta.dir, ".."),
			stdio: ["ignore", "pipe", "pipe", controlFd],
			timeout: 15_000,
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		output = stdout;
	} finally {
		fs.closeSync(controlFd);
	}
	const inherited = output.split("\n").filter(line => line.includes(root));
	expect(inherited.join("\n"), "control: an inheritable descriptor must reach the child").toContain(control);
	expect(inherited.join("\n")).not.toContain(transcript);
	expect(inherited.join("\n")).not.toMatch(/omp\.[\d-]+\.\d+\.log/);
});
