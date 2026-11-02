# Installing by hand, updating, removing

Most people need only the one-command installer from the [README](../README.md#install). This page is for doing
the same by hand, and for what happens after.

## What the installer does

`install.sh` is one Bash file you can read before you run it:

```sh
curl -fsSL https://raw.githubusercontent.com/smixs/pi-durable-telegram/main/install.sh -o install.sh
less install.sh
bash install.sh
```

1. Checks the machine: Linux, a normal user (not root), `curl`, systemd user services.
2. Runs the official pi installer from `https://pi.dev/install.sh` when pi is missing.
3. Opens pi for `/login` when pi has no stored login, then asks pi which model it runs.
4. Asks for the bot token, checks it with Telegram, and reads your Telegram id from the first message you send the bot.
5. Installs the daemon from the latest GitHub release into `~/.local/share/pi-durable-telegram` (no root needed).
6. Writes `~/.config/pi-durable-telegram/env` (mode 600) and `~/pi-agent/AGENTS.md`, installs and starts the
   systemd user service, and waits for the bot's first answer.

Running it again updates the daemon and keeps your bot and settings. For unattended runs it reads `PDT_YES=1`,
`PDT_BOT_TOKEN`, `PDT_USER_ID`, `PDT_DEEPGRAM_API_KEY` and `PDT_WORKDIR`.

## Manual install

Without the installer, step by step. You need a Linux server with systemd and Node.js 22.19 or newer, a bot token from
[@BotFather](https://t.me/BotFather), your numeric Telegram user id (from [@userinfobot](https://t.me/userinfobot)) and
a model provider account.

1. **Install.**

   ```sh
   npm install -g pi-durable-telegram
   ```

2. **Configure.** Create `~/.config/pi-durable-telegram/env` with mode 600:

   ```sh
   TELEGRAM_BOT_TOKEN=123456789:AA...
   TELEGRAM_ALLOWED_USER_IDS=111111111
   PI_WORKDIR=/home/me/pi-agent
   DEEPGRAM_API_KEY=...            # optional, for voice
   ```

3. **Log in.** If pi is logged in on this machine, skip this: the daemon shares pi's `~/.pi/agent/auth.json`. Put
   the provider and model you want into the env file as `PI_PROVIDER` and `PI_MODEL` (a default saved in pi's
   settings is picked up on its own). Otherwise run the command below, open the printed URL in any browser, sign in and paste
   the code back. Credentials refresh automatically.

   ```sh
   pi-durable-telegram login anthropic --env-file ~/.config/pi-durable-telegram/env
   ```

4. **Run it as a service.**

   ```sh
   mkdir -p ~/.config/systemd/user
   cp "$(npm root -g)/pi-durable-telegram/deploy/pi-durable-telegram.service" ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now pi-durable-telegram
   loginctl enable-linger "$USER"   # keep it running after you log out
   ```

5. **Say hello to your bot.** `journalctl --user -u pi-durable-telegram -f` shows `message_admitted` and `delivered`.

systemd does not load your shell's `PATH`. If Node comes from nvm or another version manager, edit `ExecStart` to use
absolute paths: `<path to node> <npm root -g>/pi-durable-telegram/dist/cli/main.js run --env-file ...`.

> **Note on subscriptions.** Using a Claude subscription through OAuth in third-party tools may be restricted by
> Anthropic's terms. Check them; using it this way is your responsibility. An API key (`ANTHROPIC_API_KEY`) works too.

## Running in the foreground

```sh
pi-durable-telegram run --env-file ~/.config/pi-durable-telegram/env
```

Exit codes: 0 clean shutdown, 1 fatal error (restart it), 2 configuration error or rejected bot token, 3 the data
directory is used by another process, 4 not logged in. On SIGTERM the daemon stops polling, lets in-flight work stop,
closes the storage and releases its lock; unfinished runs continue after the next start.

## Updating

Run the installer again, or by hand:

```sh
npm install -g pi-durable-telegram@latest
systemctl --user restart pi-durable-telegram
```

Unfinished runs continue after the restart.

## Removing

```sh
systemctl --user disable --now pi-durable-telegram
rm ~/.config/systemd/user/pi-durable-telegram.service && systemctl --user daemon-reload
rm -rf ~/.local/share/pi-durable-telegram      # the daemon
rm -rf ~/.config/pi-durable-telegram           # bot token and settings
rm -rf ~/.local/state/pi-durable-telegram      # conversations (SQLite)
```

Your workspace `~/pi-agent` and pi itself are left alone; remove them yourself if you want.

---

Back to the [README](../README.md).

## Upgrading from 0.1.8 or earlier

Version 0.1.9 uses pi-durable 1.5.0. Its first open automatically migrates SQLite storage to schema v2. Stop the
service and copy the data directory before the first start. A rollback to a version using pi 1.3.0 or earlier requires
restoring that copy; keep the upgraded database with 0.1.9.
