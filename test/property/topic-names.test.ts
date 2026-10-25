import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { normalizeTopicName } from "../../src/channel/topic-names.ts";
import { check } from "../helpers/property.ts";

const character = fc.constantFrom("a", "Б", "é", "漢", "😀", "🌐");
const title = fc.array(character, { minLength: 1, maxLength: 128 }).map((parts) => parts.join(""));
const padding = fc.array(fc.constantFrom(" ", "\u00a0", "\u2003"), { maxLength: 8 }).map((parts) => parts.join(""));

test("P-topic-name: Unicode titles keep their code points and only surrounding spaces are removed", (t) => {
	check(t, fc.tuple(title, padding, padding), ([name, before, after]) => {
		assert.equal(normalizeTopicName(`${before}${name}${after}`), name);
	});
	assert.equal(normalizeTopicName("😀".repeat(128)), "😀".repeat(128), "Telegram counts Unicode code points");
});

test("P-topic-name: control characters and Unicode line separators are rejected wherever they occur", (t) => {
	const control = fc
		.oneof(fc.integer({ min: 0, max: 0x1f }), fc.integer({ min: 0x7f, max: 0x9f }), fc.constantFrom(0x2028, 0x2029))
		.map((code) => String.fromCodePoint(code));
	check(t, fc.tuple(title, control), ([name, char]) => {
		assert.equal(normalizeTopicName(`${char}${name}`), undefined);
		assert.equal(normalizeTopicName(`${name}${char}${name}`), undefined);
		assert.equal(normalizeTopicName(`${name}${char}`), undefined);
	});
});

test("P-topic-name: blank or overlong titles are rejected without silently truncating", (t) => {
	const overlong = fc.array(character, { minLength: 129, maxLength: 180 }).map((parts) => parts.join(""));
	check(t, fc.oneof(padding, overlong), (name) => {
		assert.equal(normalizeTopicName(name), undefined);
	});
});

test("P-topic-name: any accepted title is stable when normalized again", (t) => {
	check(t, fc.string({ unit: "binary", maxLength: 300 }), (name) => {
		const normalized = normalizeTopicName(name);
		if (normalized === undefined) return;
		assert.equal(normalizeTopicName(normalized), normalized);
		assert.equal(normalized, normalized.trim());
		assert.ok(Array.from(normalized).length >= 1 && Array.from(normalized).length <= 128);
		assert.doesNotMatch(normalized, /[\p{Cc}\u2028\u2029]/u);
	});
});
