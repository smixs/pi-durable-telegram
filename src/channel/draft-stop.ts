import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { type ConversationId, LiveDoc, type TaskId } from "@earendil-works/pi-durable";
import { DELIVER_TASK } from "../delivery/task.ts";
import { ChatInfo } from "./docs.ts";
import type { ChannelRuntime, CommandScope } from "./scope.ts";

type Draft = { conversationId: ConversationId; submissionId: number };

/** A native draft is identified by its durable delivery task, even when Telegram omits its topic id. */
export async function draftScope(
	rt: ChannelRuntime,
	chatId: number,
	draftId: number,
	updateId: number,
): Promise<{ scope: CommandScope; submissionId: number } | undefined> {
	const draft = await activeDraft(rt, chatId, draftId);
	if (draft === undefined) return undefined;
	const info = await rt.harness.snapshot(ChatInfo, draft.conversationId, BG);
	if (info?.chatId !== chatId) return undefined;
	const conversation = await rt.harness.conversation(draft.conversationId, BG);
	if (conversation === undefined) return undefined;
	return {
		submissionId: draft.submissionId,
		scope: {
			rt,
			conversation,
			chatId,
			updateId,
			key: `tg:${chatId}:stop:${updateId}`,
			...(info.threadId === undefined ? {} : { threadId: info.threadId }),
		},
	};
}

async function activeDraft(rt: ChannelRuntime, chatId: number, draftId: number): Promise<Draft | undefined> {
	if (!Number.isSafeInteger(draftId) || draftId <= 0) return undefined;
	const task = await rt.harness.getTask(draftId as TaskId, BG);
	if (task?.kind !== DELIVER_TASK || task.state.status !== "running") return undefined;
	if (!isRecord(task.input) || task.input.chatId !== chatId) return undefined;
	const submissionId = draftSubmission(task.state.checkpoint);
	if (submissionId === undefined) return undefined;
	const run = (await rt.harness.snapshot(LiveDoc, task.conversationId, BG))?.run;
	if (!run?.inputs.some((id) => id === submissionId)) return undefined;
	return { conversationId: task.conversationId, submissionId };
}

function draftSubmission(checkpoint: unknown): number | undefined {
	if (!isRecord(checkpoint) || checkpoint.phase !== "wait") return undefined;
	return typeof checkpoint.submissionId === "number" ? checkpoint.submissionId : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
