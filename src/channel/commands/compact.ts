import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { recordKey } from "../intake.ts";
import { type MessageScope, reply } from "../scope.ts";

/**
 * /compact [instructions]: record the key first (a redelivered update must not start a second, paid compaction), then
 * start a manual compaction and a durable task that reports its outcome.
 */
export async function runCompact(scope: MessageScope, instructions: string): Promise<void> {
	const { conversation, rt } = scope;
	if (!(await recordKey(conversation, scope.key, BG, scope.updateId))) return;
	const compactionTaskId = await conversation.compact(instructions === "" ? undefined : instructions, BG);
	await conversation.commit(async (tx) => {
		const input = {
			chatId: scope.chatId,
			replyTo: scope.messageId,
			compactionTaskId,
			...(scope.threadId === undefined ? {} : { threadId: scope.threadId }),
		};
		await tx.createTask(rt.compactReport, input, { ownership: { kind: "conversation" }, background: true });
	}, BG);
	await reply(scope, "Compacting…");
}
