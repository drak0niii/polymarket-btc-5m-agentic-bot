#!/usr/bin/env bash
set -euo pipefail

curl -X POST http://127.0.0.1:3000/api/v1/bot-control/stop \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "stop requested from script",
    "requestedBy": "stop-live-bot.sh",
    "cancelOpenOrders": true
  }'