# Changelog

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
