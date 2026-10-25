import assert from "node:assert/strict";
import { test } from "node:test";
import { Api } from "grammy";
import { PreviewStreamer } from "../../src/delivery/preview.ts";
import { TypingPulse } from "../../src/delivery/typing.ts";
import { silentLogger } from "../../src/runtime/log.ts";
import { TelegramApiError } from "../../src/telegram/errors.ts";
import { createGrammyPort } from "../../src/telegram/grammy-port.ts";
import { FakeBotApi } from "../fixtures/fake-bot-api.ts";
import { waitFor } from "../helpers/env.ts";
import { FakeTelegram } from "../helpers/fake-telegram.ts";

test("Telegram topic routing: text, rich messages, drafts and typing include the topic; edits identify messages", async (t) => {
	const server = new FakeBotApi();
	const apiRoot = await server.start();
	t.after(() => server.stop());
	const port = createGrammyPort({ token: "42:fake", apiRoot });
	const threadId = 37;
	const messageId = await port.sendMessage(5, "hello", { html: true, replyTo: 9, threadId });
	await port.sendMessage(5, "**rich**", { rich: true, threadId });
	await port.sendDraft(5, 8, "draft", undefined, threadId);
	await port.sendChatAction(5, "typing", undefined, threadId);
	await port.editMessageText(5, messageId, "updated", { html: true, threadId });
	await port.editMessageText(5, messageId, "**updated**", { rich: true, threadId });
	for (const call of server.calls.filter((call) => call.method !== "editMessageText")) {
		assert.equal(call.body.chat_id, 5);
		assert.equal(call.body.message_thread_id, threadId, call.method);
	}
	for (const call of server.calls.filter((call) => call.method === "editMessageText")) {
		assert.equal(call.body.message_id, messageId);
		assert.ok(!Object.hasOwn(call.body, "message_thread_id"), "edits do not accept message_thread_id");
	}
	assert.deepEqual(server.calls[0]?.body.reply_parameters, { message_id: 9, allow_sending_without_reply: true });
});

test("Telegram main-chat requests omit message_thread_id", async (t) => {
	const server = new FakeBotApi();
	const apiRoot = await server.start();
	t.after(() => server.stop());
	const port = createGrammyPort({ token: "42:fake", apiRoot });
	await port.sendMessage(5, "hello", {});
	await port.sendMessage(5, "rich", { rich: true });
	await port.sendDraft(5, 8, "draft");
	await port.sendChatAction(5, "typing");
	for (const call of server.calls) assert.ok(!Object.hasOwn(call.body, "message_thread_id"), call.method);
});

test("Telegram uploads route photos and documents to their topic and preserve main-chat calls", async () => {
	const api = new Api("42:fake");
	const calls: { method: string; payload: Record<string, unknown> }[] = [];
	api.config.use(async (_previous, method, payload) => {
		calls.push({ method, payload });
		return { ok: true, result: { message_id: 1 } } as never;
	});
	const port = createGrammyPort({ token: "42:fake", apiRoot: "http://127.0.0.1", api });
	await port.sendPhoto(5, "unused.png", "caption", undefined, 37);
	await port.sendDocument(5, "unused.txt", undefined, undefined, 41);
	await port.sendPhoto(5, "unused.png", undefined);
	await port.sendDocument(5, "unused.txt", "caption");
	assert.deepEqual(
		calls.map((call) => [call.method, call.payload.message_thread_id]),
		[
			["sendPhoto", 37],
			["sendDocument", 41],
			["sendPhoto", undefined],
			["sendDocument", undefined],
		],
	);
	assert.equal(calls[0]?.payload.caption, "caption");
	assert.ok(!Object.hasOwn(calls[2]?.payload ?? {}, "message_thread_id"));
	assert.ok(!Object.hasOwn(calls[3]?.payload ?? {}, "message_thread_id"));
});

test("topic preview: a rejected draft and HTML preview fall back inside the same topic", async () => {
	const port = new FakeTelegram();
	port.use((call) => {
		if (call.method === "sendDraft") throw new TelegramApiError("sendRichMessageDraft", 400, "draft unavailable");
		if (call.method === "sendMessage" && call.options?.html === true)
			throw new TelegramApiError("sendMessage", 400, "Bad Request: can't parse entities");
	});
	const streamer = new PreviewStreamer({
		port,
		chatId: 5,
		threadId: 37,
		replyTo: 9,
		log: silentLogger,
		messageId: undefined,
		draftId: 8,
		onCreated: async () => undefined,
		intervalMs: 1,
	});
	try {
		streamer.push({ text: "answer", hint: undefined });
		await waitFor(() => port.created(5).length === 1);
		assert.equal(port.created(5)[0]?.threadId, 37);
		assert.equal(port.created(5)[0]?.replyTo, 9);
		assert.ok(port.calls.every((call) => call.threadId === 37));
		assert.equal(port.count("sendMessage"), 2);
	} finally {
		await streamer.close();
	}
});

test("topic previews and typing stay separate for two topics in the same chat", async () => {
	const port = new FakeTelegram();
	const typing = new TypingPulse(port, 5, undefined, 37);
	typing.set(true);
	typing.stop();
	const streamers = [37, 41].map(
		(threadId) =>
			new PreviewStreamer({
				port,
				chatId: 5,
				threadId,
				replyTo: undefined,
				log: silentLogger,
				messageId: undefined,
				draftId: threadId,
				onCreated: async () => assert.fail("drafts do not create messages"),
				intervalMs: 1,
			}),
	);
	try {
		for (const streamer of streamers) streamer.push({ text: "answer", hint: undefined });
		await waitFor(() => port.drafts.length === 2);
		assert.deepEqual(port.drafts.map((draft) => draft.threadId).sort(), [37, 41]);
		assert.equal(port.calls.find((call) => call.method === "sendChatAction")?.threadId, 37);
	} finally {
		await Promise.all(streamers.map((streamer) => streamer.close()));
	}
});
