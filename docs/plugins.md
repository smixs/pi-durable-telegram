# Plugins

The core carries messages, files, buttons and answers. Everything else comes as a plugin. Plugins are off until you
list them in `PI_PLUGINS` in the env file, then restart the service:

```sh
PI_PLUGINS=search,mcp,skills,helpers,reminders
```

An entry is one of:

- a built-in plugin: `search`, `mcp`, `skills`, `helpers` or `reminders`;
- a path to a module file or a folder: absolute, `~/...`, or relative to `PI_WORKDIR` (`./plugins/mine.mjs`);
- the name of an npm package installed in `<PI_DATA_DIR>/plugins` (see [below](#install-a-plugin-from-npm)).

Plugins load in the listed order. `/status` shows which loaded and which failed.

## Web search: `search`

Gives the agent a `web_search` tool: a query and an optional number of results (1 to 10, default 5). Each result has
a title, a link, a date when the provider gives one, and a short snippet. To read a page the agent uses `bash` with
`curl`.

Set the key of one provider:

| Provider | Key |
|---|---|
| Tavily | `TAVILY_API_KEY` |
| Exa | `EXA_API_KEY` |
| Brave Search API | `BRAVE_API_KEY` |
| Parallel | `PARALLEL_API_KEY` |

With several keys, the first in this order is used; `PI_SEARCH_PROVIDER=exa` picks one explicitly. Without a key the
plugin does not load and tells you why.

Search results are text from strangers. They reach the model inside a `<search_results>` block marked as untrusted
data, and long text is cut. A failed search (wrong key, rate limit, timeout after 20 seconds) comes back to the model
as an error it can read; the answer goes on.

## MCP servers: `mcp`

Connects the [MCP](https://modelcontextprotocol.io) servers listed in `<PI_WORKDIR>/.mcp.json` (another file:
`PI_MCP_CONFIG`). The format is the one Claude Code and other clients use:

```json
{
  "mcpServers": {
    "files": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/me/work"],
      "env": { "LOG_LEVEL": "info" }
    },
    "github": {
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" }
    }
  }
}
```

- A server with `command` runs on the server as a child process (`args`, `env` and `cwd` are optional; `cwd` is
  relative to `PI_WORKDIR`). A server with `url` is reached over HTTP. Servers that need an OAuth sign-in are not
  supported yet.
- `${NAME}` is replaced with the variable from the env file, so tokens stay in the env file. Like `bash`, a server
  process gets no secrets from the service environment, only the ones its config names.
- Each tool becomes `mcp__<server>__<tool>`, for example `mcp__github__create_issue`.
- A server that does not start, or does not answer within 30 seconds (`PI_MCP_TIMEOUT`), is reported in one chat
  line while the others work. Tools are read once at start: a change in a server or in the file needs a service
  restart, and so does a server that stopped while running.
- A tool call cut off by a restart is never repeated by itself: it may already have done something, so the model is
  told it was interrupted and checks first.

## Skills: `skills`

A skill is a folder with a `SKILL.md` that starts with a short header:

```markdown
---
name: deploy
description: How to ship this project to production
---
Steps...
```

The plugin looks in `<PI_WORKDIR>/skills/*/SKILL.md`, in pi's own `~/.pi/agent/skills` (or
`$PI_CODING_AGENT_DIR/skills`) and in the folders in `PI_SKILLS_DIRS` (comma-separated). The system prompt gets one
list of names, descriptions and paths; when a task matches, the agent reads that `SKILL.md` with its `read` tool. When
two skills share a name, the first folder wins. The list is rebuilt only when a `SKILL.md` appears, changes or goes
away.

## Helpers: `helpers`

Gives the agent a `helper` tool: it hands a self-contained task to a helper agent and gets the helper's final answer
back as the tool result. A helper has the same tools as the main agent (bash, files, Telegram, search,
MCP, reminders), except `helper` itself, so helpers cannot start helpers. A helper does not see the chat: the task
text is all it knows. Several helper calls in one answer run at the same time.

| Setting | Default | What it does |
|---|---|---|
| `PI_HELPER_MODEL` | the main model | `provider/model` for helpers, with the ids you would put in `PI_PROVIDER` and `PI_MODEL`. Another provider needs its own `login`. |
| `PI_HELPER_THINKING` | the main level; `off` with `PI_HELPER_MODEL` | thinking level of helpers |
| `PI_HELPERS_MAX` | 4 | helper calls running at once per topic; a call over the limit comes back to the model as an error asking it to wait for the running ones |

- A bad `PI_HELPER_MODEL` or `PI_HELPER_THINKING` is reported as a plugin problem; helpers then use the main model.
- `/stop` and the stop button of a draft stop the helpers together with the answer.
- After a restart a running helper goes on in the same helper conversation, and its task is not sent to it again.
- The `PI_HELPERS_MAX` limit is tracked per topic in the running service's memory.
- Helpers can rename their originating topic on request, but do not automatically name it from a delegated task.
- Helper spend is in the "All chats" line of `/status`, not in "This chat".

## Reminders: `reminders`

Gives the agent a `remind` tool with three operations: `add` (a text plus `at`, a date and time, or `in`, minutes from
now; optional `every`: `daily`, `weekdays`, `weekly` or a number of minutes, at least 5), `list` (pending reminders
with ids and next times) and `cancel` (by id). When a reminder comes due, the agent gets its text as a message marked
`[reminder …]`, does what it says and answers in the chat like any other answer.

| Setting | Default | What it does |
|---|---|---|
| `PI_TIMEZONE` | the server's zone | IANA zone such as `Europe/Berlin` for times without an offset and for the date in the prompt |

- A repeating reminder keeps its local time across daylight saving changes. A time skipped by the clock change is
  refused for `add`; a repeat that falls into it moves past it that day. A daily, weekday or weekly reminder fires at
  most once per local date, also on the day the clock goes back.
- At most 100 pending reminders per topic, at most 366 days ahead. `cancel` ends the reminder at once.
- Reminders are stored durably. After a restart they wait again; one missed while the service was down fires once
  after start, marked late; a repeating one fires once and then goes on from its next time, it does not catch up every
  missed time. Each due time wakes the agent at most once, even across restarts.
- `/new` keeps reminders. A reminder set by a helper belongs to its originating topic's main conversation and wakes
  that topic. Each topic lists and cancels its own reminders.
- With `reminders` removed from `PI_PLUGINS`, a pending reminder is dropped at its due time without waking the agent
  (the log says `reminder … dropped`). The service always starts. The same happens to a reminder of a user taken off
  `TELEGRAM_ALLOWED_USER_IDS`: it never wakes the agent or reaches that chat again.
- There is no separate task list: ask the agent to keep lists in files in the working directory.

## Write your own

A plugin is an ES module whose default export is a function. It receives a small context and returns a pi-durable
extension: tools, prompt sections, hooks. A plugin needs no imports:

```js
// ~/my-plugin.mjs, then PI_PLUGINS=~/my-plugin.mjs
export default (ctx) => ({
  name: "weather",
  tools: [{
    name: "weather_now",
    description: "Current weather in a city",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    execute: async ({ city }) => {
      const res = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=3`);
      if (!res.ok) throw new Error(`wttr.in answered ${res.status}`);
      return { output: [{ type: "text", text: await res.text() }] };
    },
  }],
  sections: [{ key: "weather", render: () => "Use weather_now for weather questions." }],
});
```

The context:

| Field | What it is |
|---|---|
| `env` | the environment from the env file, secrets included |
| `workdir`, `dataDir` | `PI_WORKDIR` and `PI_DATA_DIR` |
| `log` | the service log: `ctx.log.info("event", { key: "value" })` |
| `models` | pi-ai's model catalog: register another provider here |
| `now()` | the service clock, in milliseconds |
| `problem(text)` | report a part that failed while the rest works (one chat line, listed in `/status`) |
| `onClose(fn)` | run `fn` at shutdown, for example to stop a child process |

Rules:

- `parameters` is a JSON Schema object. A thrown error becomes an error result the model reads.
- Tool and extension names must not repeat the core ones (`read`, `write`, `edit`, `bash`, `telegram_send_file`,
  `telegram_rename_topic`) or another plugin's; such a plugin is not loaded. The same goes for section keys
  (core: `preamble`, `agents_md`, `telegram_topic`).
  A section key is lowercase letters, digits, `-` and `_`, starting with a letter. To change a core tool or section on
  purpose, use pi-durable's `wraps`.
- A tool is not rerun after a restart unless it says `replay: "safe"`; set that only for tools that are safe to repeat.
- Plugins cannot define pi-durable tasks: an unfinished task of a removed plugin would block startup. The tasks of the
  built-in plugins are part of the core and always registered.
- A changed plugin needs a service restart. The plugin factory has 60 seconds to finish.

For types, `import type { Plugin } from "pi-durable-telegram"`.

## Install a plugin from npm

npm plugins live in `<PI_DATA_DIR>/plugins`. With the default data directory:

```sh
npm install --prefix ~/.local/state/pi-durable-telegram/plugins <package>
```

Then add the package name to `PI_PLUGINS` and restart the service. The package's `exports` (or `main`) must point to
the module with the default export. A plugin package should keep `pi-durable-telegram` and pi-durable out of its own
dependencies.

## When a plugin breaks

- A plugin that cannot be found, fails to import, throws while starting, returns an invalid extension, or reuses a
  taken name is skipped. The
  service still starts. The log has `plugin_problem` with the reason, each allowed user gets one short chat line after
  start, and `/status` lists it under problems.
- If you remove a plugin, or it breaks, while one of its tool calls is unfinished, the model gets that call back as an
  error ("was interrupted") after the restart and the answer continues. A running helper stops with it. Startup is
  never blocked by it.

---

Back to the [README](../README.md).
