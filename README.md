# CliHub

[中文](README.zh.md) | English

Self-hosted CLI session manager — manage multiple Claude Code sessions from your phone.

A lightweight PWA that bridges your mobile browser to Claude Code CLI processes running on your dev machine, via WebSocket.

## Features

- **Multi-session** — run 10+ Claude Code sessions in parallel
- **Streaming output** — real-time Markdown rendering with syntax highlighting
- **Remote permissions** — approve/deny tool calls from your phone
- **Image support** — send screenshots to Claude via paste/drag/attach
- **Push notifications** — get notified when Claude replies or needs approval
- **Slash commands** — full autocomplete for built-in and custom commands
- **Bilingual UI** — English / Chinese, auto-detected, switchable
- **PWA** — add to home screen for native-like experience
- **Telegram Bot** — manage sessions from Telegram (create, switch, stop, resume, approve permissions, send images)
- **SQLite persistence** — structured event storage with session history
- **Stop generation** — interrupt Claude mid-response with one click
- **Offline-ready** — Service Worker caches all assets

## Architecture

```
Phone (PWA)
    ↓ HTTPS / WSS
Cloudflare Tunnel (or any reverse proxy)
    ↓ localhost:5678
CliHub Server (Node.js + Express + ws)
    ↓ stdin/stdout (NDJSON stream-json)
Claude Code CLI Processes
```

## Prerequisites

- **Node.js** >= 18
- **Claude Code CLI** — `npm install -g @anthropic-ai/claude-code`, then run `claude` to authenticate
- **jq** — `brew install jq` (or `apt-get install jq` on Linux). Required for the permission hook; without it, you'll need to approve all tool calls manually in the CLI

## Quick Start

### One-command setup

```bash
git clone https://github.com/rayisjuly/clihub.git
cd clihub
./setup.sh
```

The setup script will check dependencies, install packages, create `.env`, optionally install the permission hook, and start the server.

### Manual setup

```bash
git clone https://github.com/rayisjuly/clihub.git
cd clihub
npm install
cp .env.example .env
# Edit .env — set BEARER_TOKEN to a secret of your choice
nano .env

# Start the server
node server.js
```

### Process management (recommended)

CliHub includes built-in support for [pm2](https://pm2.keymetrics.io/) process manager. With pm2, the server auto-restarts on crash and survives terminal closure.

```bash
npm install -g pm2
pm2 start ecosystem.config.js    # Start with auto-restart
pm2 startup && pm2 save          # Auto-start on boot
```

Common commands:

```bash
pm2 logs clihub       # View logs
pm2 restart clihub    # Restart server
pm2 stop clihub       # Stop server
pm2 status clihub     # Check status
```

> **Note:** If you change `.env`, you must `pm2 delete clihub && pm2 start ecosystem.config.js` instead of `pm2 restart`, because restart does not reload environment variables.

Without pm2, `setup.sh` uses a built-in watchdog loop that also auto-restarts on crash (but won't survive terminal closure — use `nohup` or `tmux` in that case).

### Docker

```bash
git clone https://github.com/rayisjuly/clihub.git
cd clihub
cp .env.example .env
# Edit .env and set BEARER_TOKEN

docker compose up -d
```

> **Note:** Docker mode mounts `~/.claude` from the host for authentication. You must have Claude Code CLI installed and logged in on the host machine first (`npm install -g @anthropic-ai/claude-code && claude` to authenticate).

## Remote Access

After installation, CliHub runs on `localhost:5678`. To access from your phone, choose one or both:

### Option A: PWA + Cloudflare Tunnel

Full-featured web UI with Markdown rendering, syntax highlighting, slash commands, and session history.

1. **Install cloudflared**

   ```bash
   # macOS
   brew install cloudflared

   # Linux (Debian/Ubuntu)
   # See https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
   ```

2. **Login to Cloudflare**

   ```bash
   cloudflared tunnel login
   ```

3. **Create a tunnel**

   ```bash
   cloudflared tunnel create clihub
   ```

4. **Configure the tunnel** — create `~/.cloudflared/config.yml`:

   ```yaml
   tunnel: clihub
   credentials-file: /home/your-user/.cloudflared/<TUNNEL_ID>.json

   ingress:
     - hostname: clihub.yourdomain.com
       service: http://localhost:5678
     - service: http_status:404
   ```

   Replace `clihub.yourdomain.com` with your actual domain and update the credentials path.

5. **Add DNS route**

   ```bash
   cloudflared tunnel route dns clihub clihub.yourdomain.com
   ```

6. **Run the tunnel**

   ```bash
   cloudflared tunnel run clihub
   ```

7. **(Optional) Add Cloudflare Access policy** — for an extra layer of authentication on top of the bearer token, configure an [Access application](https://developers.cloudflare.com/cloudflare-one/applications/) in the Cloudflare Zero Trust dashboard. If you do, set `CF_ACCESS_DOMAIN` in your `.env` so CliHub can include it in CSP headers.

8. **Open on your phone** — navigate to `https://clihub.yourdomain.com`, enter your `BEARER_TOKEN`, and add the page to your home screen as a PWA.

### Option B: Telegram Bot

Quick access without tunnel setup — send messages, approve permissions, and monitor sessions from any device with Telegram.

1. Create a bot via [@BotFather](https://t.me/BotFather)
2. Get your user ID via [@userinfobot](https://t.me/userinfobot)
3. Add to `.env`:
   ```
   TELEGRAM_BOT_TOKEN=your_token
   TELEGRAM_ALLOWED_USERS=your_user_id
   ```
4. Restart the server

Available commands: `/new`, `/list`, `/switch`, `/stop`, `/resume`, `/status`

You can also send images directly — the bot will forward them to Claude as visual input.

> **Security**: If `TELEGRAM_ALLOWED_USERS` is empty, all users are denied by default.

### Comparison

| | PWA + Tunnel | Telegram Bot |
|--|-------------|-------------|
| Full UI (Markdown, syntax highlight) | ✅ | ❌ Plain text |
| Send images | ✅ Paste/drag/attach | ✅ Send photo |
| Permission approval | ✅ Inline buttons | ✅ Inline buttons |
| Offline cache | ✅ Service Worker | ❌ |
| No tunnel required | ❌ Needs Cloudflare/ngrok | ✅ Works anywhere |
| Multi-device notifications | Requires push setup | ✅ Native |
| Setup complexity | Medium (tunnel config) | Low (BotFather + env) |

You can use both at the same time.

## Permission Hook

CliHub includes a `PreToolUse` hook that routes Claude Code's permission requests to your phone for approval. This is what enables the approve/deny buttons on your phone. Without it, Claude runs with whatever permission mode you set in the CLI.

**Automatic install** (via setup.sh): The setup script will offer to configure the hook for you.

**Manual install**: Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "",
      "hooks": ["bash:/absolute/path/to/clihub/hooks/permission-hook.sh"]
    }]
  }
}
```

> Replace `/absolute/path/to/clihub/` with your actual clihub directory path.

When Claude tries to use a tool (write file, run command, etc.), you'll get a notification on your phone with approve/deny buttons.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `BEARER_TOKEN` | *(required)* | Authentication token for the web UI |
| `HOOK_TOKEN` | same as BEARER_TOKEN | Token for permission hook requests |
| `PORT` | `5678` | Server port |
| `PROJECTS_DIR` | `~/Documents/Project` | Root directory containing your projects (adjust to your setup) |
| `CF_ACCESS_DOMAIN` | *(none)* | Cloudflare Access domain for CSP headers (optional) |
| `TELEGRAM_BOT_TOKEN` | *(none)* | Telegram Bot token from @BotFather (optional) |
| `TELEGRAM_ALLOWED_USERS` | *(none)* | Comma-separated Telegram user IDs (required if bot enabled) |
| `CLIHUB_HOOK_ALLOW_EXTERNAL` | `0` | Allow non-CliHub sessions to bypass permission hook (0 = deny, 1 = allow) |

## Security

CliHub is designed for **personal use** on a private network or behind a tunnel.

- **Bearer token auth** — all HTTP and WebSocket connections require a token
- **Rate limiting** — login attempts are throttled (5 per 15 min)
- **CSP headers** — strict Content-Security-Policy, no inline scripts
- **Path traversal protection** — project directories are sandboxed
- **XSS sanitization** — all Markdown output passes through DOMPurify

For remote access, we recommend [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) with Access policies.

## Tech Stack

- **Backend**: Node.js + Express + ws (WebSocket)
- **Frontend**: Vanilla HTML/CSS/JS — zero frameworks, zero build step
- **Markdown**: marked + highlight.js + DOMPurify (local vendor copies)
- **Persistence**: SQLite (better-sqlite3)
- **Telegram**: node-telegram-bot-api (optional)
- **Process management**: Node.js `child_process` with NDJSON stream-json protocol

## Project Structure

```
server.js              # Backend entry point
db.js                  # SQLite database layer
telegram.js            # Optional Telegram Bot integration
ecosystem.config.js    # PM2 process manager config
public/
  index.html           # Main HTML shell
  css/style.css        # Styles
  js/                  # Frontend modules (app, i18n, messages, sessions, ...)
  locales/             # i18n translations (en.json, zh.json)
  vendor/              # Third-party libs (marked, hljs, DOMPurify)
hooks/
  permission-hook.sh   # PreToolUse hook for remote permission approval
Dockerfile             # Docker image
docker-compose.yml     # Docker Compose config
```

## License

[MIT](LICENSE)
