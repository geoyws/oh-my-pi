/**
 * The single slot holding a model switch deferred to the end of the current
 * turn. A switch applied mid-turn would split that turn across two models (the
 * agent loop re-resolves the model per provider request), so user switches made
 * while streaming, and plan-mode transitions, wait here until the turn settles.
 *
 * Exactly one switch is ever queued: a later switch replaces the earlier one
 * regardless of origin (last write wins). Observers read the slot through
 * {@link ModelSwitchQueue.pending} and subscribe to changes.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { formatModelString } from "../config/model-resolver";
import { resolveUserModelSwitch } from "../plan-mode/model-transition";
import type { AgentSession } from "../session/agent-session";

/**
 * Who queued the pending switch.
 * - `user`: model picker, ctrl+p role cycle, or model hub while a turn streamed.
 * - `plan`: the live plan-role reconciler; dropped when the plan role changes again.
 * - `plan-restore`: restoring the pre-plan model on plan exit.
 */
export type PendingModelSwitchSource = "user" | "plan" | "plan-restore";

/** Read-only view of the queued switch. */
export interface PendingModelSwitch {
	readonly model: Model;
	readonly thinkingLevel?: ConfiguredThinkingLevel;
	readonly source: PendingModelSwitchSource;
	/** Role the switch selects (ctrl+p cycle); a later press advances from it. */
	readonly role?: string;
}

/** A user-initiated switch, applied now when idle or queued while streaming. */
export interface UserModelSwitchRequest {
	/** Session the switch targets; only switches of the host's main session are queued. */
	readonly target: AgentSession;
	readonly model: Model;
	readonly thinkingLevel?: ConfiguredThinkingLevel;
	readonly role?: string;
	/** Performs the switch exactly as the idle path would; runs once when the turn ends. */
	readonly apply: () => Promise<void>;
}

export interface ModelSwitchQueueHost {
	readonly session: AgentSession;
	showStatus(message: string): void;
	showWarning(message: string): void;
}

type QueuedModelSwitch = PendingModelSwitch & { readonly apply?: () => Promise<void> };

export class ModelSwitchQueue {
	readonly #host: ModelSwitchQueueHost;
	#entry: QueuedModelSwitch | undefined;
	readonly #listeners = new Set<() => void>();

	constructor(host: ModelSwitchQueueHost) {
		this.#host = host;
	}

	/** The queued switch, or `undefined` when none is pending. */
	get pending(): PendingModelSwitch | undefined {
		const entry = this.#entry;
		if (!entry) return undefined;
		return { model: entry.model, thinkingLevel: entry.thinkingLevel, source: entry.source, role: entry.role };
	}

	/** Call `listener` whenever the pending switch changes; returns the unsubscribe. */
	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/**
	 * Route a user-initiated switch. Returns `false` when the caller must apply
	 * it now (idle session, or a session other than the main one); returns
	 * `true` when it was queued for the turn end, replacing any queued switch —
	 * including a plan-mode one, since the user's latest choice wins.
	 */
	queueUser(request: UserModelSwitchRequest): boolean {
		const session = this.#host.session;
		if (request.target !== session) return false;
		const decision = resolveUserModelSwitch(session.model, request.model, session.isStreaming);
		if (decision.kind === "apply") return false;
		this.#set({
			model: request.model,
			thinkingLevel: request.thinkingLevel,
			source: "user",
			role: request.role,
			apply: request.apply,
		});
		const from = decision.from ? formatModelString(decision.from) : "none";
		this.#host.showStatus(`Model switch queued for after this turn: ${from} -> ${formatModelString(decision.to)}`);
		return true;
	}

	/**
	 * Queue a plan-mode transition, applied silently via `setModelTemporary` at
	 * the turn end. Replaces any queued switch, including a user one: plan mode
	 * only queues on entry, exit, or a plan-role reassignment — each a newer
	 * explicit action than the earlier queued pick.
	 */
	queuePlan(source: "plan" | "plan-restore", model: Model, thinkingLevel: ConfiguredThinkingLevel | undefined): void {
		this.#set({ model, thinkingLevel, source });
	}

	/** Drop the queued switch when it came from one of `sources`. */
	clear(...sources: PendingModelSwitchSource[]): void {
		if (this.#entry && sources.includes(this.#entry.source)) this.#set(undefined);
	}

	/** Apply the queued switch, if any, exactly once. */
	async flush(): Promise<void> {
		const entry = this.#entry;
		if (!entry) return;
		this.#set(undefined);
		try {
			if (entry.apply) {
				await entry.apply();
				this.#host.showStatus(`Model switched to ${formatModelString(entry.model)}`);
			} else {
				await this.#host.session.setModelTemporary(entry.model, entry.thinkingLevel);
			}
		} catch (error) {
			this.#host.showWarning(
				`Failed to switch model after streaming: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	#set(entry: QueuedModelSwitch | undefined): void {
		if (entry === this.#entry) return;
		this.#entry = entry;
		for (const listener of this.#listeners) listener();
	}
}
