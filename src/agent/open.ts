import { join } from "node:path";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import type { AuthContext, MutableModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { FileCredentialStore } from "../auth/credential-store.ts";
import { createTelegramChannel, type TelegramChannel } from "../channel/create.ts";
import type { Config } from "../config/schema.ts";
import { createDeepgramStt } from "../media/deepgram.ts";
import type { Stt } from "../media/stt.ts";
import { type LoadedPlugins, loadPlugins } from "../plugins/load.ts";
import type { FatalHandler } from "../runtime/fatal.ts";
import { errorSummary, type Logger, silentLogger } from "../runtime/log.ts";
import { ensurePrivateDir, makePrivate } from "../runtime/private-dir.ts";
import type { TelegramPort } from "../telegram/port.ts";
import { createEmptyAnswerExtension } from "./empty-answer.ts";
import { createAgentModels, resolveModel, StartupError } from "./models.ts";
import { createPromptExtension } from "./prompt.ts";
import { createSettings } from "./settings.ts";
import { buildSafeEnv } from "./tools/bash.ts";
import { createWorkspaceTools } from "./tools/workspace-tools.ts";

export type Agent = {
	readonly harness: Harness;
	readonly models: MutableModels;
	readonly channel: TelegramChannel;
	readonly config: Config;
	readonly plugins: LoadedPlugins;
};

export type OpenAgentDeps = {
	/** Models to use instead of the configured provider (tests use pi-ai's faux provider). */
	readonly models?: MutableModels;
	readonly authContext?: AuthContext;
	readonly port?: TelegramPort;
	readonly stt?: Stt;
	readonly log?: Logger;
	readonly onFatal?: FatalHandler;
	/** Environment the agent's bash sees, before the allowlist filter; default `process.env`. */
	readonly shellEnv?: Readonly<Record<string, string | undefined>>;
	/** Environment plugins read, secrets included; default `process.env`. */
	readonly pluginEnv?: Readonly<Record<string, string | undefined>>;
	readonly previewIntervalMs?: number;
	readonly editRetryDelaysMs?: readonly number[];
	readonly limits?: { readonly downloadBytes?: number; readonly uploadBytes?: number };
	readonly now?: () => number;
};

export const DATABASE_FILE = "durable.sqlite";

/**
 * Open the agent: models and auth check, the Telegram channel, the registry (workspace tools, prompt, empty-answer
 * nudge, channel) and the Harness over SQLite in the data directory. The caller then runs `channel.start()`.
 */
export async function openAgent(config: Config, deps: OpenAgentDeps = {}): Promise<Agent> {
	const log = deps.log ?? silentLogger;
	await ensurePrivateDir(config.dataDir);
	const models = deps.models ?? (await defaultModels(config, deps.authContext));
	const ref = { provider: config.provider, modelId: config.modelId };
	const model = resolveModel(models, ref, config.thinkingLevel);
	if ((await models.checkAuth(config.provider)) === undefined) {
		throw new StartupError(`not logged in: run \`pi-durable-telegram login ${config.provider}\``, 4);
	}
	const channel = createTelegramChannel({
		botToken: config.botToken,
		allowedUserIds: config.allowedUserIds,
		workdir: config.workdir,
		model: ref,
		thinkingLevel: config.thinkingLevel,
		apiRoot: config.telegramApiRoot,
		rich: config.telegramRich === "auto",
		topicNames: config.telegramTopicNames,
		log,
		models,
		...optional({
			stt: deps.stt ?? sttFor(config),
			port: deps.port,
			onFatal: deps.onFatal,
			previewIntervalMs: deps.previewIntervalMs,
			editRetryDelaysMs: deps.editRetryDelaysMs,
			limits: deps.limits,
		}),
	});
	const registry = createRegistry();
	registry.install(createWorkspaceTools({ env: buildSafeEnv(deps.shellEnv ?? process.env) }));
	registry.install(
		createPromptExtension({ instructionsPath: config.instructionsPath, rich: config.telegramRich === "auto" }),
	);
	registry.install(createEmptyAnswerExtension());
	registry.install(channel.extension);
	const snapshot = registry.snapshot();
	const names = [...snapshot.installed(), ...snapshot.tools().map((entry) => entry.tool)].map((x) => x.name);
	const taken = new Set([...names, ...snapshot.sections().map((entry) => `section:${entry.section.key}`)]);
	const env = deps.pluginEnv ?? process.env;
	const base = { env, workdir: config.workdir, dataDir: config.dataDir, log, models, now: deps.now ?? Date.now };
	const plugins = await loadPlugins(config.plugins, base, taken, (extension) => registry.install(extension));
	const database = join(config.dataDir, DATABASE_FILE);
	const failed = async (error: unknown): Promise<never> => {
		await plugins.close();
		throw error;
	};
	const storage = await openNodeSqliteStorage(database).catch(failed);
	await makePrivate([database, `${database}-wal`, `${database}-shm`]).catch(failed);
	const harness = await Harness.open(
		storage,
		{
			models,
			registry,
			settings: createSettings({ ...optional({ contextCap: config.contextCap }), contextWindow: model.contextWindow }),
			env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? config.workdir }),
			onReport: (error) => log.warn("harness_report", { error: errorSummary(error) }),
			...optional({ now: deps.now }),
		},
		BG,
	).catch(failed);
	await checkTasks(harness).catch(failed);
	return { harness, models, channel, config, plugins };
}

function optional<T extends Record<string, unknown>>(values: T): Partial<T> {
	return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as Partial<T>;
}

async function defaultModels(config: Config, authContext: AuthContext | undefined): Promise<MutableModels> {
	const credentials = new FileCredentialStore(config.authFile);
	return createAgentModels({ provider: config.provider, credentials, ...optional({ authContext }) });
}

function sttFor(config: Config): Stt | undefined {
	return config.deepgramApiKey === undefined ? undefined : createDeepgramStt(config.deepgramApiKey);
}

/** Refuse to run when unfinished tasks have no registered definition: they would stay blocked forever. */
async function checkTasks(harness: Harness): Promise<void> {
	const inspection = await harness.inspect(BG);
	const blocked = inspection.tasks.filter((task) => task.state.kind === "blocked").map((task) => task.record.kind);
	if (blocked.length === 0) return;
	await harness.close(BG);
	throw new StartupError(`unfinished tasks without a definition: ${[...new Set(blocked)].join(", ")}`, 1);
}
