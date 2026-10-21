import type { DaemonBrokerClient, DaemonBrokerLease } from "@oh-my-pi/pi-coding-agent/launch/client";

/**
 * Present a broker client (real or double) as the lease `daemonClientForProject`
 * returns, for spies that bypass the shared client registry. Releasing it never
 * closes `client`; the test owns that.
 */
export function unmanagedDaemonLease(client: DaemonBrokerClient): DaemonBrokerLease {
	const lease: DaemonBrokerLease = {
		get projectDir() {
			return client.projectDir;
		},
		request: (operation, signal) => client.request(operation, signal),
		onCompletion: (owner, sink) => client.onCompletion(owner, sink),
		retain: () => unmanagedDaemonLease(client),
		release: () => {},
		close: () => {},
		[Symbol.dispose]: () => {},
	};
	return lease;
}
