#!/usr/bin/env bash
set -euo pipefail
if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Linux required" >&2
  exit 42
fi
if ! command -v bwrap >/dev/null 2>&1; then
  echo "bwrap required" >&2
  exit 43
fi
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd -P)"
export MCP_SHELL_SECURITY_MODE="restrictive"
export MCP_SHELL_BWRAP_PATH="/usr/bin/bwrap"
export MCP_SHELL_ENABLE_STREAMING="false"
export MCP_SHELL_ENABLE_NETWORK="false"
export MCP_SHELL_DEFAULT_WORKDIR="$ROOT"
export MCP_SHELL_ALLOWED_WORKDIRS="$ROOT"
export MCP_SHELL_MAX_EXECUTION_TIME="60"
export MCP_DISABLED_TOOLS="terminal_operate,delete_execution_outputs"
export BACKOFFICE_ENABLED="false"
if [[ -x "$ROOT/node_modules/.bin/mcp-shell-server" ]]; then
  exec "$ROOT/node_modules/.bin/mcp-shell-server"
fi
exec npx --yes @mako10k/mcp-shell-server@2.8.1
