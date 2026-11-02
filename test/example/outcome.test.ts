import assert from "node:assert/strict";
import { test } from "node:test";
import { finalReplyText } from "../../src/delivery/final-text.ts";
import { toolHint } from "../../src/delivery/hints.ts";
import { stallsQueue, trimDetail, unansweredText } from "../../src/delivery/outcome.ts";
import { classifyTelegramError, TelegramApiError, TelegramUnknown } from "../../src/telegram/errors.ts";

const model = { provider: "anthropic", modelId: "claude-opus-5-5" };

test("unanswered text table", () => {
	assert.equal(unansweredText("aborted", undefined, model), undefined);
	assert.match(unansweredText("model_error", "401 invalid x-api-key", model) ?? "", /auth failed.*login anthropic/);
	assert.match(unansweredText("model_error", "OAuth token refresh failed: invalid_grant", model) ?? "", /auth failed/);
	assert.match(unansweredText("model_error", "529 overloaded_error", model) ?? "", /overloaded/);
	assert.equal(
		unansweredText("model_error", "connection reset by peer", model),
		"⚠ Model error: connection reset by peer.",
	);
	assert.match(unansweredText("no_model", undefined, model) ?? "", /anthropic\/claude-opus-5-5/);
	assert.match(unansweredText("faulted", "boom", model) ?? "", /Internal error: boom/);
	assert.match(unansweredText("reset", undefined, model) ?? "", /reset/);
	assert.match(unansweredText("orphaned", undefined, model) ?? "", /not answered \(orphaned\)/);
	for (const reason of [
		"model_error",
		"faulted",
		"no_model",
		"interrupted",
		"restart_limit",
		"turn_limit",
		"nothing_to_answer",
	])
		assert.ok(stallsQueue(reason), reason);
	assert.ok(!stallsQueue("aborted"));
});

test("details are trimmed to one redacted line", () => {
	assert.equal(trimDetail("first line\nsecond"), "first line");
	assert.equal(trimDetail("token sk-ant-oat01-abcdefghijklmnop expired"), "token sk-ant-<redacted> expired");
	assert.equal(trimDetail({ code: 1 }), '{"code":1}');
	assert.equal(trimDetail(undefined), undefined);
	assert.equal((trimDetail("x".repeat(1000)) ?? "").length, 300);
});

test("tool hints", () => {
	assert.equal(toolHint("bash", { command: "npm test\nnpm run lint" }), "bash: npm test");
	assert.equal(toolHint("read", { path: "src/index.ts" }), "read: src/index.ts");
	assert.equal(toolHint("custom", { other: 1 }), "custom");
	assert.equal(toolHint("bash", { command: "x".repeat(200) }).length, 60);
});

test("final reply text keeps only user-visible text", () => {
	const base = { role: "assistant", api: "faux", provider: "faux", model: "m", usage: {}, timestamp: 0 } as const;
	assert.equal(
		finalReplyText({ ...base, stopReason: "stop", content: [{ type: "text", text: " hi " }] } as never),
		"hi",
	);
	assert.equal(
		finalReplyText({ ...base, stopReason: "stop", content: [{ type: "thinking", thinking: "x" }] } as never),
		undefined,
	);
	assert.equal(
		finalReplyText({ ...base, stopReason: "error", content: [{ type: "text", text: "x" }] } as never),
		undefined,
	);
	const commentary = { type: "text", text: "note", textSignature: JSON.stringify({ v: 1, phase: "commentary" }) };
	assert.equal(
		finalReplyText({ ...base, stopReason: "stop", content: [commentary, { type: "text", text: "answer" }] } as never),
		"answer",
	);
});

test("telegram error classification", () => {
	const api = (code: number, description: string, retry?: number) =>
		classifyTelegramError(new TelegramApiError("m", code, description, retry));
	assert.deepEqual(api(429, "Too Many Requests", 3), { kind: "retry_after", seconds: 3 });
	assert.equal(api(400, "Bad Request: message is not modified: specified new message content").kind, "not_modified");
	assert.equal(api(400, "Bad Request: can't parse entities: Unsupported start tag").kind, "parse_error");
	assert.equal(api(400, "Bad Request: message to edit not found").kind, "message_gone");
	assert.equal(api(400, "Bad Request: message is too long").kind, "too_big");
	assert.equal(api(403, "Forbidden: bot was blocked by the user").kind, "blocked");
	assert.equal(classifyTelegramError(new TelegramUnknown("sendMessage", "x")).kind, "unknown");
	assert.equal(classifyTelegramError(Object.assign(new Error("a"), { name: "AbortError" })).kind, "aborted");
});

test("model errors: auth only on auth signals; overflow, limits and others keep their own reason", () => {
	const text = (detail: string) => unansweredText("model_error", trimDetail(detail), model) ?? "";
	const overflow =
		'400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 1040312 tokens > 1000000 maximum"}}';
	assert.match(text(overflow), /too long for the model.*\/compact/);
	const maxTokens =
		'400 {"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: 200000 > 128000, which is the maximum allowed number of output tokens"}}';
	assert.match(text(maxTokens), /^⚠ Model error: 400 .*max_tokens/);
	const server =
		'500 {"type":"error","error":{"type":"api_error","message":"Internal server error"},"request_id":"req_011CX4031abc"}';
	assert.match(text(server), /^⚠ Model error: 500 /);
	assert.match(text('429 {"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}'), /rate-limited/);
	for (const auth of [
		'401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
		'403 {"type":"error","error":{"type":"permission_error","message":"OAuth authentication is currently not allowed"}}',
		"OAuth refresh failed for anthropic",
		"No API key for provider: anthropic",
		"Provider is not configured: anthropic",
		'{"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}',
	])
		assert.match(text(auth), /auth failed/, auth);
	for (const other of ["invalid token count in request 401 times", "request req_401abc failed", "connection reset"])
		assert.doesNotMatch(text(other), /auth failed/, other);
});
