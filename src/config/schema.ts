import { isAbsolute, join, resolve } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { LogLevel } from "../runtime/log.ts";
import { piAgentDir, resolveAuthFile } from "./pi-home.ts";

export type Config = {
	readonly botToken: string;
	readonly allowedUserIds: readonly number[];
	readonly provider: string;
	readonly modelId: string;
	readonly thinkingLevel: ModelThinkingLevel;
	readonly workdir: string;
	readonly dataDir: string;
	/** Credentials file: `PI_AUTH_FILE`, else pi's shared `auth.json` (see `resolveAuthFile`). */
	readonly authFile: string;
	readonly instructionsPath: string;
	readonly deepgramApiKey: string | undefined;
	readonly telegramApiRoot: string;
	/** `auto`: answers as rich messages with buttons and native drafts; `never`: HTML messages only. */
	readonly telegramRich: "auto" | "never";
	readonly logLevel: LogLevel;
	readonly contextCap: number | undefined;
	/** `PI_PLUGINS`: built-in names, paths or npm package names, in load order. */
	readonly plugins: readonly string[];
};

export type ConfigProblem = { readonly variable: string; readonly message: string };

/** Every problem found in the environment, one per line; never carries a secret value. */
export class ConfigError extends Error {
	readonly problems: readonly ConfigProblem[];
	constructor(problems: readonly ConfigProblem[]) {
		super(problems.map((problem) => `${problem.variable}: ${problem.message}`).join("\n"));
		this.name = "ConfigError";
		this.problems = problems;
	}
}

export type Env = Readonly<Record<string, string | undefined>>;
export type ConfigDefaults = {
	readonly cwd: string;
	readonly home: string;
	/** File existence check for choosing the credentials file; defaults to the real file system. */
	readonly exists?: (path: string) => boolean;
};

export const THINKING_LEVELS: readonly ModelThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];
const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export const DEFAULT_PROVIDER = "anthropic";
export const DEFAULT_MODEL = "claude-opus-5-5";
export const DEFAULT_THINKING: ModelThinkingLevel = "high";

type Collector = { problems: ConfigProblem[]; add(variable: string, message: string): void };

function collector(): Collector {
	const problems: ConfigProblem[] = [];
	return { problems, add: (variable, message) => problems.push({ variable, message }) };
}

/** Parse and validate the environment. Pure: defaults for paths come from `defaults`. Throws `ConfigError`. */
export function parseConfig(env: Env, defaults: ConfigDefaults = { cwd: process.cwd(), home: homeOf(env) }): Config {
	const out = collector();
	const botToken = parseBotToken(env.TELEGRAM_BOT_TOKEN, out);
	const allowedUserIds = parseAllowedUserIds(env.TELEGRAM_ALLOWED_USER_IDS, out);
	const provider = parseProvider(env.PI_PROVIDER, out);
	const modelId = parseNonEmpty("PI_MODEL", env.PI_MODEL, DEFAULT_MODEL, out);
	const thinkingLevel = parseEnum("PI_THINKING", env.PI_THINKING, THINKING_LEVELS, DEFAULT_THINKING, out);
	const workdir = resolvePath(nonEmpty(env.PI_WORKDIR) ?? defaults.cwd, defaults.cwd);
	const dataDir = dataDirFromEnv(env, defaults);
	const authFile = authFileFromEnv(env, defaults);
	const instructionsPath = resolvePath(nonEmpty(env.PI_INSTRUCTIONS) ?? join(workdir, "AGENTS.md"), workdir);
	const deepgramApiKey = parseOptionalSecret("DEEPGRAM_API_KEY", env.DEEPGRAM_API_KEY, out);
	const telegramApiRoot = parseApiRoot(env.TELEGRAM_API_ROOT, out);
	const telegramRich = parseEnum("TELEGRAM_RICH", env.TELEGRAM_RICH, ["auto", "never"] as const, "auto", out);
	const logLevel = parseEnum("PI_LOG_LEVEL", env.PI_LOG_LEVEL, LOG_LEVELS, "info", out);
	const contextCap = parseContextCap(env.PI_CONTEXT_CAP, out);
	const plugins = parseList(env.PI_PLUGINS);
	if (out.problems.length > 0) throw new ConfigError(out.problems);
	return {
		botToken,
		allowedUserIds,
		provider,
		modelId,
		thinkingLevel,
		workdir,
		dataDir,
		authFile,
		instructionsPath,
		deepgramApiKey,
		telegramApiRoot,
		telegramRich,
		logLevel,
		contextCap,
		plugins,
	};
}

/** A comma-separated list: items trimmed, blanks and repeats dropped, first-appearance order kept. */
export function parseList(value: string | undefined): string[] {
	return [...new Set((value ?? "").split(",").map((item) => item.trim()))].filter((item) => item !== "");
}

function homeOf(env: Env): string {
	return nonEmpty(env.HOME) ?? process.cwd();
}

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

function resolvePath(path: string, base: string): string {
	return isAbsolute(path) ? resolve(path) : resolve(base, path);
}

/** `PI_DATA_DIR`, else `$XDG_STATE_HOME/pi-durable-telegram`, else `~/.local/state/pi-durable-telegram`. */
export function dataDirFromEnv(env: Env, defaults: ConfigDefaults = { cwd: process.cwd(), home: homeOf(env) }): string {
	return resolvePath(nonEmpty(env.PI_DATA_DIR) ?? defaultDataDir(env, defaults.home), defaults.cwd);
}

/** The credentials file the daemon and `login` share; see `resolveAuthFile`. */
export function authFileFromEnv(
	env: Env,
	defaults: ConfigDefaults = { cwd: process.cwd(), home: homeOf(env) },
): string {
	const paths = { agentDir: piAgentDir(env, defaults.home), dataDir: dataDirFromEnv(env, defaults), cwd: defaults.cwd };
	return resolveAuthFile(env, paths, defaults.exists);
}

function defaultDataDir(env: Env, home: string): string {
	const state = nonEmpty(env.XDG_STATE_HOME);
	return join(state ?? join(home, ".local", "state"), "pi-durable-telegram");
}

export const BOT_TOKEN_PATTERN = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;

function parseBotToken(value: string | undefined, out: Collector): string {
	const token = nonEmpty(value);
	if (token === undefined) out.add("TELEGRAM_BOT_TOKEN", "required (from @BotFather)");
	else if (!BOT_TOKEN_PATTERN.test(token)) out.add("TELEGRAM_BOT_TOKEN", "does not look like a bot token");
	return token ?? "";
}

/** Comma-separated positive Telegram user ids; at least one; duplicates collapsed. */
export function parseAllowedUserIds(value: string | undefined, out: Collector = collector()): number[] {
	const raw = nonEmpty(value);
	if (raw === undefined) {
		out.add("TELEGRAM_ALLOWED_USER_IDS", "required: comma-separated Telegram user ids");
		return [];
	}
	const ids = new Set<number>();
	let invalid = false;
	for (const part of raw
		.split(",")
		.map((piece) => piece.trim())
		.filter((piece) => piece !== "")) {
		const id = /^[1-9]\d{0,15}$/.test(part) ? Number(part) : Number.NaN;
		if (Number.isSafeInteger(id)) ids.add(id);
		else {
			invalid = true;
			out.add("TELEGRAM_ALLOWED_USER_IDS", `invalid user id ${JSON.stringify(part.slice(0, 20))}`);
		}
	}
	if (ids.size === 0 && !invalid) out.add("TELEGRAM_ALLOWED_USER_IDS", "needs at least one id");
	return [...ids];
}

function parseProvider(value: string | undefined, out: Collector): string {
	const provider = nonEmpty(value) ?? DEFAULT_PROVIDER;
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(provider))
		out.add("PI_PROVIDER", "must look like a provider id, e.g. anthropic");
	return provider;
}

function parseNonEmpty(variable: string, value: string | undefined, fallback: string, out: Collector): string {
	if (value !== undefined && value.trim() === "" && value !== "") out.add(variable, "must not be blank");
	return nonEmpty(value) ?? fallback;
}

function parseEnum<T extends string>(
	variable: string,
	value: string | undefined,
	allowed: readonly T[],
	fallback: T,
	out: Collector,
): T {
	const raw = nonEmpty(value);
	if (raw === undefined) return fallback;
	if ((allowed as readonly string[]).includes(raw)) return raw as T;
	out.add(variable, `must be one of ${allowed.join(", ")}`);
	return fallback;
}

function parseOptionalSecret(variable: string, value: string | undefined, out: Collector): string | undefined {
	if (value === undefined || value === "") return undefined;
	const trimmed = value.trim();
	if (trimmed === "") out.add(variable, "must not be blank when set");
	return trimmed === "" ? undefined : trimmed;
}

function parseApiRoot(value: string | undefined, out: Collector): string {
	const raw = nonEmpty(value) ?? "https://api.telegram.org";
	if (!/^https?:\/\/[^\s/]+(\/[^\s]*)?$/.test(raw)) out.add("TELEGRAM_API_ROOT", "must be an http(s) URL");
	return raw.replace(/\/+$/, "");
}

function parseContextCap(value: string | undefined, out: Collector): number | undefined {
	const raw = nonEmpty(value);
	if (raw === undefined) return undefined;
	const cap = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
	if (Number.isSafeInteger(cap) && cap >= 1000) return cap;
	out.add("PI_CONTEXT_CAP", "must be a whole number of tokens, at least 1000");
	return undefined;
}
