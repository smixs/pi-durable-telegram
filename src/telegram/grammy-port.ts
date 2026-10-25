import { Api, GrammyError, HttpError, InputFile } from "grammy";
import { TelegramApiError, TelegramUnavailable, TelegramUnknown } from "./errors.ts";
import type { BotCommandSpec, ChatAction, SendOptions, TelegramPort } from "./port.ts";
import { createRetryTransformer } from "./retry.ts";

export type GrammyPortOptions = {
	readonly token: string;
	readonly apiRoot: string;
	/** The bot's API instance (with retries); a separate instance without retries serves `fast` calls. */
	readonly api?: Api;
};

/** Create the retrying Bot API client the bot and the port share. */
export function createRetryingApi(token: string, apiRoot: string): Api {
	const api = new Api(token, { apiRoot, timeoutSeconds: 75 });
	api.config.use(createRetryTransformer());
	return api;
}

/** `TelegramPort` over grammY's `Api`. Errors are translated to token-free `TelegramApiError` and friends. */
export function createGrammyPort(options: GrammyPortOptions): TelegramPort {
	const api = options.api ?? createRetryingApi(options.token, options.apiRoot);
	const fast = new Api(options.token, { apiRoot: options.apiRoot, timeoutSeconds: 30 });
	fast.config.use(createRetryTransformer({ fast: true }));
	const pick = (o: SendOptions) => (o.fast === true ? fast : api);
	return {
		sendMessage: (chatId, text, o, signal) =>
			o.rich === true
				? guard("sendRichMessage", async () => {
						const sent = await pick(o).sendRichMessage(chatId, { markdown: text }, messageExtra(o), gs(signal));
						return sent.message_id;
					})
				: guard(
						"sendMessage",
						async () => (await pick(o).sendMessage(chatId, text, sendExtra(o), gs(signal))).message_id,
					),
		editMessageText: (chatId, messageId, text, o, signal) =>
			guard("editMessageText", async () => {
				const content = o.rich === true ? { markdown: text } : text;
				await pick(o).editMessageText(
					chatId,
					messageId,
					content,
					o.html === true ? { parse_mode: "HTML" } : {},
					gs(signal),
				);
			}),
		renameTopic: (chatId, threadId, name, signal) =>
			guard("editForumTopic", async () => {
				await api.editForumTopic(chatId, threadId, { name }, gs(signal));
			}).catch((error: unknown) => {
				if (
					error instanceof TelegramApiError &&
					error.code === 400 &&
					/^(?:Bad Request:\s*)?TOPIC_NOT_MODIFIED$/i.test(error.description)
				)
					return;
				throw error;
			}),
		sendDraft: (chatId, draftId, markdown, signal, threadId) =>
			guard("sendRichMessageDraft", async () => {
				await fast.sendRichMessageDraft(
					chatId,
					draftId,
					{ markdown },
					{ can_stop: true, ...threadExtra(threadId) },
					gs(signal),
				);
			}),
		answerCallbackQuery: (queryId) =>
			guard("answerCallbackQuery", async () => {
				await fast.answerCallbackQuery(queryId);
			}),
		sendChatAction: (chatId, action: ChatAction, signal, threadId) =>
			guard("sendChatAction", async () => {
				await fast.sendChatAction(chatId, action, threadExtra(threadId), gs(signal));
			}),
		sendPhoto: (chatId, path, caption, signal, threadId) =>
			guard(
				"sendPhoto",
				async () =>
					(await api.sendPhoto(chatId, new InputFile(path), captionExtra(caption, threadId), gs(signal))).message_id,
			),
		sendDocument: (chatId, path, caption, signal, threadId) =>
			guard(
				"sendDocument",
				async () =>
					(await api.sendDocument(chatId, new InputFile(path), captionExtra(caption, threadId), gs(signal))).message_id,
			),
		getFile: (fileId, signal) =>
			guard("getFile", async () => {
				const file = await api.getFile(fileId, gs(signal));
				if (file.file_path === undefined) throw new TelegramApiError("getFile", 400, "file has no download path");
				return file.file_size === undefined ? { path: file.file_path } : { path: file.file_path, size: file.file_size };
			}),
		downloadFile: (filePath, signal) => fetch(`${options.apiRoot}/file/bot${options.token}/${filePath}`, { signal }),
		setMyCommands: (commands: readonly BotCommandSpec[]) =>
			guard("setMyCommands", async () => {
				await api.setMyCommands(commands.map((each) => ({ command: each.command, description: each.description })));
			}),
	};
}

type GrammySignal = Parameters<Api["getFile"]>[1];

/** grammY types signals with the abort-controller polyfill; native signals work at runtime. */
function gs(signal: AbortSignal | undefined): GrammySignal {
	return signal as unknown as GrammySignal;
}

function sendExtra(options: SendOptions) {
	return {
		...(options.html === true ? { parse_mode: "HTML" as const } : {}),
		...messageExtra(options),
		link_preview_options: { is_disabled: true },
	};
}

function replyExtra(options: SendOptions) {
	return options.replyTo === undefined
		? {}
		: { reply_parameters: { message_id: options.replyTo, allow_sending_without_reply: true } };
}

function threadExtra(threadId: number | undefined) {
	return threadId === undefined ? {} : { message_thread_id: threadId };
}

function messageExtra(options: SendOptions) {
	return { ...replyExtra(options), ...threadExtra(options.threadId) };
}

function captionExtra(caption: string | undefined, threadId: number | undefined) {
	return { ...(caption === undefined || caption === "" ? {} : { caption }), ...threadExtra(threadId) };
}

async function guard<T>(method: string, call: () => Promise<T>): Promise<T> {
	try {
		return await call();
	} catch (error) {
		throw translate(method, error);
	}
}

/** Rebuild grammY errors without payloads, URLs or causes, which may carry the token or user text. */
export function translate(method: string, error: unknown): unknown {
	if (error instanceof TelegramUnknown || error instanceof TelegramUnavailable || error instanceof TelegramApiError)
		return error;
	if (error instanceof GrammyError) {
		if (error.error_code >= 500) return new TelegramUnavailable(method, `HTTP ${error.error_code}`);
		return new TelegramApiError(method, error.error_code, error.description, error.parameters.retry_after);
	}
	if (error instanceof HttpError) return new TelegramUnavailable(method, "network error");
	return error;
}
