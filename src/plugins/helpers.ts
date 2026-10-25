import type { Context } from "@earendil-works/chord";
import { type ModelThinkingLevel, Type } from "@earendil-works/pi-ai";
import {
	type AgentChange,
	AssistantEntry,
	type ConversationId,
	configure,
	defineExtension,
	defineTool,
	type Extension,
	type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { resolveModel } from "../agent/models.ts";
import { loadProvider } from "../agent/providers.ts";
import { ChatInfo } from "../channel/docs.ts";
import { THINKING_LEVELS } from "../config/schema.ts";
import { finalReplyText } from "../delivery/final-text.ts";
import type { PluginContext } from "./load.ts";

export const DEFAULT_HELPERS_MAX = 4;
type Ctx = Pick<PluginContext, "env" | "models" | "problem">;
type Settings = { readonly max: number; readonly change: AgentChange };

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

/**
 * The child conversation is owned by this tool call's task: found again after a restart through the ownership index,
 * aborted with the call, and given the same chat so its tools reach the user. Without `self` it cannot start helpers.
 */
async function runHelper(task: string, api: ToolExecutionApi, context: Context, self: Extension, settings: Settings) {
	const child = await api.commit(async (tx) => {
		const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
		if (existing !== undefined) return existing.id;
		const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
		await configure(tx, created.id, { ...settings.change, extensions: { remove: [self] } });
		Object.assign(await tx.doc(ChatInfo, created.id), await tx.doc(ChatInfo, api.conversationId));
		return created.id;
	}, context);
	await api.details({ conversationId: child }, context);
	const handle = await api.conversation(child, context);
	if (handle === undefined) throw new Error("the helper's conversation is missing");
	const request = { type: "input", content: task, requestId: `helper:${api.taskId}` } as const;
	const settled = await (await handle.submit(request, context)).wait(context);
	if (settled.status !== "done" || settled.type !== "input")
		throw new Error(`the helper gave no answer (${settled.status === "unanswered" ? settled.reason : settled.type})`);
	const answer = settled.answer;
	const entry = await api.commit((tx) => tx.entry(AssistantEntry, answer), context);
	const text = finalReplyText(entry?.model?.[0]) ?? "(the helper answered with no text)";
	return { output: [{ type: "text" as const, text }], details: { conversationId: child } };
}

export function createHelpersExtension(settings: Settings): Extension {
	const running = new Map<ConversationId, number>();
	const release = (id: ConversationId) => {
		const left = (running.get(id) ?? 1) - 1;
		if (left > 0) running.set(id, left);
		else running.delete(id);
	};
	const extension: Extension = defineExtension({
		name: "helpers",
		tools: [
			defineTool({
				name: "helper",
				description:
					"Give a self-contained task to a helper agent with the same tools and get its final answer. The helper does " +
					"not see this chat: put everything it needs into task. Several helper calls in one turn run in parallel, " +
					`at most ${settings.max} at a time.`,
				parameters: Type.Object({
					task: Type.String({ minLength: 1, description: "The whole task, with all the context it needs" }),
				}),
				replay: "safe",
				execute: async ({ task }, api, context) => {
					const count = running.get(api.conversationId) ?? 0;
					if (count >= settings.max)
						throw new Error(`${count} helpers are already running; wait for their answers, then call helper again.`);
					running.set(api.conversationId, count + 1);
					try {
						return await runHelper(task, api, context, extension, settings);
					} finally {
						release(api.conversationId);
					}
				},
			}),
		],
	});
	return extension;
}

export default async function helpersPlugin(ctx: PluginContext): Promise<Extension> {
	const max = parseMax(ctx);
	return createHelpersExtension({ max, change: await modelChange(ctx, parseThinking(ctx)) });
}
