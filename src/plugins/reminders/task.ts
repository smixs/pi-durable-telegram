import type { Context } from "@earendil-works/chord";
import {
	type ConversationId,
	defineDoc,
	defineTask,
	type Harness,
	type NextTaskState,
	type TaskRuntime,
	type Tx,
} from "@earendil-works/pi-durable";
import { ChatInfo } from "../../channel/docs.ts";
import { admitIn } from "../../channel/intake.ts";
import { DELIVER_TASK, type DeliverTask } from "../../delivery/task.ts";
import { type Every, formatLocal, nextOccurrence } from "./time.ts";

/** One pending reminder; `tz` and `wall` are fixed when it is set, so later occurrences keep the user's local time. */
export type Reminder = { text: string; next: number; every?: Every; wall: string; tz: string; setAt: number };

/** Pending reminders of a chat's main conversation, by id: what `list` shows and `cancel` removes. */
export const Reminders = defineDoc<{ items: Record<string, Reminder> }>({
	kind: "tg.reminders",
	version: 1,
	checkpointWhen: () => false,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ items: {} }),
});

export const REMIND_TASK = "tg.remind";
type Input = { id: string; due: number };
type Runtime = TaskRuntime<Input, State, null, object>;
type State = { phase: "wait"; due: number };
type Next = NextTaskState<State, null>;
const DONE: Next = { status: "terminal", outcome: { status: "completed", result: null } };
const LATE_MS = 2 * 60_000;

export function wakeNote(id: string, entry: Reminder, due: number, now: number): string {
	const late = now - due > LATE_MS ? `, was due ${formatLocal(due, entry.tz)}, late: the service was down` : "";
	return `[reminder ${id}, set ${formatLocal(entry.setAt, entry.tz)}${late}] ${entry.text}`;
}

/** Why a due reminder must not wake the agent, or undefined. */
function refusal(runtime: Runtime, chatId: number, allowed: ReadonlySet<number>): string | undefined {
	if (runtime.registry.extension("reminders") === undefined) return "the reminders plugin is off";
	return allowed.has(chatId) ? undefined : "its chat is no longer allowed";
}

/**
 * The wake input and the next due time commit together; a cancelled or already advanced entry fires nothing, and the
 * intake key `remind:<id>:<due>` (also the submission's request id) drops a second wake for the same due time. A wake
 * passes the same allow-list as a message: a reminder of a chat no longer allowed is dropped.
 */
async function fire(tx: Tx, runtime: Runtime, allowed: ReadonlySet<number>, id: string, due: number): Promise<Next> {
	const doc = await tx.doc(Reminders, runtime.conversationId);
	const entry = Object.hasOwn(doc.items, id) ? doc.items[id] : undefined;
	if (entry === undefined || entry.next !== due) return DONE;
	const chatId = (await tx.doc(ChatInfo, runtime.conversationId)).chatId;
	const refused = refusal(runtime, chatId, allowed);
	if (refused !== undefined) {
		delete doc.items[id];
		runtime.report(new Error(`reminder ${id} dropped: ${refused}`));
		return DONE;
	}
	const deliver = runtime.registry.task(DELIVER_TASK) as unknown as DeliverTask;
	const content = wakeNote(id, entry, due, runtime.now());
	await admitIn(tx, runtime.conversationId, deliver, { chatId, requestId: `remind:${id}:${due}`, content });
	const next = nextOccurrence(entry, due, runtime.now());
	if (next === undefined) {
		delete doc.items[id];
		return DONE;
	}
	entry.next = next;
	return { status: "running", checkpoint: { phase: "wait", due: next } };
}

/**
 * One background, conversation-owned task per reminder: it sleeps until the due time on the harness clock, and after a
 * restart sleeps again from its checkpoint (or fires at once, late). Registered by core whether or not the reminders
 * plugin is on, so unfinished reminders never block startup; `allowed` is the channel's allow-list.
 */
export function createReminderTask(allowed: ReadonlySet<number>) {
	return defineTask<Input, State, null>({
		name: REMIND_TASK,
		version: 1,
		initial: (input) => ({ phase: "wait", due: input.due }),
		phases: {
			wait: async (task, runtime, context) => {
				const due = task.state.checkpoint.due;
				const doc = await runtime.snapshot(Reminders, runtime.conversationId, context);
				if (doc?.items[task.input.id]?.next === due && runtime.now() < due) {
					await runtime.sleepUntil(due, task.state.checkpoint, context);
					return;
				}
				await runtime.commit((tx) => fire(tx, runtime, allowed, task.input.id, due), context);
			},
		},
		abort: (task, runtime, context) =>
			runtime.commit(async (tx) => {
				delete (await tx.doc(Reminders, runtime.conversationId)).items[task.input.id];
				return { status: "terminal", outcome: { status: "aborted" } };
			}, context),
	});
}

export type ReminderTask = ReturnType<typeof createReminderTask>;

/** Stop matching core tasks through the host; plugins receive only this reminder-scoped capability. */
export async function cancelReminderTask(
	harness: Harness,
	conversationId: ConversationId,
	id: string,
	context: Context,
): Promise<void> {
	const tasks = (await harness.inspect(context)).tasks;
	for (const task of tasks) {
		if (task.record.kind !== REMIND_TASK || task.record.conversationId !== conversationId) continue;
		const input = task.record.input as Input;
		if (input.id !== id) continue;
		await harness.abortTask(task.record.id, context);
		await harness.waitForTask(task.record.id, context);
	}
}
