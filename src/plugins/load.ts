import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Context } from "@earendil-works/chord";
import type { MutableModels } from "@earendil-works/pi-ai";
import type { ConversationId, Extension } from "@earendil-works/pi-durable";
import { errorSummary, type Logger } from "../runtime/log.ts";

export type PluginContext = {
	/** The environment as read from the env file, secrets included. */
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly workdir: string;
	readonly dataDir: string;
	readonly log: Logger;
	/** The model catalog generation uses: a plugin may register another provider. */
	readonly models: MutableModels;
	/** The harness clock. */
	readonly now: () => number;
	/** Cancel the core task of this chat's reminder, including a durable sleep. */
	readonly cancelReminder: (conversationId: ConversationId, id: string, context: Context) => Promise<void>;
	/** A part of the plugin failed while the rest works: logged, told once in chat, listed in /status. */
	readonly problem: (text: string) => void;
	/** Runs at shutdown, after the harness has closed. */
	readonly onClose: (close: () => unknown) => void;
};
export type Plugin = (ctx: PluginContext) => Extension | Promise<Extension>;
export type PluginProblem = { readonly plugin: string; readonly reason: string };
export type PluginReport = { readonly loaded: readonly string[]; readonly problems: readonly PluginProblem[] };
export type LoadedPlugins = {
	readonly report: PluginReport;
	close(): Promise<void>;
};
type Base = Omit<PluginContext, "problem" | "onClose">;

const BUILTIN: Record<string, () => Promise<{ default: unknown }>> = {
	search: () => import("./search.ts"),
	mcp: () => import("./mcp.ts"),
	skills: () => import("./skills.ts"),
	helpers: () => import("./helpers.ts"),
	reminders: () => import("./reminders/index.ts"),
};
const LOAD_MS = 60_000;
const LATE = `did not finish loading in ${LOAD_MS / 1000} s`;

/** Where `npm install --prefix` puts npm plugins. */
export const pluginsDir = (dataDir: string): string => join(dataDir, "plugins");

/** `~` expanded, relative paths taken from the working directory. */
export function expandPath(path: string, base: Pick<PluginContext, "env" | "workdir">): string {
	const home = base.env.HOME?.trim() || homedir();
	const expanded = path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
	return isAbsolute(expanded) ? resolve(expanded) : resolve(base.workdir, expanded);
}

export function pluginKind(entry: string): "builtin" | "npm" | "path" | undefined {
	if (Object.hasOwn(BUILTIN, entry)) return "builtin";
	if (/^@[a-z0-9~-][a-z0-9._~-]*\/[a-z0-9~-][a-z0-9._~-]*$/.test(entry)) return "npm";
	if (/^[.~/]/.test(entry) || entry.includes("/")) return "path";
	return /^[a-z0-9][a-z0-9._~-]*$/.test(entry) ? "npm" : undefined;
}

/**
 * Load and `install` each plugin in order. A plugin that fails to resolve, import, build or install, defines tasks, or
 * reuses a name in `taken` (core extensions, tools and `section:` keys, earlier plugins) is skipped and reported.
 */
export async function loadPlugins(
	entries: readonly string[],
	base: Base,
	taken: Set<string>,
	install: (extension: Extension) => void,
): Promise<LoadedPlugins> {
	const loaded: string[] = [];
	const problems: PluginProblem[] = [];
	const closers: (() => unknown)[] = [];
	for (const plugin of entries) {
		const problem = (reason: string) => {
			problems.push({ plugin, reason });
			base.log.warn("plugin_problem", { plugin, reason });
		};
		try {
			const ctx = { ...base, problem, onClose: (fn: () => unknown) => closers.push(fn) };
			const extension = await withTimeout(loadOne(plugin, ctx), LOAD_MS, LATE);
			const names = claim(extension, taken);
			install(extension); // pi-durable's own checks: section key format, duplicates within the extension
			for (const name of names) taken.add(name);
			loaded.push(plugin);
			base.log.info("plugin_loaded", { plugin, tools: extension.tools?.length ?? 0 });
		} catch (error) {
			problem(`did not load: ${errorSummary(error).replace(/^(Type)?Error: /, "")}`);
		}
	}
	const close = async () => void (await Promise.allSettled(closers.splice(0).map(async (fn) => fn())));
	return { report: { loaded, problems }, close };
}

async function loadOne(plugin: string, ctx: PluginContext): Promise<Extension> {
	const kind = pluginKind(plugin);
	if (kind === undefined) throw new Error("not a plugin name or path");
	const module =
		kind === "builtin" ? await BUILTIN[plugin]?.() : await import(pathToFileURL(await entryOf(plugin, kind, ctx)).href);
	const factory = (module as { default?: unknown } | undefined)?.default;
	if (typeof factory !== "function") throw new Error("default export is not a function");
	return (factory as Plugin)(ctx);
}

async function entryOf(plugin: string, kind: "npm" | "path", ctx: PluginContext): Promise<string> {
	const dir = pluginsDir(ctx.dataDir);
	const path = kind === "path" ? expandPath(plugin, ctx) : join(dir, "node_modules", plugin);
	const info = await stat(path).catch(() => undefined);
	if (info === undefined)
		throw new Error(kind === "npm" ? `not installed: run npm install --prefix ${dir} ${plugin}` : `not found: ${path}`);
	return info.isDirectory() ? join(path, await packageEntry(path)) : path;
}

/** A folder's entry: `exports` (string, `.`, `import` or `default`), then `main`, then `index.js`. */
async function packageEntry(dir: string): Promise<string> {
	const pkg: unknown = JSON.parse(await readFile(join(dir, "package.json"), "utf8").catch(() => "{}"));
	const { exports, main } = (pkg ?? {}) as { exports?: unknown; main?: unknown };
	const root = isObject(exports) && "." in exports ? exports["."] : exports;
	const conditional = isObject(root) ? (root.import ?? root.default) : root;
	if (typeof conditional === "string") return conditional;
	return typeof main === "string" ? main : "index.js";
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function claim(extension: Extension, taken: Set<string>): string[] {
	if (!isObject(extension) || typeof extension.name !== "string" || extension.name === "")
		throw new Error("the plugin did not return an extension with a name");
	if ((extension.tasks?.length ?? 0) > 0) throw new Error("plugins cannot define tasks");
	const sections = (extension.sections ?? []).map((section) => `section:${section.key}`);
	const names = [extension.name, ...(extension.tools ?? []).map((tool) => tool.name), ...sections];
	const clash = names.find((name) => taken.has(name));
	if (clash !== undefined) throw new Error(`the name ${clash} is already taken`);
	return names;
}

export function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), ms);
		timer.unref();
	});
	return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
