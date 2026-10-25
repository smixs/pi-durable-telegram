import type { Context } from "@earendil-works/chord";
import {
	type ConversationId,
	type EntryId,
	LiveDoc,
	type NextTaskState,
	type RunningTask,
	type SettledSubmissionRecord,
	type Submission,
	type TaskRuntime,
	type Tx,
	type UserInput,
} from "@earendil-works/pi-durable";
import { DELIVERED_RING_SIZE, Delivered } from "../channel/docs.ts";
import { LiveTracker } from "./live-frame.ts";
import { trimDetail } from "./outcome.ts";
import { PreviewStreamer } from "./preview.ts";
import type { DeliverInput, DeliverState, DeliveryDeps, Outcome, SendState, WaitState } from "./types.ts";
import { TypingPulse } from "./typing.ts";

type Runtime = TaskRuntime<DeliverInput, DeliverState, null, object>;
type Running = RunningTask<DeliverInput, DeliverState, null>;
type Next = NextTaskState<DeliverState, null>;

/**
 * Phase `wait`: submit the message (idempotent by request id), stream the run into a preview while it is this
 * message's run, wait for the submission to settle, then claim the answer and move to `send` in one commit.
 */
export async function waitPhase(
	task: RunningTask<DeliverInput, WaitState, null>,
	runtime: Runtime,
	context: Context,
	deps: DeliveryDeps,
): Promise<void> {
	const conversation = await runtime.conversation(runtime.conversationId, context);
	if (conversation === undefined) {
		await runtime.commit(() => terminal(), context);
		return;
	}
	const submission = await conversation.submit(
		{ type: "input", content: task.input.content as UserInput, requestId: task.input.requestId, whenBusy: "followUp" },
		context,
	);
	if (task.state.checkpoint.submissionId === undefined) {
		await runtime.commit((_tx, current) => running({ ...waitOf(current), submissionId: submission.id }), context);
	}
	const settled = await streamUntilSettled(task, submission, runtime, context, deps);
	await runtime.commit((tx, current) => decide(tx, current, settled, runtime), context);
}

async function streamUntilSettled(
	task: RunningTask<DeliverInput, WaitState, null>,
	submission: Submission,
	runtime: Runtime,
	context: Context,
	deps: DeliveryDeps,
): Promise<SettledSubmissionRecord> {
	const port = deps.port();
	const { chatId, messageId, threadId } = task.input;
	const typing = new TypingPulse(port, chatId, runtime.signal, threadId);
	const draft = deps.rich === true && task.state.checkpoint.preview === undefined;
	const preview = new PreviewStreamer({
		port,
		chatId,
		...(threadId === undefined ? {} : { threadId }),
		replyTo: messageId,
		log: deps.log,
		messageId: task.state.checkpoint.preview?.messageId,
		signal: runtime.signal,
		now: () => runtime.now(),
		...(deps.previewIntervalMs === undefined ? {} : { intervalMs: deps.previewIntervalMs }),
		...(draft ? { draftId: Number(task.id) } : {}),
		onCreated: (id) =>
			runtime.commit((_tx, current) => running({ ...waitOf(current), preview: { messageId: id } }), context),
	});
	const tracker = new LiveTracker(submission.id);
	const watch = await runtime.watchDoc(LiveDoc, runtime.conversationId, context);
	watch?.start(async (value) => {
		const frame = tracker.update(value);
		typing.set(frame.mine);
		if (frame.mine) preview.push(frame);
	});
	try {
		return await submission.wait(context);
	} finally {
		await watch?.stop();
		typing.stop();
		await preview.close();
	}
}

function waitOf(current: Running): WaitState {
	const checkpoint = current.state.checkpoint;
	return checkpoint.phase === "wait" ? checkpoint : { phase: "wait" };
}

function running(checkpoint: DeliverState): Next {
	return { status: "running", checkpoint };
}

export function terminal(): Next {
	return { status: "terminal", outcome: { status: "completed", result: null } };
}

async function decide(tx: Tx, current: Running, settled: SettledSubmissionRecord, runtime: Runtime): Promise<Next> {
	const wait = waitOf(current);
	const outcome = await outcomeOf(tx, settled, runtime.conversationId, current.id);
	const next: SendState = { phase: "send", outcome, sent: 0, messageIds: [] };
	if (wait.preview !== undefined) next.preview = wait.preview;
	return running(next);
}

async function outcomeOf(
	tx: Tx,
	settled: SettledSubmissionRecord,
	conversationId: ConversationId,
	taskId: number,
): Promise<Outcome> {
	if (settled.status === "unanswered") {
		const detail = trimDetail(settled.detail);
		return detail === undefined
			? { kind: "unanswered", reason: settled.reason }
			: { kind: "unanswered", reason: settled.reason, detail };
	}
	if (settled.type !== "input") return { kind: "unanswered", reason: "not_an_input" };
	return claimAnswer(tx, conversationId, settled.answer, taskId);
}

/** Claim an answer entry for this task; an answer already claimed by another task is `shared`. */
async function claimAnswer(tx: Tx, conversationId: ConversationId, answer: EntryId, taskId: number): Promise<Outcome> {
	const delivered = await tx.doc(Delivered, conversationId);
	const key = String(answer);
	const claim = Object.hasOwn(delivered.answers, key) ? delivered.answers[key] : undefined;
	if (claim !== undefined && claim.taskId !== taskId) return { kind: "shared", entryId: answer };
	if (claim === undefined) {
		delivered.answers[key] = { taskId, state: "sending" };
		delivered.order.push(answer);
		while (delivered.order.length > DELIVERED_RING_SIZE) delete delivered.answers[String(delivered.order.shift())];
	}
	return { kind: "answer", entryId: answer };
}
