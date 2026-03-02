#!/bin/bash
# input: System environment (Node.js, npm, cloudflared)
# output: Install dependencies + start server
# pos: One-click deployment script

set -e

echo "=== CliHub Setup ==="

# Check Node.js
if ! command -v node &> /dev/null; then
  echo "Node.js is required. Install: brew install node"
  exit 1
fi
echo "Node.js $(node -v)"

# Check npm
if ! command -v npm &> /dev/null; then
  echo "npm is required"
  exit 1
fi
echo "npm $(npm -v)"

# Install dependencies
echo "Installing dependencies..."
npm install

# Check cloudflared (optional)
if command -v cloudflared &> /dev/null; then
  echo "cloudflared installed"
  HAS_TUNNEL=true
else
  echo "cloudflared not installed (optional, for remote access)"
  echo "  Install: brew install cloudflare/cloudflare/cloudflared"
  HAS_TUNNEL=false
fi

echo ""
echo "=== Starting ==="

# Start server
PORT=${PORT:-5678}
echo "Starting CliHub on http://localhost:$PORT"
node server.js &
SERVER_PID=$!

# Start tunnel (if available)
if [ "$HAS_TUNNEL" = true ] && [ -n "$TUNNEL_NAME" ]; then
  echo "Starting Cloudflare Tunnel: $TUNNEL_NAME"
  cloudflared tunnel run --url http://localhost:$PORT "$TUNNEL_NAME" &
  TUNNEL_PID=$!
fi

# Graceful exit
trap "echo 'Stopping...'; kill $SERVER_PID 2>/dev/null; [ -n \"$TUNNEL_PID\" ] && kill $TUNNEL_PID 2>/dev/null; exit 0" SIGINT SIGTERM

echo ""
echo "CliHub is running"
echo "  Local:  http://localhost:$PORT"
[ "$HAS_TUNNEL" = true ] && echo "  Remote: via Cloudflare Tunnel"
echo "  Press Ctrl+C to stop"

wait
