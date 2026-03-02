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

## Quick Start

### npm

```bash
git clone https://github.com/rayisjuly/clihub.git
cd clihub
npm install

# Start the server (token required)
BEARER_TOKEN=your_secret node server.js
```

### Docker

```bash
git clone https://github.com/rayisjuly/clihub.git
cd clihub
cp .env.example .env
# Edit .env and set BEARER_TOKEN

docker compose up -d
```

Open `http://localhost:5678` on your phone (or set up a tunnel for remote access).

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `BEARER_TOKEN` | *(required)* | Authentication token for the web UI |
| `HOOK_TOKEN` | same as BEARER_TOKEN | Token for permission hook requests |
| `PORT` | `5678` | Server port |
| `PROJECTS_DIR` | `~/Documents/Project` | Root directory containing your projects |

## Security

CliHub is designed for **personal use** on a private network or behind a tunnel.

- **Bearer token auth** — all HTTP and WebSocket connections require a token
- **Rate limiting** — login attempts are throttled (5 per 15 min)
- **CSP headers** — strict Content-Security-Policy, no inline scripts
- **Path traversal protection** — project directories are sandboxed
- **XSS sanitization** — all Markdown output passes through DOMPurify

For remote access, we recommend [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) with Access policies.

## Permission Hook

CliHub includes a `PreToolUse` hook that routes Claude Code's permission requests to your phone for approval:

```bash
# Install the hook (one-time setup)
# Add to ~/.claude/settings.json:
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "",
      "hooks": ["bash:/path/to/clihub/hooks/permission-hook.sh"]
    }]
  }
}
```

When Claude tries to use a tool (write file, run command, etc.), you'll get a notification on your phone with approve/deny buttons.

## Tech Stack

- **Backend**: Node.js + Express + ws (WebSocket)
- **Frontend**: Vanilla HTML/CSS/JS — zero frameworks, zero build step
- **Markdown**: marked + highlight.js + DOMPurify (local vendor copies)
- **Process management**: Node.js `child_process` with NDJSON stream-json protocol

## Project Structure

```
server.js              # Backend entry point
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
