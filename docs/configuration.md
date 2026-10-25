# Configuration

Configuration comes from the environment, optionally loaded from a file with `--env-file <path>` (real environment
variables win over the file). Invalid values stop the daemon at start with one line per problem.

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | | Bot token from @BotFather |
| `TELEGRAM_ALLOWED_USER_IDS` | yes | | Comma-separated Telegram user ids allowed to use the bot |
| `PI_PROVIDER` | no | pi's default, else `anthropic` | pi-ai provider id |
| `PI_MODEL` | no | pi's default, else `claude-opus-5-5` | Model id of the provider |
| `PI_THINKING` | no | pi's default, else `high` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`; checked against the model |
| `PI_WORKDIR` | no | current directory | The agent's working directory |
| `PI_DATA_DIR` | no | `$XDG_STATE_HOME/pi-durable-telegram` or `~/.local/state/pi-durable-telegram` | SQLite storage and lock |
| `PI_AUTH_FILE` | no | pi's `~/.pi/agent/auth.json` (or `$PI_CODING_AGENT_DIR/auth.json`) | Credentials file, shared with pi under pi's own lock. A `<PI_DATA_DIR>/auth.json` from an older version is used while pi has none |
| `PI_INSTRUCTIONS` | no | `<PI_WORKDIR>/AGENTS.md` | Project instructions added to the system prompt; re-read when the file changes |
| `PI_CONTEXT_CAP` | no | model window | Compact the context once it grows past this many tokens (in the background from three quarters of it) |
| `DEEPGRAM_API_KEY` | no | | Enables voice transcription |
| `TELEGRAM_API_ROOT` | no | `https://api.telegram.org` | Bot API server (for a local Bot API server) |
| `TELEGRAM_RICH` | no | `auto` | `auto`: answers are rich messages (tables, task lists, folds, buttons) streamed as native drafts with a stop button; `never`: Telegram HTML messages streamed by editing one message |
| `TELEGRAM_TOPIC_NAMES` | no | `auto` | `auto`: the agent gives new topics with implicit Telegram titles a short task name; `manual`: rename only when asked. Explicit names and unknown titles of older topics are kept |
| `PI_LOG_LEVEL` | no | `info` | `debug`, `info`, `warn` or `error` |
| `PI_PLUGINS` | no | none | Comma-separated plugins to load: `search`, `mcp`, `skills`, `helpers`, `reminders`, a path (absolute, `~` or relative to `PI_WORKDIR`) or an npm package installed in `<PI_DATA_DIR>/plugins`; see [plugins](plugins.md) |
| `PI_SEARCH_PROVIDER` | no | first key found | `search` plugin: `tavily`, `exa`, `brave` or `parallel` |
| `TAVILY_API_KEY` | no | | `search` plugin: Tavily key |
| `EXA_API_KEY` | no | | `search` plugin: Exa key |
| `BRAVE_API_KEY` | no | | `search` plugin: Brave Search API key |
| `PARALLEL_API_KEY` | no | | `search` plugin: Parallel key |
| `PI_MCP_CONFIG` | no | `<PI_WORKDIR>/.mcp.json` | `mcp` plugin: the MCP servers file (absolute, `~` or relative to `PI_WORKDIR`) |
| `PI_MCP_TIMEOUT` | no | `30` | `mcp` plugin: seconds each server has to start and list its tools (keep under 60) |
| `PI_SKILLS_DIRS` | no | | `skills` plugin: more comma-separated skill folders, after `<PI_WORKDIR>/skills` and pi's `~/.pi/agent/skills` |
| `PI_HELPER_MODEL` | no | the main model | `helpers` plugin: `provider/model` helpers run on; another provider needs its own `login` |
| `PI_HELPER_THINKING` | no | the main level; `off` with `PI_HELPER_MODEL` | `helpers` plugin: thinking level of helpers |
| `PI_HELPERS_MAX` | no | `4` | `helpers` plugin: helper calls running at once per chat |
| `PI_TIMEZONE` | no | the server's zone | `reminders` plugin: IANA time zone (`Europe/Berlin`) for reminder times and the date in the prompt |

Example `~/.config/pi-durable-telegram/env`:

```sh
TELEGRAM_BOT_TOKEN=123456789:AA...
TELEGRAM_ALLOWED_USER_IDS=111111111
PI_WORKDIR=/home/me/projects
DEEPGRAM_API_KEY=...
PI_PLUGINS=search,skills
TAVILY_API_KEY=...
```

---

Back to the [README](../README.md).
