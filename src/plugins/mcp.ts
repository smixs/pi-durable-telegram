import { readFile } from "node:fs/promises";
import { defineExtension, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import {
	McpAuthRequiredError,
	McpClient,
	type McpTransport,
	StdioTransport,
	StreamableHttpTransport,
	type Tool,
	toLlmContent,
} from "@earendil-works/pi-mcp";
import type { Schema } from "@earendil-works/pi-schema";
import { buildSafeEnv } from "../agent/tools/bash.ts";
import { errorSummary } from "../runtime/log.ts";
import { packageVersion } from "../runtime/version.ts";
import { expandPath, type PluginContext, withTimeout } from "./load.ts";

type Server = { command?: unknown; args?: unknown; env?: unknown; cwd?: unknown; url?: unknown; headers?: unknown };
type Env = PluginContext["env"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** `${VAR}` from the env file; an unset variable is an error for that server. */
function expand(value: unknown, env: Env): string {
	if (typeof value !== "string") throw new Error("expected a string");
	return value.replace(/\$\{([A-Za-z_]\w*)\}/g, (_, name: string) => {
		const found = env[name];
		if (found === undefined) throw new Error(`\${${name}} is not set`);
		return found;
	});
}

function expandAll(value: unknown, env: Env): Record<string, string> {
	if (value === undefined) return {};
	if (!isRecord(value)) throw new Error("env and headers must be objects of strings");
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item, env)]));
}

function transportFor(server: Server, ctx: PluginContext): McpTransport {
	if (server.url !== undefined) {
		return new StreamableHttpTransport({
			url: expand(server.url, ctx.env),
			headers: expandAll(server.headers, ctx.env),
		});
	}
	if (typeof server.command !== "string") throw new Error("needs command or url");
	if (server.args !== undefined && !Array.isArray(server.args)) throw new Error("args must be a list");
	return new StdioTransport({
		command: server.command,
		args: ((server.args as unknown[] | undefined) ?? []).map((arg) => expand(arg, ctx.env)),
		cwd: expandPath(typeof server.cwd === "string" ? server.cwd : ".", ctx),
		// Like bash: no inherited secrets; a server gets a secret only when its config names it.
		env: { ...buildSafeEnv(ctx.env), ...expandAll(server.env, ctx.env) },
		inheritEnv: false,
		stderr: "pipe",
		maxStderrBytes: 8192,
	});
}

/** `mcp__<server>__<tool>`, provider-safe characters, at most 64 long. */
export function mcpToolName(server: string, tool: string): string {
	const safe = (part: string) => part.replace(/[^A-Za-z0-9_-]/g, "_");
	return `mcp__${safe(server)}__${safe(tool)}`.slice(0, 64);
}

/** Never rerun after a restart: the call may have had side effects, whatever the server's hints say. */
function toTool(server: string, client: McpClient, tool: Tool): ToolRegistration {
	const { $schema: _, ...schema } = tool.inputSchema;
	return {
		name: mcpToolName(server, tool.name),
		description: `[${server}] ${tool.description ?? tool.title ?? tool.name}`,
		parameters: { ...schema, type: "object", properties: schema.properties ?? {} } as Schema,
		replay: "unsafe",
		execute: async (args, _api, context) => {
			const options = { timeoutMs: 300_000, ...(context.abortSignal ? { signal: context.abortSignal } : {}) };
			const result = await client.callTool(tool.name, args as Record<string, unknown>, options).catch((error) => {
				throw new Error(`MCP server ${server}: ${errorSummary(error)} (a service restart reconnects it)`);
			});
			return { output: toLlmContent(result), isError: result.isError === true };
		},
	};
}

async function connect(name: string, server: unknown, ctx: PluginContext, clients: McpClient[]) {
	if (!isRecord(server)) throw new Error("not an object");
	const client = new McpClient({ name: "pi-durable-telegram", version: packageVersion(), requestTimeoutMs: 30_000 });
	clients.push(client);
	const transport = transportFor(server, ctx);
	// Each server has its own deadline, under the loader's 60 s, so one hung server does not drop the others.
	const seconds = Number(ctx.env.PI_MCP_TIMEOUT) > 0 ? Number(ctx.env.PI_MCP_TIMEOUT) : 30;
	try {
		const ready = client.connect(transport).then(() => client.listTools());
		const tools = await withTimeout(ready, seconds * 1000, `did not answer in ${seconds} s`);
		ctx.log.info("mcp_server_ready", { server: name, tools: tools.length });
		return tools.map((tool) => toTool(name, client, tool));
	} catch (error) {
		await client.close().catch(() => undefined);
		const stderr = transport instanceof StdioTransport ? transport.stderr.trim().split("\n").at(-1) : undefined;
		if (error instanceof McpAuthRequiredError) throw new Error("needs sign-in (OAuth), not supported yet");
		throw new Error(`${errorSummary(error)}${stderr ? ` (${errorSummary(stderr).slice(0, 200)})` : ""}`);
	}
}

async function readServers(path: string): Promise<Record<string, unknown>> {
	const text = await readFile(path, "utf8").catch(() => {
		throw new Error(`no MCP config at ${path}`);
	});
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`${path} is not valid JSON`);
	}
	const servers = isRecord(parsed) ? parsed.mcpServers : undefined;
	if (!isRecord(servers) || Object.keys(servers).length === 0) throw new Error(`no servers in mcpServers of ${path}`);
	return servers;
}

/** Tools of every server in `PI_MCP_CONFIG` (default `<workdir>/.mcp.json`); a server that fails is reported. */
export default async function mcpPlugin(ctx: PluginContext): Promise<Extension> {
	const servers = await readServers(expandPath(ctx.env.PI_MCP_CONFIG?.trim() || ".mcp.json", ctx));
	const clients: McpClient[] = [];
	ctx.onClose(() => Promise.allSettled(clients.map((client) => client.close())));
	const connected = await Promise.all(
		Object.entries(servers).map(async ([name, server]) => {
			try {
				return await connect(name, server, ctx, clients);
			} catch (error) {
				ctx.problem(`server ${name} did not start: ${errorSummary(error).replace(/^(Error: )+/, "")}`);
				return [];
			}
		}),
	);
	const tools = new Map<string, ToolRegistration>();
	for (const tool of connected.flat()) {
		if (tools.has(tool.name)) ctx.log.warn("mcp_tool_skipped", { tool: tool.name, reason: "duplicate name" });
		else tools.set(tool.name, tool);
	}
	return defineExtension({ name: "mcp", tools: [...tools.values()] });
}
