export type ChatAction = "typing" | "upload_photo" | "upload_document";

export type SendOptions = {
	/** The topic to send to; absent for the main chat. Ignored for edits, which identify an existing message. */
	readonly threadId?: number;
	/** Parse as Telegram HTML; plain text otherwise. */
	readonly html?: boolean;
	/** The text is rich Markdown sent as a rich message (`sendRichMessage`, `rich_message` edits). */
	readonly rich?: boolean;
	/** Reply to this message of the chat (sent anyway if it is gone). */
	readonly replyTo?: number;
	/** No automatic retries: a 429 or network error is returned to the caller at once (previews, typing). */
	readonly fast?: boolean;
};

export type BotCommandSpec = { readonly command: string; readonly description: string };

/**
 * The Telegram surface the channel uses; the grammY implementation is `createGrammyPort`, tests use fakes. Methods
 * throw `TelegramApiError`, `TelegramUnknown` (non-idempotent call with unknown outcome) or `TelegramUnavailable`.
 */
export interface TelegramPort {
	sendMessage(chatId: number, text: string, options: SendOptions, signal?: AbortSignal): Promise<number>;
	editMessageText(
		chatId: number,
		messageId: number,
		text: string,
		options: SendOptions,
		signal?: AbortSignal,
	): Promise<void>;
	/** Rename this topic; optional for transports that do not support topic management. */
	renameTopic?(chatId: number, threadId: number, name: string, signal?: AbortSignal): Promise<void>;
	/** Show or update the ephemeral rich draft `draftId` (private chats), with a stop button. */
	sendDraft(chatId: number, draftId: number, markdown: string, signal?: AbortSignal, threadId?: number): Promise<void>;
	/** Stop the loading state of a tapped inline button. */
	answerCallbackQuery(queryId: string): Promise<void>;
	sendChatAction(chatId: number, action: ChatAction, signal?: AbortSignal, threadId?: number): Promise<void>;
	sendPhoto(
		chatId: number,
		path: string,
		caption: string | undefined,
		signal?: AbortSignal,
		threadId?: number,
	): Promise<number>;
	sendDocument(
		chatId: number,
		path: string,
		caption: string | undefined,
		signal?: AbortSignal,
		threadId?: number,
	): Promise<number>;
	/** `getFile`: the server path to download, and the size when Telegram reports it. */
	getFile(fileId: string, signal?: AbortSignal): Promise<{ path: string; size?: number }>;
	/** Download a file returned by `getFile`. The URL carries the bot token; implementations must not log it. */
	downloadFile(filePath: string, signal: AbortSignal): Promise<Response>;
	setMyCommands(commands: readonly BotCommandSpec[]): Promise<void>;
}
