import type { JsonValue } from "@earendil-works/chord";
import { truncate } from "../format/escape.ts";
import { redact } from "../runtime/redact.ts";

/** First line of a durable `detail`, redacted and at most `max` characters. */
export function trimDetail(detail: JsonValue | undefined, max = 300): string | undefined {
	if (detail === undefined || detail === null) return undefined;
	const text = typeof detail === "string" ? detail : JSON.stringify(detail);
	const line = text.split("\n").find((each) => each.trim() !== "") ?? "";
	const clean = truncate(redact(line.trim()), max);
	return clean === "" ? undefined : clean;
}

/** Provider error lines start with the HTTP status; numbers elsewhere (token counts, request ids) mean nothing. */
const overflowPattern = /prompt is too long|context[_ ]length|maximum context|context window|too many (input )?tokens/i;
const overloadPattern =
	/^(429|529)\b|\brate_limit_error\b|\boverloaded(_error)?\b|\brate.?limit(ed)?\b|too many requests/i;
const authPattern = new RegExp(
	[
		"^(401|403)\\b",
		"\\b(authentication_error|permission_error)\\b",
		"\\bOAuth (refresh|token)\\b",
		"\\btoken refresh\\b",
		"\\b(token|credentials?) (has |have )?expired\\b",
		"\\bunauthori[sz]ed\\b",
		"\\binvalid[ _-]?x-api-key\\b",
		"\\bno api key\\b",
		"\\bnot logged in\\b",
		"\\bprovider is not configured\\b",
		"\\bcredential store\\b",
	].join("|"),
	"i",
);

/** The one line a user sees when a request got no answer; undefined when nothing should be said. */
export function unansweredText(
	reason: string,
	detail: string | undefined,
	model: { provider: string; modelId: string },
): string | undefined {
	switch (reason) {
		case "aborted":
			return undefined;
		case "model_error":
			return modelErrorText(detail ?? "", model.provider);
		case "no_model":
			return `⚠ Model ${model.provider}/${model.modelId} is not available (check PI_PROVIDER/PI_MODEL).`;
		case "faulted":
			return `⚠ Internal error: ${truncate(detail ?? "unknown", 200)}.`;
		case "reset":
			return "Context was reset; this request was dropped.";
		default:
			return `⚠ Request not answered (${reason}).`;
	}
}

function modelErrorText(detail: string, provider: string): string {
	if (overflowPattern.test(detail)) return "⚠ The conversation is too long for the model: send /compact or /new.";
	if (overloadPattern.test(detail)) return "⚠ Provider is overloaded or rate-limited, try again later.";
	if (authPattern.test(detail))
		return `⚠ Model auth failed: run \`pi-durable-telegram login ${provider}\` on the server.`;
	return `⚠ Model error: ${truncate(detail === "" ? "unknown" : detail, 200)}.`;
}

/** Reasons after which queued messages stay in the inbox until something places them. */
export function stallsQueue(reason: string): boolean {
	return [
		"model_error",
		"faulted",
		"no_model",
		"interrupted",
		"restart_limit",
		"turn_limit",
		"nothing_to_answer",
	].includes(reason);
}
