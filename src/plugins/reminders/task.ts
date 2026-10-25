import type { Context } from "@earendil-works/chord";
import { withCancel } from "@earendil-works/chord/context";
import { defineDoc, defineTask, type NextTaskState, type TaskRuntime, type Tx } from "@earendil-works/pi-durable";
import { ChatInfo } from "../../channel/docs.ts";
import { admitIn } from "../../channel/intake.ts";
import { DELIVER_TASK, type DeliverTask } from "../../delivery/task.ts";
import { type Every, formatLocal, nextOccurrence } from "./time.ts";

/** One pending reminder; `tz` and `wall` are fixed when it is set, so later occurrences keep the user's local time. */
export type Reminder = { text: string; next: number; every?: Every; wall: string; tz: string; setAt: number };

/** Pending reminders of a topic's main conversation, by id: what `list` shows and `cancel` removes. */
export const Reminders = defineDoc<{ items: Record<string, Reminder> }>({
	kind: "tg.reminders",
	version: 1,
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
	const { chatId, threadId } = await tx.doc(ChatInfo, runtime.conversationId);
	const refused = refusal(runtime, chatId, allowed);
	if (refused !== undefined) {
		delete doc.items[id];
		runtime.report(new Error(`reminder ${id} dropped: ${refused}`));
		return DONE;
	}
	const deliver = runtime.registry.task(DELIVER_TASK) as unknown as DeliverTask;
	const content = wakeNote(id, entry, due, runtime.now());
	await admitIn(tx, runtime.conversationId, deliver, {
		chatId,
		...(threadId === undefined ? {} : { threadId }),
		requestId: `remind:${id}:${due}`,
		content,
	});
	const next = nextOccurrence(entry, due, runtime.now());
	if (next === undefined) {
		delete doc.items[id];
		return DONE;
	}
	entry.next = next;
	return { status: "running", checkpoint: { phase: "wait", due: next } };
}

/** Sleep until `due`, or less: a cancel or another change of the entry wakes the task early, and `fire` ends it. */
async function sleepUnlessChanged(runtime: Runtime, id: string, due: number, context: Context): Promise<void> {
	const pending = (doc: { readonly items: Readonly<Record<string, Reminder>> } | null) =>
		doc !== null && Object.hasOwn(doc.items, id) && doc.items[id]?.next === due;
	const early = withCancel(context);
	const watch = await runtime.watchDoc(Reminders, runtime.conversationId, context);
	watch?.start(async (doc) => {
		if (!pending(doc)) early.cancel();
	});
	try {
		if (watch !== undefined && pending(watch.value)) await runtime.sleep(due, early.context);
	} catch (error) {
		if (context.abortSignal?.aborted === true || early.context.abortSignal?.aborted !== true) throw error;
	} finally {
		await watch?.stop();
	}
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
				await sleepUnlessChanged(runtime, task.input.id, due, context);
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
