import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { splitForTelegram } from "../../src/format/chunk.ts";
import { TelegramApiError } from "../../src/telegram/errors.ts";
import { CHAT, newFaux, startTestAgent, tempDir } from "../helpers/agent.ts";
import { waitFor } from "../helpers/env.ts";
import { FakeTelegram } from "../helpers/fake-telegram.ts";
import { textOf, toolCall } from "../helpers/faux-steps.ts";
import { textUpdate } from "../helpers/updates.ts";

test("T-upgrade-sleep: a 429 on a later chunk survives reopen and resumes without skipping or duplicating it", async () => {
	const { dir, cleanup } = await tempDir();
	const port = new FakeTelegram();
	let now = Date.now();
	const answer = Array.from({ length: 50 }, (_, i) => `Block ${i} ${"z".repeat(200)}`).join("\n\n");
	const chunks = splitForTelegram(answer);
	assert.ok(chunks.length >= 3);
	let limited = false;
	port.use((call) => {
		if (call.method === "sendMessage" && call.text === chunks[1]?.html && !limited) {
			limited = true;
			throw new TelegramApiError("sendMessage", 429, "retry after 5", 5);
		}
	});
	const faux = newFaux();
	faux.setResponses([fauxAssistantMessage(answer)]);
	const first = await startTestAgent({ dir, port, faux, deps: { now: () => now } });
	try {
		await first.agent.channel.handleUpdate(textUpdate(CHAT, 1, "long answer"));
		const sleeping = await waitFor(async () =>
			(await first.agent.harness.inspect(BG)).tasks.find(
				(t) => t.record.kind === "tg.deliver" && t.state.kind === "sleeping",
			),
		);
		assert.equal((sleeping.record.state as { checkpoint: { inFlight?: number } }).checkpoint.inFlight, undefined);
		await first.close();
		now += 10_000;
		const idle = newFaux();
		const second = await startTestAgent({ dir, port, faux: idle, deps: { now: () => now } });
		try {
			await waitFor(() => second.logs.some((line) => line.includes("info delivered")));
			for (const chunk of chunks) assert.equal(port.textsIn(CHAT).filter((text) => text === chunk.html).length, 1);
			assert.equal(idle.state.callCount, 0);
			assert.ok(!second.logs.some((line) => line.includes("delivery_unknown")));
		} finally {
			await second.close();
		}
	} finally {
		await first.close();
		await cleanup();
	}
});

test("T-upgrade-cancel: a reminder sleeping across reopen is cancelled immediately and never fires", async () => {
	const { dir, cleanup } = await tempDir();
	const port = new FakeTelegram();
	let now = Date.now();
	const deps = { now: () => now };
	const config = { PI_PLUGINS: "reminders" };
	let id = "";
	const faux = newFaux();
	faux.setResponses([
		toolCall("remind", { op: "add", text: "later", in: "1" }),
		(context) => {
			id = /Reminder (r\d+)/.exec(textOf(context.messages.at(-1)))?.[1] ?? "";
			return fauxAssistantMessage("set");
		},
	]);
	const first = await startTestAgent({ dir, port, faux, config, deps });
	try {
		await first.agent.channel.handleUpdate(textUpdate(CHAT, 1, "remind"));
		await waitFor(() => port.textsIn(CHAT).includes("set"));
		assert.match(id, /^r\d+$/);
		await waitFor(async () =>
			(await first.agent.harness.inspect(BG)).tasks.some(
				(t) => t.record.kind === "tg.remind" && t.state.kind === "sleeping",
			),
		);
		await first.close();
		const cancel = newFaux();
		cancel.setResponses([toolCall("remind", { op: "cancel", id }), fauxAssistantMessage("cancelled")]);
		const second = await startTestAgent({ dir, port, faux: cancel, config, deps });
		try {
			await second.agent.channel.handleUpdate(textUpdate(CHAT, 2, "cancel"));
			await waitFor(() => port.textsIn(CHAT).includes("cancelled"));
			const tasks = await second.agent.harness.commit((tx) => tx.scanTasks({ kind: "tg.remind" }, 100), BG);
			assert.ok(tasks.items.length > 0);
			assert.ok(tasks.items.every((task) => task.state.status === "terminal"));
		} finally {
			await second.close();
		}
		now += 120_000;
		const idle = newFaux();
		const third = await startTestAgent({ dir, port, faux: idle, config, deps });
		try {
			assert.equal((await third.agent.harness.inspect(BG)).tasks.length, 0);
			assert.equal(idle.state.callCount, 0);
		} finally {
			await third.close();
		}
	} finally {
		await first.close();
		await cleanup();
	}
});
