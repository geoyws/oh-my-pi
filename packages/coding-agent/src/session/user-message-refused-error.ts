/**
 * Rejection when a `before_user_message` extension handler refuses a user
 * message. The message was NOT sent to the provider, NOT persisted, and NOT
 * queued. {@link notice} (== {@link Error.message}) is the handler's safe
 * notice verbatim — the only text any UI may display for the refusal. It
 * never contains the message text.
 */
export class UserMessageRefusedError extends Error {
	readonly notice: string;
	constructor(notice?: string) {
		const safe = notice?.trim() ? notice : "An extension refused to send this message.";
		super(safe);
		this.name = "UserMessageRefusedError";
		this.notice = safe;
	}
}
