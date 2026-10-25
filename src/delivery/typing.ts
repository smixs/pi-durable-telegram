import type { TelegramPort } from "../telegram/port.ts";

const TYPING_INTERVAL_MS = 4500;

/** Repeats "typing…" every 4.5 s while on; Telegram clears it after about 5 s. Failures are ignored. */
export class TypingPulse {
	readonly #port: TelegramPort;
	readonly #chatId: number;
	readonly #signal: AbortSignal | undefined;
	readonly #threadId: number | undefined;
	#timer: NodeJS.Timeout | undefined;

	constructor(port: TelegramPort, chatId: number, signal?: AbortSignal, threadId?: number) {
		this.#port = port;
		this.#chatId = chatId;
		this.#signal = signal;
		this.#threadId = threadId;
	}

	set(on: boolean): void {
		if (on && this.#timer === undefined) {
			this.#tick();
			this.#timer = setInterval(() => this.#tick(), TYPING_INTERVAL_MS);
			this.#timer.unref();
		} else if (!on) this.stop();
	}

	stop(): void {
		if (this.#timer !== undefined) clearInterval(this.#timer);
		this.#timer = undefined;
	}

	#tick(): void {
		if (this.#signal?.aborted === true) {
			this.stop();
			return;
		}
		this.#port.sendChatAction(this.#chatId, "typing", this.#signal, this.#threadId).catch(() => undefined);
	}
}
