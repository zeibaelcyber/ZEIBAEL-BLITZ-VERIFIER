#!/usr/bin/env bash
set -euo pipefail

: "${UPSTASH_EMAIL:?UPSTASH_EMAIL is required}"
: "${UPSTASH_API_KEY:?UPSTASH_API_KEY is required}"
exec npx --yes @upstash/mcp-server@0.3.0 \
  --email "$UPSTASH_EMAIL" \
  --api-key "$UPSTASH_API_KEY" \
  --disable-telemetry
