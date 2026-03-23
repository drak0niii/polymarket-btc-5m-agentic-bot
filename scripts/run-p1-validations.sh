#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

corepack pnpm --filter @polymarket-btc-5m-agentic-bot/worker typecheck
corepack pnpm --filter @polymarket-btc-5m-agentic-bot/worker test
