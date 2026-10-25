import type { Models } from "@earendil-works/pi-ai";
import type { Conversation, Harness, ModelRef } from "@earendil-works/pi-durable";
import type { Message } from "grammy/types";
import type { CompactReportTask } from "../delivery/compact-report.ts";
import type { DeliverTask } from "../delivery/task.ts";
import type { Stt } from "../media/stt.ts";
import type { PluginReport } from "../plugins/load.ts";
import type { FatalHandler } from "../runtime/fatal.ts";
import type { Logger } from "../runtime/log.ts";
import { telegramErrorSummary } from "../telegram/errors.ts";
import type { TelegramPort } from "../telegram/port.ts";
import type { ConversationDirectory } from "./conversations.ts";

/** Everything the update handlers and commands use once the channel has started. */
export type ChannelRuntime = {
	readonly harness: Harness;
	readonly directory: ConversationDirectory;
	readonly port: TelegramPort;
	readonly log: Logger;
	readonly allowed: ReadonlySet<number>;
	readonly workdir: string;
	readonly stt: Stt | undefined;
	readonly models: Models | undefined;
	readonly model: ModelRef;
	readonly downloadLimit: number;
	readonly deliver: DeliverTask;
	readonly compactReport: CompactReportTask;
	readonly startedAt: number;
	readonly version: string;
	/** Keep a detached operation alive until shutdown drains it. */
	readonly track: (work: Promise<unknown>) => void;
	readonly onFatal: FatalHandler;
	readonly now: () => Date;
	readonly plugins: PluginReport;
};

/** One incoming message being handled. */
export type MessageScope = {
	readonly rt: ChannelRuntime;
	readonly conversation: Conversation;
	readonly message: Message;
	readonly chatId: number;
	/** Private-chat topic; absent in the general chat and in records created before topics were supported. */
	readonly threadId?: number;
	readonly messageId: number;
	/** The Telegram update that carried the message. */
	readonly updateId: number;
	/** `tg:<chat>:<message>:<date>`. */
	readonly key: string;
};

/** What a command needs; `messageId` is absent for a draft's stop button. */
export type CommandScope = Pick<MessageScope, "rt" | "conversation" | "chatId" | "threadId" | "key"> & {
	readonly messageId?: number;
	readonly updateId?: number;
};

/** A direct reply to the message (or a plain message), sent at most once; failures are logged, never thrown. */
export async function reply(scope: CommandScope, text: string): Promise<void> {
	try {
		await scope.rt.port.sendMessage(scope.chatId, text, {
			...(scope.messageId === undefined ? {} : { replyTo: scope.messageId }),
			...(scope.threadId === undefined ? {} : { threadId: scope.threadId }),
		});
	} catch (error) {
		scope.rt.log.warn("reply_failed", { chat: scope.chatId, ...telegramErrorSummary(error) });
	}
}
