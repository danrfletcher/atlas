"""G14/G16 scanners. Every read goes through `run` (mac_inventory.procrun.run_command
by default), which is itself the allow-list gate -- see procrun.py.
"""

import json
import os
import re
import shutil
from pathlib import Path
from typing import Callable, Dict, Iterator, List, Optional

from . import config
from .ids import dedup_items, derive_app_id, derive_cli_id, derive_launch_agent_id
from .procrun import run_command as default_run_command

RunFn = Callable[..., object]


def _manager_available(name: str) -> bool:
    return shutil.which(name) is not None


def _read_plist_json(path: Path, run: RunFn) -> Optional[dict]:
    """plutil -convert json -o - <path>.

    A non-zero exit or unparsable stdout means this one file isn't a usable plist
    (missing, malformed, non-plist) and is skipped -- callers treat None as "skip this
    entry". A runner-level failure -- plutil missing or hung -- means plutil itself is
    unusable right now, not that this one file is bad, so that exception is left to
    propagate (R10): the whole scan aborts and the endpoint cache keeps its last good
    snapshot instead of quietly emptying every app/launch-agent.
    """
    result = run(["plutil", "-convert", "json", "-o", "-", str(path)])
    if result.returncode != 0:
        return None
    try:
        data = json.loads(result.stdout)
    except (ValueError, TypeError):
        return None
    return data if isinstance(data, dict) else None


def _iter_app_bundles(root: Path) -> Iterator[Path]:
    """Depth-first walk for `.app` bundles anywhere under `root` (R9): system and
    vendor apps often sit one or more levels deep (e.g. /Applications/Utilities,
    "/Applications/Adobe Photoshop 2026/Adobe Photoshop 2026.app"). Never descends
    into a `.app` bundle's own contents -- it's a leaf, not a folder to search.
    A missing or unreadable root simply yields nothing.
    """
    for dirpath, dirnames, _filenames in os.walk(root):
        dirnames.sort()
        current = Path(dirpath)
        bundle_names = [name for name in dirnames if name.endswith(".app")]
        dirnames[:] = [name for name in dirnames if not name.endswith(".app")]
        for name in bundle_names:
            yield current / name


def scan_apps(run: RunFn = default_run_command, directories: Optional[List[Path]] = None) -> List[Dict]:
    directories = directories if directories is not None else config.APP_DIRECTORIES
    items: List[Dict] = []
    for directory in directories:
        for entry in _iter_app_bundles(Path(directory)):
            info = _read_plist_json(entry / "Contents" / "Info.plist", run)
            if info is None:
                continue
            bundle_id = derive_app_id(info)
            if not bundle_id:
                continue
            label = info.get("CFBundleDisplayName") or info.get("CFBundleName") or entry.stem
            version = info.get("CFBundleShortVersionString") or info.get("CFBundleVersion") or ""
            items.append(
                {
                    "id": bundle_id,
                    "label": str(label),
                    "version": str(version),
                    "path": str(entry),
                }
            )
    return dedup_items(items)


_MAS_VERSION_RE = re.compile(r"^(.*)\s+\(([^)]+)\)\s*$")


def _brew_root(run: RunFn, root_flag: str) -> str:
    """Best-effort lookup of the Cellar/Caskroom root, purely for the `path` field.
    Not critical to the listing itself, so a failure here just leaves path empty.
    """
    try:
        result = run(["brew", root_flag])
    except Exception:
        return ""
    return result.stdout.strip() if result.returncode == 0 else ""


def _brew_info_installed(run: RunFn) -> Optional[dict]:
    """`brew info --json=v2 --installed` -- Homebrew's own machine-readable listing
    (R5), covering both formulae and casks in one call.

    A manager that isn't installed contributes nothing (returns None). Once brew is
    known to be installed, any failure (non-zero exit, timeout, OSError, bad JSON)
    raises so the caller's cache keeps its last good snapshot instead of being
    emptied (R1) -- only a missing binary is "not installed".
    """
    if not _manager_available("brew"):
        return None
    result = run(["brew", "info", "--json=v2", "--installed"])
    if result.returncode != 0:
        raise RuntimeError(
            f"brew info --json=v2 --installed exited {result.returncode}: {result.stderr.strip()}"
        )
    try:
        data = json.loads(result.stdout)
    except (ValueError, TypeError) as exc:
        raise RuntimeError("brew info --json=v2 --installed returned invalid JSON") from exc
    if not isinstance(data, dict):
        raise RuntimeError("brew info --json=v2 --installed returned an unexpected shape")
    return data


def _scan_brew_formulae(run: RunFn, data: dict) -> List[Dict]:
    root = _brew_root(run, "--cellar")
    items: List[Dict] = []
    for entry in data.get("formulae", []):
        name = entry.get("name")
        cli_id = derive_cli_id("brew", name) if name else None
        if not cli_id:
            continue
        installed = entry.get("installed") or []
        version = installed[-1].get("version", "") if installed else ""
        path = f"{root}/{name}/{version}" if root and version else ""
        items.append({"id": cli_id, "label": str(name), "version": str(version), "path": path})
    return items


def _scan_brew_casks(run: RunFn, data: dict) -> List[Dict]:
    """Casks get their own `brew-cask:` prefix (R6): a formula and a cask can share a
    name (e.g. the `docker` formula and the `docker` cask), and both must survive
    dedup rather than one silently overwriting the other under a shared `brew:` id.
    """
    root = _brew_root(run, "--caskroom")
    items: List[Dict] = []
    for entry in data.get("casks", []):
        token = entry.get("token")
        cli_id = derive_cli_id("brew-cask", token) if token else None
        if not cli_id:
            continue
        names = entry.get("name") or []
        label = names[0] if names else token
        version = entry.get("installed") or ""
        path = f"{root}/{token}/{version}" if root and version else ""
        items.append({"id": cli_id, "label": str(label), "version": str(version), "path": path})
    return items


def _scan_mas(run: RunFn) -> List[Dict]:
    """A manager that isn't installed contributes nothing; an installed manager's
    failure raises (see _brew_info_installed's docstring -- same rule applies here).
    """
    if not _manager_available("mas"):
        return []
    result = run(["mas", "list"])
    if result.returncode != 0:
        raise RuntimeError(f"mas list exited {result.returncode}: {result.stderr.strip()}")

    items: List[Dict] = []
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split(None, 1)
        if len(parts) < 2:
            continue
        _app_store_id, rest = parts
        match = _MAS_VERSION_RE.match(rest)
        name, version = (match.group(1).strip(), match.group(2).strip()) if match else (rest, "")
        cli_id = derive_cli_id("mas", name)
        if not cli_id:
            continue
        items.append({"id": cli_id, "label": name, "version": version, "path": ""})
    return items


def scan_cli(run: RunFn = default_run_command) -> List[Dict]:
    items: List[Dict] = []
    brew_data = _brew_info_installed(run)
    if brew_data is not None:
        items.extend(_scan_brew_formulae(run, brew_data))
        items.extend(_scan_brew_casks(run, brew_data))
    items.extend(_scan_mas(run))
    return dedup_items(items)


def scan_launch_agents(run: RunFn = default_run_command, directories: Optional[List[Path]] = None) -> List[Dict]:
    directories = directories if directories is not None else config.LAUNCH_AGENT_DIRECTORIES
    items: List[Dict] = []
    for directory in directories:
        try:
            entries = sorted(Path(directory).iterdir())
        except OSError:
            continue
        for entry in entries:
            if entry.suffix != ".plist":
                continue
            plist = _read_plist_json(entry, run)
            if plist is None:
                continue
            label = derive_launch_agent_id(plist)
            if not label:
                continue
            items.append({"id": label, "label": label, "version": "", "path": str(entry)})
    return dedup_items(items)
