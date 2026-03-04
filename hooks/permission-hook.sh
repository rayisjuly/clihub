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

# Longer timeout for interactive tools (AskUserQuestion needs user thinking time)
CURL_TIMEOUT=120
if [ "$TOOL" = "AskUserQuestion" ]; then
  CURL_TIMEOUT=180
fi

RESPONSE=$(curl -s -X POST "http://localhost:5678/api/permission" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${HOOK_TOKEN:-$BEARER_TOKEN}" \
  -d "$PAYLOAD" \
  --max-time "$CURL_TIMEOUT")

ALLOWED=$(echo "$RESPONSE" | jq -r '.allowed')
HAS_UPDATED=$(echo "$RESPONSE" | jq 'has("updatedInput")')

# Debug log to file (hook stderr may not reach server)
echo "[Hook $(date +%H:%M:%S)] tool=$TOOL allowed=$ALLOWED hasUpdated=$HAS_UPDATED" >> /tmp/clihub-hook.log

if [ "$ALLOWED" = "true" ]; then
  if [ "$HAS_UPDATED" = "true" ]; then
    # Build answers summary for additionalContext fallback
    ANSWERS_SUMMARY=$(echo "$RESPONSE" | jq -r '.updatedInput.answers | to_entries | map("\(.key): \(.value)") | join("; ")')

    OUTPUT=$(echo "$RESPONSE" | jq -c --arg ctx "User answered via remote UI: $ANSWERS_SUMMARY" '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: .updatedInput,
        additionalContext: $ctx
      }
    }')
    echo "[Hook $(date +%H:%M:%S)] stdout: $OUTPUT" >> /tmp/clihub-hook.log
    echo "$OUTPUT"
  fi
  exit 0
else
  echo "User denied this operation" >&2
  exit 2
fi
