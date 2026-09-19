#!/usr/bin/env bash
set -euo pipefail

: "${ZEIBAEL_ARCHIVE_DATABASE_URL:?ZEIBAEL_ARCHIVE_DATABASE_URL is required}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
OUT_DIR="${ZEIBAEL_ARCHIVE_OUTPUT_DIR:-$ROOT/.zeibael-shadow-archive}"
mkdir -p "$OUT_DIR"
MANIFEST="$OUT_DIR/source-manifest.json"
ARCHIVE="$OUT_DIR/completed-payloads.ndjson"

export PGOPTIONS="-c default_transaction_read_only=on"
psql -XAt --no-psqlrc -v ON_ERROR_STOP=1 "$ZEIBAEL_ARCHIVE_DATABASE_URL"   -f "$ROOT/integrations/supabase-shadow-migration/source-manifest.sql" > "$MANIFEST"

python3 - "$MANIFEST" <<'PY'
import json,sys
m=json.load(open(sys.argv[1],encoding="utf-8"))
a=m.get("active") or {}
if any(int(a.get(k,0)) != 0 for k in ("runs","tasks","workers")):
    raise SystemExit("archive blocked: active run/task/worker exists")
PY

psql -XAt --no-psqlrc -v ON_ERROR_STOP=1 "$ZEIBAEL_ARCHIVE_DATABASE_URL"   -f "$ROOT/integrations/supabase-shadow-migration/shadow-export-completed.sql" > "$ARCHIVE"

python3 "$ROOT/scripts/validate_shadow_archive.py" "$ARCHIVE" "$MANIFEST"
printf '%s\n' "$OUT_DIR"
