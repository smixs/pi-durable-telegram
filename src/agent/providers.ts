import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { piAgentDir } from "../config/pi-home.ts";

interface ModelsJsonModel {
	readonly id: string;
	readonly name?: string;
	readonly api?: Api;
	readonly reasoning?: boolean;
	readonly contextWindow?: number;
	readonly maxTokens?: number;
	readonly input?: readonly string[];
}

interface ModelsJsonProvider {
	readonly name?: string;
	readonly baseUrl?: string;
	readonly api?: Api;
	readonly apiKey?: string;
	readonly models?: readonly ModelsJsonModel[];
}

interface ModelsJsonFile {
	readonly providers?: Readonly<Record<string, ModelsJsonProvider>>;
}

function readProviderConfig(id: string, agentDir: string): ModelsJsonProvider | undefined {
	const modelsPath = join(agentDir, "models.json");
	if (!existsSync(modelsPath)) return undefined;

	try {
		const raw = readFileSync(modelsPath, "utf8");
		const parsed = JSON.parse(raw) as ModelsJsonFile;
		return parsed?.providers?.[id];
	} catch {
		return undefined;
	}
}

function parseApiKeyConfig(apiKey: string | undefined): { envVar?: string; staticKey?: string } {
	if (!apiKey) return {};
	const m = apiKey.match(/^\$\{?([A-Za-z0-9_]+)\}?$/);
	return m?.[1] ? { envVar: m[1] } : { staticKey: apiKey };
}

function createModelList(
	models: readonly ModelsJsonModel[] | undefined,
	providerId: string,
	defaultApi: Api,
	baseUrl: string,
): Model<Api>[] {
	return (models ?? []).map((m) => ({
		id: m.id,
		name: m.name ?? m.id,
		api: m.api ?? defaultApi,
		baseUrl,
		provider: providerId,
		reasoning: m.reasoning ?? true,
		thinkingLevelMap: {
			off: "off",
			minimal: "low",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "max",
			max: "max",
		},
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: m.contextWindow ?? 128_000,
		maxTokens: m.maxTokens ?? 16_384,
		input: (m.input as ("text" | "image")[]) ?? ["text"],
		type: "chat",
	}));
}

function loadFromModelsJson(id: string, agentDir = piAgentDir(process.env)): Provider | undefined {
	const config = readProviderConfig(id, agentDir);
	if (!config) return undefined;

	const apiName: Api = config.api ?? "openai-completions";
	const apiImpl = getApiProvider(apiName);
	if (!apiImpl) return undefined;

	const { envVar, staticKey } = parseApiKeyConfig(config.apiKey);
	const baseUrl = config.baseUrl ?? "";
	const modelsList = createModelList(config.models, id, apiName, baseUrl);

	return {
		id,
		name: config.name ?? id,
		baseUrl,
		auth: {
			apiKey: {
				name: `${config.name ?? id} API key`,
				resolve: async ({ ctx, credential, signal }) => {
					signal?.throwIfAborted();
					if (credential?.key) {
						return { auth: { apiKey: credential.key }, source: "stored credential" };
					}
					if (staticKey) {
						return { auth: { apiKey: staticKey }, source: "models.json" };
					}
					if (envVar) {
						const val = (await ctx?.env?.(envVar)) ?? process.env[envVar];
						if (val) return { auth: { apiKey: val }, source: envVar };
					}
					return undefined;
				},
			},
		},
		getModels: () => modelsList,
		getAllModels: () => modelsList,
		stream: (model, context, options) => apiImpl.stream(model, context, options),
		streamSimple: (model, context, options) => apiImpl.streamSimple(model, context, options),
	};
}

/**
 * The pi-ai provider for an id. Anthropic is loaded directly; any other built-in provider comes from the full
 * catalog, which is loaded only when needed. Custom providers defined in `models.json` serve as fallback.
 */
export async function loadProvider(id: string): Promise<Provider | undefined> {
	if (id === "anthropic") return anthropicProvider() as unknown as Provider;
	const { builtinProviders } = await import("@earendil-works/pi-ai/providers/all");
	const builtin = builtinProviders().find((provider) => provider.id === id);
	if (builtin) return builtin;
	return loadFromModelsJson(id);
}
