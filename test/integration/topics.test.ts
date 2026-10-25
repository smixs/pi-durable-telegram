import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { type FauxProviderHandle, fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { LiveDoc } from "@earendil-works/pi-durable";
import { ChatInfo, ChatMap } from "../../src/channel/docs.ts";
import { TelegramApiError } from "../../src/telegram/errors.ts";
import { CHAT, newFaux, startTestAgent, type TestAgent, tempDir } from "../helpers/agent.ts";
import { sleep, waitFor } from "../helpers/env.ts";
import { FakeTelegram } from "../helpers/fake-telegram.ts";
import { observe, textOf, toolCall, untilAborted } from "../helpers/faux-steps.ts";
import { pngBytes } from "../helpers/images.ts";
import { callbackUpdate, mediaUpdate, stoppedUpdate, textUpdate, topicUpdate } from "../helpers/updates.ts";

const A = 10;
const B = 20;
const RICH = { TELEGRAM_RICH: "auto" };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(faux: FauxProviderHandle, config: Record<string, string> = {}) {
	const { dir, cleanup } = await tempDir();
	const port = new FakeTelegram();
	const t = await startTestAgent({ dir, faux, port, config });
	cleanups.push(cleanup, () => t.close());
	return { t, port, dir };
}

async function conversation(t: TestAgent, threadId?: number) {
	const key = threadId === undefined ? String(CHAT) : `${CHAT}:${threadId}`;
	const id = await waitFor(async () => (await t.agent.harness.snapshot(ChatMap, BG))?.chats[key]);
	const found = await t.agent.harness.conversation(id as never, BG);
	assert.ok(found !== undefined);
	return found;
}

function userTexts(messages: readonly Message[]): string[] {
	return messages.filter((message) => message.role === "user").map((message) => textOf(message as never));
}

function textsIn(port: FakeTelegram, threadId?: number): string[] {
	return port
		.created(CHAT)
		.filter((message) => message.threadId === threadId)
		.map((message) => message.text);
}

test("topics: one private chat has independent histories, including identical message ids and duplicate updates", async () => {
	const faux = newFaux();
	const seen: string[][] = [];
	const answer = (text: string) =>
		observe((messages) => void seen.push(userTexts(messages)), fauxAssistantMessage(text));
	faux.setResponses([answer("A remembered"), answer("B remembered"), answer("A recalled"), answer("B recalled")]);
	const { t, port } = await setup(faux);
	const first = textUpdate(CHAT, 1, "remember alpha", { threadId: A });
	await t.agent.channel.handleUpdate(first);
	await waitFor(() => textsIn(port, A).includes("A remembered"));
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "remember beta", { threadId: B }));
	await waitFor(() => textsIn(port, B).includes("B remembered"));
	await t.agent.channel.handleUpdate(first);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 2, "recall alpha", { threadId: A }));
	await waitFor(() => textsIn(port, A).includes("A recalled"));
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 2, "recall beta", { threadId: B }));
	await waitFor(() => textsIn(port, B).includes("B recalled"));
	assert.deepEqual(seen, [
		["remember alpha"],
		["remember beta"],
		["remember alpha", "recall alpha"],
		["remember beta", "recall beta"],
	]);
	assert.notEqual((await conversation(t, A)).id, (await conversation(t, B)).id);
	assert.equal(faux.state.callCount, 4, "a redelivery stays within its original topic");
	assert.deepEqual(textsIn(port), [], "topic answers never spill into General");
});

test("topics: a model run blocked in one topic does not delay another topic", async () => {
	const faux = newFaux();
	faux.setResponses([untilAborted, fauxAssistantMessage("B finished")]);
	const { t, port } = await setup(faux);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "long A job", { threadId: A }));
	await waitFor(() => faux.state.callCount === 1);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 2, "quick B job", { threadId: B }));
	await waitFor(() => textsIn(port, B).includes("B finished"));
	const a = await conversation(t, A);
	assert.ok((await t.agent.harness.snapshot(LiveDoc, a.id, BG))?.run, "A is still running when B finishes");
	assert.deepEqual(textsIn(port, A), []);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 3, "/stop", { threadId: A }));
	await waitFor(() => textsIn(port, A).includes("Stopped."));
	assert.ok(port.calls.some((call) => call.method === "sendChatAction" && call.threadId === B));
});

test("topics: /new clears only the current topic and command replies stay there", async () => {
	const faux = newFaux();
	const seen: string[][] = [];
	faux.setResponses([
		fauxAssistantMessage("A remembered"),
		fauxAssistantMessage("B remembered"),
		observe((messages) => void seen.push(userTexts(messages)), fauxAssistantMessage("fresh A")),
		observe((messages) => void seen.push(userTexts(messages)), fauxAssistantMessage("same B")),
	]);
	const { t, port } = await setup(faux);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "remember alpha", { threadId: A }));
	await waitFor(() => textsIn(port, A).includes("A remembered"));
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 2, "remember beta", { threadId: B }));
	await waitFor(() => textsIn(port, B).includes("B remembered"));
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 3, "/new", { threadId: A }));
	await waitFor(() => textsIn(port, A).includes("New context. Old history is kept."));
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 4, "new alpha", { threadId: A }));
	await waitFor(() => textsIn(port, A).includes("fresh A"));
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 5, "recall beta", { threadId: B }));
	await waitFor(() => textsIn(port, B).includes("same B"));
	assert.deepEqual(seen, [["new alpha"], ["remember beta", "recall beta"]]);
	assert.deepEqual(textsIn(port, B), ["B remembered", "same B"]);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 6, "/status", { threadId: B }));
	await waitFor(() => textsIn(port, B).some((text) => text.includes("State: idle, queued: 0")));
	assert.deepEqual(textsIn(port), []);
});

test("topics: General keeps its old conversation and every topic keeps its history after restart", async () => {
	const { dir, cleanup } = await tempDir();
	cleanups.push(cleanup);
	const port = new FakeTelegram();
	const faux = newFaux();
	faux.setResponses([fauxAssistantMessage("general saved"), fauxAssistantMessage("topic saved")]);
	const first = await startTestAgent({ dir, faux, port });
	let savedMap: Record<string, number> | undefined;
	try {
		await first.agent.channel.handleUpdate(textUpdate(CHAT, 1, "General history"));
		await waitFor(() => textsIn(port).includes("general saved"));
		await first.agent.channel.handleUpdate(textUpdate(CHAT, 2, "A history", { threadId: A }));
		await waitFor(() => textsIn(port, A).includes("topic saved"));
		savedMap = (await first.agent.harness.snapshot(ChatMap, BG))?.chats;
		assert.equal(Object.keys(savedMap ?? {}).length, 2);
	} finally {
		await first.close();
	}
	const resumed = newFaux();
	const seen: string[][] = [];
	resumed.setResponses([
		observe((messages) => void seen.push(userTexts(messages)), fauxAssistantMessage("general resumed")),
		observe((messages) => void seen.push(userTexts(messages)), fauxAssistantMessage("topic resumed")),
	]);
	const second = await startTestAgent({ dir, faux: resumed, port });
	cleanups.push(() => second.close());
	await second.agent.channel.handleUpdate(textUpdate(CHAT, 3, "continue General"));
	await waitFor(() => textsIn(port).includes("general resumed"));
	await second.agent.channel.handleUpdate(textUpdate(CHAT, 4, "continue A", { threadId: A }));
	await waitFor(() => textsIn(port, A).includes("topic resumed"));
	assert.deepEqual(seen, [
		["General history", "continue General"],
		["A history", "continue A"],
	]);
	assert.deepEqual((await second.agent.harness.snapshot(ChatMap, BG))?.chats, savedMap);
	const a = await conversation(second, A);
	assert.deepEqual(await second.agent.harness.snapshot(ChatInfo, a.id, BG), { chatId: CHAT, threadId: A });
});

test("topics: a generation interrupted by restart resumes into its original topic and draft", async () => {
	const { dir, cleanup } = await tempDir();
	cleanups.push(cleanup);
	const port = new FakeTelegram();
	const slow = newFaux();
	slow.setResponses([untilAborted]);
	const first = await startTestAgent({ dir, faux: slow, port, config: RICH });
	let draftId = 0;
	try {
		await first.agent.channel.handleUpdate(textUpdate(CHAT, 1, "long topic job", { threadId: A }));
		draftId = (await waitFor(() => port.drafts.find((draft) => draft.threadId === A))).draftId;
		await waitFor(() => slow.state.callCount === 1);
	} finally {
		await first.close();
	}
	const fast = newFaux();
	fast.setResponses([fauxAssistantMessage("A resumed")]);
	const second = await startTestAgent({ dir, faux: fast, port, config: RICH });
	cleanups.push(() => second.close());
	await waitFor(() => textsIn(port, A).includes("A resumed"));
	assert.deepEqual(textsIn(port), []);
	assert.ok(port.drafts.every((draft) => draft.threadId === A && draft.draftId === draftId));
	assert.equal(port.created(CHAT)[0]?.replyTo, 1);
	assert.equal(fast.state.callCount, 1);
});

test("topics: draft stop resolves its owning topic; a stale draft cannot stop a later run or another topic", async () => {
	const faux = newFaux();
	faux.setResponses([untilAborted, untilAborted, untilAborted]);
	const { t, port } = await setup(faux, RICH);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "long A job", { threadId: A }));
	await waitFor(() => faux.state.callCount === 1);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 2, "long B job", { threadId: B }));
	await waitFor(() => faux.state.callCount === 2);
	const draftA = await waitFor(() => port.drafts.find((draft) => draft.threadId === A));
	const draftB = await waitFor(() => port.drafts.find((draft) => draft.threadId === B));
	assert.notEqual(draftA.draftId, draftB.draftId);
	const stop = stoppedUpdate(CHAT, draftA.draftId);
	await t.agent.channel.handleUpdate(stop);
	await waitFor(() => textsIn(port, A).includes("Stopped."));
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 3, "another A job", { threadId: A }));
	await waitFor(() => faux.state.callCount === 3);
	await t.agent.channel.handleUpdate(stop);
	await t.agent.channel.handleUpdate(stoppedUpdate(CHAT, draftA.draftId));
	await t.agent.channel.handleUpdate(stoppedUpdate(CHAT, 999_999));
	await sleep(150);
	const a = await conversation(t, A);
	const b = await conversation(t, B);
	assert.ok((await t.agent.harness.snapshot(LiveDoc, a.id, BG))?.run, "the later A job is still running");
	assert.ok((await t.agent.harness.snapshot(LiveDoc, b.id, BG))?.run, "B was not stopped");
	assert.deepEqual(textsIn(port, A), ["Stopped."]);
	assert.deepEqual(textsIn(port, B), []);
	assert.deepEqual(textsIn(port), []);
});

test("topics: callbacks stay in the topic of the bot message and use that topic's button snapshot", async () => {
	const faux = newFaux();
	let seen: string[] = [];
	const question =
		'A question?\n\n<tg-button-row><tg-button type="callback_data" data="yes">Yes</tg-button></tg-button-row>';
	faux.setResponses([
		fauxAssistantMessage(question),
		fauxAssistantMessage("B answer"),
		observe((messages) => {
			seen = userTexts(messages);
		}, fauxAssistantMessage("A accepted")),
	]);
	const { t, port } = await setup(faux, RICH);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "A request", { threadId: A }));
	const sent = await waitFor(() => port.created(CHAT).find((message) => message.threadId === A));
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 2, "B request", { threadId: B }));
	await waitFor(() => textsIn(port, B).includes("B answer"));
	await t.agent.channel.handleUpdate(callbackUpdate(CHAT, sent.id, "yes", { threadId: A, text: "shortened" }));
	await waitFor(() => textsIn(port, A).includes("A accepted"));
	assert.deepEqual(seen, ["A request", "yes\n\n(button under your message: «A question? [Yes]»)"]);
	await waitFor(() => port.messages.get(sent.id)?.text.includes("✅ Yes"));
	assert.deepEqual(textsIn(port, B), ["B answer"]);
	assert.equal(port.created(CHAT).find((message) => message.text === "A accepted")?.replyTo, sent.id);
});

test("topics: an inaccessible callback is acknowledged without injecting its data into General", async () => {
	const faux = newFaux();
	faux.setResponses([fauxAssistantMessage("A answer"), fauxAssistantMessage("B answer")]);
	const { t, port } = await setup(faux, RICH);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "A request", { threadId: A }));
	await waitFor(() => textsIn(port, A).includes("A answer"));
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 2, "B request", { threadId: B }));
	await waitFor(() => textsIn(port, B).includes("B answer"));
	const a = await conversation(t, A);
	const b = await conversation(t, B);
	const beforeMap = await t.agent.harness.snapshot(ChatMap, BG);
	const beforeA = await a.context(BG);
	const beforeB = await b.context(BG);
	const update = callbackUpdate(CHAT, 1000, "unroutable reply", { queryId: "inaccessible-topic" });
	assert.ok(update.callback_query !== undefined);
	update.callback_query.message = {
		message_id: 1000,
		date: 0,
		chat: { id: CHAT, type: "private", first_name: "U" },
	};
	await t.agent.channel.handleUpdate(update);
	assert.deepEqual(port.answeredQueries, ["inaccessible-topic"]);
	assert.deepEqual(await t.agent.harness.snapshot(ChatMap, BG), beforeMap, "General is not created");
	assert.deepEqual(await a.context(BG), beforeA);
	assert.deepEqual(await b.context(BG), beforeB);
	assert.equal(faux.state.callCount, 2);
	assert.deepEqual(textsIn(port), []);
});

test("topics: photo and document tools send their output into the initiating topic", async () => {
	const faux = newFaux();
	faux.setResponses([
		toolCall("telegram_send_file", { path: "pic.png", caption: "A picture" }),
		toolCall("telegram_send_file", { path: "report.txt" }),
		fauxAssistantMessage("A files sent"),
	]);
	const { t, port, dir } = await setup(faux);
	await writeFile(join(dir, "work", "pic.png"), pngBytes(16, 16));
	await writeFile(join(dir, "work", "report.txt"), "report");
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "send files", { threadId: A }));
	await waitFor(() => textsIn(port, A).includes("A files sent"));
	assert.deepEqual(
		port
			.created(CHAT)
			.map((message) => [message.kind, message.threadId])
			.sort(),
		[
			["document", A],
			["photo", A],
			["text", A],
		],
	);
	assert.ok(
		port.calls.some((call) => call.method === "sendChatAction" && call.text === "upload_photo" && call.threadId === A),
	);
	assert.ok(
		port.calls.some(
			(call) => call.method === "sendChatAction" && call.text === "upload_document" && call.threadId === A,
		),
	);
});

test("topics: a photo rejected by Telegram falls back to a document in the same topic", async () => {
	const faux = newFaux();
	faux.setResponses([
		toolCall("telegram_send_file", { path: "pic.png", caption: "A picture" }),
		fauxAssistantMessage("A file sent"),
	]);
	const { t, port, dir } = await setup(faux);
	port.use((call) => {
		if (call.method === "sendPhoto")
			throw new TelegramApiError("sendPhoto", 400, "Bad Request: PHOTO_INVALID_DIMENSIONS");
	});
	await writeFile(join(dir, "work", "pic.png"), pngBytes(16, 16));
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "send picture", { threadId: A }));
	await waitFor(() => textsIn(port, A).includes("A file sent"));
	assert.deepEqual(
		port.calls
			.filter((call) => call.method === "sendPhoto" || call.method === "sendDocument")
			.map((call) => [call.method, call.threadId]),
		[
			["sendPhoto", A],
			["sendDocument", A],
		],
	);
	assert.equal(port.created(CHAT).find((message) => message.kind === "document")?.threadId, A);
});

test("topics: lifecycle service messages are ignored without creating a context or calling the model", async () => {
	const { t, port } = await setup(newFaux());
	await t.agent.channel.handleUpdate(
		topicUpdate(
			mediaUpdate(CHAT, 1, {
				forum_topic_created: { name: "A task", icon_color: 7322096 },
			}),
			A,
		),
	);
	await t.agent.channel.handleUpdate(topicUpdate(mediaUpdate(CHAT, 2, { forum_topic_edited: { name: "Renamed" } }), A));
	await t.agent.channel.handleUpdate(topicUpdate(mediaUpdate(CHAT, 3, { forum_topic_closed: {} }), A));
	await t.agent.channel.handleUpdate(topicUpdate(mediaUpdate(CHAT, 4, { forum_topic_reopened: {} }), A));
	assert.deepEqual((await t.agent.harness.snapshot(ChatMap, BG))?.chats ?? {}, {});
	assert.equal(port.calls.filter((call) => call.method !== "setMyCommands").length, 0);
});
