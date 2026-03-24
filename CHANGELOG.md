# Changelog

## [2.9.2] - 2026-03-24

### Added
- Telegram context usage display: accurate context % read from CLI transcript JSONL (matches statusline)
- Extract `contextWindow` from CLI `system.init` and `result.modelUsage` events (no more hardcoded model tables)
- SQLite `context_window` column for persistence across restarts

### Fixed
- Context % calculation: use single API call usage from transcript instead of cumulative billing tokens
- Model detection: read model from CLI init event, broadcast to frontend and Telegram
- Cost display: use `total_cost_usd` (replace, not accumulate) from CLI result event

## [2.9.1] - 2026-03-23

### Added
- Telegram Bot image support: send photos to Claude as visual input
- Telegram Bot auto-reconnect on network errors (EFATAL/ETIMEDOUT/ESOCKETTIMEDOUT)
- Network retry with exponential backoff (2s→4s→8s) for all Telegram message sends

### Changed
- Telegram stream edit interval: 1.5s → 3s to avoid Telegram API rate limits
- README restructured: added complete Cloudflare Tunnel tutorial, PWA vs Telegram comparison table, reorganized sections

## [2.9.0] - 2026-03-23

### Added
- Telegram Bot integration (optional): manage sessions from Telegram — create, list, switch, stop, resume, approve permissions
- Commands: `/new`, `/list`, `/switch`, `/stop`, `/resume`, `/status`
- User allowlist via `TELEGRAM_ALLOWED_USERS` env var (denies all by default)
- Stop generation: send button transforms into stop button during generation, interrupt Claude mid-response

## [2.8.1] - 2026-03-09

### Added
- `ecosystem.config.js`: PM2 process manager config (auto-restart, .env loading, log management)
- Built-in watchdog loop in `setup.sh` for environments without pm2
- PM2 npm scripts: `pm2:start`, `pm2:stop`, `pm2:restart`, `pm2:logs`, `pm2:status`

### Changed
- `setup.sh`: auto-detects pm2, uses it for process supervision; falls back to watchdog loop
- `package.json`: added pm2 convenience scripts
- `.gitignore`: added `logs/` directory

## [2.8.0] - 2026-03-04

### Added
- AskUserQuestion interactive UI: single/multi-select options, Other free input, Submit button (CLI style, blue accent)
- EnterPlanMode/ExitPlanMode custom permission labels ("Enter plan mode?" / "Approve plan?")
- Plan Mode green banner indicator (shows when Claude is planning, hides on exit)
- `public/js/questions.js`: new module for question interaction (parallel to permissions.js)
- Hook `additionalContext` fallback: user answers passed to Claude via context when `updatedInput` unsupported
- Push notifications for `question_request` events

### Changed
- `server.js`: INTERACTIVE_TOOLS set, `question_request`/`question_response` WS events, 180s timeout for AskUserQuestion
- `hooks/permission-hook.sh`: `hookSpecificOutput` JSON with `updatedInput` + `additionalContext`, file-based debug logging
- Sidebar badge counts include pending questions
- Tool result display: suppress error for answered AskUserQuestion (show ✓ instead of ✗)

## [2.7.0] - 2026-03-04

### Added
- Sidebar CLI-style beautification: status indicators (✓/spinning/✗), compact layout, horizontal footer
- `hooks/README.md`: documentation for permission hook setup

### Changed
- Sidebar session items: reduced padding, smaller font, removed pill badges (plain colored text)
- Sidebar footer: vertical stack → horizontal flex row, shortened labels ("Notify")
- New session button: `+ new` plain text button (no border)
- Group headers: simplified count format `(N)`, muted project name
- Delete button: smaller, red on hover
- Sidebar responsive widths: 300→280px (mobile), 320→300px (desktop)
- `scripts/sync-to-clihub.sh`: 10-item rewrite (pipefail, trap cleanup, clone verification, portable sed, privacy/brand coverage)
- `setup.sh`: complete rewrite (5 dependency checks, .env auto-creation, permission hook auto-install)
- `README.md`: added Prerequisites, One-command setup, Docker host CLI note
- `scripts/sync-protect.txt`: simplified from 5 to 3 entries (README auto-syncs with brand replacement)

## [2.6.2] - 2026-03-03

### Fixed
- Token usage showing 100%: server was accumulating `input_tokens` with `+=` but Claude API returns current context window size (not increment); changed to `=`
- Context percentage missing `output_tokens` in calculation
- Token display priority: prefer `totalUsage` over `lastTurnUsage` for accurate context %
- Bottom gap on iOS PWA: added `100dvh` viewport height, reduced safe-area bottom padding

### Added
- `scripts/sync-to-clihub.sh`: one-command sync to public repo (clone → rsync → brand replace → privacy scan → push)
- `scripts/sync-exclude.txt`: blacklist for private files (diary, .context, data, docs, etc.)
- `scripts/sync-protect.txt`: clihub-only files protection (.gitignore, README, CLAUDE.md, package.json)

## [2.6.1] - 2026-03-03

### Fixed
- Horizontal overflow on tool lines: multi-layer overflow protection (body, #app, #messages, .tl, .msg-text, table)
- Permission requests now force-scroll to bottom (requires user action)
- Token usage display: `renderTokenBar` falls back to `totalUsage` when `lastTurnUsage` unavailable
- History scroll pagination: changed from `seq` (duplicated across events) to DB auto-increment `id`
- iOS scroll passthrough: body `overflow:hidden` + `overscroll-behavior:contain` on messages

### Added
- Responsive breakpoints: sm (≤480px), lg (≥769px), xl (≥1025px)
- Safe-area support for header and sidebar (`env(safe-area-inset-top)`)
- Touch target optimization: menu button min 44×44px

### Changed
- Header compressed: title + meta on single row, reduced padding
- Start panel compressed: smaller buttons and select
- Viewport meta: removed `user-scalable=no`, added `viewport-fit=cover`
- Login box: `width:300px` → `width:90%; max-width:300px`
- SW cache bumped to v27

## [2.6.0] - 2026-03-02

### Added
- CLI terminal interaction mode: complete frontend rendering overhaul to simulate Claude Code CLI experience
- Tool tree-line rendering: `· verb summary` / `└ param` with spinning dot, ✓/✗ status indicators
- User messages with `❯` prompt style, assistant messages as flowing markdown text
- Inline permission prompts in message stream: `Allow? [Allow] [Allow Session] [Deny]`
- CLI-style thinking indicator with collapsible thought process
- Monospace font family (`SF Mono`, `Fira Code`, `Consolas`, `Monaco`)

### Changed
- tools.js: complete rewrite from `<details>` card system to CLI tree-line rendering
- messages.js: complete rewrite from chat bubbles to terminal-style prompt + flowing text
- permissions.js: modal popup → inline in message stream
- style.css: massive overhaul, removed all bubble/card/modal styles, added `.tl-*` CLI line styles
- `renderAssistantTurn` now returns DocumentFragment instead of container div
- SW cache bumped to v23

### Fixed
- Session list lost after server restart: added missing `createdAt` field to frontend session handlers

### Removed
- Chat bubble UI (avatars, headers, message wrappers)
- Tool card UI (`<details>` based expandable cards)
- Permission modal popup HTML and styles
- Old thinking block styles (shimmer, details-based)

## [2.5.0] - 2026-03-02

### Added
- SQLite persistent storage (better-sqlite3): structured event storage replacing NDJSON
- Tool card UI: expandable cards with specialized renderers (Bash/Read/Edit/Write/Glob/Grep)
- Dark/light theme system: CSS variables, system preference auto-detect, manual toggle
- Session resume: frontend Resume button for stopped sessions
- highlight.js light theme (github-light.min.css) for light mode code highlighting
- Auto-migration from existing JSON/NDJSON files to SQLite on first startup

### Changed
- `handleClaudeEvent()` rewritten: text batched on block_stop, thinking stored, tool_input/output untruncated
- `get_history` returns structured event format (events array per assistant turn)
- `session_status` handler now calls `updateActiveUI()` for proper state transitions
- SW cache bumped to v18

### Removed
- NDJSON file persistence (replaced by SQLite)
- Direct JSON file metadata storage (replaced by SQLite sessions table)

## [2.4.0] - 2026-03-02

### Added
- i18n bilingual system (English / Chinese), auto-detect + manual switch
- Docker support (Dockerfile + docker-compose.yml)
- WebSocket heartbeat: server-side ping/pong (30s) + client-side keep-alive (25s)
- Message sync: seq numbering + replay buffer (500 events) for reconnect recovery
- Disconnect grace period (2s) to avoid UI flicker on quick reconnects
- Exponential backoff reconnection (1s → 30s max)
- English documentation: README, CONTRIBUTING, LICENSE (MIT), .env.example
- CSP `CF_ACCESS_DOMAIN` env var (replaces hardcoded domain)

### Changed
- All source code comments and messages translated to English
- `broadcast()` → `broadcastSession()` with sequence numbers for session events
- SW cache bumped to v16, added i18n assets

## [2.3.3] - 2026-03-02

### Fixed
- CSP compatibility with Cloudflare Access
- manifest.json CORS: added crossorigin="use-credentials"
- favicon.ico 404: added SVG icon + favicon route
- Deprecated apple-mobile-web-app-capable meta tag

### Added
- Permission dialogs grouped by session
- App icon (SVG + PNG 192/512)
- Session list sorting: active sessions first

### Improved
- Server broadcast function cleanup
- SW cache v15

## [2.3.2] - 2026-03-02

### Fixed
- CDN dependencies localized to public/vendor/ (Safari ITP fix)
- Session list click: replaced inline onclick with event delegation (CSP)
- Delete button mobile mistouch fix (pointer-events:none when hidden)
- Defensive checks for third-party lib loading

### Added
- Multi-client permission sync: one client resolves, others auto-close
- Multi-client user message sync: real-time broadcast

## [2.3.1] - 2026-03-01

### Fixed
- Input disabled after WS reconnect: visibilitychange + ping/pong heartbeat
- Pending permissions lost on disconnect: resend on reconnect
- Slash command autocomplete missing auth header
- Session restore missing approvedTools field
- Duplicate permission dialogs: toolUseId dedup

### Added
- "Allow Session" permission button: auto-approve same tool for session duration

## [2.3.0] - 2026-03-01

### Security
- Image API path traversal fix
- /api/commands endpoint authentication
- readHistory path traversal fix
- projectDir whitelist validation
- CDN scripts pinned with SRI hashes
- Token removed from URL params, using fetch + blob URL
- escapeHTML: added quote escaping
- Hook script: jq JSON construction (shell injection fix)
- CSP: removed unsafe-inline, added HSTS
- Inline scripts extracted to init.js

### Fixed
- Input disabled after WS reconnect

## [2.2.0] - 2026-03-01

### Added
- Image send/receive: attach, paste, drag-and-drop with Canvas compression
- Push notifications via Notification API + Service Worker
- Notification toggle in sidebar

### Improved
- Multimodal content support (image + text)
- Image storage in data/images/
- express.json limit 10mb

## [2.1.0] - 2026-03-01

### Added
- Context window usage percentage status bar
- Session cost display
- Message history pagination (50 per page, scroll to load more)
- Thinking indicator (collapsible block)
- Session list grouped by project

### Improved
- Removed max session limit
- SW cache v8

## [2.0.1] - 2026-03-01

### Fixed
- Permission sessionId mismatch: hook uses environment variable
- Built-in permission bypass: added --permission-mode bypassPermissions

## [2.0.0] - 2026-03-01

### Added
- Multi-session management: parallel Claude Code processes
- Sidebar: drawer-style session list with status dots + unread badges
- Session switching with per-session message isolation
- Remote permission approval: PreToolUse Hook + HTTP long-polling + UI dialog
- Session resume via --resume flag
- WS protocol v2: all messages carry sessionId
- tool_use/tool_result event display

## [1.0.0] - 2026-02-28

### Added
- Express + WebSocket + Claude Code CLI bridge (NDJSON protocol)
- Chat UI: dark theme, mobile-first, streaming Markdown with syntax highlighting
- Project directory picker with auto-scan
- Slash command autocomplete (built-in + custom)
- PWA: manifest.json + Service Worker offline cache
- setup.sh: one-click install + tunnel setup
