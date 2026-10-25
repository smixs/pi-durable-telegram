import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { chatKey } from "../../src/channel/docs.ts";
import { check } from "../helpers/property.ts";

const id = fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER });
const route = fc.record({ chatId: id, threadId: id });

test("P-topics: independent chat/topic routes never overwrite each other's conversation mapping", (t) => {
	const routes = fc.uniqueArray(route, { minLength: 2, maxLength: 40, selector: JSON.stringify });
	check(
		t,
		routes,
		(items) => {
			const conversations = new Map(items.map(({ chatId, threadId }, index) => [chatKey(chatId, threadId), index]));
			for (const [index, { chatId, threadId }] of items.entries()) {
				assert.equal(conversations.get(chatKey(chatId, threadId)), index);
			}
		},
		100,
	);
});

test("P-topics: ordinary chats and zero-thread messages retain their legacy conversation key", (t) => {
	check(
		t,
		id,
		(chatId) => {
			assert.equal(chatKey(chatId), String(chatId));
			assert.equal(chatKey(chatId, 0), chatKey(chatId));
		},
		100,
	);
});

test("P-topics: distinct topics within one private chat stay separate from each other and its general chat", (t) => {
	check(
		t,
		fc.tuple(id, fc.uniqueArray(id, { minLength: 2, maxLength: 20 })),
		([chatId, threads]) => {
			const keys = new Set(threads.map((threadId) => chatKey(chatId, threadId)));
			assert.equal(keys.size, threads.length);
			assert.ok(!keys.has(chatKey(chatId)));
		},
		100,
	);
});
