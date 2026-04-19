#!/bin/bash
# cc -> codex 委譲スクリプト v2.0 (HTTP/SSE-based)
# Usage: discord-delegate.sh "タスク内容" [codex番号1-5] [タイムアウト秒]

TASK="${1:?Usage: discord-delegate.sh \"task\" [codex_number] [timeout_seconds]}"
CODEX_NUM="${2:-1}"
TIMEOUT="${3:-300}"
PORT="${DISCORD_BRIDGE_PORT:-13456}"
BASE_URL="http://localhost:${PORT}"

# 返信先チャンネル（cc1-3）と送信先（codex1-5）のID解決
REPLY_CHANNEL_ID="${DISCORD_CHANNEL_ID:-}"
CODEX_CHANNEL_ID=$(python3 -c "
import json
cfg = json.load(open('/home/deploy/.discord-bridge.json'))
print(cfg.get('channels', {}).get('bridge-codex${CODEX_NUM}', ''))
" 2>/dev/null)

if [ -z "$CODEX_CHANNEL_ID" ]; then
  echo "[delegate] ERROR: bridge-codex${CODEX_NUM} not found" >&2
  exit 1
fi

echo "[delegate] -> codex${CODEX_NUM} (reply to: ${REPLY_CHANNEL_ID})" >&2

# タスクにreturn_channelを埋め込んでcodexへ送信
PAYLOAD=$(python3 -c "
import json, sys
task = sys.argv[1]
reply_ch = sys.argv[2]
codex_ch = sys.argv[3]
d = {
    'channelId': codex_ch,
    'message': task,
    'level': 'info',
    'title': 'TASK:return_channel=' + reply_ch
}
print(json.dumps(d, ensure_ascii=False))
" "$TASK" "$REPLY_CHANNEL_ID" "$CODEX_CHANNEL_ID")

curl -s -X POST "${BASE_URL}/notify" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" > /dev/null

# SSEでcodexチャンネルの返信を待機
echo "[delegate] Waiting for codex${CODEX_NUM} result (${TIMEOUT}s)..." >&2

RESULT=$(curl -s -N "${BASE_URL}/events?channelId=${CODEX_CHANNEL_ID}" \
  --max-time "$TIMEOUT" 2>/dev/null \
  | awk '/^event: notify$/ { found=1; next } found && /^data:/ { sub(/^data: /,""); print; found=0; exit }')

if [ -n "$RESULT" ]; then
  # JSONからmessageフィールドを抽出
  MSG=$(echo "$RESULT" | python3 -c "
import json, sys
try:
    d = json.loads(sys.stdin.read())
    print(d.get('message', d.get('content', '')))
except:
    pass
" 2>/dev/null)
  echo "${MSG:-$RESULT}"
  exit 0
else
  echo "[delegate] Timeout after ${TIMEOUT}s" >&2
  exit 1
fi
