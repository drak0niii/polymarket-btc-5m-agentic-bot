#!/usr/bin/env bash
set -euo pipefail

curl -X POST http://127.0.0.1:3000/api/v1/bot-control/start \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "start requested from script",
    "requestedBy": "run-live-bot.sh"
  }'