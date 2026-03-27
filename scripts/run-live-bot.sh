#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

BOT_CONTROL_BASE_URL="${BOT_CONTROL_BASE_URL:-http://127.0.0.1:${API_PORT:-3000}}"
BOT_DEPLOYMENT_TIER="${BOT_DEPLOYMENT_TIER:-paper}"
BOT_REQUIRE_PRODUCTION_READINESS_PASS="${BOT_REQUIRE_PRODUCTION_READINESS_PASS:-true}"
READINESS_ARTIFACT_PATH="${READINESS_ARTIFACT_PATH:-artifacts/production-readiness/latest.json}"

if [[ "${BOT_REQUIRE_PRODUCTION_READINESS_PASS}" == "true" ]] && \
  [[ "${BOT_DEPLOYMENT_TIER}" == "cautious_live" || "${BOT_DEPLOYMENT_TIER}" == "scaled_live" ]]; then
  if [[ ! -f "${READINESS_ARTIFACT_PATH}" ]]; then
    echo "Refusing to start ${BOT_DEPLOYMENT_TIER}: readiness artifact missing at ${READINESS_ARTIFACT_PATH}" >&2
    exit 1
  fi

  node -e '
const fs = require("fs");
const path = process.argv[1];
const maxAgeMs = Number(process.env.BOT_MAX_VENUE_SMOKE_AGE_MS ?? 21600000);
const payload = JSON.parse(fs.readFileSync(path, "utf8"));
if (payload.success !== true) {
  console.error(`Refusing live start: latest readiness artifact is not successful at ${path}`);
  process.exit(1);
}
const executedAt = Date.parse(payload.executedAt ?? "");
if (!Number.isFinite(executedAt) || Date.now() - executedAt > maxAgeMs) {
  console.error(`Refusing live start: readiness artifact is stale at ${path}`);
  process.exit(1);
}
' "${READINESS_ARTIFACT_PATH}"
fi

curl -X POST "${BOT_CONTROL_BASE_URL}/api/v1/bot-control/start" \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "start requested from script",
    "requestedBy": "run-live-bot.sh"
  }'
