"""Defaults for the mac-inventory service (see .vector/briefs/ticket-plan.md, "Defaults taken")."""

from pathlib import Path

PORT = 8787
TOKEN_PATH = Path.home() / ".config" / "mac-inventory" / "token"

REFRESH_INTERVAL_SECONDS = 300
REQUEST_TIMEOUT_SECONDS = 15
COMMAND_TIMEOUT_SECONDS = 10

APP_DIRECTORIES = [
    Path("/Applications"),
    Path.home() / "Applications",
    Path("/System/Applications"),
]

LAUNCH_AGENT_DIRECTORIES = [
    Path.home() / "Library" / "LaunchAgents",
    Path("/Library/LaunchAgents"),
    Path("/Library/LaunchDaemons"),
]
