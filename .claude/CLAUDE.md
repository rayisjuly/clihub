# CliHub — Project Development Rules

## Overview

Self-hosted CLI session manager — manage multiple Claude Code sessions from your phone. A lightweight PWA bridging mobile browser to Claude Code CLI processes via WebSocket.

## Tech Stack

| Layer | Choice |
|-------|--------|
| Backend | Node.js + Express + ws |
| Frontend | Vanilla HTML/CSS/JS (zero frameworks) |
| Markdown | marked + highlight.js + DOMPurify (local vendor) |
| Tunnel | Cloudflare Tunnel (or any reverse proxy) |
| Process mgmt | Node.js child_process |
| Persistence | SQLite (better-sqlite3) |

## Design Principles

- **Zero frameworks** — no React/Vue/build step; just vanilla JS modules
- **Modular frontend** — `public/js/*.js` modules share `window.CliHub` namespace
- **Minimal dependencies** — only `express`, `ws`, `better-sqlite3`, and `node-telegram-bot-api` (optional) in package.json
- **Stream-json protocol** — Claude Code CLI communicates via NDJSON stdin/stdout
- **CLI terminal style** — messages rendered as terminal prompts with monospace font

## File Structure

```
clihub/
├── server.js                 # Backend: Express + WebSocket + process management
├── db.js                     # SQLite persistence: sessions + events tables
├── package.json
├── ecosystem.config.js       # PM2 process manager config (auto-restart, .env loading)
├── public/                   # Frontend static files
│   ├── index.html            # Main HTML shell
│   ├── css/style.css         # All styles
│   ├── js/                   # Frontend modules
│   │   ├── app.js            # Core: CliHub namespace, WS connection, dispatch
│   │   ├── i18n.js           # Internationalization (locale loading, t(), DOM apply)
│   │   ├── messages.js       # Message rendering (Markdown, tool calls, thinking)
│   │   ├── sessions.js       # Session list, switching, create/stop
│   │   ├── permissions.js    # Inline permission prompts (approve/deny in message stream)
│   │   ├── tools.js          # CLI tree-line tool rendering (verb / param / status)
│   │   ├── commands.js       # Slash command autocomplete
│   │   ├── tokens.js         # Token usage display
│   │   ├── images.js         # Image attach/paste/drag/compress/upload
│   │   ├── notifications.js  # Push notification support
│   │   └── init.js           # Bootstrap: wire DOM, init modules, connect WS
│   ├── locales/              # i18n translation files
│   │   ├── en.json           # English
│   │   └── zh.json           # Chinese
│   ├── vendor/               # Third-party libs (local copies, no CDN)
│   │   ├── marked.min.js
│   │   ├── highlight.min.js
│   │   ├── purify.min.js
│   │   ├── github-dark.min.css
│   │   └── github-light.min.css
│   ├── manifest.json         # PWA manifest
│   ├── sw.js                 # Service Worker (offline caching)
│   ├── icon.svg / icon-192.png / icon-512.png
│   └── README.md             # Frontend directory docs
├── hooks/
│   └── permission-hook.sh    # PreToolUse Hook (remote permission long-polling)
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── setup.sh                  # One-click install + start script
├── LICENSE                   # MIT
├── CONTRIBUTING.md
├── CHANGELOG.md
└── .claude/
    └── CLAUDE.md             # This file
```

## Core Protocol

### Claude Code stream-json

```bash
claude -p \
  --input-format stream-json \
  --output-format stream-json \
  --include-partial-messages \
  --verbose \
  --permission-mode bypassPermissions
```

- Input: NDJSON written to stdin
- Output: NDJSON read from stdout
- Key events: `text_delta` (streaming text), `tool_use` (permission check), `result` (contains session_id)
- `bypassPermissions` disables built-in permission prompts; PreToolUse Hook handles approval instead

### WebSocket Messages

Server ↔ Frontend communicate via WebSocket (`/ws`), all messages are JSON.

### Permission Hook Flow

```
Claude CLI attempts tool use
  → PreToolUse Hook fires (permission-hook.sh)
  → Hook POSTs to server /api/permission
  → Server forwards to frontend via WS
  → User taps Allow / Deny on phone
  → Response returned to Hook
  → Hook exits 0 (allow) or 2 (deny)
```

## Frontend Architecture

- **Namespace**: All modules attach to `window.CliHub`
- **Handler pattern**: `CliHub.registerHandler(type, fn)` for WS message routing
- **DOM cache**: All DOM references stored in `CliHub.el` object
- **i18n**: `CliHub.t('key')` for JS strings, `data-i18n` / `data-i18n-placeholder` attributes for HTML
- **Event binding**: All in `DOMContentLoaded` via `addEventListener` (init.js)

## Development Phases

| Phase | Goal | Status |
|-------|------|--------|
| 1 | Core communication (MVP) — single session + streaming | Done |
| 2 | Multi-session + permission approval | Done |
| 3 | UX polish — i18n, images, notifications, token display | Done |
| 3.5 | SQLite persistence + tool cards + dual theme + resume | Done |
| 3.6 | CLI terminal interaction mode | In progress |
| 4 | Automation — scheduled tasks, auto-start, health checks | Planned |

## Coding Conventions

- CommonJS modules (`require` / `module.exports`) on server
- 2-space indentation
- Single quotes for strings
- Process crashes must not bring down the main server
- Environment variables for config, with sensible defaults
- All user-facing strings go through i18n (`en.json` / `zh.json`)
- All code comments in English

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BEARER_TOKEN` | *(required)* | Auth token for web UI |
| `HOOK_TOKEN` | = BEARER_TOKEN | Token for permission hook requests |
| `PORT` | `5678` | Server port |
| `PROJECTS_DIR` | `~/Documents/Project` | Root dir containing your projects |
| `CF_ACCESS_DOMAIN` | *(none)* | Cloudflare Access domain for CSP headers |

## Security

- Bearer token authentication on all HTTP/WS connections
- Rate limiting on login (5 attempts / 15 min)
- Strict CSP headers, no inline scripts
- Path traversal protection on project directories
- XSS sanitization via DOMPurify on all rendered Markdown
- HSTS enabled

## Cache Versioning

When modifying frontend files:
1. Update `CACHE_NAME` in `public/sw.js` (e.g., `clihub-v17`)
2. If adding/removing files, update the `ASSETS` array in `sw.js`
