import type { ImageContent } from "@oh-my-pi/pi-ai";
import { shiftImageMarkers } from "@oh-my-pi/pi-tui/prompt/composer-attachments";
import type { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { UserMessageRefusedError } from "../../session/agent-session";
import type { ParsedSlashCommand, TuiSlashCommandRuntime } from "../types";

/** Clear only text still owned by this submission, never a newer detached draft. */
export function clearSubmittedText(runtime: TuiSlashCommandRuntime): void {
	if (!runtime.draftDetached) runtime.ctx.editor.setText("");
}

/**
 * Return a submission that already left the editor without replacing a draft
 * typed while it awaited dispatch: its attachments append after the newer
 * draft's, its `[Image #N]` markers shift to match, and its text goes first.
 */
export function restoreDetachedDraft(
	editor: CustomEditor,
	text: string,
	images?: ImageContent[],
	imageLinks?: (string | undefined)[],
): void {
	const currentText = editor.getExpandedText();
	const restoredText = shiftImageMarkers(text, editor.pendingImages.length);
	if (images?.length) {
		editor.pendingImages.push(...images);
		editor.pendingImageLinks.push(...(imageLinks ?? images.map(() => undefined)));
		editor.imageLinks = editor.pendingImageLinks;
	}
	editor.setCollapsedText([restoredText, currentText].filter(part => part.trim()).join("\n\n"));
}

/**
 * Hand back a refused line whose images Enter left in the editor (`!`/`$`,
 * `/compact`, `/handoff`). While those images are still the live prefix of
 * `pendingImages` they already sit at the indices the refused text's
 * `[Image #N]` markers name, and any draft typed since already counts them in
 * its own markers: the refused text goes back ahead of it and the images stay
 * where they are. Otherwise the images are re-added through
 * {@link restoreDetachedDraft}.
 */
export function restoreRefusedLine(
	editor: CustomEditor,
	text: string,
	images?: ImageContent[],
	imageLinks?: (string | undefined)[],
): void {
	if (images?.length && images.every((image, index) => editor.pendingImages[index] === image)) {
		const laterText = editor.getExpandedText();
		editor.setCollapsedText(laterText.trim() ? `${text}\n\n${laterText}` : text);
		return;
	}
	restoreDetachedDraft(editor, text, images, imageLinks);
}

/**
 * Gate user-authored slash text that a command persists or sends to a model
 * outside `prompt()` (`/tan` work, `/omfg` complaint, `/cleanse` request,
 * `/ratchet` flow). A refusal merges the original slash line (and its
 * attachments) back ahead of any newer draft, shows only the handler's
 * notice, and returns false so nothing starts.
 */
export async function admitTuiSlashText(
	command: ParsedSlashCommand,
	runtime: TuiSlashCommandRuntime,
	text: string,
): Promise<boolean> {
	const images = runtime.input?.images?.length ? runtime.input.images : undefined;
	if (!text && !images) return true;
	try {
		await runtime.ctx.session.gateUserMessage(text, images, "interactive");
		return true;
	} catch (error) {
		if (error instanceof UserMessageRefusedError) {
			restoreDetachedDraft(runtime.ctx.editor, command.text, images, runtime.input?.imageLinks);
			runtime.ctx.showError(error.notice);
			runtime.ctx.ui.requestRender();
			return false;
		}
		throw error;
	}
}

/**
 * Hand back a refused submission that already left the editor: the refused
 * text goes ahead of any newer draft typed while dispatch was pending (its
 * `[Image #N]` markers shift to match), refused attachments merge ahead of
 * newer ones, and the newer draft is never clobbered. Mirrors
 * `InteractiveMode.cancelPendingSubmission`.
 */
export function restoreRefusedDraft(
	editor: CustomEditor,
	text: string,
	images?: ImageContent[],
	imageLinks?: (string | undefined)[],
): void {
	const laterText = editor.getExpandedText();
	const refusedImages = images ?? [];
	const recoveredText = laterText ? `${text}\n${shiftImageMarkers(laterText, refusedImages.length)}` : text;
	editor.pendingImages = [...refusedImages, ...editor.pendingImages];
	editor.pendingImageLinks = [...(imageLinks ?? refusedImages.map(() => undefined)), ...editor.pendingImageLinks];
	editor.imageLinks = editor.pendingImageLinks;
	editor.setCollapsedText(recoveredText);
}
