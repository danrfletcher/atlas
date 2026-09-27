#!/usr/bin/env bash
# Manual real-Mac smoke test for GP1. Run this on the host Mac -- not in CI, and not
# from another machine over Tailscale unless you pass that machine's Tailscale IP as
# the first argument.
#
# Usage: tests/smoke_mac.sh [tailscale-host] [port]
set -euo pipefail

PORT="${2:-8787}"
TOKEN_FILE="${MAC_INVENTORY_TOKEN_FILE:-$HOME/.config/mac-inventory/token}"

HOST="${1:-}"
if [ -z "$HOST" ]; then
  HOST="$(ifconfig | awk '/inet /{print $2}' | grep -E '^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.' | head -n1 || true)"
fi
if [ -z "$HOST" ]; then
  echo "Could not auto-detect a Tailscale address; pass it as the first argument." >&2
  exit 1
fi

if [ ! -s "$TOKEN_FILE" ]; then
  echo "Token file missing or empty: $TOKEN_FILE" >&2
  exit 1
fi

TOKEN="$(cat "$TOKEN_FILE")"
BASE="http://${HOST}:${PORT}"

json_len() {
  python3 -c "import json,sys; print(len(json.load(sys.stdin)['items']))"
}

echo "== /apps (via ${BASE}) =="
apps_json="$(curl -sf -H "Authorization: Bearer ${TOKEN}" "${BASE}/apps")"
echo "apps count: $(echo "$apps_json" | json_len)"

echo "== /cli =="
cli_json="$(curl -sf -H "Authorization: Bearer ${TOKEN}" "${BASE}/cli")"
echo "cli count: $(echo "$cli_json" | json_len)"
if echo "$cli_json" | grep -q '"id": *"brew:git"'; then
  echo "brew:git present: yes"
else
  echo "brew:git present: no (only expected if git is installed via brew)"
fi

echo "== /launch-agents =="
la_json="$(curl -sf -H "Authorization: Bearer ${TOKEN}" "${BASE}/launch-agents")"
echo "launch-agents count: $(echo "$la_json" | json_len)"
sample_plist="$(ls "$HOME/Library/LaunchAgents"/*.plist 2>/dev/null | head -n1 || true)"
if [ -n "$sample_plist" ]; then
  sample_label="$(plutil -extract Label raw -o - "$sample_plist" 2>/dev/null || true)"
  if [ -n "$sample_label" ] && echo "$la_json" | grep -q "\"id\": *\"${sample_label}\""; then
    echo "sample launch agent Label '${sample_label}' found in /launch-agents: yes"
  else
    echo "sample launch agent Label '${sample_label}' found in /launch-agents: no"
  fi
else
  echo "no local LaunchAgents plist found to sample against"
fi

echo "== negative: refused from a non-Tailscale interface =="
if curl -sf -m 3 -H "Authorization: Bearer ${TOKEN}" "http://127.0.0.1:${PORT}/apps" >/dev/null 2>&1; then
  echo "WARNING: service answered on 127.0.0.1 -- it should only be reachable on the Tailscale address"
else
  echo "confirmed: not reachable on 127.0.0.1 (service binds the Tailscale address only)"
fi

echo "smoke test complete"
