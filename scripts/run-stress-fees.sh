#!/usr/bin/env bash
set -euo pipefail

curl -X POST http://127.0.0.1:3000/api/v1/diagnostics/stress-tests/run \
  -H "Content-Type: application/json"