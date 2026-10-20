/**
 * Stand-in IDA host for `launch/project-client-lease.test.ts`, run as a real broker-supervised
 * daemon (a real host needs an IDA Pro install the gate image lacks). It listens on the endpoint in
 * `OMP_TEST_IDA_ENDPOINT`, prints the host banner the broker's readiness probe matches, and answers
 * `status`/`open` with an open database and `flush` with `{ saved: false }`. It exits only when
 * its supervising broker stops it.
 */
import { IpcServer } from "@oh-my-pi/pi-natives";

const endpoint = process.env.OMP_TEST_IDA_ENDPOINT;
if (!endpoint) throw new Error("fake-ida-host: OMP_TEST_IDA_ENDPOINT is required");
const status = {
	id: "cross-project",
	ref: "cross-project",
	idbPath: "/nonexistent/cross-project.i64",
	info: { module: "cross-project", format: "ELF", arch: "x86_64", bitness: 64 },
	state: "open",
	busy: false,
	lastUsed: Date.now(),
	current: null,
	dirty: false,
};
await IpcServer.listen(endpoint, { framing: "lines" }, connection => {
	connection.start(
		line => {
			const request = JSON.parse(line) as { id: number; op: string };
			const result = request.op === "flush" ? { saved: false } : status;
			connection.send(JSON.stringify({ id: request.id, ok: true, result }));
		},
		() => {},
	);
});
console.log(`omp ida host listening on ${endpoint}`);
