import assert from "node:assert/strict";
import { test } from "node:test";
import { Api } from "grammy";
import { TelegramApiError, TelegramUnknown } from "../../src/telegram/errors.ts";
import { createGrammyPort } from "../../src/telegram/grammy-port.ts";
import { createRetryTransformer } from "../../src/telegram/retry.ts";
import { FakeBotApi } from "../fixtures/fake-bot-api.ts";
import { FakeTelegram } from "../helpers/fake-telegram.ts";

test("Telegram topic rename sends only the scoped editForumTopic payload and leaves message sends intact", async (t) => {
	const server = new FakeBotApi();
	const apiRoot = await server.start();
	t.after(() => server.stop());
	const port = createGrammyPort({ token: "42:fake", apiRoot });
	assert.ok(port.renameTopic !== undefined);
	await port.renameTopic(5, 37, "Fix deployment");
	await port.sendMessage(5, "hello", {});
	assert.deepEqual(server.calls[0], {
		method: "editForumTopic",
		body: { chat_id: 5, message_thread_id: 37, name: "Fix deployment" },
	});
	assert.deepEqual(server.calls[1], {
		method: "sendMessage",
		body: { chat_id: 5, text: "hello", link_preview_options: { is_disabled: true } },
	});
});

function rejectingPort(code: number, description: string) {
	const api = new Api("42:fake");
	api.config.use(async () => ({ ok: false, error_code: code, description }) as never);
	api.config.use(createRetryTransformer({ sleep: async () => assert.fail("no retry expected") }));
	return createGrammyPort({ token: "42:fake", apiRoot: "http://127.0.0.1", api });
}

test("renaming a topic to its existing name succeeds; the exception applies only to topic edits", async () => {
	for (const description of ["Bad Request: TOPIC_NOT_MODIFIED", "topic_not_modified"]) {
		const port = rejectingPort(400, description);
		assert.ok(port.renameTopic !== undefined);
		await port.renameTopic(5, 37, "Fix deployment");
		await assert.rejects(port.sendMessage(5, "hello", {}), TelegramApiError);
	}
});

test("topic rename does not mask other API errors or a similar error with another code", async () => {
	for (const description of ["Bad Request: TOPIC_ID_INVALID", "Bad Request: TOPIC_NOT_MODIFIED and another error"]) {
		const port = rejectingPort(400, description);
		assert.ok(port.renameTopic !== undefined);
		await assert.rejects(port.renameTopic(5, 37, "Fix deployment"), (error: unknown) => {
			assert.ok(error instanceof TelegramApiError);
			assert.equal(error.code, 400);
			assert.equal(error.description, description);
			return true;
		});
	}
	const forbidden = rejectingPort(403, "TOPIC_NOT_MODIFIED");
	assert.ok(forbidden.renameTopic !== undefined);
	await assert.rejects(forbidden.renameTopic(5, 37, "Fix deployment"), TelegramApiError);
	const unavailable = rejectingPort(503, "unavailable");
	assert.ok(unavailable.renameTopic !== undefined);
	await assert.rejects(unavailable.renameTopic(5, 37, "Fix deployment"), TelegramUnknown);
});

test("an uncertain topic rename is sent once, so retries cannot overwrite a later manual rename", async () => {
	for (const response of [{ ok: false, error_code: 500, description: "unavailable" }, new Error("network reset")]) {
		const api = new Api("42:fake");
		let calls = 0;
		api.config.use(async () => {
			calls++;
			if (response instanceof Error) throw response;
			return response as never;
		});
		api.config.use(createRetryTransformer({ sleep: async () => assert.fail("must not retry uncertain rename") }));
		const port = createGrammyPort({ token: "42:fake", apiRoot: "http://127.0.0.1", api });
		assert.ok(port.renameTopic !== undefined);
		await assert.rejects(port.renameTopic(5, 37, "Fix deployment"), TelegramUnknown);
		assert.equal(calls, 1);
	}
});

test("a rate-limited topic rename retries because Telegram confirmed it was not applied", async () => {
	const api = new Api("42:fake");
	let calls = 0;
	const waits: number[] = [];
	api.config.use(async () => {
		calls++;
		return (
			calls === 1
				? { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 3 } }
				: { ok: true, result: true }
		) as never;
	});
	api.config.use(createRetryTransformer({ sleep: async (ms) => void waits.push(ms) }));
	const port = createGrammyPort({ token: "42:fake", apiRoot: "http://127.0.0.1", api });
	assert.ok(port.renameTopic !== undefined);
	await port.renameTopic(5, 37, "Fix deployment");
	assert.equal(calls, 2);
	assert.deepEqual(waits, [3000]);
});

test("topic rename forwards its abort signal to the API", async () => {
	const api = new Api("42:fake");
	const controller = new AbortController();
	api.config.use(async (_previous, method, _payload, signal) => {
		assert.equal(method, "editForumTopic");
		assert.equal(signal, controller.signal);
		return { ok: true, result: true } as never;
	});
	const port = createGrammyPort({ token: "42:fake", apiRoot: "http://127.0.0.1", api });
	assert.ok(port.renameTopic !== undefined);
	await port.renameTopic(5, 37, "Fix deployment", controller.signal);
});

test("FakeTelegram records scoped renames separately from messages and only applies successful calls", async () => {
	const port = new FakeTelegram();
	const controller = new AbortController();
	port.use((call, signal) => {
		assert.equal(signal, controller.signal);
		if (call.threadId === 41) throw new TelegramApiError("editForumTopic", 400, "TOPIC_ID_INVALID");
	});
	await port.renameTopic(5, 37, "Fix deployment", controller.signal);
	await assert.rejects(port.renameTopic(5, 41, "Other task", controller.signal), TelegramApiError);
	assert.deepEqual(port.renamedTopics, [{ chatId: 5, threadId: 37, name: "Fix deployment" }]);
	assert.deepEqual(port.calls, [
		{ method: "renameTopic", chatId: 5, threadId: 37, text: "Fix deployment" },
		{ method: "renameTopic", chatId: 5, threadId: 41, text: "Other task" },
	]);
	assert.equal(port.messages.size, 0);
});
