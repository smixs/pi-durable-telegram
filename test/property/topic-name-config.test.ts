import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { ConfigError, parseConfig } from "../../src/config/schema.ts";
import { check } from "../helpers/property.ts";

const env = { TELEGRAM_BOT_TOKEN: `12345:${"x".repeat(32)}`, TELEGRAM_ALLOWED_USER_IDS: "1" };

test("topic naming defaults to auto and accepts either mode with surrounding whitespace", (t) => {
	assert.equal(parseConfig(env).telegramTopicNames, "auto");
	check(t, fc.tuple(fc.constantFrom("auto", "manual"), fc.constantFrom("", " ", "\t")), ([mode, space]) => {
		const config = parseConfig({ ...env, TELEGRAM_TOPIC_NAMES: `${space}${mode}${space}` });
		assert.equal(config.telegramTopicNames, mode);
	});
});

test("invalid topic naming modes fail startup with the exact variable name", (t) => {
	const invalid = fc.string({ minLength: 1, maxLength: 30 }).filter((s) => !["", "auto", "manual"].includes(s.trim()));
	check(t, invalid, (mode) => {
		assert.throws(
			() => parseConfig({ ...env, TELEGRAM_TOPIC_NAMES: mode }),
			(error) => error instanceof ConfigError && error.problems.some((p) => p.variable === "TELEGRAM_TOPIC_NAMES"),
		);
	});
});
