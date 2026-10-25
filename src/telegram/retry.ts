import { setTimeout as sleep } from "node:timers/promises";
import type { Transformer } from "grammy";
import { TelegramUnavailable, TelegramUnknown } from "./errors.ts";

const NON_IDEMPOTENT = new Set([
	"sendMessage",
	"sendRichMessage",
	"sendPhoto",
	"sendDocument",
	"sendMediaGroup",
	"copyMessage",
	"forwardMessage",
	// An uncertain rename may have succeeded before a human changed the title; do not overwrite that change.
	"editForumTopic",
]);
const MAX_ATTEMPTS = 3;
const MAX_WAIT_SECONDS = 30;
const BACKOFF_MS = [1000, 2000, 4000];

export type RetryOptions = {
	readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	/** No retries at all; network errors are still classified (used for previews and typing). */
	readonly fast?: boolean;
};

type ApiResult = { ok: boolean; error_code?: number; description?: string; parameters?: { retry_after?: number } };

/**
 * grammY transformer with a retry policy by method. Idempotent methods retry 429 (after `retry_after`), 5xx and
 * network errors up to 3 attempts. Non-idempotent sends retry only 429 (a 429 proves nothing was sent); a 5xx,
 * network error or malformed answer becomes `TelegramUnknown`. Every wait is abortable by the call's signal.
 */
export function createRetryTransformer(options: RetryOptions = {}): Transformer {
	const wait = options.sleep ?? defaultSleep;
	return async (prev, method, payload, grammySignal) => {
		const signal = grammySignal as AbortSignal | undefined;
		const idempotent = !NON_IDEMPOTENT.has(method);
		for (let attempt = 1; ; attempt++) {
			const call: Call = { method, idempotent, attempt, last: options.fast === true || attempt >= MAX_ATTEMPTS };
			const outcome = await callOnce(() => prev(method, payload, grammySignal), call, signal);
			if (outcome.done) return outcome.result as never;
			await wait(outcome.delayMs, signal);
		}
	};
}

type Call = { readonly method: string; readonly idempotent: boolean; readonly attempt: number; readonly last: boolean };
type Outcome = { done: true; result: unknown } | { done: false; delayMs: number };

async function callOnce(invoke: () => Promise<unknown>, call: Call, signal: AbortSignal | undefined): Promise<Outcome> {
	let result: ApiResult;
	try {
		result = (await invoke()) as ApiResult;
	} catch (error) {
		// grammY wraps an aborted fetch in HttpError; the caller's signal tells them apart.
		if (signal?.aborted === true) throw signal.reason ?? error;
		return failure(call, "network error", undefined);
	}
	return judge(result, call);
}

function judge(result: ApiResult, call: Call): Outcome {
	if (typeof result !== "object" || result === null || typeof result.ok !== "boolean") {
		return failure(call, "malformed response", undefined);
	}
	if (result.ok) return { done: true, result };
	if ((result.error_code ?? 0) >= 500) return failure(call, `HTTP ${result.error_code}`, result);
	if (result.error_code === 429 && !call.last) return { done: false, delayMs: retryAfterMs(result) };
	return { done: true, result };
}

function failure(call: Call, reason: string, result: ApiResult | undefined): Outcome {
	if (!call.idempotent) throw new TelegramUnknown(call.method, reason);
	if (!call.last) return { done: false, delayMs: BACKOFF_MS[call.attempt - 1] ?? 4000 };
	if (result !== undefined) return { done: true, result };
	throw new TelegramUnavailable(call.method, reason);
}

function retryAfterMs(result: ApiResult): number {
	const seconds = result.parameters?.retry_after ?? 1;
	return Math.min(MAX_WAIT_SECONDS, Math.max(0, seconds)) * 1000;
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	await sleep(ms, undefined, signal === undefined ? {} : { signal });
}
