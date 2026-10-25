import { tail } from "../format/escape.ts";
import { fenceStateAfter } from "../format/fence.ts";
import { markdownToTelegramHtml } from "../format/markdown-html.ts";
import { draftMarkdown } from "../format/rich.ts";
import type { Logger } from "../runtime/log.ts";
import { classifyTelegramError, TelegramApiError, telegramErrorSummary } from "../telegram/errors.ts";
import type { TelegramPort } from "../telegram/port.ts";

const PREVIEW_CHARS = 3500;
export const EDIT_INTERVAL_MS = 1000;
/** A draft vanishes about 30 s after its last update; a quiet run (a long tool call) re-sends it this often. */
export const DRAFT_REFRESH_MS = 20_000;

export type PreviewFrame = { readonly text: string; readonly hint: string | undefined };

export type PreviewOptions = {
	readonly port: TelegramPort;
	readonly chatId: number;
	readonly threadId?: number;
	readonly replyTo: number | undefined;
	readonly log: Logger;
	/** Existing preview message from an earlier invocation: edited, never re-sent. */
	readonly messageId: number | undefined;
	/** Stream as the native draft with this id instead; a refused first draft switches to editing a message. */
	readonly draftId?: number;
	/** Persist a newly sent preview's id before anything else happens to it. */
	readonly onCreated: (messageId: number) => Promise<void>;
	readonly signal?: AbortSignal;
	readonly now?: () => number;
	readonly intervalMs?: number;
};

/** Render the visible part of a streaming answer: its tail, with the fence it is inside reopened, plus a tool hint. */
export function renderPreview(frame: PreviewFrame): string {
	let body = frame.text;
	if (body.length > PREVIEW_CHARS) {
		const kept = tail(body, PREVIEW_CHARS);
		const fence = fenceStateAfter(body.slice(0, body.length - kept.length), undefined);
		body = `${fence === undefined ? "" : `${fence.line}\n`}…${kept}`;
	}
	const hint = frame.hint === undefined ? "" : `\n\n⚙ ${frame.hint}`;
	return `${body}${hint}`.trim();
}

/**
 * Streams the answer as a native draft (empty frames show "Thinking…") or by editing one message: at most one update
 * in flight and one per interval, the newest frame wins, a 429 sets a cooldown and drops the frame. Never throws;
 * failures are logged.
 */
export class PreviewStreamer {
	readonly #o: PreviewOptions;
	readonly #now: () => number;
	#messageId: number | undefined;
	#latest: string | undefined;
	#lastSent: string | undefined;
	#draft: boolean;
	#draftShown = false;
	#refresh: NodeJS.Timeout | undefined;
	#lastEditAt = 0;
	#cooldownUntil = 0;
	#inFlight: Promise<void> | undefined;
	#timer: NodeJS.Timeout | undefined;
	#closed = false;

	constructor(options: PreviewOptions) {
		this.#o = options;
		this.#now = options.now ?? Date.now;
		this.#messageId = options.messageId;
		this.#draft = options.draftId !== undefined && options.messageId === undefined;
	}

	get messageId(): number | undefined {
		return this.#messageId;
	}

	push(frame: PreviewFrame): void {
		if (this.#closed) return;
		const rendered = renderPreview(frame);
		if (rendered === "" && !this.#draft) return;
		this.#latest = rendered;
		this.#schedule();
	}

	/** Stop streaming; waits for an in-flight send so a new preview id is persisted. */
	async close(): Promise<void> {
		this.#closed = true;
		clearTimeout(this.#timer);
		clearTimeout(this.#refresh);
		this.#timer = undefined;
		await this.#inFlight;
	}

	#schedule(): void {
		if (this.#timer !== undefined || this.#inFlight !== undefined || this.#closed) return;
		const interval = this.#o.intervalMs ?? EDIT_INTERVAL_MS;
		const wait = Math.max(0, this.#lastEditAt + interval - this.#now(), this.#cooldownUntil - this.#now());
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.#flush();
		}, wait);
		this.#timer.unref();
	}

	#flush(): void {
		const text = this.#latest;
		if (this.#closed || text === undefined || text === this.#lastSent || (text === "" && !this.#draft)) return;
		this.#lastEditAt = this.#now();
		this.#inFlight = this.#send(text).finally(() => {
			this.#inFlight = undefined;
			if (this.#latest !== this.#lastSent) this.#schedule();
		});
	}

	async #send(text: string): Promise<void> {
		try {
			await this.#deliver(text);
			this.#lastSent = text;
		} catch (error) {
			this.#handleError(error, text);
		}
	}

	async #deliver(text: string): Promise<void> {
		const { port, chatId, signal } = this.#o;
		if (this.#draft) {
			await port.sendDraft(chatId, this.#o.draftId ?? 0, draftMarkdown(text), signal, this.#o.threadId);
			this.#draftShown = true;
			this.#armRefresh();
			return;
		}
		const html = markdownToTelegramHtml(text, { autoCloseFence: true });
		const options = { fast: true };
		const id = this.#messageId;
		if (id !== undefined) {
			await withPlainFallback(
				() => port.editMessageText(chatId, id, html, { ...options, html: true }, signal),
				() => port.editMessageText(chatId, id, text, options, signal),
			);
			return;
		}
		const reply = {
			...options,
			...(this.#o.replyTo === undefined ? {} : { replyTo: this.#o.replyTo }),
			...(this.#o.threadId === undefined ? {} : { threadId: this.#o.threadId }),
		};
		const sent = await withPlainFallback(
			() => port.sendMessage(chatId, html, { ...reply, html: true }, signal),
			() => port.sendMessage(chatId, text, reply, signal),
		);
		this.#messageId = sent;
		await this.#o.onCreated(sent);
	}

	#armRefresh(): void {
		clearTimeout(this.#refresh);
		this.#refresh = setTimeout(() => {
			this.#lastSent = undefined;
			this.#schedule();
		}, DRAFT_REFRESH_MS);
		this.#refresh.unref();
	}

	#handleError(error: unknown, text: string): void {
		const kind = classifyTelegramError(error);
		if (kind.kind === "not_modified") this.#lastSent = text;
		else if (kind.kind === "retry_after") this.#cooldownUntil = this.#now() + kind.seconds * 1000;
		else if (this.#draft && !this.#draftShown && error instanceof TelegramApiError) {
			// Telegram refused drafts here (not a private chat, an old API): edit a message for the rest of the run.
			this.#draft = false;
			this.#lastSent = undefined;
			this.#o.log.info("draft_unavailable", telegramErrorSummary(error));
		} else if (kind.kind !== "aborted") this.#o.log.debug("preview_failed", telegramErrorSummary(error));
	}
}

/** Run `html`; when Telegram rejects the entities, run `plain` once instead. */
export async function withPlainFallback<T>(html: () => Promise<T>, plain: () => Promise<T>): Promise<T> {
	try {
		return await html();
	} catch (error) {
		if (classifyTelegramError(error).kind !== "parse_error") throw error;
		return plain();
	}
}
