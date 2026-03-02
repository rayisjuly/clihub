# Contributing to CliHub

Thanks for your interest in contributing!

## Development Setup

```bash
git clone https://github.com/rayisjuly/clihub.git
cd clihub
npm install
BEARER_TOKEN=dev node server.js
```

Open `http://localhost:5678` in your browser.

## Project Structure

```
server.js              # Backend: Express + WebSocket + process management
public/
  index.html           # Main HTML shell
  css/style.css        # All styles
  js/
    app.js             # Core namespace + WS connection
    i18n.js            # i18n module
    messages.js        # Message rendering + streaming
    sessions.js        # Session lifecycle + sidebar
    permissions.js     # Permission approval UI
    commands.js        # Slash command autocomplete
    tokens.js          # Context usage status bar
    images.js          # Image upload/preview
    notifications.js   # Push notifications
    init.js            # DOM event bindings + startup
  locales/
    en.json            # English translations
    zh.json            # Chinese translations
  vendor/              # Local copies of third-party libs
hooks/
  permission-hook.sh   # PreToolUse hook for remote approval
```

## Code Style

- **No frameworks** — vanilla HTML/CSS/JS only
- **CommonJS** on server (`require`/`module.exports`)
- **`ClaudeHub` namespace** on client — all modules attach to `window.ClaudeHub`
- 2-space indent, single quotes, semicolons
- `registerHandler(type, fn)` pattern for WS message handling

## i18n Guidelines

All user-facing text must be translated:

- **Static HTML**: use `data-i18n`, `data-i18n-placeholder`, or `data-i18n-title` attributes
- **Dynamic JS**: use `ClaudeHub.t('key')` or `ClaudeHub.t('key', { param: value })`
- **Server-side**: English only (no i18n on backend)
- Add keys to both `public/locales/en.json` and `public/locales/zh.json`

## Pull Requests

1. Fork and create a feature branch
2. Keep changes focused — one feature/fix per PR
3. Test on mobile (this is a mobile-first PWA)
4. Update locale files if adding user-facing text

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
