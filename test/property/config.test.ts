import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { ConfigError, parseConfig } from "../../src/config/schema.ts";
import { check } from "../helpers/property.ts";

const defaults = { cwd: "/srv/work", home: "/home/u" };
const tokenChars = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-".split(""));
const token = fc
	.tuple(fc.integer({ min: 10_000, max: 9_999_999_999 }), fc.string({ unit: tokenChars, minLength: 30, maxLength: 46 }))
	.map(([id, secret]) => `${id}:${secret}`);
const userId = fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER });
const spaces = fc.constantFrom("", " ", "  ");
const idList = fc.array(fc.tuple(userId, spaces, spaces), { minLength: 1, maxLength: 8 });
const badId = fc.constantFrom("-5", "abc", "0", "1.5", "0x10", "99999999999999999999", "12a", "+7");

function problemsOf(env: Record<string, string | undefined>): string[] {
	try {
		parseConfig(env, defaults);
		return [];
	} catch (error) {
		assert.ok(error instanceof ConfigError);
		return [...new Set(error.problems.map((problem) => problem.variable))].sort();
	}
}

test("P-config: a valid environment parses to the exact allow set", (t) => {
	check(t, fc.tuple(token, idList), ([botToken, ids]) => {
		const raw = ids.map(([id, before, after]) => `${before}${id}${after}`).join(",");
		const config = parseConfig({ TELEGRAM_BOT_TOKEN: botToken, TELEGRAM_ALLOWED_USER_IDS: raw }, defaults);
		assert.deepEqual(new Set(config.allowedUserIds), new Set(ids.map(([id]) => id)));
		assert.equal(config.allowedUserIds.length, new Set(ids.map(([id]) => id)).size);
		assert.equal(config.provider, "anthropic");
		assert.equal(config.modelId, "claude-opus-5-5");
		assert.equal(config.thinkingLevel, "high");
		assert.equal(config.workdir, "/srv/work");
		assert.equal(config.dataDir, "/home/u/.local/state/pi-durable-telegram");
		assert.equal(config.instructionsPath, "/srv/work/AGENTS.md");
	});
});

test("P-config: malformed ids or missing required variables are listed exactly, without secrets", (t) => {
	const scenario = fc.record({
		token: fc.option(token, { nil: undefined }),
		ids: fc.option(fc.tuple(idList, fc.option(badId, { nil: undefined })), { nil: undefined }),
		deepgram: fc.option(fc.string({ unit: tokenChars, minLength: 20, maxLength: 40 }), { nil: undefined }),
	});
	check(t, scenario, ({ token: botToken, ids, deepgram }) => {
		const env = {
			TELEGRAM_BOT_TOKEN: botToken,
			TELEGRAM_ALLOWED_USER_IDS: idsText(ids),
			DEEPGRAM_API_KEY: deepgram,
		};
		const expected = [
			...(botToken === undefined ? ["TELEGRAM_BOT_TOKEN"] : []),
			...(ids === undefined || ids[1] !== undefined ? ["TELEGRAM_ALLOWED_USER_IDS"] : []),
		].sort();
		assert.deepEqual(problemsOf(env), expected);
		assertNoSecrets(env, [botToken?.split(":")[1], deepgram]);
	});
});

function idsText(ids: [[number, string, string][], string | undefined] | undefined): string | undefined {
	if (ids === undefined) return undefined;
	const good = ids[0].map(([id]) => String(id));
	return [...good, ...(ids[1] === undefined ? [] : [ids[1]])].join(",");
}

function assertNoSecrets(env: Record<string, string | undefined>, secrets: (string | undefined)[]): void {
	try {
		parseConfig(env, defaults);
	} catch (error) {
		const text = String((error as Error).message);
		for (const secret of secrets) if (secret !== undefined) assert.ok(!text.includes(secret));
	}
}

test("config examples", () => {
	const base = { TELEGRAM_BOT_TOKEN: `12345:${"x".repeat(32)}`, TELEGRAM_ALLOWED_USER_IDS: "1, 2,2," };
	assert.deepEqual(parseConfig(base, defaults).allowedUserIds, [1, 2]);
	assert.deepEqual(problemsOf({ ...base, TELEGRAM_ALLOWED_USER_IDS: "," }), ["TELEGRAM_ALLOWED_USER_IDS"]);
	assert.deepEqual(problemsOf({ ...base, TELEGRAM_BOT_TOKEN: "nope" }), ["TELEGRAM_BOT_TOKEN"]);
	assert.deepEqual(problemsOf({ ...base, PI_THINKING: "huge" }), ["PI_THINKING"]);
	assert.deepEqual(problemsOf({ ...base, PI_PROVIDER: "Bad Id" }), ["PI_PROVIDER"]);
	assert.equal(
		parseConfig({ ...base, PI_PROVIDER: "custom.provider-v1_alpha" }, defaults).provider,
		"custom.provider-v1_alpha",
	);
	assert.deepEqual(problemsOf({ ...base, PI_CONTEXT_CAP: "10" }), ["PI_CONTEXT_CAP"]);
	assert.deepEqual(problemsOf({ ...base, TELEGRAM_API_ROOT: "ftp://x" }), ["TELEGRAM_API_ROOT"]);
	const custom = parseConfig(
		{
			...base,
			PI_WORKDIR: "proj",
			PI_DATA_DIR: "/data",
			PI_INSTRUCTIONS: "NOTES.md",
			XDG_STATE_HOME: "/state",
			TELEGRAM_API_ROOT: "http://localhost:8081/",
		},
		defaults,
	);
	assert.equal(custom.workdir, "/srv/work/proj");
	assert.equal(custom.dataDir, "/data");
	assert.equal(custom.instructionsPath, "/srv/work/proj/NOTES.md");
	assert.equal(custom.telegramApiRoot, "http://localhost:8081");
	assert.equal(parseConfig({ ...base, XDG_STATE_HOME: "/state" }, defaults).dataDir, "/state/pi-durable-telegram");
});
