import type { Context } from "@earendil-works/chord";
import type { TSchema } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	defineExtension,
	type Extension,
	section,
	type ToolExecutionApi,
	type ToolRegistration,
	type Tx,
} from "@earendil-works/pi-durable";
import { ChatInfo, ChatMap, chatKey } from "../../channel/docs.ts";
import type { PluginContext } from "../load.ts";
import { REMIND_TASK, type Reminder, Reminders, type ReminderTask } from "./task.ts";
import { type Every, formatLocal, parseAt, parseEvery, serverZone, validZone, wallOf } from "./time.ts";

export const MAX_PENDING = 100;
const MAX_AHEAD_MS = 366 * 24 * 60 * 60_000;
type Options = { readonly tz: string; readonly now: () => number };
type Args = { op: string; text?: string; at?: string; in?: number; every?: string; id?: string };

const PARAMETERS = {
	type: "object",
	properties: {
		op: { type: "string", enum: ["add", "list", "cancel"], description: "add, list or cancel" },
		text: { type: "string", maxLength: 2000, description: "add: what to do or say when it comes due" },
		at: { type: "string", description: "add: local date-time such as 2026-10-15T09:00 (or with Z or an offset)" },
		in: { type: "integer", minimum: 1, description: "add: minutes from now, instead of at" },
		every: { type: "string", description: "add, optional: daily, weekdays, weekly or a number of minutes (5 or more)" },
		id: { type: "string", description: "cancel: the reminder id from list" },
	},
	required: ["op"],
} as unknown as TSchema;

/** Reminders live in the topic's main conversation, also when a helper sets them. */
async function rootOf(tx: Tx, conversationId: ConversationId): Promise<ConversationId> {
	const chat = await tx.doc(ChatInfo, conversationId);
	return ((await tx.doc(ChatMap)).chats[chatKey(chat.chatId, chat.threadId)] ?? conversationId) as ConversationId;
}

function dueOf(args: Args, now: number, tz: string): number {
	if ((args.at === undefined) === (args.in === undefined)) throw new Error("add needs exactly one of at or in");
	const due = args.at === undefined ? now + (args.in ?? 0) * 60_000 : parseAt(args.at, tz);
	if (due <= now) throw new Error(`${formatLocal(due, tz)} is in the past; now is ${formatLocal(now, tz)} (${tz})`);
	if (due - now > MAX_AHEAD_MS) throw new Error("a reminder can be at most 366 days ahead");
	return due;
}

const everyText = (every: Every | undefined): string =>
	every === undefined ? "" : typeof every === "number" ? `, then every ${every} min` : `, then ${every}`;

async function add(args: Args, api: ToolExecutionApi, context: Context, options: Options): Promise<string> {
	const text = args.text?.trim() ?? "";
	if (text === "") throw new Error("add needs text");
	const { tz } = options;
	const now = options.now();
	const due = dueOf(args, now, tz);
	const every = args.every?.trim() ? parseEvery(args.every) : undefined;
	const id = `r${api.taskId}`;
	const entry: Reminder = { text, next: due, wall: wallOf(due, tz), tz, setAt: now, ...(every ? { every } : {}) };
	const stored = await api.commit(async (tx) => {
		const root = await rootOf(tx, api.conversationId);
		const doc = await tx.doc(Reminders, root);
		if (Object.hasOwn(doc.items, id)) return { ...(doc.items[id] as Reminder) }; // a rerun after a restart
		if (Object.keys(doc.items).length >= MAX_PENDING)
			throw new Error(`${MAX_PENDING} reminders are pending; cancel some first`);
		doc.items[id] = entry;
		await tx.createTask(
			api.registry.task(REMIND_TASK) as unknown as ReminderTask,
			{ id, due },
			{ ownership: { kind: "conversation" }, background: true, conversationId: root },
		);
		return entry;
	}, context);
	return `Reminder ${id}: ${formatLocal(stored.next, tz)} (${tz})${everyText(stored.every)}.`;
}

async function list(api: ToolExecutionApi, context: Context, options: Options): Promise<string> {
	const items = await api.commit(async (tx) => {
		const doc = await tx.doc(Reminders, await rootOf(tx, api.conversationId));
		return Object.entries(doc.items).map(([id, r]) => [id, { ...r }] as const); // plain copies outlive the commit
	}, context);
	const lines = items
		.sort(([, a], [, b]) => a.next - b.next)
		.map(([id, r]) => `${id}  ${formatLocal(r.next, options.tz)}${everyText(r.every)}  ${r.text.slice(0, 80)}`);
	const head = `Now: ${formatLocal(options.now(), options.tz)} (${options.tz})`;
	return [head, ...(lines.length > 0 ? lines : ["No reminders."])].join("\n");
}

async function cancel(args: Args, api: ToolExecutionApi, context: Context): Promise<string> {
	const id = args.id?.trim() ?? "";
	const text = await api.commit(async (tx) => {
		const doc = await tx.doc(Reminders, await rootOf(tx, api.conversationId));
		const found = Object.hasOwn(doc.items, id) ? doc.items[id]?.text : undefined;
		delete doc.items[id];
		return found;
	}, context);
	if (text === undefined) throw new Error(`no reminder ${JSON.stringify(id)}; see op list`);
	return `Cancelled ${id}: ${text}`;
}

const SECTION = [
	"remind: op add sets a reminder: text plus at (a local date-time) or in (minutes), optional every (daily, weekdays,",
	"weekly or minutes); op list shows them with ids; op cancel removes one by id. Tell the user the time the tool returns.",
	"A message starting with [reminder …] is a reminder coming due: do what its text says and answer the user.",
	"There is no separate task list: keep lists in files in the working directory when asked.",
];

export function createRemindersExtension(options: Options): Extension {
	const tool: ToolRegistration = {
		name: "remind",
		description: "Set, list or cancel reminders. A due reminder wakes you with its text in this chat.",
		parameters: PARAMETERS,
		replay: "safe",
		execute: async (raw, api, context) => {
			const args = raw as Args;
			const text =
				args.op === "add"
					? await add(args, api, context, options)
					: args.op === "cancel"
						? await cancel(args, api, context)
						: await list(api, context, options);
			return { output: [{ type: "text", text }] };
		},
	};
	const today = () => `Today is ${formatLocal(options.now(), options.tz).slice(0, 14)}, time zone ${options.tz}.`;
	return defineExtension({
		name: "reminders",
		tools: [tool],
		sections: [section("reminders", () => [today(), ...SECTION].join("\n"))],
	});
}

export default function remindersPlugin(ctx: PluginContext): Extension {
	const wanted = ctx.env.PI_TIMEZONE?.trim();
	const tz = wanted && validZone(wanted) ? wanted : serverZone();
	if (wanted && tz !== wanted) ctx.problem(`PI_TIMEZONE=${wanted} is not a time zone; using ${tz}`);
	return createRemindersExtension({ tz, now: ctx.now });
}
