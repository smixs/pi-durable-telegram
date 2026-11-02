import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { CHAT, newFaux, startTestAgent, type TestAgent, tempDir } from "../helpers/agent.ts";
import { waitFor } from "../helpers/env.ts";
import { FakeTelegram } from "../helpers/fake-telegram.ts";
import { stoppedUpdate, textUpdate } from "../helpers/updates.ts";

// Advance only the harness clock between real SQLite reopens: no network or wall-clock backoff.
async function retryAcrossReopens(errors: string[], delays: number[], recovered: boolean): Promise<void> {
	const { dir, cleanup } = await tempDir();
	const port = new FakeTelegram();
	let now = Date.now();
	let calls = 0;
	let current: TestAgent | undefined;
	try {
		for (let step = 0; step <= delays.length; step++) {
			const faux = newFaux();
			faux.setResponses([
				() => {
					calls++;
					return recovered && step === delays.length
						? fauxAssistantMessage("rotated access works")
						: fauxAssistantMessage("", { stopReason: "error", errorMessage: errors[step % errors.length] });
				},
			]);
			current = await startTestAgent({ dir, port, faux, deps: { now: () => now } });
			if (step === 0) await current.agent.channel.handleUpdate(textUpdate(CHAT, 1, "work"));
			const agent = current;
			if (step < delays.length) {
				const sleeping = await waitFor(async () =>
					(await agent.agent.harness.inspect(BG)).tasks.find(
						(task) => task.record.kind === "pi.generation" && task.state.kind === "sleeping",
					),
				);
				assert.equal(sleeping.record.state.status, "sleeping");
				const state = sleeping.record.state as unknown as { checkpoint: { attempt: number; until: number } };
				assert.equal(state.checkpoint.attempt, step + 1);
				assert.equal(state.checkpoint.until - now, delays[step]);
				assert.deepEqual(port.textsIn(CHAT), [], "a retryable failure is silent");
				await agent.close();
				current = undefined;
				now += delays[step] ?? 0;
			} else {
				await waitFor(() => agent.logs.some((line) => line.includes("info delivered")));
				assert.equal(calls, delays.length + 1, "the persisted attempt budget survives restarts");
				assertFinished(agent, port, recovered);
			}
		}
	} finally {
		await current?.close();
		await cleanup();
	}
}

function assertFinished(agent: TestAgent, port: FakeTelegram, recovered: boolean): void {
	assert.equal(port.textsIn(CHAT).length, 1);
	if (recovered) assert.deepEqual(port.textsIn(CHAT), ["rotated access works"]);
	else assert.ok(!port.textsIn(CHAT).includes("rotated access works"));
	assert.deepEqual(agent.fatal, []);
}

test("INF-18: auth rotation retries 10/20/40 s across restarts, then exhausts after three retries", async () => {
	await retryAcrossReopens(
		['401 {"error":{"type":"authentication_error"}}', "401 access token expired", "Access token has been revoked"],
		[10000, 20000, 40000],
		false,
	);
});

test("INF-18: a fresh provider response completes the same request after auth rotation", async () => {
	await retryAcrossReopens(["401 authentication_error"], [10000], true);
});

test("INF-18: provider 429 retries 5/10/20/40/60 s across restarts, then exhausts", async () => {
	await retryAcrossReopens(["429 rate_limit_error: too many requests"], [5000, 10000, 20000, 40000, 60000], false);
});

test("INF-18: draft stop aborts a sleeping auth retry without starting another provider call", async () => {
	const { dir, cleanup } = await tempDir();
	const faux = newFaux();
	faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 authentication_error" })]);
	const port = new FakeTelegram();
	const t = await startTestAgent({ dir, faux, port });
	try {
		await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "work"));
		await waitFor(async () =>
			(await t.agent.harness.inspect(BG)).tasks.some(
				(task) => task.record.kind === "pi.generation" && task.state.kind === "sleeping",
			),
		);
		await t.agent.channel.handleUpdate(stoppedUpdate(CHAT, 123));
		await waitFor(() => port.textsIn(CHAT).includes("Stopped."));
		assert.equal(faux.state.callCount, 1);
		assert.deepEqual(t.fatal, []);
	} finally {
		await t.close();
		await cleanup();
	}
});
