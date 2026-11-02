import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { type FauxProviderHandle, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { splitForTelegram } from "../../src/format/chunk.ts";
import { stripButtons, THINKING } from "../../src/format/rich.ts";
import { TelegramApiError } from "../../src/telegram/errors.ts";
import { CHAT, newFaux, startTestAgent, type TestAgent, tempDir } from "../helpers/agent.ts";
import { sleep, waitFor } from "../helpers/env.ts";
import { blockUntilAborted, FakeTelegram } from "../helpers/fake-telegram.ts";
import { lastUserText, observe, untilAborted, words } from "../helpers/faux-steps.ts";
import { callbackUpdate, mediaUpdate, stoppedUpdate, textUpdate } from "../helpers/updates.ts";

const RICH = { TELEGRAM_RICH: "auto" };
const QUESTION = `| a | b |\n|---|---|\n| 1 | 2 |\n\nUpdate now?\n\n<tg-button-row><tg-button type="callback_data" data="Да, обновляй">Да</tg-button><tg-button type="callback_data" data="Нет">Нет</tg-button></tg-button-row>`;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(
	faux: FauxProviderHandle,
	port = new FakeTelegram(),
): Promise<{ t: TestAgent; port: FakeTelegram }> {
	const { dir, cleanup } = await tempDir();
	const t = await startTestAgent({ dir, faux, port, config: RICH });
	cleanups.push(cleanup, () => t.close());
	return { t, port };
}

const delivered = (t: TestAgent) =>
	waitFor(() => t.logs.some((line) => line.includes("info delivered")), { what: "delivered" });

test("T-rich-answer: streamed as a native draft, delivered as one rich message that replies to the user", async () => {
	const faux = newFaux({ tokensPerSecond: 150 });
	const answer = `${words(120)}\n\n${QUESTION}`;
	faux.setResponses([fauxAssistantMessage(answer)]);
	const { t, port } = await setup(faux);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 10, "do it"));
	await delivered(t);
	assert.equal(port.drafts[0]?.markdown, THINKING, "a run starts with the thinking draft");
	assert.ok(
		port.drafts.some((draft) => draft.markdown.startsWith("word0")),
		"the answer streamed into the draft",
	);
	assert.ok(port.drafts.every((draft) => !draft.markdown.includes("<tg-button") && draft.draftId > 0));
	assert.deepEqual(
		port.created(CHAT).map((m) => [m.text, m.rich, m.replyTo]),
		[[answer, true, 10]],
	);
	assert.equal(port.count("editMessageText"), 0, "no edited preview");
});

test("T-rich-400: Telegram refuses the rich message, the answer goes out as HTML with buttons as labels", async () => {
	const faux = newFaux();
	faux.setResponses([fauxAssistantMessage(QUESTION)]);
	const port = new FakeTelegram();
	port.use((call) => {
		if (call.options?.rich === true) throw new TelegramApiError("sendRichMessage", 400, "Bad Request: RICH_INVALID");
	});
	const { t } = await setup(faux, port);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 11, "go"));
	await delivered(t);
	const html = splitForTelegram(stripButtons(QUESTION)).map((chunk) => chunk.html);
	assert.deepEqual(
		port.created(CHAT).map((m) => [m.text, m.html, m.replyTo]),
		html.map((text, i) => [text, true, i === 0 ? 11 : undefined]),
	);
	assert.match(html[0] ?? "", /\[Да\] \[Нет\]$/);
	assert.ok(t.logs.some((line) => line.includes("rich_rejected")));
});

test("T-draft-fallback: refused drafts switch the run to an edited preview; the final answer edits it", async () => {
	const faux = newFaux({ tokensPerSecond: 150 });
	const answer = `Done: ${words(200)}`;
	faux.setResponses([fauxAssistantMessage(answer)]);
	const port = new FakeTelegram();
	port.use((call) => {
		if (call.method === "sendDraft")
			throw new TelegramApiError("sendRichMessageDraft", 400, "Bad Request: not private");
	});
	const { t } = await setup(faux, port);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 12, "go"));
	await delivered(t);
	assert.equal(port.count("sendDraft"), 1, "only the first draft was tried");
	assert.ok(port.count("editMessageText") >= 2, "streamed by edits");
	assert.deepEqual(
		port.created(CHAT).map((m) => [m.text, m.rich, m.replyTo]),
		[[answer, true, 12]],
	);
});

test("T-rich-crash: closed while the draft streams, reopened: the run resumes and the answer lands once", async () => {
	const { dir, cleanup } = await tempDir();
	cleanups.push(cleanup);
	const port = new FakeTelegram();
	const slow = newFaux({ tokensPerSecond: 40 });
	slow.setResponses([fauxAssistantMessage(`Partial ${words(600)}`)]);
	const first = await startTestAgent({ dir, faux: slow, port, config: RICH });
	await first.agent.channel.handleUpdate(textUpdate(CHAT, 1, "work"));
	await waitFor(() => port.drafts.some((draft) => draft.markdown.startsWith("Partial")), {
		what: "draft",
		timeoutMs: 15_000,
	});
	await first.close();
	const draftId = port.drafts[0]?.draftId;
	const fast = newFaux();
	fast.setResponses([fauxAssistantMessage("Final answer after restart")]);
	const second = await startTestAgent({ dir, faux: fast, port, config: RICH });
	cleanups.push(() => second.close());
	await delivered(second);
	assert.deepEqual(
		port.created(CHAT).map((m) => [m.text, m.rich, m.replyTo]),
		[["Final answer after restart", true, 1]],
	);
	assert.equal(fast.state.callCount, 1, "the interrupted request was resent once");
	assert.ok(
		port.drafts.every((draft) => draft.draftId === draftId),
		"the resumed run keeps its draft id",
	);
});

test("T-rich-crash-final: closed while the final rich send is in flight; after reopen the answer is sent once", async () => {
	const { dir, cleanup } = await tempDir();
	cleanups.push(cleanup);
	const port = new FakeTelegram();
	const faux = newFaux();
	faux.setResponses([fauxAssistantMessage("The answer")]);
	let blocked = false;
	const unhook = port.use((call, signal) => {
		if (call.method === "sendMessage" && call.options?.rich === true) {
			blocked = true;
			return blockUntilAborted(signal);
		}
	});
	const first = await startTestAgent({ dir, faux, port, config: RICH });
	await first.agent.channel.handleUpdate(textUpdate(CHAT, 3, "go"));
	await waitFor(() => blocked, { what: "final send in flight" });
	await first.close();
	unhook();
	const idle = newFaux();
	const second = await startTestAgent({ dir, faux: idle, port, config: RICH });
	cleanups.push(() => second.close());
	await delivered(second);
	assert.deepEqual(
		port.created(CHAT).map((m) => [m.text, m.rich, m.replyTo]),
		[["The answer", true, 3]],
	);
	assert.equal(idle.state.callCount, 0, "the model is not called again");
});

test("T-tap: a tap is answered, admitted once as the user's reply with its context, and marks the choice", async () => {
	const faux = newFaux();
	const seen: string[] = [];
	faux.setResponses([
		fauxAssistantMessage(QUESTION),
		observe((messages) => void seen.push(lastUserText(messages)), fauxAssistantMessage("Updating.")),
	]);
	const { t, port } = await setup(faux);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 20, "update?"));
	const question = await waitFor(() => port.created(CHAT)[0], { what: "question" });
	const tap = callbackUpdate(CHAT, question.id, "Да, обновляй", { queryId: "cq-1" });
	await t.agent.channel.handleUpdate(tap);
	await waitFor(() => port.textsIn(CHAT).includes("Updating."), { what: "answer to the tap" });
	assert.deepEqual(port.answeredQueries, ["cq-1"]);
	assert.equal(
		seen[0],
		"Да, обновляй\n\n(button under your message: «| a | b | |---|---| | 1 | 2 | Update now? [Да] [Нет]»)",
	);
	assert.equal(port.created(CHAT).find((m) => m.text === "Updating.")?.replyTo, question.id);
	await waitFor(() => port.messages.get(question.id)?.text.includes("✅ Да"), { what: "choice marked" });
	assert.match(port.messages.get(question.id)?.text ?? "", /<tg-button type="disabled">Нет<\/tg-button>/);
	await t.agent.channel.handleUpdate(tap);
	await waitFor(() => t.logs.filter((line) => line.includes("update_duplicate")).length === 1, { what: "duplicate" });
	assert.equal(faux.state.callCount, 2, "the redelivered tap reached the model once");
});

test("T-tap-rows: two taps in one message mark their own rows; the first choice survives the second", async () => {
	const twoRows = `${QUESTION}\n\nWhen?\n\n<tg-button-row><tg-button type="callback_data" data="Утром">Утром</tg-button><tg-button type="callback_data" data="Вечером">Вечером</tg-button></tg-button-row>`;
	const faux = newFaux();
	faux.setResponses([fauxAssistantMessage(twoRows), fauxAssistantMessage("Later."), fauxAssistantMessage("Updating.")]);
	const { t, port } = await setup(faux);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 20, "update?"));
	const question = await waitFor(() => port.created(CHAT)[0], { what: "question" });
	const text = () => port.messages.get(question.id)?.text ?? "";
	await t.agent.channel.handleUpdate(callbackUpdate(CHAT, question.id, "Вечером"));
	await waitFor(() => text().includes("✅ Вечером"), { what: "second row marked" });
	assert.match(text(), /type="callback_data" data="Да, обновляй"/, "the first question is still answerable");
	await t.agent.channel.handleUpdate(callbackUpdate(CHAT, question.id, "Да, обновляй"));
	await waitFor(() => text().includes("✅ Да"), { what: "first row marked" });
	assert.match(text(), /✅ Вечером/, "the second row keeps its choice");
	assert.doesNotMatch(text(), /callback_data/);
	await waitFor(() => port.textsIn(CHAT).includes("Updating."), { what: "both taps answered" });
	assert.equal(faux.state.callCount, 3);
});

test("T-tap-stranger: taps from strangers or another sender are ignored silently and never reach the model", async () => {
	const faux = newFaux();
	const { t, port } = await setup(faux);
	await t.agent.channel.handleUpdate(callbackUpdate(222, 5, "Да"));
	await t.agent.channel.handleUpdate(callbackUpdate(CHAT, 5, "Да", { fromId: 333 }));
	assert.equal(port.calls.filter((call) => call.method !== "setMyCommands").length, 0, "no Telegram call at all");
	assert.equal(faux.state.callCount, 0);
	assert.equal(t.logs.filter((line) => line.includes("update_ignored")).length, 2);
});

test("T-tap-old: a button of a message the bridge no longer knows still becomes a message, unmarked", async () => {
	const faux = newFaux();
	const seen: string[] = [];
	faux.setResponses([observe((messages) => void seen.push(lastUserText(messages)), fauxAssistantMessage("ok"))]);
	const { t, port } = await setup(faux);
	await t.agent.channel.handleUpdate(callbackUpdate(CHAT, 77, "Нет", { text: "Old question?" }));
	await waitFor(() => port.textsIn(CHAT).includes("ok"), { what: "answer" });
	assert.equal(seen[0], "Нет\n\n(button under your message: «Old question?»)");
	assert.equal(port.count("editMessageText"), 0);
});

for (const quote of [false, true]) {
	test(`T-reply-snapshot: ${quote ? "a selected quote takes priority" : "the saved bot text takes priority over Telegram text"}`, async () => {
		const faux = newFaux();
		let seen = "";
		faux.setResponses([
			fauxAssistantMessage(QUESTION),
			observe((messages) => {
				seen = lastUserText(messages);
			}, fauxAssistantMessage("Reply received.")),
		]);
		const { t, port } = await setup(faux);
		await t.agent.channel.handleUpdate(textUpdate(CHAT, 40, "question?"));
		await delivered(t);
		const question = port.created(CHAT)[0];
		assert.ok(question);
		await t.agent.channel.handleUpdate(
			mediaUpdate(CHAT, 41, {
				text: "yes",
				reply_to_message: {
					...textUpdate(CHAT, question.id, "Telegram shortened text", { isBot: true }).message,
				},
				...(quote ? { quote: { text: "Update\nnow?", position: 0 } } : {}),
			}),
		);
		await waitFor(() => port.textsIn(CHAT).includes("Reply received."));
		assert.equal(
			seen,
			quote
				? "yes\n\n(reply quoting: «Update now?»)"
				: "yes\n\n(reply to your message: «| a | b | |---|---| | 1 | 2 | Update now? [Да] [Нет]»)",
		);
	});
}

const oldBotMessage = textUpdate(CHAT, 77, "Old\nquestion?", { isBot: true }).message;
for (const scenario of [
	{
		name: "bot text without a saved snapshot",
		fields: { text: "yes", reply_to_message: oldBotMessage },
		expected: "yes\n\n(reply to your message: «Old question?»)",
	},
	{
		name: "a media caption",
		fields: {
			text: "yes",
			reply_to_message: {
				...mediaUpdate(CHAT, 78, { photo: [], caption: "Photo\ncaption" }).message,
				from: { id: 999, is_bot: true, first_name: "Bot" },
			},
		},
		expected: "yes\n\n(reply to your message: «Photo caption»)",
	},
	{
		name: "the user's own message",
		fields: { text: "yes", reply_to_message: textUpdate(CHAT, 78, "My idea").message },
		expected: "yes\n\n(reply to message from U: «My idea»)",
	},
	{
		name: "another sender's message",
		fields: {
			text: "yes",
			reply_to_message: {
				...textUpdate(CHAT, 78, "An idea").message,
				from: { id: 123, is_bot: false, first_name: "Ada", last_name: "Lovelace" },
			},
		},
		expected: "yes\n\n(reply to message from Ada Lovelace: «An idea»)",
	},
	{ name: "plain text without a reply", fields: { text: "yes" }, expected: "yes" },
	{
		name: "a long reply context",
		fields: { text: "yes", reply_to_message: { ...oldBotMessage, text: "x".repeat(2000) } },
		expected: `yes\n\n(reply to your message: «${"x".repeat(1499)}…»)`,
	},
	{
		name: "an incoming file with a caption",
		fields: {
			document: { file_id: "file", file_unique_id: "f", file_name: "note.txt", file_size: 1 },
			caption: "attached",
			reply_to_message: oldBotMessage,
		},
		expected: /\[attachment\] document saved to .*\nCaption: attached\n\n\(reply to your message: «Old question\?»\)$/,
	},
	{
		name: "an incoming voice saved without a transcript",
		fields: {
			voice: { file_id: "file", file_unique_id: "v", duration: 1, file_size: 1 },
			reply_to_message: oldBotMessage,
		},
		expected: /\[attachment\] voice saved to .*\nNo transcript: .*\n\n\(reply to your message: «Old question\?»\)$/,
	},
	{
		name: "a location with a selected quote",
		fields: {
			location: { latitude: 41.3, longitude: 69.2 },
			reply_to_message: oldBotMessage,
			quote: { text: "question?", position: 4 },
		},
		expected: '[telegram location] {"location":{"latitude":41.3,"longitude":69.2}}\n\n(reply quoting: «question?»)',
	},
]) {
	test(`T-reply: ${scenario.name}`, async () => {
		const faux = newFaux();
		let seen = "";
		faux.setResponses([
			observe((messages) => {
				seen = lastUserText(messages);
			}, fauxAssistantMessage("Reply received.")),
		]);
		const { t, port } = await setup(faux);
		port.files.set("file", new Uint8Array([1]));
		await t.agent.channel.handleUpdate(mediaUpdate(CHAT, 42, scenario.fields));
		await waitFor(() => port.textsIn(CHAT).includes("Reply received."));
		if (scenario.expected instanceof RegExp) assert.match(seen, scenario.expected);
		else assert.equal(seen, scenario.expected);
	});
}

test("INF-18: an idle draft stop is silent and logged, including before the first run", async () => {
	const { t, port } = await setup(newFaux());
	await t.agent.channel.handleUpdate(stoppedUpdate(CHAT, 123));
	assert.deepEqual(port.textsIn(CHAT), []);
	assert.ok(t.logs.some((line) => line.includes("draft_stop_idle_ignored")));
	assert.equal((await t.agent.harness.inspect(BG)).tasks.length, 0);
});

test("T-draft-stop: the draft's stop button stops the run like /stop; a redelivered or foreign stop does nothing", async () => {
	const faux = newFaux();
	faux.setResponses([untilAborted]);
	const { t, port } = await setup(faux);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 30, "long job"));
	const draft = await waitFor(() => port.drafts[0], { what: "thinking draft" });
	await t.agent.channel.handleUpdate(stoppedUpdate(222, draft.draftId));
	const stop = stoppedUpdate(CHAT, draft.draftId);
	await t.agent.channel.handleUpdate(stop);
	await waitFor(() => port.textsIn(CHAT).includes("Stopped."), { what: "stopped" });
	await delivered(t);
	await t.agent.channel.handleUpdate(stop);
	await sleep(300);
	assert.deepEqual(port.textsIn(CHAT), ["Stopped."], "no answer, one confirmation, nothing for the stranger");
	assert.ok(t.logs.some((line) => line.includes("update_ignored") && line.includes("chat=222")));
});
