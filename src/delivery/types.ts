import type { JsonValue } from "@earendil-works/chord";
import type { Harness, ModelRef } from "@earendil-works/pi-durable";
import type { FatalHandler } from "../runtime/fatal.ts";
import type { Logger } from "../runtime/log.ts";
import type { TelegramPort } from "../telegram/port.ts";

export type DeliverInput = {
	chatId: number;
	/** Telegram topic receiving the answer; absent for the main chat. */
	threadId?: number;
	/** The user's Telegram message; the answer replies to it. Absent for a wake that answers no message (a reminder). */
	messageId?: number;
	/** Durable request id of the submission: `tg:<chat>:<message>` (`remind:<id>:<due>` for a reminder). */
	requestId: string;
	/** pi-ai `UserInput`. */
	content: JsonValue;
};

export type Preview = { messageId: number };

export type Outcome =
	| { kind: "answer"; entryId: number }
	| { kind: "unanswered"; reason: string; detail?: string }
	| { kind: "shared"; entryId: number };

export type WaitState = { phase: "wait"; submissionId?: number; preview?: Preview };

export type SendState = {
	phase: "send";
	outcome: Outcome;
	preview?: Preview;
	/** Chunks delivered (or given up on) so far. */
	sent: number;
	/** Index of a non-idempotent send started but not recorded: after a crash chunk 0 is sent again, others skipped. */
	inFlight?: number;
	messageIds: number[];
	/** Some chunk's outcome is unknown. */
	unknown?: boolean;
	/** Telegram rejected the rich message at this chunk: the rest of the answer goes out as HTML. */
	htmlFrom?: number;
};

export type DeliverState = WaitState | SendState;

/** What delivery needs from the running channel; getters, because tasks are defined before the Harness opens. */
export type DeliveryDeps = {
	readonly port: () => TelegramPort;
	readonly harness: () => Harness;
	readonly log: Logger;
	readonly model: ModelRef;
	readonly onFatal: FatalHandler;
	/** Answers go out as rich messages and stream as native drafts. */
	readonly rich?: boolean;
	readonly previewIntervalMs?: number;
	/** Pauses between final preview edits during a Telegram outage (default `EDIT_RETRY_DELAYS_MS`). */
	readonly editRetryDelaysMs?: readonly number[];
};
