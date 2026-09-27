"""The one place every shell-out in this service passes through (F6/F1 fence).

Every call is an argv list (never a shell string), the target binary must be on the
allow list, and no dangerous subcommand may appear anywhere in the arguments -- this
is a defence-in-depth check, since none of these binaries are ever needed for the
read-only listings this service performs.
"""

import subprocess
from typing import List

from . import config

ALLOWED_COMMANDS = {"brew", "mas", "plutil", "ifconfig"}

FORBIDDEN_TOKENS = {
    "install",
    "uninstall",
    "upgrade",
    "reinstall",
    "remove",
    "purchase",
    "load",
    "unload",
    "start",
    "stop",
    "kickstart",
    "bootout",
    "bootstrap",
    "link",
    "unlink",
    "cleanup",
    "tap",
    "untap",
    "pin",
    "unpin",
    "services",
}


class DisallowedCommandError(RuntimeError):
    """Raised when code tries to shell out to something outside the read-only allow list."""


def validate_command(argv: List[str]) -> None:
    if not argv:
        raise DisallowedCommandError("empty command")
    if argv[0] not in ALLOWED_COMMANDS:
        raise DisallowedCommandError(f"command not allow-listed: {argv[0]!r}")
    if any(token in FORBIDDEN_TOKENS for token in argv[1:]):
        raise DisallowedCommandError(f"forbidden token in command: {argv!r}")


def run_command(argv: List[str], timeout: float = config.COMMAND_TIMEOUT_SECONDS) -> subprocess.CompletedProcess:
    validate_command(argv)
    return subprocess.run(
        list(argv),
        capture_output=True,
        text=True,
        timeout=timeout,
        shell=False,
    )
