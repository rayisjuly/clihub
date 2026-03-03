#!/bin/bash
# input: System environment (Node.js, npm, claude, jq)
# output: Install dependencies + configure hook + start server
# pos: One-click setup and launch script

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

PORT=${PORT:-5678}
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

echo "=== CliHub Setup ==="
echo ""

# ─── Step 1: Check dependencies ───
echo "--- Checking dependencies ---"
MISSING=0

# Node.js (required)
if command -v node &>/dev/null; then
  echo -e "  ${GREEN}✓${NC} Node.js $(node -v)"
else
  echo -e "  ${RED}✗${NC} Node.js not found (required)"
  echo "    Install: brew install node"
  MISSING=1
fi

# npm (required)
if command -v npm &>/dev/null; then
  echo -e "  ${GREEN}✓${NC} npm $(npm -v)"
else
  echo -e "  ${RED}✗${NC} npm not found (required)"
  MISSING=1
fi

# Claude Code CLI (required)
if command -v claude &>/dev/null; then
  echo -e "  ${GREEN}✓${NC} Claude Code CLI installed"
else
  echo -e "  ${RED}✗${NC} Claude Code CLI not found (required)"
  echo "    Install: npm install -g @anthropic-ai/claude-code"
  MISSING=1
fi

# jq (required for permission hook)
if command -v jq &>/dev/null; then
  echo -e "  ${GREEN}✓${NC} jq $(jq --version 2>&1)"
else
  echo -e "  ${YELLOW}!${NC} jq not found (required for permission hook)"
  echo "    Install: brew install jq"
  MISSING=1
fi

# cloudflared (optional)
if command -v cloudflared &>/dev/null; then
  echo -e "  ${GREEN}✓${NC} cloudflared installed (optional)"
else
  echo -e "  ${YELLOW}-${NC} cloudflared not installed (optional, for remote access)"
fi

if [ "$MISSING" = "1" ]; then
  echo ""
  echo -e "${RED}Missing dependencies. Install them and re-run.${NC}"
  exit 1
fi

# ─── Step 2: Install npm packages ───
echo ""
echo "--- Installing npm packages ---"
npm install --silent
echo -e "  ${GREEN}✓${NC} Dependencies installed"

# ─── Step 3: Configure .env ───
echo ""
echo "--- Configuring environment ---"

if [ ! -f .env ]; then
  cp .env.example .env
  echo -e "  ${YELLOW}!${NC} Created .env from .env.example"
  echo ""
  echo "    Edit .env and set BEARER_TOKEN, then re-run:"
  echo -e "    ${YELLOW}nano .env && ./setup.sh${NC}"
  exit 0
fi

# Load .env
set -a
source .env
set +a

if [ -z "$BEARER_TOKEN" ] || [ "$BEARER_TOKEN" = "your_secret_token_here" ]; then
  echo -e "  ${RED}✗${NC} BEARER_TOKEN not set in .env"
  echo "    Edit .env and set a real token, then re-run."
  exit 1
fi
echo -e "  ${GREEN}✓${NC} BEARER_TOKEN configured"

# ─── Step 4: Permission hook (optional) ───
echo ""
echo "--- Permission hook ---"

HOOK_PATH="$SCRIPT_DIR/hooks/permission-hook.sh"
SETTINGS_FILE="$HOME/.claude/settings.json"

# Check if hook is already configured
HOOK_INSTALLED=false
if [ -f "$SETTINGS_FILE" ]; then
  if grep -q "permission-hook.sh" "$SETTINGS_FILE" 2>/dev/null; then
    HOOK_INSTALLED=true
  fi
fi

if $HOOK_INSTALLED; then
  echo -e "  ${GREEN}✓${NC} Permission hook already configured"
else
  echo "  The permission hook lets you approve/deny Claude's tool calls"
  echo "  from your phone. Without it, tools run without confirmation."
  echo ""
  echo -n "  Install permission hook? (y/N) "
  read -r confirm
  if [[ "$confirm" == "y" || "$confirm" == "Y" ]]; then
    chmod +x "$HOOK_PATH"
    mkdir -p "$HOME/.claude"
    if [ -f "$SETTINGS_FILE" ]; then
      # Merge into existing settings
      TEMP_FILE=$(mktemp)
      jq --arg hook "bash:$HOOK_PATH" '
        .hooks //= {} |
        .hooks.PreToolUse //= [] |
        if (.hooks.PreToolUse | map(select(.hooks[] | contains("permission-hook.sh"))) | length) == 0
        then .hooks.PreToolUse += [{"matcher": "", "hooks": [$hook]}]
        else .
        end
      ' "$SETTINGS_FILE" > "$TEMP_FILE" && mv "$TEMP_FILE" "$SETTINGS_FILE"
    else
      cat > "$SETTINGS_FILE" << EOF
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": ["bash:$HOOK_PATH"]
      }
    ]
  }
}
EOF
    fi
    echo -e "  ${GREEN}✓${NC} Hook installed → $SETTINGS_FILE"
  else
    echo -e "  ${YELLOW}-${NC} Skipped (see hooks/README.md to install later)"
  fi
fi

# ─── Step 5: Start server ───
echo ""
echo "=== Starting CliHub ==="

node server.js &
SERVER_PID=$!

# Start tunnel (if available and configured)
if command -v cloudflared &>/dev/null && [ -n "$TUNNEL_NAME" ]; then
  echo "Starting Cloudflare Tunnel: $TUNNEL_NAME"
  cloudflared tunnel run --url "http://localhost:$PORT" "$TUNNEL_NAME" &
  TUNNEL_PID=$!
fi

trap "echo ''; echo 'Stopping...'; kill $SERVER_PID 2>/dev/null; [ -n \"$TUNNEL_PID\" ] && kill $TUNNEL_PID 2>/dev/null; exit 0" SIGINT SIGTERM

echo ""
echo -e "${GREEN}CliHub is running${NC}"
echo "  Local:  http://localhost:$PORT"
[ -n "$TUNNEL_NAME" ] && echo "  Remote: via Cloudflare Tunnel ($TUNNEL_NAME)"
echo ""
echo "  Open this URL on your phone to start managing sessions."
echo "  Press Ctrl+C to stop."

wait
