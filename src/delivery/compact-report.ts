import type { Context } from "@earendil-works/chord";
import {
	type CompactionResult,
	defineTask,
	type Harness,
	type SubmissionRecord,
	type TaskId,
	type TaskOutcome,
} from "@earendil-works/pi-durable";
import { classifyTelegramError, telegramErrorSummary } from "../telegram/errors.ts";
import { guardPhase } from "./phase-guard.ts";
import type { DeliveryDeps } from "./types.ts";

export type CompactReportInput = { chatId: number; threadId?: number; replyTo: number; compactionTaskId: number };
type State = { phase: "wait" } | { phase: "reply"; text: string; inFlight?: boolean };

export const COMPACT_REPORT_TASK = "tg.compact-report";

/** The reply for a finished compaction and, when its summary went through a write, that write's placement. */
export function compactionReply(outcome: TaskOutcome<CompactionResult>, placement?: SubmissionRecord): string {
	if (outcome.status === "aborted") return "Compaction cancelled.";
	if (outcome.status !== "completed") return "Compaction failed.";
	if (outcome.result.entryId !== undefined) return "Compacted.";
	if (outcome.result.submissionId === undefined) return "Nothing to compact.";
	if (placement === undefined || placement.type !== "write") return "Compaction result unavailable.";
	if (placement.status === "done") return "Compacted.";
	if (placement.status === "queued") return "Compaction summary queued for the next turn.";
	return placement.reason === "stale"
		? "Compaction summary discarded: the context changed meanwhile."
		: "Compaction summary was not applied.";
}

async function placementOf(harness: Harness, result: CompactionResult | undefined, context: Context) {
	if (result?.submissionId === undefined) return undefined;
	const submission = await harness.submission(result.submissionId, context);
	return submission === undefined ? undefined : await submission.wait(context);
}

/** Waits for a manual compaction (survives restarts) and replies once with its outcome. */
export function createCompactReportTask(deps: DeliveryDeps) {
	return defineTask<CompactReportInput, State, null>({
		name: COMPACT_REPORT_TASK,
		version: 1,
		initial: () => ({ phase: "wait" }),
		phases: {
			wait: (task, runtime, context) =>
				guardPhase("compact-wait", runtime.signal, deps, async () => {
					const id = task.input.compactionTaskId as TaskId<CompactionResult>;
					const settled = await runtime.waitForTask(id, context);
					const outcome = settled.state.outcome;
					const result = outcome.status === "completed" ? outcome.result : undefined;
					const text = compactionReply(outcome, await placementOf(deps.harness(), result, context));
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "reply", text } }), context);
				}),
			reply: (task, runtime, context) =>
				guardPhase("compact-reply", runtime.signal, deps, async () => {
					const { text, inFlight } = task.state.checkpoint;
					if (inFlight !== true) {
						await runtime.commit(
							() => ({ status: "running", checkpoint: { phase: "reply", text, inFlight: true } }),
							context,
						);
						await deps
							.port()
							.sendMessage(
								task.input.chatId,
								text,
								{
									replyTo: task.input.replyTo,
									...(task.input.threadId === undefined ? {} : { threadId: task.input.threadId }),
								},
								runtime.signal,
							)
							.catch((error: unknown) => {
								if (classifyTelegramError(error).kind === "aborted") throw error;
								deps.log.warn("compact_reply_failed", telegramErrorSummary(error));
							});
					}
					await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
				}),
		},
		abort: (_task, runtime, context) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});
}

export type CompactReportTask = ReturnType<typeof createCompactReportTask>;
