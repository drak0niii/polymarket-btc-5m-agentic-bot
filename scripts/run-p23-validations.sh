#!/usr/bin/env bash
set -euo pipefail

corepack pnpm --filter @polymarket-btc-5m-agentic-bot/worker typecheck
corepack pnpm --filter @polymarket-btc-5m-agentic-bot/worker test
corepack pnpm --filter @polymarket-btc-5m-agentic-bot/worker validate:p23
