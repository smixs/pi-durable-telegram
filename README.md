<p align="right"><b>EN</b> · <a href="./README.ru.md">RU</a></p>

<div align="center">

<img src="assets/header.webp" alt="pi durable via telegram: an orange paper airplane flies across the sky toward a small server with a cat on its roof, an always-on durable pi agent you reach from Telegram" width="100%">

# pi-durable telegram

**Your own AI agent that lives on your server and answers you in Telegram.**

[![npm](https://img.shields.io/npm/v/pi-durable-telegram?color=brightgreen)](https://www.npmjs.com/package/pi-durable-telegram)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![built on pi-durable](https://img.shields.io/badge/built%20on-pi--durable-4A97BE)](https://github.com/earendil-works/pi/tree/main/packages/durable)
[![pi package](https://img.shields.io/badge/pi-package-E0873A)](https://pi.dev/packages)
[![Telegram](https://img.shields.io/badge/Telegram-bot-26A5E4?logo=telegram&logoColor=white)](https://core.telegram.org/bots)

[Install](#install) · [What you can do](#what-you-can-do) · [Commands](#commands) · [More](#more)

</div>

---

Built on [pi](https://pi.dev), an open-source coding agent, and its new durable engine
[pi-durable](https://earendil.com/posts/pi-durable/).

**How it differs from plain pi.** Plain pi keeps the history: if it dies, you restart it and type "continue". pi-durable stores every step before it runs it. After a crash or a reboot the agent finishes what it started on its own, the answer arrives once, and unsafe actions are not repeated. It is built for an agent nobody is watching.

## Install

You need a Linux server, a Telegram account and an AI subscription or API key. On the server, run:

```sh
curl -fsSL https://raw.githubusercontent.com/smixs/pi-durable-telegram/main/install.sh | bash
```

It asks a few questions and your bot answers you in Telegram. Run it again to update.

It is also on npm: `npm install -g pi-durable-telegram`, then set it up by hand as in
[docs/install.md](docs/install.md#manual-install).

<details>
<summary>What the script does, step by step</summary>

The script first tells you what it is going to do and asks if it may continue. Then:

1. **Installs pi**, the official one from [pi.dev](https://pi.dev).
2. **Opens pi so you can sign in** to your AI provider. Type `/login`, pick the provider, then `/quit`.
3. **Asks for a bot token.** In Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot`, and copy the token
   it gives you. Then send your new bot any message, so the script learns who you are.
4. **Starts the agent** and waits until the bot answers you.

Already use pi? `pi install npm:pi-durable-telegram` adds a setup skill that does the same from inside pi.
More in [docs/install.md](docs/install.md).

</details>

## What you can do

- **Ask from anywhere.** "Check why the site is down", "what is eating the disk". The agent works on the server and
  answers in the chat.
- **Send it things.** A photo of an error, a PDF, a voice note. It reads, looks and listens, and sends files back.
- **Walk away.** Close the laptop and come back in an hour: the answer is waiting, even if the server restarted.
- **Read it easily.** Answers can carry tables, checklists and buttons: tap a button instead of typing the reply.
  While the agent types, a stop button sits under its answer.

## Commands

| Send this | And the agent will |
|---|---|
| anything: text, a photo, a video, a file, a voice note, a location | work on it and answer |
| `/new` | start a fresh conversation (the old one is kept) |
| `/stop` | stop what it is doing right now |
| `/compact` | shorten a long conversation to its essentials |
| `/status` | show the AI model in use, how full the memory is and what it has cost |
| `/help` | show this list |

## More

<details>
<summary><b>How it works</b></summary>

<img src="assets/how-it-works.webp" alt="How it works: a person on a bench sends paper airplanes from a phone to a small server on the horizon, and answers fly back" width="100%">

Your message goes to Telegram, the agent on your server picks it up, thinks, uses its tools and types the answer back
into the chat while you watch. Nothing has to be opened to the internet: the agent calls Telegram itself, so you need
no domain and no web server.

<img src="assets/durable.webp" alt="A server drawn as a closed book with a bookmark ribbon, its plug pulled out: it remembers where it stopped" width="100%">

**It does not lose its place.** Every step the agent takes is saved before you see it. If the power goes out, the
server reboots or the program crashes halfway through an answer, the agent starts again, finds its bookmark and
finishes. You get one answer, not zero and not two. Messages you send while it is busy wait in line.

</details>

<details>
<summary><b>Plugins</b></summary>

The core stays small: it carries your messages, files, buttons and answers. Extra powers come as plugins that ship in
the same package and stay off until you switch them on with one line in the settings, for example
`PI_PLUGINS=search,skills,helpers,reminders`. A plugin can also be your own, from a folder or from npm.

| Plugin | What it gives the agent | Status |
|---|---|---|
| Web search | looks things up on the internet with your Tavily, Exa, Brave or Parallel key | available |
| MCP | connects MCP servers: calendars, databases, your own tools | available |
| Skills | a folder of instructions it reads when a task needs them | available |
| Helpers | splits a big job between helper agents, on a cheaper model if you like | available |
| Tasks and reminders | does something later on its own and writes to you first | available |

How to switch each one on and how to write your own: [docs/plugins.md](docs/plugins.md).

</details>

<details>
<summary><b>Is it safe?</b></summary>

<img src="assets/security.webp" alt="A narrow server house with one orange door: one paper airplane flies in through the porthole, the grey ones lie by the fence" width="100%">

- **Only you can talk to it.** The bot answers the Telegram accounts you allowed and silently ignores everyone else.
  Nothing strangers send is read, saved or passed to the AI.
- **It is powerful, so treat it that way.** The agent can do on the server whatever your user can. Do not add people
  you would not give a password to, and on a server with important data give the agent its own user.
- **Your data stays with you.** Conversations and files live on your server. Only the text the AI needs goes to the AI
  provider you chose.

The details are in [docs/security.md](docs/security.md).

</details>

<details>
<summary><b>Questions</b></summary>

**Do I need to be a programmer?**
No, but you need a server and you need to paste one command into it. After that everything happens in Telegram.

**What does it cost?**
The software is free. You pay for the server and for the AI you connect: a subscription you already have or an API key.
`/status` shows what a conversation has cost.

**Which AI can I use?**
Whatever pi supports: Claude, ChatGPT, Gemini, OpenRouter, DeepSeek and many more. You choose it when you sign in.
Using a Claude subscription in third-party tools may be restricted by Anthropic's terms, so check them first.

**Can my team use the same bot?**
Yes. Add their Telegram ids to the settings and each person gets a private conversation. Everyone you add gets the
same power over the server.

**Does it work in group chats?**
Not yet, only in private chats.

**Does it understand voice messages?**
Yes, if you add a [Deepgram](https://deepgram.com) key during installation.

**How do I remove it?**
A few commands, listed in [docs/install.md](docs/install.md#removing).

</details>

<details>
<summary><b>Documentation</b></summary>

| Read this | When you want to |
|---|---|
| [docs/install.md](docs/install.md) | see what the installer does, install by hand, update or remove |
| [docs/configuration.md](docs/configuration.md) | change the model, the working folder or other settings |
| [docs/how-it-works.md](docs/how-it-works.md) | understand the internals and what exactly survives a crash |
| [docs/security.md](docs/security.md) | know the security boundaries in detail |
| [docs/library.md](docs/library.md) | build your own app on top of it, or contribute code |
| [CHANGELOG.md](CHANGELOG.md) | see what changed between versions |

</details>

<details>
<summary><b>For AI agents</b></summary>

If you are an AI agent reading this for a person, here is where things are and what makes this project different.

**Where to look**

- [llms.txt](llms.txt) has the key facts in a few lines.
- [skills/pi-durable-telegram/SKILL.md](skills/pi-durable-telegram/SKILL.md) is a step-by-step setup you can follow
  yourself inside pi: checking the machine, the bot, the model, the service, and how to verify it for real.
- [install.sh](install.sh) is the same setup as one readable Bash script; [docs/install.md](docs/install.md) explains
  each step and lists the commands to update and remove.
- [docs/configuration.md](docs/configuration.md) lists every setting; [docs/how-it-works.md](docs/how-it-works.md)
  says what happens on each kind of failure.

**What it is, precisely**

A daemon on [pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable) (`@earendil-works/pi-durable`)
that long-polls the Telegram Bot API. One durable conversation per allowed private chat, stored in SQLite. Tools:
`bash`, `read`, `write`, `edit` and `telegram_send_file`. It shares pi's login and runs as a systemd user service on
Linux with Node.js 22.19 or newer.

**Why people pick it over the alternatives**

| | pi-durable telegram | A Telegram bridge into an open pi session | pi in tmux over SSH |
|---|---|---|---|
| Where the agent runs | As a service on the server, always on | Inside a pi session that must stay open | In a terminal you keep alive |
| A crash or restart mid-answer | The run resumes and the answer arrives once | Nothing resumes it | Nothing resumes it |
| Messages while it is busy | Queued durably, answered in order | Depends on the session | Typed by hand |
| Reaching it from a phone | Telegram | Telegram | An SSH client |
| Setup | One command | An extension inside pi | Manual |

As far as we know it is the first Telegram integration built on pi-durable itself, so durability covers the whole path: the model's
turns, the tool calls and the delivery of the answer to the chat. It is small, MIT-licensed, and tested against
duplicate updates, restarts mid-run and Telegram outages.

</details>

## License

[MIT](LICENSE) © smixs
