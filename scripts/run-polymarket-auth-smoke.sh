#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
corepack pnpm --filter @polymarket-btc-5m-agentic-bot/worker smoke:polymarket-auth
