# hooks/

Claude Code PreToolUse hooks for remote permission approval.

## Files

| File | Role | Description |
|------|------|-------------|
| `permission-hook.sh` | Core | Intercepts tool calls, POSTs to CliHub server for user approval via long-polling |

## How It Works

```
Claude CLI → PreToolUse Hook fires
  → permission-hook.sh reads stdin JSON (tool_name, tool_input, session_id)
  → curl POST to http://localhost:5678/api/permission
  → Server holds request, forwards to frontend via WebSocket
  → User taps Allow / Deny on phone
  → Server responds to curl
  → Hook exits 0 (allow) or 2 (deny)
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `CLIHUB_SESSION` | Set by server when spawning Claude CLI. If empty, hook exits 0 (bypass). |
| `HOOK_TOKEN` / `BEARER_TOKEN` | Auth token for the POST request. |

## Installation

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "",
      "hooks": ["bash:/path/to/clihub/hooks/permission-hook.sh"]
    }]
  }
}
```
