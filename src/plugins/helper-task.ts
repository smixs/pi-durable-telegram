import type { Context } from "@earendil-works/chord";
import {
	AssistantEntry,
	type ConversationId,
	defineTask,
	type NextTaskState,
	type RunningTask,
	type SettledSubmissionRecord,
	type TaskRuntime,
	type Tx,
} from "@earendil-works/pi-durable";
import { ChatInfo } from "../channel/docs.ts";
import { admitIn } from "../channel/intake.ts";
import { finalReplyText } from "../delivery/final-text.ts";
import { DELIVER_TASK, type DeliverTask } from "../delivery/task.ts";

export const HELPER_TASK = "tg.helper";
type Input = { task: string };
type State = { phase: "work" };
type Runtime = TaskRuntime<Input, State, null, object>;
type Report = { status: "done" | "error" | "interrupted"; text: string };
const DONE = { status: "terminal", outcome: { status: "completed", result: null } } as const;
const ABORTED = { status: "terminal", outcome: { status: "aborted" } } as const;

async function reportOf(tx: Tx, settled: SettledSubmissionRecord): Promise<Report> {
	if (settled.status === "unanswered") {
		const { reason } = settled;
		const interrupted = reason === "aborted" || reason === "interrupted" || reason === "restart_limit";
		return { status: interrupted ? "interrupted" : "error", text: `The helper gave no answer (${reason}).` };
	}
	if (settled.type !== "input") return { status: "error", text: "The helper did not answer its task." };
	const entry = await tx.entry(AssistantEntry, settled.answer);
	return { status: "done", text: finalReplyText(entry?.model?.[0]) ?? "(the helper answered with no text)" };
}

/** Admit the report through the reminder wake path, in the same commit that ends the helper. */
async function wake(tx: Tx, runtime: Runtime, allowed: ReadonlySet<number>, report: Report): Promise<void> {
	const conversationId = runtime.conversationId;
	const { chatId } = await tx.doc(ChatInfo, conversationId);
	if (!allowed.has(chatId)) return;
	const id = `h${runtime.taskId}`;
	const deliver = runtime.registry.task(DELIVER_TASK) as unknown as DeliverTask;
	await admitIn(tx, conversationId, deliver, {
		chatId,
		requestId: `helper-report:${id}`,
		content: `[helper ${id} ${report.status}] ${report.text}`,
	});
}

async function work(
	task: RunningTask<Input, State, null>,
	runtime: Runtime,
	context: Context,
	allowed: ReadonlySet<number>,
): Promise<void> {
	let report: (tx: Tx) => Report | Promise<Report>;
	try {
		let childId: ConversationId | undefined;
		await runtime.commit(async (tx) => {
			childId = (await tx.scanConversations({ ownerTaskId: task.id }, 1)).items[0]?.id;
			return undefined;
		}, context);
		const handle = childId === undefined ? undefined : await runtime.conversation(childId, context);
		if (handle === undefined) throw new Error("The helper's conversation is missing.");
		const chat = await runtime.snapshot(ChatInfo, runtime.conversationId, context);
		if (!allowed.has(chat?.chatId ?? 0) || runtime.registry.extension("helpers") === undefined) {
			await handle.abort(context);
			report = () => ({ status: "interrupted", text: "The helper was disabled." });
		} else {
			const request = { type: "input", content: task.input.task, requestId: `helper:${task.id}` } as const;
			const settled = await (await handle.submit(request, context)).wait(context);
			report = (tx) => reportOf(tx, settled);
		}
	} catch (error) {
		if (runtime.signal.aborted) throw error; // The abort handler or the next invocation takes over.
		runtime.report(error);
		report = () => ({ status: "error", text: "The helper could not complete its task." });
	}
	await runtime.commit(async (tx) => {
		await wake(tx, runtime, allowed, await report(tx));
		return DONE;
	}, context);
}

/** Core registration lets existing helpers settle even when the plugin is disabled between runs. */
export function createHelperTask(allowed: ReadonlySet<number>) {
	return defineTask<Input, State, null>({
		name: HELPER_TASK,
		version: 1,
		initial: () => ({ phase: "work" }),
		phases: { work: (task, runtime, context) => work(task, runtime, context, allowed) },
		abort: (_task, runtime, context) =>
			runtime.commit(async (tx): Promise<NextTaskState<State, null>> => {
				await wake(tx, runtime, allowed, { status: "interrupted", text: "The helper was stopped." });
				return ABORTED;
			}, context),
	});
}

export type HelperTask = ReturnType<typeof createHelperTask>;
