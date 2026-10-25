import { readFile } from "node:fs/promises";
import { TelegramApiError } from "../../src/telegram/errors.ts";
import type { BotCommandSpec, ChatAction, SendOptions, TelegramPort } from "../../src/telegram/port.ts";

export type FakeMessage = {
	id: number;
	chatId: number;
	threadId?: number;
	text: string;
	html: boolean;
	rich?: boolean;
	replyTo?: number;
	kind: "text" | "photo" | "document";
	path?: string;
	caption?: string;
};
export type FakeCall = {
	method: string;
	chatId?: number;
	threadId?: number;
	messageId?: number;
	text?: string;
	options?: SendOptions;
};
type Hook = (call: FakeCall, signal: AbortSignal | undefined) => Promise<void> | void;

/** In-memory Telegram: keeps the current text of every message, records calls, and can be scripted to fail or block. */
export class FakeTelegram implements TelegramPort {
	readonly messages = new Map<number, FakeMessage>();
	readonly calls: FakeCall[] = [];
	readonly files = new Map<string, Uint8Array>();
	/** Draft frames shown, in order, per chat. */
	readonly drafts: { chatId: number; threadId?: number; draftId: number; markdown: string }[] = [];
	readonly renamedTopics: { chatId: number; threadId: number; name: string }[] = [];
	readonly answeredQueries: string[] = [];
	commands: readonly BotCommandSpec[] = [];
	#nextId = 1000;
	#hooks: Hook[] = [];

	/** Run before every call; may throw to fail it or await to block it. */
	use(hook: Hook): () => void {
		this.#hooks.push(hook);
		return () => {
			this.#hooks = this.#hooks.filter((each) => each !== hook);
		};
	}

	async #enter(call: FakeCall, signal: AbortSignal | undefined): Promise<void> {
		this.calls.push(call);
		for (const hook of [...this.#hooks]) await hook(call, signal);
	}

	textsIn(chatId: number): string[] {
		return [...this.messages.values()].filter((m) => m.chatId === chatId).map((m) => m.text);
	}

	created(chatId: number): FakeMessage[] {
		return [...this.messages.values()].filter((m) => m.chatId === chatId);
	}

	count(method: string): number {
		return this.calls.filter((c) => c.method === method).length;
	}

	async sendMessage(chatId: number, text: string, options: SendOptions, signal?: AbortSignal): Promise<number> {
		await this.#enter({ method: "sendMessage", chatId, text, options, ...threadExtra(options.threadId) }, signal);
		checkHtml(text, options);
		const id = this.#nextId++;
		this.messages.set(id, {
			id,
			chatId,
			...threadExtra(options.threadId),
			text,
			html: options.html === true,
			...(options.rich === true ? { rich: true } : {}),
			kind: "text",
			...(options.replyTo === undefined ? {} : { replyTo: options.replyTo }),
		});
		return id;
	}

	async editMessageText(
		chatId: number,
		messageId: number,
		text: string,
		options: SendOptions,
		signal?: AbortSignal,
	): Promise<void> {
		await this.#enter({ method: "editMessageText", chatId, messageId, text, options }, signal);
		const message = this.messages.get(messageId);
		if (message === undefined || message.chatId !== chatId)
			throw new TelegramApiError("editMessageText", 400, "Bad Request: message to edit not found");
		checkHtml(text, options);
		if (message.text === text)
			throw new TelegramApiError("editMessageText", 400, "Bad Request: message is not modified");
		message.text = text;
		message.html = options.html === true;
		message.rich = options.rich === true;
	}

	async sendDraft(
		chatId: number,
		draftId: number,
		markdown: string,
		signal?: AbortSignal,
		threadId?: number,
	): Promise<void> {
		await this.#enter(
			{ method: "sendDraft", chatId, messageId: draftId, text: markdown, ...threadExtra(threadId) },
			signal,
		);
		this.drafts.push({ chatId, draftId, markdown, ...threadExtra(threadId) });
	}

	async renameTopic(chatId: number, threadId: number, name: string, signal?: AbortSignal): Promise<void> {
		await this.#enter({ method: "renameTopic", chatId, threadId, text: name }, signal);
		this.renamedTopics.push({ chatId, threadId, name });
	}

	async answerCallbackQuery(queryId: string): Promise<void> {
		await this.#enter({ method: "answerCallbackQuery", text: queryId }, undefined);
		this.answeredQueries.push(queryId);
	}

	async sendChatAction(chatId: number, action: ChatAction, signal?: AbortSignal, threadId?: number): Promise<void> {
		await this.#enter({ method: "sendChatAction", chatId, text: action, ...threadExtra(threadId) }, signal);
	}

	async sendPhoto(
		chatId: number,
		path: string,
		caption: string | undefined,
		signal?: AbortSignal,
		threadId?: number,
	): Promise<number> {
		await this.#enter({ method: "sendPhoto", chatId, text: path, ...threadExtra(threadId) }, signal);
		const id = this.#nextId++;
		this.messages.set(id, {
			id,
			chatId,
			...threadExtra(threadId),
			text: caption ?? "",
			html: false,
			kind: "photo",
			path,
			...(caption === undefined ? {} : { caption }),
		});
		return id;
	}

	async sendDocument(
		chatId: number,
		path: string,
		caption: string | undefined,
		signal?: AbortSignal,
		threadId?: number,
	): Promise<number> {
		await this.#enter({ method: "sendDocument", chatId, text: path, ...threadExtra(threadId) }, signal);
		const id = this.#nextId++;
		this.messages.set(id, {
			id,
			chatId,
			text: caption ?? "",
			html: false,
			kind: "document",
			path,
			...threadExtra(threadId),
		});
		return id;
	}

	async getFile(fileId: string, signal?: AbortSignal): Promise<{ path: string; size?: number }> {
		await this.#enter({ method: "getFile", text: fileId }, signal);
		const bytes = this.files.get(fileId);
		if (bytes === undefined) throw new TelegramApiError("getFile", 400, "Bad Request: invalid file_id");
		return { path: `files/${fileId}`, size: bytes.length };
	}

	async downloadFile(filePath: string, signal: AbortSignal): Promise<Response> {
		await this.#enter({ method: "download", text: filePath }, signal);
		const bytes = this.files.get(filePath.replace(/^files\//, ""));
		return bytes === undefined ? new Response("not found", { status: 404 }) : new Response(Buffer.from(bytes));
	}

	async setMyCommands(commands: readonly BotCommandSpec[]): Promise<void> {
		await this.#enter({ method: "setMyCommands" }, undefined);
		this.commands = commands;
	}

	async addFileFromDisk(fileId: string, path: string): Promise<void> {
		this.files.set(fileId, await readFile(path));
	}
}

function threadExtra(threadId: number | undefined) {
	return threadId === undefined ? {} : { threadId };
}

/** Reject unbalanced HTML the way Telegram does, so parse fallbacks can be exercised. */
function checkHtml(text: string, options: SendOptions): void {
	if (options.html !== true) return;
	if (text.includes("<broken>"))
		throw new TelegramApiError("sendMessage", 400, "Bad Request: can't parse entities: unsupported start tag");
}

/** Block a call until its signal aborts (simulates a request in flight at crash time). */
export function blockUntilAborted(signal: AbortSignal | undefined): Promise<never> {
	return new Promise((_resolve, reject) => {
		const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
		if (signal === undefined) return;
		if (signal.aborted) fail();
		signal.addEventListener("abort", fail, { once: true });
	});
}
