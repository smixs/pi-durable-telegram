import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { mcpToolName } from "../../src/plugins/mcp.ts";
import { CHAT, newFaux, startTestAgent, tempDir } from "../helpers/agent.ts";
import { waitFor } from "../helpers/env.ts";
import { FakeTelegram } from "../helpers/fake-telegram.ts";
import { lastToolResult, observe, textOf, toolCall } from "../helpers/faux-steps.ts";
import { textUpdate } from "../helpers/updates.ts";

/** A minimal MCP server over stdio: newline-delimited JSON-RPC, two tools, exits when stdin closes. */
const SERVER = `import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
writeFileSync(process.argv[2], String(process.pid));
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const tools = [
	{ name: "echo", description: "Echo text", inputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object",
		$defs: { word: { type: "string", minLength: 1 } }, properties: { text: { $ref: "#/$defs/word" } }, required: ["text"] } },
	{ name: "env", inputSchema: { type: "object" } },
];
createInterface({ input: process.stdin }).on("line", (line) => {
	const msg = JSON.parse(line);
	if (msg.id === undefined) return;
	if (msg.method === "initialize")
		send({ id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } });
	else if (msg.method === "tools/list") send({ id: msg.id, result: { tools } });
	else if (msg.method === "tools/call" && msg.params.name === "echo")
		send({ id: msg.id, result: { content: [{ type: "text", text: "echo: " + msg.params.arguments.text }] } });
	else if (msg.method === "tools/call")
		send({ id: msg.id, result: { content: [{ type: "text", text: Object.keys(process.env).sort().join(",") + " SECRET=" + process.env.SECRET }] } });
	else send({ id: msg.id, error: { code: -32601, message: "no such method" } });
});
process.stdin.on("end", () => process.exit(0));
`;

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

test("T-mcp: tools of a stdio server are exposed and callable; a failing server is reported; close stops the child", async () => {
	const { dir, cleanup } = await tempDir();
	try {
		const work = join(dir, "work");
		await mkdir(work, { recursive: true });
		await writeFile(join(dir, "server.mjs"), SERVER);
		const pidFile = join(dir, "pid");
		// biome-ignore-start lint/suspicious/noTemplateCurlyInString: ${VAR} is the MCP config syntax under test
		const mcpConfig = {
			mcpServers: {
				good: { command: process.execPath, args: [join(dir, "server.mjs"), pidFile], env: { SECRET: "${MY_TOKEN}" } },
				broken: {
					command: process.execPath,
					args: ["-e", "process.stderr.write('bad config here\\n'); process.exit(1)"],
				},
				unset: { command: process.execPath, env: { X: "${NOT_SET}" } },
				hung: { command: process.execPath, args: ["-e", "process.stdin.resume()"] },
			},
		};
		// biome-ignore-end lint/suspicious/noTemplateCurlyInString: ${VAR} is the MCP config syntax under test
		await writeFile(join(work, ".mcp.json"), JSON.stringify(mcpConfig));
		const port = new FakeTelegram();
		const faux = newFaux();
		const results: string[] = [];
		const record = (messages: readonly Message[]) => results.push(textOf(lastToolResult(messages)));
		faux.setResponses([
			toolCall("mcp__good__echo", { text: "hi" }),
			observe(record, toolCall("mcp__good__echo", { text: "" })),
			observe(record, toolCall("mcp__good__env", {})),
			observe(record, fauxAssistantMessage("done")),
		]);
		const env = {
			PATH: process.env.PATH,
			HOME: dir,
			TELEGRAM_BOT_TOKEN: "123:abc",
			MY_TOKEN: "tok-1",
			PI_MCP_TIMEOUT: "1",
		};
		const t = await startTestAgent({ dir, faux, port, config: { PI_PLUGINS: "mcp" }, deps: { pluginEnv: env } });
		const pid = Number(await readFile(pidFile, "utf8"));
		try {
			assert.deepEqual(t.agent.plugins.report.loaded, ["mcp"]);
			const problems = t.agent.plugins.report.problems.map((p) => p.reason).sort();
			assert.equal(problems.length, 3);
			assert.match(problems[0] ?? "", /^server broken did not start: .*bad config here/);
			assert.equal(problems[1], "server hung did not start: did not answer in 1 s", "a hung server drops only itself");
			assert.match(problems[2] ?? "", /^server unset did not start: .*\$\{NOT_SET\} is not set/);
			const notice = await waitFor(() => port.created(CHAT).find((m) => m.text.startsWith("Plugin mcp")));
			assert.equal(notice.text.split("\n").length, 3);

			await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "use mcp"));
			await waitFor(() => port.textsIn(CHAT).includes("done"));
			assert.equal(results[0], "echo: hi");
			assert.match(results[1] ?? "", /text: expected at least 1 characters/, "the $ref schema is enforced");
			assert.match(results[2] ?? "", /SECRET=tok-1$/);
			assert.doesNotMatch(results[2] ?? "", /TELEGRAM_BOT_TOKEN|MY_TOKEN/);
			assert.ok(alive(pid));
		} finally {
			await t.close();
		}
		await waitFor(() => !alive(pid), { what: "server stopped" });
	} finally {
		await cleanup();
	}
});

test("T-mcp-config: a missing config fails the plugin; tool names are namespaced and capped", async () => {
	assert.equal(mcpToolName("git hub", "create.issue"), "mcp__git_hub__create_issue");
	assert.equal(mcpToolName("s", "x".repeat(100)).length, 64);
	const { dir, cleanup } = await tempDir();
	try {
		const port = new FakeTelegram();
		const t = await startTestAgent({
			dir,
			faux: newFaux(),
			port,
			config: { PI_PLUGINS: "mcp" },
			deps: { pluginEnv: {} },
		});
		try {
			assert.match(t.agent.plugins.report.problems[0]?.reason ?? "", /^did not load: no MCP config at .*\.mcp\.json$/);
		} finally {
			await t.close();
		}
	} finally {
		await cleanup();
	}
});
