import type { Context } from "@earendil-works/chord";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	type AgentChange,
	type ConversationId,
	configure,
	defineDoc,
	defineExtension,
	defineTool,
	type Extension,
	type TaskId,
	type ToolExecutionApi,
	type Tx,
} from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { resolveModel } from "../agent/models.ts";
import { loadProvider } from "../agent/providers.ts";
import { ChatInfo } from "../channel/docs.ts";
import { THINKING_LEVELS } from "../config/schema.ts";
import { HELPER_TASK, type HelperTask } from "./helper-task.ts";
import type { PluginContext } from "./load.ts";

export const DEFAULT_HELPERS_MAX = 4;
type Ctx = Pick<PluginContext, "env" | "models" | "problem">;
type Settings = { readonly max: number; readonly change: AgentChange };
type Launch = { id: TaskId; child: ConversationId };

const HelperLaunch = defineDoc<{ launch?: Launch }>({
	kind: "tg.helper-launch",
	version: 1,
	checkpointWhen: () => false,
	scope: "task",
	initial: () => ({}),
});

const HelperSlots = defineDoc<{ ids: TaskId[] }>({
	kind: "tg.helper-slots",
	version: 1,
	checkpointWhen: () => false,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ ids: [] }),
});

async function activeHelpers(tx: Tx, ids: readonly TaskId[]): Promise<TaskId[]> {
	const active: TaskId[] = [];
	for (const id of ids) {
		const record = await tx.task(id);
		if (record !== undefined && record.state.status !== "terminal") active.push(id);
	}
	return active;
}

function parseMax(ctx: Ctx): number {
	const raw = ctx.env.PI_HELPERS_MAX?.trim();
	if (!raw) return DEFAULT_HELPERS_MAX;
	if (/^[1-9]\d{0,2}$/.test(raw)) return Number(raw);
	ctx.problem(`PI_HELPERS_MAX=${raw} is not a whole number from 1 to 999; using ${DEFAULT_HELPERS_MAX}`);
	return DEFAULT_HELPERS_MAX;
}

function parseThinking(ctx: Ctx): ModelThinkingLevel | undefined {
	const raw = ctx.env.PI_HELPER_THINKING?.trim();
	if (!raw) return undefined;
	if ((THINKING_LEVELS as readonly string[]).includes(raw)) return raw as ModelThinkingLevel;
	ctx.problem(`PI_HELPER_THINKING=${raw} is not one of ${THINKING_LEVELS.join(", ")}; helpers use the main level`);
	return undefined;
}

/** `provider/model`, with the provider registered when it is not the main one, and logged in. */
async function helperRef(ctx: Ctx, raw: string, thinkingLevel: ModelThinkingLevel) {
	const slash = raw.indexOf("/");
	if (slash <= 0 || slash === raw.length - 1) throw new Error("use provider/model");
	const ref = { provider: raw.slice(0, slash), modelId: raw.slice(slash + 1) };
	if (ctx.models.getModels(ref.provider).length === 0) {
		const provider = await loadProvider(ref.provider);
		if (provider === undefined) throw new Error(`unknown provider ${ref.provider}`);
		ctx.models.setProvider(provider);
	}
	resolveModel(ctx.models, ref, thinkingLevel);
	if ((await ctx.models.checkAuth(ref.provider)) === undefined)
		throw new Error(`not logged in: run pi-durable-telegram login ${ref.provider}`);
	return ref;
}

/** The helper's model and thinking level; any failure is a plugin problem and helpers keep the main model. */
async function modelChange(ctx: Ctx, thinking: ModelThinkingLevel | undefined): Promise<AgentChange> {
	const fallback = thinking === undefined ? {} : { thinkingLevel: thinking };
	const raw = ctx.env.PI_HELPER_MODEL?.trim();
	if (!raw) return fallback;
	try {
		const thinkingLevel = thinking ?? "off";
		return { model: await helperRef(ctx, raw, thinkingLevel), thinkingLevel };
	} catch (error) {
		const reason = (error instanceof Error ? error.message : String(error)).replace(/^PI_[A-Z_]+: /, "");
		ctx.problem(`PI_HELPER_MODEL=${raw}: ${reason}; helpers use the main model`);
		return fallback;
	}
}

/** Persist the launch receipt with the job so replay of the tool cannot start a second helper. */
async function startHelper(task: string, api: ToolExecutionApi, context: Context, self: Extension, settings: Settings) {
	const result = await api.commit(async (tx) => {
		const receipt = await tx.doc(HelperLaunch, api.taskId);
		if (receipt.launch !== undefined) return { launch: { ...receipt.launch } };
		const legacy = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
		if (legacy !== undefined) return { legacy: legacy.id };

		const slots = await tx.doc(HelperSlots, api.conversationId);
		const active = await activeHelpers(tx, slots.ids);
		if (active.length >= settings.max)
			throw new Error(`${active.length} helpers are already running; wait for their answers, then call helper again.`);

		const id = await tx.createTask(
			api.registry.task(HELPER_TASK) as unknown as HelperTask,
			{ task },
			{
				ownership: { kind: "conversation" },
				background: true,
			},
		);
		const created = await tx.createConversation({ ownership: { kind: "task", taskId: id } });
		await configure(tx, created.id, { ...settings.change, extensions: { remove: [self] } });
		(await tx.doc(ChatInfo, created.id)).chatId = (await tx.doc(ChatInfo, api.conversationId)).chatId;
		slots.ids = [...active, id];
		const launch = { id, child: created.id };
		receipt.launch = launch;
		return { launch };
	}, context);
	if (result.legacy !== undefined) {
		await (await api.conversation(result.legacy, context))?.abort(context);
		throw new Error("A helper from before the upgrade was interrupted. Check its work before retrying.");
	}
	const { id, child } = result.launch;
	const text = `Helper h${id} started in the background. Its report will arrive as a separate message.`;
	return { output: [{ type: "text" as const, text }], details: { conversationId: child } };
}

export function createHelpersExtension(settings: Settings): Extension {
	const extension: Extension = defineExtension({
		name: "helpers",
		tools: [
			defineTool({
				name: "helper",
				description:
					"Start a helper with the same tools in the background and return its id immediately. Its report arrives " +
					"as a new message, [helper <id> done|error|interrupted]. Continue your turn after starting it. The helper " +
					"cannot see this chat: put everything it needs into task. Several helper calls in one turn run in parallel, " +
					`at most ${settings.max} at a time.`,
				parameters: obj(
					{
						task: str({ minLength: 1, description: "The whole task, with all the context it needs" }),
					},
					{ open: true },
				),
				replay: "safe",
				execute: ({ task }, api, context) => startHelper(task, api, context, extension, settings),
			}),
		],
	});
	return extension;
}

export default async function helpersPlugin(ctx: PluginContext): Promise<Extension> {
	const max = parseMax(ctx);
	return createHelpersExtension({ max, change: await modelChange(ctx, parseThinking(ctx)) });
}
