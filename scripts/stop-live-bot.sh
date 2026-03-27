#!/usr/bin/env bash
set -euo pipefail

BOT_CONTROL_BASE_URL="${BOT_CONTROL_BASE_URL:-http://127.0.0.1:${API_PORT:-3000}}"

curl -X POST "${BOT_CONTROL_BASE_URL}/api/v1/bot-control/stop" \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "stop requested from script",
    "requestedBy": "stop-live-bot.sh",
    "cancelOpenOrders": true
  }'
