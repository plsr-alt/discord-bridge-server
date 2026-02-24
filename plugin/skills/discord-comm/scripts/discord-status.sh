#!/bin/bash
# Discord Bridge ヘルスチェック（チャンネル登録込み）
# Usage: discord-status.sh
PORT="${DISCORD_BRIDGE_PORT:-13456}"
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
CHANNEL_ID=""
ALLOWED_USER_IDS=""
if [ -n "$PROJECT_ROOT" ] && [ -f "$PROJECT_ROOT/.discord-bridge.json" ]; then
  CHANNEL_ID=$(python3 -c "import json; print(json.load(open('$PROJECT_ROOT/.discord-bridge.json')).get('channelId', ''))" 2>/dev/null)
  ALLOWED_USER_IDS=$(python3 -c "import json; print(json.dumps(json.load(open('$PROJECT_ROOT/.discord-bridge.json')).get('allowedUserIds', [])))" 2>/dev/null)
fi

# チャンネル設定をサーバーに登録
if [ -n "$CHANNEL_ID" ] && [ -n "$ALLOWED_USER_IDS" ]; then
  curl -s -X POST "http://localhost:${PORT}/register-channel" \
    -H "Content-Type: application/json" \
    -d "{\"channelId\": \"${CHANNEL_ID}\", \"allowedUserIds\": ${ALLOWED_USER_IDS}}" > /dev/null
fi

if [ -n "$CHANNEL_ID" ]; then
  curl -s "http://localhost:${PORT}/health?channelId=${CHANNEL_ID}"
else
  curl -s "http://localhost:${PORT}/health"
fi
