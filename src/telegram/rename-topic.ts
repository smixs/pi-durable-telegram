import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ToolExecutionApi,
	type ToolExecutionResult,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { ChatInfo, ChatMap, chatKey, type TopicName, TopicNames } from "../channel/docs.ts";
import { canAutoNameTopic, normalizeTopicName, type TopicNamesMode } from "../channel/topic-names.ts";
import type { Logger } from "../runtime/log.ts";
import { isAbort, TelegramApiError, telegramErrorSummary } from "./errors.ts";
import type { TelegramPort } from "./port.ts";

type Deps = { port: () => TelegramPort; log: Logger; topicNames: TopicNamesMode };
type Args = { name: string; automatic?: boolean };
type Rename = { chatId: number; threadId: number; key: string; name: string; previous?: TopicName };

const parameters = Type.Object({
	name: Type.String({ description: "New topic title: 1-128 Unicode characters, no control characters." }),
	automatic: Type.Optional(
		Type.Boolean({ description: "True only for the once-per-topic automatic naming instruction." }),
	),
});

/** Rename only the current topic. An interrupted edit never reruns and overwrites a later manual name. */
export function createRenameTopicTool(deps: Deps): ToolRegistration {
	return defineTool({
		name: "telegram_rename_topic",
		description: "Rename the current private-chat topic. Ordinary chats have no topic to rename.",
		parameters,
		replay: "unsafe",
		execute: (args, api, context) => renameTopic(args, api, context, deps),
	}) as unknown as ToolRegistration;
}

function failure(text: string): ToolExecutionResult {
	return { output: [{ type: "text", text }], isError: true };
}

async function renameTopic(
	args: Args,
	api: ToolExecutionApi,
	context: Context,
	deps: Deps,
): Promise<ToolExecutionResult> {
	const name = normalizeTopicName(args.name);
	if (name === undefined)
		return failure("Use a nonempty topic title of at most 128 Unicode characters, without control characters.");
	const port = deps.port();
	const rename = port.renameTopic?.bind(port);
	if (rename === undefined) return failure("This Telegram transport does not support renaming topics.");
	const plan = await prepareRename(args, name, api, context, deps.topicNames);
	if (typeof plan === "string") return failure(plan);
	try {
		await rename(plan.chatId, plan.threadId, name, context.abortSignal);
	} catch (error) {
		if (isAbort(error)) throw error;
		if (!topicNotModified(error)) {
			deps.log.warn("rename_topic_failed", {
				chat: plan.chatId,
				thread: plan.threadId,
				...telegramErrorSummary(error),
			});
			return failure(
				"Topic rename failed or its outcome is unknown. Do not retry automatically; check the topic name before retrying.",
			);
		}
	}
	const stored = await rememberRename(api, context, plan);
	const text = stored
		? "Renamed this topic."
		: "Rename request completed, but topic metadata changed during the request. Check the visible title before further edits.";
	return { output: [{ type: "text", text }] };
}

function prepareRename(
	args: Args,
	name: string,
	api: ToolExecutionApi,
	context: Context,
	mode: TopicNamesMode,
): Promise<Rename | string> {
	return api.commit(async (tx) => {
		const chat = await tx.doc(ChatInfo, api.conversationId);
		if (chat.chatId === 0 || chat.threadId === undefined || chat.threadId <= 0)
			return "This conversation has no private-chat topic to rename.";
		const key = chatKey(chat.chatId, chat.threadId);
		const names = await tx.doc(TopicNames);
		const current = names.topics[key];
		const root = (await tx.doc(ChatMap)).chats[key] === api.conversationId;
		if (args.automatic === true && !canAutoNameTopic(mode, current, root))
			return "Automatic naming is not allowed for this topic; preserve its current name.";
		// Claim before the request: a failed or interrupted automatic edit must not be tried again after restart.
		if (current !== undefined) current.attempted = true;
		return {
			chatId: chat.chatId,
			threadId: chat.threadId,
			key,
			name,
			...(current === undefined ? {} : { previous: { ...current } }),
		};
	}, context);
}

function rememberRename(api: ToolExecutionApi, context: Context, plan: Rename): Promise<boolean> {
	return api.commit(async (tx) => {
		const names = await tx.doc(TopicNames);
		if (!sameName(names.topics[plan.key], plan.previous)) return false;
		names.topics[plan.key] = { name: plan.name, implicit: false, attempted: true };
		return true;
	}, context);
}

function sameName(current: Readonly<TopicName> | undefined, previous: Readonly<TopicName> | undefined): boolean {
	return (
		current?.name === previous?.name &&
		current?.implicit === previous?.implicit &&
		current?.attempted === previous?.attempted
	);
}

function topicNotModified(error: unknown): boolean {
	return (
		error instanceof TelegramApiError &&
		error.code === 400 &&
		/^(?:Bad Request:\s*)?TOPIC_NOT_MODIFIED$/i.test(error.description)
	);
}
