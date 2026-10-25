import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import type { Conversation } from "@earendil-works/pi-durable";
import type { CallbackQuery } from "grammy/types";
import { contextLine, markChosen } from "../format/rich.ts";
import { telegramErrorSummary } from "../telegram/errors.ts";
import { Buttons, rememberButtons } from "./docs.ts";
import { admit } from "./intake.ts";
import type { ChannelRuntime } from "./scope.ts";

const CONTEXT_CHARS = 1500;

type Tap = { chatId: number; messageId: number; sent: string; data: string };

/**
 * A tap on an answer's button is the user's next message: the button's data and a line naming the message it was
 * under. It is admitted once per callback query, so a redelivered tap is a duplicate; then the message shows the
 * choice. Buttons of any old message work; without the sent Markdown the choice is just not marked.
 */
export async function handleTap(rt: ChannelRuntime, query: CallbackQuery): Promise<void> {
	await rt.port.answerCallbackQuery(query.id).catch((error: unknown) => {
		rt.log.debug("callback_answer_failed", telegramErrorSummary(error));
	});
	const message = query.message;
	// Telegram omits the topic of inaccessible messages; never send their callback into the general conversation.
	if (query.data === undefined || message === undefined || message.date === 0) return;
	const chatId = message.chat.id;
	const messageId = message.message_id;
	const threadId = callbackThread(message);
	const conversation = await rt.directory.get(chatId, BG, threadId);
	const sent = (await rt.harness.snapshot(Buttons, conversation.id, BG))?.messages[String(messageId)];
	const context = contextLine(sent ?? ("text" in message ? (message.text ?? "") : ""), CONTEXT_CHARS);
	const content = context === "" ? query.data : `${query.data}\n\n(button under your message: «${context}»)`;
	const input = {
		chatId,
		messageId,
		requestId: `tg:${chatId}:cq:${query.id}`,
		content,
		...(threadId === undefined ? {} : { threadId }),
	};
	const result = await admit(conversation, rt.deliver, input, BG);
	rt.log.info(result === "admitted" ? "tap_admitted" : "update_duplicate", { chat: chatId, message: messageId });
	if (result === "admitted" && sent !== undefined)
		rt.track(markChoice(rt, conversation, { chatId, messageId, sent, data: query.data }));
}

function callbackThread(message: NonNullable<CallbackQuery["message"]>): number | undefined {
	return "message_thread_id" in message ? message.message_thread_id : undefined;
}

/** Mark the tapped button and disable the other choices of its row; failures are logged, never thrown. */
async function markChoice(rt: ChannelRuntime, conversation: Conversation, tap: Tap): Promise<void> {
	const marked = markChosen(tap.sent, tap.data);
	if (marked === undefined) return;
	try {
		await rt.port.editMessageText(tap.chatId, tap.messageId, marked, { rich: true });
		await conversation.commit(
			async (tx) => rememberButtons(await tx.doc(Buttons, conversation.id), tap.messageId, marked),
			BG,
		);
	} catch (error) {
		rt.log.warn("tap_mark_failed", { chat: tap.chatId, ...telegramErrorSummary(error) });
	}
}
