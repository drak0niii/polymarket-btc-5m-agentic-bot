#!/usr/bin/env bash
set -euo pipefail

pnpm --filter @polymarket-btc-5m-agentic-bot/api exec prisma migrate dev --config ../../prisma.config.ts