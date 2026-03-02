#!/bin/bash
# input: PreToolUse Hook stdin JSON (tool_name, tool_input, session_id, tool_use_id)
# output: exit 0 allow / exit 2 deny
# pos: Claude Code PreToolUse Hook, remote permission approval via HTTP long-polling

# Sessions not started by Hub bypass directly
if [ -z "$CLIHUB_SESSION" ]; then
  exit 0
fi

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name')
TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input')
SESSION="$CLIHUB_SESSION"
TOOL_USE_ID=$(echo "$INPUT" | jq -r '.tool_use_id')

PAYLOAD=$(echo "$INPUT" | jq -c --arg sid "$SESSION" \
  '{sessionId: $sid, tool: .tool_name, toolInput: .tool_input, toolUseId: .tool_use_id}')

RESPONSE=$(curl -s -X POST "http://localhost:5678/api/permission" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${HOOK_TOKEN:-$BEARER_TOKEN}" \
  -d "$PAYLOAD" \
  --max-time 120)

ALLOWED=$(echo "$RESPONSE" | jq -r '.allowed')

if [ "$ALLOWED" = "true" ]; then
  exit 0
else
  echo "User denied this operation" >&2
  exit 2
fi
