import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { type FauxProviderHandle, fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { ChatMap, chatKey, TopicNames } from "../../src/channel/docs.ts";
import { TelegramUnknown } from "../../src/telegram/errors.ts";
import { CHAT, newFaux, startTestAgent, type TestAgent, tempDir } from "../helpers/agent.ts";
import { waitFor } from "../helpers/env.ts";
import { FakeTelegram } from "../helpers/fake-telegram.ts";
import { gate, lastToolResult, observe, textOf, toolCall } from "../helpers/faux-steps.ts";
import { mediaUpdate, textUpdate, topicUpdate } from "../helpers/updates.ts";

const A = 41;
const B = 42;
const AUTO_NUDGE = /automatic:\s*true/;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(faux: FauxProviderHandle, config: Record<string, string> = {}) {
	const { dir, cleanup } = await tempDir();
	const port = new FakeTelegram();
	const t = await startTestAgent({ dir, faux, port, config });
	cleanups.push(cleanup, () => t.close());
	return { t, port };
}

function topicInstructions(messages: readonly Message[]): string {
	let shown = "";
	for (const message of messages) {
		if (message.role !== "system" || message.sections?.telegram_topic === undefined) continue;
		shown = message.sections.telegram_topic ?? "";
	}
	return shown;
}

async function created(t: TestAgent, threadId: number, name: string, implicit = false) {
	await t.agent.channel.handleUpdate(
		topicUpdate(
			mediaUpdate(CHAT, threadId, {
				forum_topic_created: { name, icon_color: 7322096, ...(implicit ? { is_name_implicit: true } : {}) },
			}),
			threadId,
		),
	);
}

async function edited(t: TestAgent, threadId: number, name: string) {
	await t.agent.channel.handleUpdate(
		topicUpdate(
			mediaUpdate(CHAT, threadId + 100, {
				forum_topic_edited: { name },
			}),
			threadId,
		),
	);
}

function answered(port: FakeTelegram, text: string) {
	return waitFor(() => port.textsIn(CHAT).includes(text), { what: text });
}

test("topic names: an implicit title is named from the model once, and duplicate creation never rearms it", async () => {
	const faux = newFaux();
	const prompts: string[] = [];
	const errors: boolean[] = [];
	faux.setResponses([
		observe(
			(messages) => void prompts.push(topicInstructions(messages)),
			toolCall("telegram_rename_topic", { name: "  DNS failure investigation  ", automatic: true }),
		),
		observe(
			(messages) => {
				prompts.push(topicInstructions(messages));
				errors.push(lastToolResult(messages)?.isError === true);
			},
			toolCall("telegram_rename_topic", { name: "Unwanted second rename", automatic: true }),
		),
		observe(
			(messages) => void errors.push(lastToolResult(messages)?.isError === true),
			fauxAssistantMessage("named once"),
		),
	]);
	const { t, port } = await setup(faux);
	await created(t, A, "New topic", true);
	assert.deepEqual(
		(await t.agent.harness.snapshot(ChatMap, BG))?.chats ?? {},
		{},
		"service events create no conversation",
	);
	assert.equal(faux.state.callCount, 0);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "Investigate the DNS failures", { threadId: A }));
	await answered(port, "named once");
	assert.match(prompts[0] ?? "", AUTO_NUDGE);
	assert.doesNotMatch(prompts[1] ?? "", AUTO_NUDGE);
	assert.deepEqual(errors, [false, true]);
	assert.deepEqual(port.renamedTopics, [{ chatId: CHAT, threadId: A, name: "DNS failure investigation" }]);
	await created(t, A, "New topic", true);
	const title = (await t.agent.harness.snapshot(TopicNames, BG))?.topics[chatKey(CHAT, A)];
	assert.equal(title?.name, "DNS failure investigation");
	assert.equal(title?.attempted, true);
});

for (const scenario of ["explicit title", "user edited title", "unknown old topic", "manual mode"] as const) {
	test(`topic names: stale automatic calls cannot overwrite ${scenario}`, async () => {
		const faux = newFaux();
		let instructions = "";
		let error = false;
		faux.setResponses([
			observe(
				(messages) => {
					instructions = topicInstructions(messages);
				},
				toolCall("telegram_rename_topic", { name: "Unwanted automatic title", automatic: true }),
			),
			observe((messages) => {
				error = lastToolResult(messages)?.isError === true;
			}, fauxAssistantMessage("protected")),
		]);
		const { t, port } = await setup(faux, scenario === "manual mode" ? { TELEGRAM_TOPIC_NAMES: "manual" } : {});
		if (scenario !== "unknown old topic") await created(t, A, "Original title", scenario !== "explicit title");
		if (scenario === "user edited title") await edited(t, A, "User's own title");
		await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "continue this task", { threadId: A }));
		await answered(port, "protected");
		assert.doesNotMatch(instructions, AUTO_NUDGE);
		assert.equal(error, true);
		assert.deepEqual(port.renamedTopics, []);
		assert.equal(port.count("renameTopic"), 0);
		const title = (await t.agent.harness.snapshot(TopicNames, BG))?.topics[chatKey(CHAT, A)];
		if (scenario === "user edited title") assert.equal(title?.name, "User's own title");
	});
}

test("topic names: an explicit request renames an unknown old topic and leaves its neighbor alone", async () => {
	const faux = newFaux();
	let error = true;
	faux.setResponses([
		toolCall("telegram_rename_topic", { name: "  Release checklist  " }),
		observe((messages) => {
			error = lastToolResult(messages)?.isError === true;
		}, fauxAssistantMessage("renamed by request")),
	]);
	const { t, port } = await setup(faux, { TELEGRAM_TOPIC_NAMES: "manual" });
	await created(t, B, "Neighbor's title", true);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "Rename this topic to Release checklist", { threadId: A }));
	await answered(port, "renamed by request");
	assert.equal(error, false);
	assert.deepEqual(port.renamedTopics, [{ chatId: CHAT, threadId: A, name: "Release checklist" }]);
	const titles = (await t.agent.harness.snapshot(TopicNames, BG))?.topics;
	assert.equal(titles?.[chatKey(CHAT, A)]?.name, "Release checklist");
	assert.deepEqual(titles?.[chatKey(CHAT, B)], { name: "Neighbor's title", implicit: true });
});

test("topic names: General rejects the rename tool without making a Telegram request", async () => {
	const faux = newFaux();
	let result = "";
	let error = false;
	faux.setResponses([
		toolCall("telegram_rename_topic", { name: "No topic here" }),
		observe((messages) => {
			const last = lastToolResult(messages);
			error = last?.isError === true;
			result = textOf(last);
		}, fauxAssistantMessage("cannot rename General")),
	]);
	const { t, port } = await setup(faux);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "rename this conversation"));
	await answered(port, "cannot rename General");
	assert.equal(error, true);
	assert.match(result, /topic/i);
	assert.equal(port.count("renameTopic"), 0);
	assert.deepEqual((await t.agent.harness.snapshot(TopicNames, BG))?.topics ?? {}, {});
});

test("topic names: an in-flight rename keeps newer observed metadata and asks to check the visible title", async () => {
	const faux = newFaux();
	let result = "";
	faux.setResponses([
		toolCall("telegram_rename_topic", { name: "Automatic title", automatic: true }),
		observe((messages) => {
			result = textOf(lastToolResult(messages));
		}, fauxAssistantMessage("manual edit kept")),
	]);
	const { t, port } = await setup(faux);
	const release = gate();
	let pending = false;
	port.use(async (call) => {
		if (call.method !== "renameTopic") return;
		pending = true;
		await release.promise;
	});
	try {
		await created(t, A, "New topic", true);
		await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "investigate this task", { threadId: A }));
		await waitFor(() => pending, { what: "rename in flight" });
		await edited(t, A, "Manual while pending");
	} finally {
		release.open();
	}
	await answered(port, "manual edit kept");
	assert.match(result, /metadata changed/i);
	assert.match(result, /check the visible title/i);
	assert.deepEqual((await t.agent.harness.snapshot(TopicNames, BG))?.topics[chatKey(CHAT, A)], {
		name: "Manual while pending",
		implicit: false,
		attempted: true,
	});
});

test("topic names: an uncertain rename is claimed before Telegram and is not automatically retried after restart", async () => {
	const { dir, cleanup } = await tempDir();
	cleanups.push(cleanup);
	const port = new FakeTelegram();
	const faux = newFaux();
	let initialInstructions = "";
	let failure = false;
	faux.setResponses([
		observe(
			(messages) => {
				initialInstructions = topicInstructions(messages);
			},
			toolCall("telegram_rename_topic", { name: "Network diagnosis", automatic: true }),
		),
		observe((messages) => {
			failure = lastToolResult(messages)?.isError === true;
		}, fauxAssistantMessage("rename uncertain")),
	]);
	const first = await startTestAgent({ dir, port, faux });
	let claimedBeforeCall = false;
	const unhook = port.use(async (call) => {
		if (call.method !== "renameTopic") return;
		claimedBeforeCall =
			(await first.agent.harness.snapshot(TopicNames, BG))?.topics[chatKey(CHAT, A)]?.attempted === true;
		throw new TelegramUnknown("editForumTopic", "connection dropped");
	});
	try {
		await created(first, A, "New topic", true);
		await first.agent.channel.handleUpdate(textUpdate(CHAT, 1, "diagnose the network", { threadId: A }));
		await answered(port, "rename uncertain");
		assert.match(initialInstructions, AUTO_NUDGE);
		assert.equal(failure, true);
		assert.equal(claimedBeforeCall, true);
	} finally {
		await first.close();
		unhook();
	}
	const resumed = newFaux();
	let instructions = "";
	let retryError = false;
	resumed.setResponses([
		observe(
			(messages) => {
				instructions = topicInstructions(messages);
			},
			toolCall("telegram_rename_topic", { name: "Blind retry", automatic: true }),
		),
		observe((messages) => {
			retryError = lastToolResult(messages)?.isError === true;
		}, fauxAssistantMessage("retry prevented")),
	]);
	const second = await startTestAgent({ dir, port, faux: resumed });
	cleanups.push(() => second.close());
	await created(second, A, "New topic", true);
	await second.agent.channel.handleUpdate(textUpdate(CHAT, 2, "continue diagnosis", { threadId: A }));
	await answered(port, "retry prevented");
	assert.doesNotMatch(instructions, AUTO_NUDGE);
	assert.equal(retryError, true);
	assert.equal(port.count("renameTopic"), 1);
	assert.deepEqual(port.renamedTopics, []);
});

test("topic names: helpers have no automatic naming nudge and cannot consume their parent's naming opportunity", async () => {
	const faux = newFaux();
	let helperInstructions = "";
	let helperError = false;
	faux.setResponses([
		toolCall("helper", { task: "try to name this topic automatically" }),
		observe(
			(messages) => {
				helperInstructions = topicInstructions(messages);
			},
			toolCall("telegram_rename_topic", { name: "Helper's unwanted title", automatic: true }),
		),
		observe((messages) => {
			helperError = lastToolResult(messages)?.isError === true;
		}, fauxAssistantMessage("helper declined")),
		fauxAssistantMessage("parent finished"),
	]);
	const { t, port } = await setup(faux, { PI_PLUGINS: "helpers" });
	await created(t, A, "New topic", true);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "delegate this task", { threadId: A }));
	await answered(port, "parent finished");
	assert.doesNotMatch(helperInstructions, AUTO_NUDGE);
	assert.equal(helperError, true);
	assert.equal(port.count("renameTopic"), 0);
	assert.notEqual((await t.agent.harness.snapshot(TopicNames, BG))?.topics[chatKey(CHAT, A)]?.attempted, true);
});
