#!/usr/bin/env bash
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd -P)"
COMMIT="a8d9b5786f81e70e73cce7bb164f5f83da84a4b5"
CACHE_BASE="${XDG_CACHE_HOME:-$HOME/.cache}/zeibael/zenith-safe"
CHECKOUT="$CACHE_BASE/$COMMIT"
MARKER="$CHECKOUT/.zeibael-safe-patched"

for bin in git uv python3; do
  command -v "$bin" >/dev/null 2>&1 || { echo "$bin required for Zenith safe wrapper" >&2; exit 44; }
done

mkdir -p "$CACHE_BASE"
if [[ ! -d "$CHECKOUT/.git" ]]; then
  rm -rf "$CHECKOUT"
  git clone --quiet --no-checkout https://github.com/Intelligent-Internet/zenith.git "$CHECKOUT"
  git -C "$CHECKOUT" fetch --quiet --depth 1 origin "$COMMIT"
  git -C "$CHECKOUT" checkout --quiet --detach "$COMMIT"
fi

ACTUAL="$(git -C "$CHECKOUT" rev-parse HEAD)"
[[ "$ACTUAL" == "$COMMIT" ]] || { echo "Zenith commit drift: $ACTUAL" >&2; exit 45; }

if [[ ! -f "$MARKER" ]]; then
  git -C "$CHECKOUT" reset --hard --quiet "$COMMIT"
  git -C "$CHECKOUT" clean -fdx --quiet
  python3 "$ROOT/scripts/patch_zenith_safe.py" "$CHECKOUT"
  printf '%s\n' "$COMMIT" > "$MARKER"
fi

TARGET="$CHECKOUT/zenith/src/zenith_harness/acp_runner.py"
grep -q 'sandbox_mode="workspace-write"' "$TARGET" || { echo "Zenith workspace sandbox patch missing" >&2; exit 46; }
grep -q 'approval_policy="on-request"' "$TARGET" || { echo "Zenith approval patch missing" >&2; exit 47; }
grep -q 'sandbox_workspace_write.network_access=false' "$TARGET" || { echo "Zenith network-off patch missing" >&2; exit 48; }
if grep -q 'sandbox_mode="danger-full-access"' "$TARGET"; then
  echo "Unsafe Zenith danger-full-access survived patch" >&2
  exit 49
fi

export ZENITH_ORCHESTRATOR_PROVIDER="codex"
export ZENITH_WORKER_PROVIDER="codex"
export ZENITH_VALIDATOR_PROVIDER="codex"
export ZENITH_TERMINAL_REVIEWER_PROVIDER="codex"
export ZENITH_MAX_PARALLEL_NODES="${ZENITH_MAX_PARALLEL_NODES:-4}"
export ZENITH_WORKER_REASONING_EFFORT="${ZENITH_WORKER_REASONING_EFFORT:-high}"
export ZENITH_VALIDATOR_REASONING_EFFORT="${ZENITH_VALIDATOR_REASONING_EFFORT:-high}"
export ZENITH_TERMINAL_REVIEWER_REASONING_EFFORT="${ZENITH_TERMINAL_REVIEWER_REASONING_EFFORT:-high}"

exec uv run --project "$CHECKOUT/zenith" zenith-server --mode orchestrator --transport stdio
