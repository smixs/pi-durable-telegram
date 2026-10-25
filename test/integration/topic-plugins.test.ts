import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { type FauxResponseFactory, fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import { ChatMap, chatKey } from "../../src/channel/docs.ts";
import { Reminders } from "../../src/plugins/reminders/task.ts";
import { CHAT, newFaux, startTestAgent, tempDir } from "../helpers/agent.ts";
import { waitFor } from "../helpers/env.ts";
import { FakeTelegram } from "../helpers/fake-telegram.ts";
import { lastUserText, textOf, toolCall } from "../helpers/faux-steps.ts";
import { textUpdate } from "../helpers/updates.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("topic reminders are listed separately and wake their original topic after restart", async () => {
	const { dir, cleanup } = await tempDir();
	cleanups.push(cleanup);
	const port = new FakeTelegram();
	const now = Date.UTC(2026, 9, 25, 12);
	const faux = newFaux();
	const step: FauxResponseFactory = (context) => {
		const last = context.messages.at(-1);
		if (last?.role === "toolResult") return fauxAssistantMessage(textOf(last));
		return lastUserText(context.messages) === "set reminder"
			? toolCall("remind", { op: "add", text: "topic task", in: 1 })
			: toolCall("remind", { op: "list" });
	};
	faux.setResponses(Array.from({ length: 10 }, () => step));
	const config = { PI_PLUGINS: "reminders" };
	const one = await startTestAgent({ dir, port, faux, config, deps: { now: () => now } });
	try {
		await one.agent.channel.handleUpdate(textUpdate(CHAT, 1, "set reminder", { threadId: 41 }));
		await waitFor(() => port.created(CHAT).some((m) => m.text.startsWith("Reminder r")));
		await one.agent.channel.handleUpdate(textUpdate(CHAT, 2, "list reminders", { threadId: 42 }));
		const listed = await waitFor(() => port.created(CHAT).find((m) => m.text.includes("No reminders.")));
		assert.equal(listed.threadId, 42);
		const map = await one.agent.harness.snapshot(ChatMap, BG);
		const original = map?.chats[chatKey(CHAT, 41)] as ConversationId;
		const other = map?.chats[chatKey(CHAT, 42)] as ConversationId;
		assert.equal(Object.keys((await one.agent.harness.snapshot(Reminders, original, BG))?.items ?? {}).length, 1);
		assert.equal(Object.keys((await one.agent.harness.snapshot(Reminders, other, BG))?.items ?? {}).length, 0);
	} finally {
		await one.close();
	}
	const resumed = newFaux();
	resumed.setResponses([fauxAssistantMessage("Reminder delivered")]);
	const two = await startTestAgent({ dir, port, faux: resumed, config, deps: { now: () => now + 60_000 } });
	cleanups.push(() => two.close());
	const delivered = await waitFor(() => port.created(CHAT).find((m) => m.text === "Reminder delivered"));
	assert.equal(delivered.threadId, 41);
	assert.equal(delivered.replyTo, undefined);
});

function hasHelper(messages: readonly Message[]): boolean {
	const tools = new Set<string>();
	for (const message of messages) {
		if (message.role !== "system") continue;
		for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
		for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
	}
	return tools.has("helper");
}

test("a helper inherits the originating topic when sending a file", async () => {
	const { dir, cleanup } = await tempDir();
	cleanups.push(cleanup);
	const port = new FakeTelegram();
	const faux = newFaux();
	const step: FauxResponseFactory = (context) => {
		const last = context.messages.at(-1);
		if (last?.role === "toolResult") return fauxAssistantMessage("File sent");
		return hasHelper(context.messages)
			? toolCall("helper", { task: "send artifact.txt" })
			: toolCall("telegram_send_file", { path: join(dir, "work", "artifact.txt") });
	};
	faux.setResponses(Array.from({ length: 10 }, () => step));
	const t = await startTestAgent({ dir, port, faux, config: { PI_PLUGINS: "helpers" } });
	cleanups.push(() => t.close());
	await writeFile(join(dir, "work", "artifact.txt"), "example artifact\n");
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "delegate", { threadId: 41 }));
	await waitFor(() => port.textsIn(CHAT).includes("File sent"));
	const sent = port.created(CHAT).filter((m) => m.kind === "document");
	assert.equal(sent.length, 1);
	assert.equal(sent[0]?.threadId, 41);
	assert.ok(port.calls.some((call) => call.method === "sendChatAction" && call.threadId === 41));
});
