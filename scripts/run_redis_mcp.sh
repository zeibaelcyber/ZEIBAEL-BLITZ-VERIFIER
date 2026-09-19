#!/usr/bin/env bash
set -euo pipefail

: "${ZEIBAEL_REDIS_URL:?ZEIBAEL_REDIS_URL is required; no implicit external Redis fallback}"
exec uvx --python 3.14 --from "redis-mcp-server==0.5.1" \
  redis-mcp-server --url "$ZEIBAEL_REDIS_URL"
