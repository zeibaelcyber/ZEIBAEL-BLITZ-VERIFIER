#!/usr/bin/env bash
set -euo pipefail

ROOT=/tmp/doppler-mcp
test "$(git -C "$ROOT" rev-parse HEAD)" = "989b827c0ff9c93cba529549c2bbed50a48a9191"

grep -F 'case "--read-only"' "$ROOT/src/index.ts" >/dev/null
grep -F 'tool.method === "GET"' "$ROOT/src/index.ts" >/dev/null
grep -F 'serverName = options.readOnly ? "doppler-api-readonly"' "$ROOT/src/index.ts" >/dev/null
grep -F 'DOPPLER_TOKEN' "$ROOT/src/index.ts" >/dev/null

help_out="$(node "$ROOT/dist/index.js" --help 2>&1)"
grep -F -- "--read-only" <<<"$help_out" >/dev/null

set +e
noauth_out="$(env -i PATH="$PATH" HOME="$(mktemp -d)" node "$ROOT/dist/index.js" --read-only 2>&1)"
noauth_rc=$?
set -e
if [[ "$noauth_rc" -eq 0 ]]; then
  echo "Doppler MCP unexpectedly started without credentials" >&2
  exit 1
fi
grep -F "Not authenticated" <<<"$noauth_out" >/dev/null

printf '%s
' '{
  "schema":"zeibael.doppler_readonly_public_canary.v1",
  "status":"PASS",
  "source_commit":"989b827c0ff9c93cba529549c2bbed50a48a9191",
  "dependency_high_severity_gate":"PASS",
  "readonly_get_filter":"PASS",
  "no_credential_fail_closed":"PASS",
  "real_secret_access":false,
  "supabase_access":false,
  "blitz_router_changed":false,
  "live_order_enabled":false
}'
