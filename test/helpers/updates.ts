import type { Update } from "grammy/types";

let nextUpdateId = 1;
export const DATE = 1_790_000_000;

export function textUpdate(
	chatId: number,
	messageId: number,
	text: string,
	options: { fromId?: number; chatType?: "private" | "group"; isBot?: boolean; date?: number; threadId?: number } = {},
): Update {
	const fromId = options.fromId ?? chatId;
	const chat =
		options.chatType === "group"
			? { id: chatId, type: "group" as const, title: "g" }
			: { id: chatId, type: "private" as const, first_name: "U" };
	return {
		update_id: nextUpdateId++,
		message: {
			message_id: messageId,
			date: options.date ?? DATE,
			chat,
			from: { id: fromId, is_bot: options.isBot ?? false, first_name: "U" },
			text,
			...(options.threadId === undefined ? {} : { message_thread_id: options.threadId, is_topic_message: true }),
		},
	} as Update;
}

export function photoUpdate(chatId: number, messageId: number, fileId: string, size: number, caption?: string): Update {
	return {
		update_id: nextUpdateId++,
		message: {
			message_id: messageId,
			date: DATE,
			chat: { id: chatId, type: "private", first_name: "U" },
			from: { id: chatId, is_bot: false, first_name: "U" },
			photo: [
				{ file_id: `${fileId}-small`, file_unique_id: "s", width: 90, height: 90, file_size: 10 },
				{ file_id: fileId, file_unique_id: "b", width: 800, height: 600, file_size: size },
			],
			...(caption === undefined ? {} : { caption }),
		},
	} as Update;
}

export function documentUpdate(chatId: number, messageId: number, fileId: string, name: string, size: number): Update {
	return {
		update_id: nextUpdateId++,
		message: {
			message_id: messageId,
			date: DATE,
			chat: { id: chatId, type: "private", first_name: "U" },
			from: { id: chatId, is_bot: false, first_name: "U" },
			document: { file_id: fileId, file_unique_id: "d", file_name: name, file_size: size },
		},
	} as Update;
}

export function voiceUpdate(chatId: number, messageId: number, fileId: string, size: number): Update {
	return {
		update_id: nextUpdateId++,
		message: {
			message_id: messageId,
			date: DATE,
			chat: { id: chatId, type: "private", first_name: "U" },
			from: { id: chatId, is_bot: false, first_name: "U" },
			voice: { file_id: fileId, file_unique_id: "v", duration: 2, file_size: size },
		},
	} as Update;
}

/** A private message with arbitrary content fields (video, sticker, location, ...). */
export function mediaUpdate(chatId: number, messageId: number, fields: Record<string, unknown>): Update {
	return {
		update_id: nextUpdateId++,
		message: {
			message_id: messageId,
			date: DATE,
			chat: { id: chatId, type: "private", first_name: "U" },
			from: { id: chatId, is_bot: false, first_name: "U" },
			...fields,
		},
	} as Update;
}

/** A tap on an inline button under message `messageId` of the bot. */
export function callbackUpdate(
	chatId: number,
	messageId: number,
	data: string,
	options: { fromId?: number; queryId?: string; text?: string; threadId?: number } = {},
): Update {
	return {
		update_id: nextUpdateId++,
		callback_query: {
			id: options.queryId ?? `q${nextUpdateId}`,
			from: { id: options.fromId ?? chatId, is_bot: false, first_name: "U" },
			chat_instance: "ci",
			data,
			message: {
				message_id: messageId,
				date: DATE,
				chat: { id: chatId, type: "private", first_name: "U" },
				...(options.text === undefined ? {} : { text: options.text }),
				...(options.threadId === undefined ? {} : { message_thread_id: options.threadId, is_topic_message: true }),
			},
		},
	} as Update;
}

/** Put an incoming message (including attachments and topic service events) in a private-chat topic. */
export function topicUpdate(update: Update, threadId: number): Update {
	if (update.message === undefined) throw new Error("A topic update must contain a message");
	return { ...update, message: { ...update.message, message_thread_id: threadId, is_topic_message: true } } as Update;
}

/** The user pressed the stop button of draft `draftId`. */
export function stoppedUpdate(chatId: number, draftId: number): Update {
	return {
		update_id: nextUpdateId++,
		stopped_message_generation: { chat: { id: chatId, type: "private", first_name: "U" }, draft_id: draftId },
	} as Update;
}
