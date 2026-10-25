import type { Context } from "@earendil-works/chord";
import { type Harness, type PromptSection, section } from "@earendil-works/pi-durable";
import type { Message } from "grammy/types";
import { ChatInfo, ChatMap, chatKey, type TopicName, TopicNames } from "./docs.ts";

export type TopicNamesMode = "auto" | "manual";

const MANUAL_INSTRUCTIONS =
	"Use telegram_rename_topic to rename this private-chat topic when the user asks. Omit automatic for an explicitly requested rename. Ordinary chats have no topic to rename.";
const AUTO_INSTRUCTIONS =
	"This topic still has an implicit default name. Once the user's task is clear, call telegram_rename_topic with a concise title of 2-6 words in the user's language and automatic: true. Do this once while handling the task; do not make a separate model request or ask a naming question. Respect names chosen by the user.";

/** Telegram titles are trimmed, single-line Unicode text with at most 128 code points. */
export function normalizeTopicName(name: string): string | undefined {
	if (/[\p{Cc}\u2028\u2029]/u.test(name)) return undefined;
	const trimmed = name.trim();
	const length = Array.from(trimmed).length;
	return length > 0 && length <= 128 ? trimmed : undefined;
}

/** Only an observed implicit name, never attempted, may be changed automatically by its own root conversation. */
export function canAutoNameTopic(
	mode: TopicNamesMode,
	title: Readonly<TopicName> | undefined,
	isRoot: boolean,
): boolean {
	return mode === "auto" && isRoot && title?.implicit === true && title.attempted !== true;
}

/** Record lifecycle metadata without creating a conversation or admitting a model request. */
export async function rememberTopicName(harness: Harness, message: Message, context: Context): Promise<void> {
	const threadId = message.message_thread_id;
	if (threadId === undefined || threadId <= 0) return;
	const change = topicNameChange(message);
	if (change === undefined) return;
	await harness.commit(async (tx) => {
		const topics = (await tx.doc(TopicNames)).topics;
		const key = chatKey(message.chat.id, threadId);
		if (change.created && Object.hasOwn(topics, key)) return;
		topics[key] = change.title;
	}, context);
}

function topicNameChange(message: Message): { created: boolean; title: TopicName } | undefined {
	const created = message.forum_topic_created;
	if (created !== undefined) {
		return { created: true, title: { name: created.name, implicit: created.is_name_implicit === true } };
	}
	const name = message.forum_topic_edited?.name;
	return name === undefined ? undefined : { created: false, title: { name, implicit: false, attempted: true } };
}

/** Read current metadata before each model request; helpers see manual controls without a naming nudge. */
export function createTopicNameSection(mode: TopicNamesMode): PromptSection {
	return section("telegram_topic", async (input, context) => {
		const chat = await input.read.snapshot(ChatInfo, input.conversationId, context);
		if (chat?.threadId === undefined || chat.threadId <= 0) return MANUAL_INSTRUCTIONS;
		const key = chatKey(chat.chatId, chat.threadId);
		const map = await input.read.snapshot(ChatMap, context);
		const names = await input.read.snapshot(TopicNames, context);
		const eligible = canAutoNameTopic(mode, names?.topics[key], map?.chats[key] === input.conversationId);
		return eligible ? `${MANUAL_INSTRUCTIONS}\n${AUTO_INSTRUCTIONS}` : MANUAL_INSTRUCTIONS;
	});
}
