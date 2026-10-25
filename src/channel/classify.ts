import type { Message } from "grammy/types";
import { attachmentOf, isSpeech } from "../media/attachments.ts";

export type Classified =
	| { readonly kind: "command"; readonly name: string; readonly args: string }
	| { readonly kind: "text"; readonly text: string }
	/** Voice, audio or a video note: transcribed when speech-to-text is configured, otherwise handled as a file. */
	| { readonly kind: "voice" }
	/** Any other file: photo, document, video, animation, sticker. */
	| { readonly kind: "file" }
	/** No text and no file: location, contact, poll, dice and whatever Telegram adds next. */
	| { readonly kind: "other" };

/** What an incoming message is, by its content. Pure. Nothing an allowed user sends is refused here. */
export function classifyMessage(message: Message): Classified {
	if (message.text !== undefined) return classifyText(message.text);
	const attachment = attachmentOf(message);
	if (attachment === undefined) return { kind: "other" };
	return { kind: isSpeech(attachment) ? "voice" : "file" };
}

/** Creating or changing a topic is routing metadata, not a request for the model. */
export function isTopicServiceOnly(message: Message): boolean {
	if (message.text !== undefined || attachmentOf(message) !== undefined) return false;
	return Object.keys(message).some((key) => key.startsWith("forum_topic_") || key.startsWith("general_forum_topic_"));
}

/** `/name@bot args` → command; anything else is text. */
export function classifyText(text: string): Classified {
	const match = /^\/([A-Za-z0-9_]{1,32})(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
	if (match === null) return { kind: "text", text };
	return { kind: "command", name: (match[1] ?? "").toLowerCase(), args: (match[2] ?? "").trim() };
}
