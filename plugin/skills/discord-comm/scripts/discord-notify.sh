#!/bin/bash
# Discord に通知を送信
# Usage: discord-notify.sh "メッセージ" [info|success|warning|error] ["タイトル"] [replyToId]
MESSAGE="${1:?Usage: discord-notify.sh MESSAGE [LEVEL] [TITLE] [REPLY_TO_ID]}"
LEVEL="${2:-info}"
TITLE="${3:-}"
REPLY_TO_ID="${4:-}"
PORT="${DISCORD_BRIDGE_PORT:-13456}"
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
CHANNEL_ID="${DISCORD_CHANNEL_ID:-}"
if [ -z "$CHANNEL_ID" ] && [ -n "$PROJECT_ROOT" ] && [ -f "$PROJECT_ROOT/.discord-bridge.json" ]; then
  CHANNEL_ID=$(python3 -c "import json; print(json.load(open('$PROJECT_ROOT/.discord-bridge.json'))['channelId'])" 2>/dev/null)
fi

JSON=$(python3 -c "
import json, sys
d = {'message': sys.argv[1], 'level': sys.argv[2]}
if sys.argv[3]:
    d['title'] = sys.argv[3]
if sys.argv[4]:
    d['channelId'] = sys.argv[4]
if sys.argv[5]:
    d['replyToId'] = sys.argv[5]
print(json.dumps(d, ensure_ascii=False))
" "$MESSAGE" "$LEVEL" "$TITLE" "$CHANNEL_ID" "$REPLY_TO_ID")

curl -s -X POST "http://localhost:${PORT}/notify"   -H "Content-Type: application/json"   -d "$JSON"
