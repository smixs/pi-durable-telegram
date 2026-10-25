import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { InboxDoc, LiveDoc, UserEntry } from "@earendil-works/pi-durable";
import { recordKey } from "../intake.ts";
import { type CommandScope, reply } from "../scope.ts";

/**
 * /stop and a draft's stop button: abort the task that owns the current run (and with it its tool tasks), not the conversation, so queued
 * messages stay; then a passive write gives the conversation a boundary to place them.
 */
export async function runStop(scope: CommandScope, expectedSubmissionId?: number): Promise<void> {
	if (!(await recordKey(scope.conversation, scope.key, BG, scope.updateId))) return;
	const { harness } = scope.rt;
	const id = scope.conversation.id;
	const live = async () => (await harness.snapshot(LiveDoc, id, BG))?.run;
	const stopping = await live();
	if (expectedSubmissionId !== undefined && !stopping?.inputs.some((id) => id === expectedSubmissionId)) return;
	if (stopping === undefined) {
		await reply(scope, "Nothing is running.");
		return;
	}
	let current: typeof stopping | undefined = stopping;
	while (current !== undefined && current.inputs[0] === stopping.inputs[0]) {
		await harness.abortTask(current.taskId, BG);
		await harness.waitForTask(current.taskId, BG);
		current = await live();
	}
	const queued = (await harness.snapshot(InboxDoc, id, BG))?.items.length ?? 0;
	const message = { role: "user" as const, content: "[/stop]", timestamp: Date.now() };
	await scope.conversation.submit(
		{ type: "write", requestId: scope.key, entry: { kind: UserEntry.kind, model: [message] } },
		BG,
	);
	await reply(scope, queued > 0 ? `Stopped. ${queued} queued message(s) will continue.` : "Stopped.");
}
