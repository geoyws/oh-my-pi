/**
 * Plan-mode model transition policy.
 *
 * Plan mode drives the active session model from the `plan` role: it switches
 * to the plan model on entry and restores the pre-plan model on exit. The same
 * policy also runs when the `plan` role is reassigned mid-planning, so a
 * correction to the wrong plan model takes effect at the next turn boundary
 * (issue #5657).
 *
 * This module holds only the pure decision — what transition a given
 * (current model, resolved role, streaming) triple implies — so the branching
 * is testable without a live session or TUI. The interactive mode performs the
 * resulting side effect.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import type { ResolvedModelRoleValue } from "../config/model-resolver";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";

/** The action implied by resolving the `plan` role against the active model. */
export type PlanModelTransition =
	/** Already on the plan model with no thinking-level change to apply. */
	| { kind: "none" }
	/** Same model; only the plan role's explicit thinking level differs. */
	| { kind: "thinking"; thinkingLevel: ConfiguredThinkingLevel }
	/**
	 * Switch to `model`. `deferred` is set when the session is mid-stream: the
	 * switch must wait for the current turn to end (a live `setModelTemporary`
	 * resets the provider session), so the caller queues it instead.
	 */
	| { kind: "apply"; model: Model; thinkingLevel: ConfiguredThinkingLevel | undefined; deferred: boolean };

/**
 * Decide how to reconcile the active model with the resolved `plan` role.
 *
 * @param currentModel - The session's active model, or `undefined` before one is set.
 * @param resolved - The `plan` role resolved against the available models.
 * @param isStreaming - Whether the session is mid-turn (forces a deferred switch).
 */
export function resolvePlanModelTransition(
	currentModel: Model | undefined,
	resolved: ResolvedModelRoleValue,
	isStreaming: boolean,
): PlanModelTransition {
	if (!resolved.model) return { kind: "none" };
	const planThinkingLevel = resolved.explicitThinkingLevel ? resolved.thinkingLevel : undefined;
	if (modelsAreEqual(currentModel, resolved.model)) {
		return planThinkingLevel ? { kind: "thinking", thinkingLevel: planThinkingLevel } : { kind: "none" };
	}
	return { kind: "apply", model: resolved.model, thinkingLevel: planThinkingLevel, deferred: isStreaming };
}

/** The action implied by a user-initiated model switch (model hub, alt+p, ctrl+p, `/model`). */
export type UserModelSwitch =
	/** Idle: switch now, exactly as before; any switch still queued is superseded. */
	| { kind: "apply" }
	/**
	 * Mid-stream: hold the switch until the turn settles so the running turn
	 * stays on one model; it replaces any switch already queued (last write wins).
	 */
	| { kind: "queue"; from: Model | undefined; to: Model }
	/**
	 * Mid-stream pick of the model the turn already runs on: nothing to switch,
	 * so any queued switch is cancelled instead of queueing `A -> A`.
	 */
	| { kind: "cancel" };

/**
 * Decide how a user model switch takes effect. A live switch mid-turn would
 * send the turn's remaining requests to a different model, so while streaming
 * the switch is queued for the turn's settle instead.
 *
 * @param currentModel - The session's active model, or `undefined` before one is set.
 * @param target - The model the user picked.
 * @param isStreaming - Whether the session is mid-turn.
 */
export function resolveUserModelSwitch(
	currentModel: Model | undefined,
	target: Model,
	isStreaming: boolean,
): UserModelSwitch {
	if (!isStreaming) return { kind: "apply" };
	if (modelsAreEqual(currentModel, target)) return { kind: "cancel" };
	return { kind: "queue", from: currentModel, to: target };
}
