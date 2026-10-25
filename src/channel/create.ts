import type { Context } from "@earendil-works/chord";
import type { Models, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Extension, Harness, ModelRef } from "@earendil-works/pi-durable";
import { Bot, GrammyError } from "grammy";
import type { Update } from "grammy/types";
import { createCompactReportTask } from "../delivery/compact-report.ts";
import { createDeliverTask } from "../delivery/task.ts";
import type { DeliveryDeps } from "../delivery/types.ts";
import type { Stt } from "../media/stt.ts";
import type { PluginReport } from "../plugins/load.ts";
import type { FatalHandler } from "../runtime/fatal.ts";
import { createLogger, errorSummary, type Logger } from "../runtime/log.ts";
import { packageVersion } from "../runtime/version.ts";
import { DOWNLOAD_LIMIT_BYTES } from "../telegram/download.ts";
import { telegramErrorSummary } from "../telegram/errors.ts";
import { createGrammyPort } from "../telegram/grammy-port.ts";
import type { TelegramPort } from "../telegram/port.ts";
import { createRetryTransformer } from "../telegram/retry.ts";
import { COMMANDS } from "./commands/list.ts";
import { ConversationDirectory } from "./conversations.ts";
import { createTelegramExtension } from "./extension.ts";
import { handleUpdate } from "./handlers.ts";
import type { ChannelRuntime } from "./scope.ts";
import type { TopicNamesMode } from "./topic-names.ts";

export type TelegramChannelOptions = {
	readonly botToken: string;
	/** Telegram user ids allowed to talk to the agent; must not be empty. */
	readonly allowedUserIds: readonly number[];
	/** The agent's working directory; attachments go to `<workdir>/inbox/`. */
	readonly workdir: string;
	readonly model: ModelRef;
	readonly thinkingLevel: ModelThinkingLevel;
	/** Speech to text for voice messages; without it voice gets a "not configured" reply. */
	readonly stt?: Stt;
	/** Bot API root; default https://api.telegram.org. */
	readonly apiRoot?: string;
	/** Answers as rich messages (buttons, tables) streamed as native drafts; default false: HTML messages. */
	readonly rich?: boolean;
	/** Auto-name observed implicit topic names once; manual mode renames only when the user asks. Default auto. */
	readonly topicNames?: TopicNamesMode;
	readonly log?: Logger;
	readonly limits?: { readonly downloadBytes?: number; readonly uploadBytes?: number };
	/** Used by /status for the context window and auth state. */
	readonly models?: Models;
	/** Replace the grammY transport (tests, proxies). Polling still uses grammY with `botToken`. */
	readonly port?: TelegramPort;
	/** The service cannot continue (failed storage, bad token, another poller). Default: log and exit. */
	readonly onFatal?: FatalHandler;
	/** Minimum pause between preview edits (default 1000 ms). */
	readonly previewIntervalMs?: number;
	/** Pauses between final preview edits while Telegram is unreachable, before a new message is sent instead. */
	readonly editRetryDelaysMs?: readonly number[];
};

export interface TelegramChannel {
	/** Install before `Harness.open`: delivery/reminder tasks and the Telegram file/topic tools. */
	readonly extension: Extension;
	/**
	 * After `Harness.open`: applies the configured agent to existing chats, registers commands, calls
	 * `harness.resume()` and starts long polling. Resolves once polling runs. Nothing else may start the scheduler first.
	 */
	start(
		harness: Harness,
		context: Context,
		options?: { readonly polling?: boolean; readonly plugins?: PluginReport },
	): Promise<void>;
	/**
	 * Drain in-flight handlers, then stop polling and confirm the handled updates. An update whose handler did not
	 * finish, or that arrived during shutdown, stays unconfirmed so Telegram redelivers it. Does not close the harness.
	 */
	stop(): Promise<void>;
	/** Handle one update from another source (a webhook, tests). Requires `start()`. */
	handleUpdate(update: Update): Promise<void>;
}

/** Exit code and message for errors that stop polling for good. */
export class PollingError extends Error {
	readonly exitCode: number;
	constructor(message: string, exitCode: number) {
		super(message);
		this.name = "PollingError";
		this.exitCode = exitCode;
	}
}

export function pollingFailure(error: unknown): PollingError {
	if (error instanceof GrammyError && error.error_code === 401)
		return new PollingError("Telegram rejected the bot token (401)", 2);
	if (error instanceof GrammyError && error.error_code === 409) {
		return new PollingError("Another process polls this bot token (409 Conflict)", 1);
	}
	return new PollingError(`Telegram polling failed: ${errorSummary(error)}`, 1);
}

const defaultFatal =
	(log: Logger): FatalHandler =>
	(reason, error, exitCode) => {
		log.error("fatal", { reason, error: error === undefined ? undefined : errorSummary(error) });
		process.exit(exitCode ?? 1);
	};

/** Create the Telegram channel for a pi-durable app. See `TelegramChannel` for the two-step lifecycle. */
export function createTelegramChannel(options: TelegramChannelOptions): TelegramChannel {
	if (options.allowedUserIds.length === 0) throw new Error("allowedUserIds must not be empty");
	const log = options.log ?? createLogger();
	const onFatal = options.onFatal ?? defaultFatal(log);
	const apiRoot = options.apiRoot ?? "https://api.telegram.org";
	const bot = new Bot(options.botToken, { client: { apiRoot, timeoutSeconds: 75 } });
	bot.api.config.use(createRetryTransformer());
	const port = options.port ?? createGrammyPort({ token: options.botToken, apiRoot, api: bot.api });
	let harness: Harness | undefined;
	const deps: DeliveryDeps = {
		port: () => port,
		harness: () => {
			if (harness === undefined) throw new Error("Telegram channel used before start()");
			return harness;
		},
		log,
		model: options.model,
		onFatal,
		rich: options.rich === true,
		...(options.previewIntervalMs === undefined ? {} : { previewIntervalMs: options.previewIntervalMs }),
		...(options.editRetryDelaysMs === undefined ? {} : { editRetryDelaysMs: options.editRetryDelaysMs }),
	};
	const deliver = createDeliverTask(deps);
	const compactReport = createCompactReportTask(deps);
	const extension = createTelegramExtension({
		deliver,
		compactReport,
		port: () => port,
		log,
		allowed: new Set(options.allowedUserIds),
		topicNames: options.topicNames ?? "auto",
		...(options.limits?.uploadBytes === undefined ? {} : { uploadLimit: options.limits.uploadBytes }),
	});
	const lifecycle = new Lifecycle({ options, log, onFatal, bot, port, deliver, compactReport });
	return {
		extension,
		start: async (opened, context, startOptions) => {
			harness = opened;
			const plugins = startOptions?.plugins ?? { loaded: [], problems: [] };
			await lifecycle.start(opened, context, startOptions?.polling ?? true, plugins);
		},
		stop: () => lifecycle.stop(),
		handleUpdate: (update) => lifecycle.handle(update),
	};
}

type LifecycleDeps = {
	options: TelegramChannelOptions;
	log: Logger;
	onFatal: FatalHandler;
	bot: Bot;
	port: TelegramPort;
	deliver: ChannelRuntime["deliver"];
	compactReport: ChannelRuntime["compactReport"];
};

const DRAIN_MS = 5000;

class Lifecycle {
	readonly #d: LifecycleDeps;
	readonly #tracked = new Set<Promise<unknown>>();
	#rt: ChannelRuntime | undefined;
	#polling: Promise<void> | undefined;
	#stopping = false;
	/** A polling update's handler is running. */
	#pollingBusy = false;
	/** An update arrived after stop() began; grammY's loop is parked on it. */
	#parked = false;
	/** grammY's loop waits on a handler that never settles; it issues no further getUpdates. */
	#frozen = false;

	constructor(deps: LifecycleDeps) {
		this.#d = deps;
	}

	async start(harness: Harness, context: Context, polling: boolean, plugins: PluginReport): Promise<void> {
		const rt = this.#runtime(harness, plugins);
		this.#rt = rt;
		// A failed Session aborts running work before it can report; this is the one place it becomes fatal.
		void harness.closed.then((end) => {
			if (end.reason === "failed") this.#d.onFatal("storage failure", end.error);
		});
		const changed = await rt.directory.reconfigureAll(context);
		if (changed > 0) this.#d.log.info("chats_reconfigured", { count: changed });
		await this.#d.port.setMyCommands(COMMANDS).catch((error: unknown) => {
			this.#d.log.warn("set_commands_failed", telegramErrorSummary(error));
		});
		harness.resume();
		if (polling) await this.#startPolling(rt);
		this.#notifyPlugins(rt);
	}

	/** Once per start, not durable: each allowed user gets one line per plugin problem. */
	#notifyPlugins(rt: ChannelRuntime): void {
		if (rt.plugins.problems.length === 0) return;
		const text = rt.plugins.problems.map((problem) => `Plugin ${problem.plugin}: ${problem.reason}`).join("\n");
		for (const chat of rt.allowed) {
			const send = rt.port.sendMessage(chat, text, {});
			rt.track(
				send.catch((error: unknown) => rt.log.warn("plugin_notice_failed", { chat, ...telegramErrorSummary(error) })),
			);
		}
	}

	#runtime(harness: Harness, plugins: PluginReport): ChannelRuntime {
		const { options, log, port } = this.#d;
		const defaults = { model: options.model, thinkingLevel: options.thinkingLevel, cwd: options.workdir };
		return {
			harness,
			directory: new ConversationDirectory(harness, defaults),
			port,
			log,
			allowed: new Set(options.allowedUserIds),
			workdir: options.workdir,
			stt: options.stt,
			models: options.models,
			model: options.model,
			downloadLimit: options.limits?.downloadBytes ?? DOWNLOAD_LIMIT_BYTES,
			deliver: this.#d.deliver,
			compactReport: this.#d.compactReport,
			startedAt: Date.now(),
			version: packageVersion(),
			track: (work) => this.#track(work),
			onFatal: this.#d.onFatal,
			now: () => new Date(),
			plugins,
		};
	}

	#startPolling(rt: ChannelRuntime): Promise<void> {
		const { bot, log } = this.#d;
		bot.use((ctx) => this.#fromPolling(ctx.update));
		bot.catch((error) =>
			log.error("bot_error", { update_id: error.ctx.update.update_id, ...telegramErrorSummary(error.error) }),
		);
		return new Promise<void>((resolve, reject) => {
			let started = false;
			this.#polling = bot
				.start({
					allowed_updates: ["message", "callback_query", "stopped_message_generation"],
					onStart: (info) => {
						started = true;
						log.info("polling_started", { bot: info.username, allowed_users: rt.allowed.size });
						resolve();
					},
				})
				.catch((error: unknown) => {
					const failure = pollingFailure(error);
					if (!started) reject(failure);
					else if (!this.#stopping) this.#d.onFatal(failure.message, undefined, failure.exitCode);
				});
		});
	}

	handle(update: Update): Promise<void> {
		const rt = this.#rt;
		if (rt === undefined || this.#stopping) return Promise.resolve();
		const work = handleUpdate(rt, update);
		this.#track(work);
		return work;
	}

	/**
	 * grammY marks an update as tried before running its handler and confirms it on `bot.stop()`. During shutdown an
	 * arriving update is parked (its handler never settles, so the loop stops on it) and left unconfirmed for the next
	 * process; a handler still running is waited for and, if it does not finish, left unconfirmed too.
	 */
	#fromPolling(update: Update): Promise<void> {
		if (this.#stopping) {
			this.#parked = true;
			return this.#freeze();
		}
		this.#pollingBusy = true;
		const work = this.handle(update).finally(() => {
			this.#pollingBusy = false;
		});
		// Once stopping, the loop must not move on: its next getUpdates would confirm what it just tried.
		return work.then(() => (this.#stopping ? this.#freeze() : undefined));
	}

	#freeze(): Promise<void> {
		this.#frozen = true;
		return new Promise<void>(() => {});
	}

	#track(work: Promise<unknown>): void {
		const settled = work.catch(() => undefined);
		this.#tracked.add(settled);
		void settled.finally(() => this.#tracked.delete(settled));
	}

	async stop(): Promise<void> {
		this.#stopping = true;
		await withTimeout(Promise.allSettled([...this.#tracked]), DRAIN_MS);
		// Checked synchronously right before bot.stop() computes its offset: no update can slip in between.
		if (this.#pollingBusy || this.#parked) {
			this.#d.log.warn("polling_left_unconfirmed", {
				reason: this.#parked ? "update during shutdown" : "handler running",
			});
			return;
		}
		await this.#stopPolling();
	}

	async #stopPolling(): Promise<void> {
		const { bot, log } = this.#d;
		if (bot.isRunning())
			await withTimeout(bot.stop(), DRAIN_MS).catch((error: unknown) =>
				log.warn("polling_stop_failed", { error: errorSummary(error) }),
			);
		if (!this.#frozen) await withTimeout(this.#polling ?? Promise.resolve(), DRAIN_MS);
	}
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => resolve(undefined), ms);
		timer.unref();
	});
	return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
