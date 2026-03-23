#!/usr/bin/env bash
set -euo pipefail

curl -X POST http://127.0.0.1:3000/api/v1/bot-control/halt \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "emergency halt requested from script",
    "requestedBy": "halt-live-bot.sh",
    "cancelOpenOrders": true
  }'
