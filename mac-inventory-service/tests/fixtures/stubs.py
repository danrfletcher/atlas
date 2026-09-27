"""Builds stub brew/mas/plutil executables on a temp PATH for the scanner tests.

plutil's stub looks up a canned JSON fixture by the plist's logical name (the app
bundle name for an Info.plist, or the plist's own filename otherwise) under
tests/fixtures/plists/. A path with no matching fixture makes the stub fail non-zero,
simulating a malformed/non-plist file.
"""

import stat
from pathlib import Path

FIXTURES_DIR = Path(__file__).resolve().parent / "plists"

_PLUTIL_STUB = """#!/bin/sh
path="$5"
base=$(basename "$path")
if [ "$base" = "Info.plist" ]; then
  appdir=$(dirname "$(dirname "$path")")
  key=$(basename "$appdir" .app)
else
  key=$(basename "$path" .plist)
fi
fixture="$MAC_INVENTORY_TEST_FIXTURES/${key}.json"
if [ -f "$fixture" ]; then
  cat "$fixture"
  exit 0
fi
echo "no fixture for $path" 1>&2
exit 1
"""

_BREW_STUB = """#!/bin/sh
args="$*"
case "$args" in
  "list --formula --versions")
    printf 'git 2.43.0\\njq 1.7.1\\n'
    ;;
  "list --cask --versions")
    printf 'docker 4.34.0\\n'
    ;;
  "--cellar")
    printf '/opt/homebrew/Cellar\\n'
    ;;
  "--caskroom")
    printf '/opt/homebrew/Caskroom\\n'
    ;;
  *)
    exit 1
    ;;
esac
"""

_MAS_STUB = """#!/bin/sh
if [ "$1" = "list" ]; then
  printf '409183694 Keynote (12.2)\\n497799835 Xcode (15.0)\\n'
else
  exit 1
fi
"""


def _write_executable(path: Path, content: str) -> None:
    path.write_text(content)
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def install_stub_tools(bin_dir: Path) -> None:
    bin_dir.mkdir(parents=True, exist_ok=True)
    _write_executable(bin_dir / "plutil", _PLUTIL_STUB)
    _write_executable(bin_dir / "brew", _BREW_STUB)
    _write_executable(bin_dir / "mas", _MAS_STUB)
