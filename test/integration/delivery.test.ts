import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { type FauxProviderHandle, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { InboxDoc, LiveDoc } from "@earendil-works/pi-durable";
import { ChatMap, Delivered } from "../../src/channel/docs.ts";
import { splitForTelegram } from "../../src/format/chunk.ts";
import { markdownToTelegramHtml } from "../../src/format/markdown-html.ts";
import { TelegramApiError, TelegramUnavailable, TelegramUnknown } from "../../src/telegram/errors.ts";
import { CHAT, newFaux, startTestAgent, type TestAgent, tempDir } from "../helpers/agent.ts";
import { waitFor } from "../helpers/env.ts";
import { FakeTelegram } from "../helpers/fake-telegram.ts";
import { gate, gated, lastToolResult, lastUserText, textOf, toolCall, words } from "../helpers/faux-steps.ts";
import { textUpdate } from "../helpers/updates.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(
	faux: FauxProviderHandle,
	port = new FakeTelegram(),
	deps: { editRetryDelaysMs?: readonly number[] } = {},
): Promise<{ t: TestAgent; port: FakeTelegram }> {
	const { dir, cleanup } = await tempDir();
	const t = await startTestAgent({ dir, faux, port, deps });
	cleanups.push(cleanup, () => t.close());
	return { t, port };
}

async function conversationId(t: TestAgent): Promise<number> {
	return waitFor(async () => (await t.agent.harness.snapshot(ChatMap, BG))?.chats[String(CHAT)]);
}

test("T-answer: streamed into one preview message, typing shown, final edit with HTML", async () => {
	const faux = newFaux({ tokensPerSecond: 150 });
	const answer = `**Result**: ${words(250)}`;
	faux.setResponses([fauxAssistantMessage(answer)]);
	const { t, port } = await setup(faux);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 10, "do it"));
	const final = splitForTelegram(answer)[0]?.html;
	await waitFor(() => port.textsIn(CHAT).includes(final ?? "?"), { timeoutMs: 20_000, what: "final answer" });
	const messages = port.created(CHAT);
	assert.equal(messages.length, 1, "one message: the preview became the answer");
	assert.equal(messages[0]?.replyTo, 10);
	assert.ok(port.count("editMessageText") >= 2, "streamed by edits");
	assert.ok(port.count("sendChatAction") >= 1, "typing shown");
	assert.equal(faux.state.callCount, 1);
});

test("T-long-answer: split into several valid messages; the first replies to the user", async () => {
	const faux = newFaux();
	const answer = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} & <tag> ${"x".repeat(150)} 😀`).join("\n\n");
	faux.setResponses([fauxAssistantMessage(answer)]);
	const { t, port } = await setup(faux);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 11, "long"));
	const chunks = splitForTelegram(answer);
	assert.ok(chunks.length >= 3);
	await waitFor(() => t.logs.some((line) => line.includes("info delivered")), { what: "delivered" });
	const texts = port.textsIn(CHAT);
	assert.equal(texts.at(-1), chunks.at(-1)?.html);
	for (const chunk of chunks) assert.ok(texts.includes(chunk.html));
	assert.equal(port.created(CHAT).filter((m) => m.replyTo === 11).length, 1);
});

test("T-429-final: a rate-limited final send waits and is delivered once", async () => {
	const faux = newFaux();
	faux.setResponses([fauxAssistantMessage("final words")]);
	const port = new FakeTelegram();
	let limited = false;
	port.use((call) => {
		if (call.method === "sendMessage" && call.options?.fast !== true && !limited) {
			limited = true;
			throw new TelegramApiError("sendMessage", 429, "Too Many Requests: retry after 1", 1);
		}
	});
	const { t } = await setup(faux, port);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 12, "go"));
	await waitFor(() => port.textsIn(CHAT).includes("final words"), { what: "final", timeoutMs: 5000 });
	assert.equal(port.textsIn(CHAT).filter((text) => text === "final words").length, 1);
	assert.ok(limited);
});

test("T-5xx-send-unknown: an unknown send outcome is logged, never resent; later chunks continue", async () => {
	const faux = newFaux();
	const answer = Array.from({ length: 40 }, (_, i) => `Line ${i} ${"y".repeat(200)}`).join("\n\n");
	faux.setResponses([fauxAssistantMessage(answer)]);
	const chunks = splitForTelegram(answer);
	const port = new FakeTelegram();
	port.use((call) => {
		if (call.method === "sendMessage" && call.text === chunks[0]?.html)
			throw new TelegramUnknown("sendMessage", "HTTP 502");
	});
	const { t } = await setup(faux, port);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 13, "go"));
	await waitFor(() => t.logs.some((line) => line.includes("info delivered")), { what: "delivered" });
	assert.equal(port.calls.filter((c) => c.text === chunks[0]?.html).length, 1, "chunk 0 attempted once");
	assert.ok(port.textsIn(CHAT).includes(chunks[1]?.html ?? "?"));
	assert.ok(t.logs.some((line) => line.includes("delivery_unknown")));
	const delivered = await t.agent.harness.snapshot(Delivered, (await conversationId(t)) as never, BG);
	assert.deepEqual(
		Object.values(delivered?.answers ?? {}).map((a) => a.state),
		["unknown"],
	);
});

test("T-parse-fallback: Telegram rejects the HTML, the plain text is sent instead", async () => {
	const faux = newFaux();
	faux.setResponses([fauxAssistantMessage("**bold** answer")]);
	const port = new FakeTelegram();
	port.use((call) => {
		if (call.method === "sendMessage" && call.options?.html === true)
			throw new TelegramApiError("sendMessage", 400, "Bad Request: can't parse entities");
	});
	const { t } = await setup(faux, port);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 14, "go"));
	await waitFor(() => port.textsIn(CHAT).includes("**bold** answer"), { what: "plain fallback" });
});

test("T-edit-fallback: a deleted preview is replaced by a new message", async () => {
	const faux = newFaux({ tokensPerSecond: 150 });
	const answer = `Done: ${words(200)}`;
	faux.setResponses([fauxAssistantMessage(answer)]);
	const port = new FakeTelegram();
	port.use((call) => {
		if (call.method === "editMessageText" && call.options?.fast !== true && call.messageId !== undefined)
			port.messages.delete(call.messageId);
	});
	const { t } = await setup(faux, port);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 15, "go"));
	const final = splitForTelegram(answer)[0]?.html ?? "?";
	await waitFor(() => port.textsIn(CHAT).includes(final), { what: "final as a new message", timeoutMs: 20_000 });
	assert.equal(port.created(CHAT).length, 1);
	assert.equal(port.created(CHAT)[0]?.replyTo, 15);
});

test("T-empty-answer: an empty final goes back to the model once; a second empty is delivered as a marker", async () => {
	const faux = newFaux();
	faux.setResponses([
		fauxAssistantMessage(""),
		fauxAssistantMessage("Real answer"),
		fauxAssistantMessage(""),
		fauxAssistantMessage(""),
	]);
	const { t, port } = await setup(faux);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 16, "first"));
	await waitFor(() => port.textsIn(CHAT).includes("Real answer"), { what: "nudged answer" });
	assert.equal(faux.state.callCount, 2);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 17, "second"));
	await waitFor(() => port.textsIn(CHAT).includes("(empty answer)"), { what: "empty marker" });
	assert.equal(faux.state.callCount, 4);
});

test("T-unknown-tool: a call to a missing tool returns an error result to the model; the turn continues", async () => {
	const faux = newFaux();
	let seen = "";
	faux.setResponses([
		toolCall("nope", {}),
		(context) => {
			const result = lastToolResult(context.messages);
			seen = `${result?.isError}:${textOf(result)}`;
			return fauxAssistantMessage("recovered");
		},
	]);
	const { t, port } = await setup(faux);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 18, "go"));
	await waitFor(() => port.textsIn(CHAT).includes("recovered"), { what: "recovered" });
	assert.match(seen, /^true:.*not available/is);
});

test("T-unstick + T-model-error-auth: an auth failure is one line; queued messages still run", async () => {
	const faux = newFaux();
	const release = gate();
	faux.setResponses([
		gated(release.promise, () =>
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 Unauthorized: invalid x-api-key" }),
		),
		fauxAssistantMessage("second ok"),
	]);
	const { t, port } = await setup(faux);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 20, "first"));
	const id = (await conversationId(t)) as never;
	await waitFor(async () => (await t.agent.harness.snapshot(LiveDoc, id, BG))?.run, { what: "run started" });
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 21, "second"));
	await waitFor(async () => ((await t.agent.harness.snapshot(InboxDoc, id, BG))?.items.length ?? 0) === 1, {
		what: "queued",
	});
	release.open();
	await waitFor(() => port.textsIn(CHAT).includes("second ok"), { what: "queued message answered", timeoutMs: 15_000 });
	const auth = port.created(CHAT).find((m) => m.replyTo === 20);
	assert.match(auth?.text ?? "", /Model auth failed: run `pi-durable-telegram login faux`/);
	assert.equal(port.created(CHAT).find((m) => m.text === "second ok")?.replyTo, 21);
});

test("T-busy-queue: a message during a run is queued and answered after it, in order", async () => {
	const faux = newFaux();
	const release = gate();
	faux.setResponses([
		gated(release.promise, () => fauxAssistantMessage("answer one")),
		fauxAssistantMessage("answer two"),
	]);
	const { t, port } = await setup(faux);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 30, "one"));
	const id = (await conversationId(t)) as never;
	await waitFor(async () => (await t.agent.harness.snapshot(LiveDoc, id, BG))?.run, { what: "run started" });
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 31, "two"));
	await waitFor(async () => ((await t.agent.harness.snapshot(InboxDoc, id, BG))?.items.length ?? 0) === 1, {
		what: "queued",
	});
	assert.equal(port.created(CHAT).length, 0, "nothing sent for the queued message");
	release.open();
	await waitFor(() => port.textsIn(CHAT).includes("answer two"), { what: "both answered" });
	const created = port.created(CHAT);
	assert.deepEqual(
		created.map((m) => [m.text, m.replyTo]),
		[
			["answer one", 30],
			["answer two", 31],
		],
	);
	assert.equal(markdownToTelegramHtml("answer one"), "answer one");
});

test("INF-18: a busy message steers the current run at its next tool boundary", async () => {
	const faux = newFaux();
	const release = gate();
	let seen = "";
	faux.setResponses([
		async () => {
			await release.promise;
			return toolCall("bash", { command: "echo ready" });
		},
		(context) => {
			seen = lastUserText(context.messages);
			return fauxAssistantMessage("corrected answer");
		},
	]);
	const { t, port } = await setup(faux);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 40, "start"));
	await waitFor(() => faux.state.callCount === 1);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 41, "use the corrected plan"));
	const id = (await conversationId(t)) as never;
	await waitFor(async () => ((await t.agent.harness.snapshot(InboxDoc, id, BG))?.items.length ?? 0) === 1);
	release.open();
	await waitFor(() => port.textsIn(CHAT).includes("corrected answer"));
	assert.equal(seen, "use the corrected plan");
	assert.equal(faux.state.callCount, 2, "the correction joins the existing tool round");
	assert.deepEqual(port.textsIn(CHAT), ["corrected answer"], "the shared answer is delivered once");
});

test("T-edit-unavailable: a final preview edit that hits a Telegram outage is retried, the answer arrives", async () => {
	const faux = newFaux({ tokensPerSecond: 150 });
	const answer = `Answer ${words(200)} THE END`;
	faux.setResponses([fauxAssistantMessage(answer)]);
	const port = new FakeTelegram();
	let failures = 0;
	port.use((call) => {
		if (call.method === "editMessageText" && call.options?.fast !== true && failures < 2) {
			failures++;
			throw new TelegramUnavailable("editMessageText", "network error");
		}
	});
	const { t } = await setup(faux, port, { editRetryDelaysMs: [100, 100, 100] });
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 19, "go"));
	const final = splitForTelegram(answer)[0]?.html ?? "?";
	await waitFor(() => t.logs.some((line) => line.includes("info delivered")), { what: "delivered", timeoutMs: 20_000 });
	assert.equal(failures, 2);
	assert.ok(port.textsIn(CHAT).includes(final), "final answer reached the chat");
	assert.equal(port.created(CHAT).length, 1, "the preview became the answer, nothing sent twice");
	const delivered = await t.agent.harness.snapshot(Delivered, (await conversationId(t)) as never, BG);
	assert.deepEqual(
		Object.values(delivered?.answers ?? {}).map((a) => a.state),
		["sent"],
	);
});

test("T-edit-unavailable-gives-up: a preview that never becomes editable is replaced by a new message", async () => {
	const faux = newFaux({ tokensPerSecond: 150 });
	const answer = `Answer ${words(200)} THE END`;
	faux.setResponses([fauxAssistantMessage(answer)]);
	const port = new FakeTelegram();
	port.use((call) => {
		if (call.method === "editMessageText" && call.options?.fast !== true)
			throw new TelegramApiError("editMessageText", 502, "Bad Gateway");
	});
	const { t } = await setup(faux, port, { editRetryDelaysMs: [10, 10] });
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 22, "go"));
	const final = splitForTelegram(answer)[0]?.html ?? "?";
	await waitFor(() => port.textsIn(CHAT).includes(final), { what: "final as a new message", timeoutMs: 20_000 });
	assert.equal(port.created(CHAT).filter((m) => m.text === final).length, 1);
	assert.equal(port.created(CHAT).find((m) => m.text === final)?.replyTo, 22);
});
