# CliHub

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
- **Claude Code CLI** — `npm install -g @anthropic-ai/claude-code` (must be logged in)
- **jq** — `brew install jq` (required for permission hook)

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

> **Note:** Docker mode mounts `~/.claude` from the host, so Claude Code CLI must be installed and authenticated on the host machine.

Open `http://localhost:5678` on your phone (or set up a tunnel for remote access).

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `BEARER_TOKEN` | *(required)* | Authentication token for the web UI |
| `HOOK_TOKEN` | same as BEARER_TOKEN | Token for permission hook requests |
| `PORT` | `5678` | Server port |
| `PROJECTS_DIR` | `~/Documents/Project` | Root directory containing your projects (adjust to your setup) |

## Security

CliHub is designed for **personal use** on a private network or behind a tunnel.

- **Bearer token auth** — all HTTP and WebSocket connections require a token
- **Rate limiting** — login attempts are throttled (5 per 15 min)
- **CSP headers** — strict Content-Security-Policy, no inline scripts
- **Path traversal protection** — project directories are sandboxed
- **XSS sanitization** — all Markdown output passes through DOMPurify

For remote access, we recommend [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) with Access policies.

## Permission Hook

CliHub includes a `PreToolUse` hook that routes Claude Code's permission requests to your phone for approval.

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

## Tech Stack

- **Backend**: Node.js + Express + ws (WebSocket)
- **Frontend**: Vanilla HTML/CSS/JS — zero frameworks, zero build step
- **Markdown**: marked + highlight.js + DOMPurify (local vendor copies)
- **Process management**: Node.js `child_process` with NDJSON stream-json protocol

## Project Structure

```
server.js              # Backend entry point
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
