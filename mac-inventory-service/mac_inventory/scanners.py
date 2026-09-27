"""G14/G16 scanners. Every read goes through `run` (mac_inventory.procrun.run_command
by default), which is itself the allow-list gate -- see procrun.py.
"""

import json
import re
import shutil
from pathlib import Path
from typing import Callable, Dict, List, Optional

from . import config
from .ids import dedup_items, derive_app_id, derive_cli_id, derive_launch_agent_id
from .procrun import run_command as default_run_command

RunFn = Callable[..., object]


def _manager_available(name: str) -> bool:
    return shutil.which(name) is not None


def _read_plist_json(path: Path, run: RunFn) -> Optional[dict]:
    """plutil -convert json -o - <path>; None on any failure (missing/malformed/non-plist)."""
    try:
        result = run(["plutil", "-convert", "json", "-o", "-", str(path)])
    except Exception:
        return None
    if result.returncode != 0:
        return None
    try:
        data = json.loads(result.stdout)
    except (ValueError, TypeError):
        return None
    return data if isinstance(data, dict) else None


def scan_apps(run: RunFn = default_run_command, directories: Optional[List[Path]] = None) -> List[Dict]:
    directories = directories if directories is not None else config.APP_DIRECTORIES
    items: List[Dict] = []
    for directory in directories:
        try:
            entries = sorted(Path(directory).iterdir())
        except OSError:
            continue
        for entry in entries:
            if entry.suffix != ".app":
                continue
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


def _scan_brew(run: RunFn, kind: str) -> List[Dict]:
    """kind is "formula" or "cask"; a manager that isn't installed contributes nothing."""
    if not _manager_available("brew"):
        return []
    try:
        listing = run(["brew", "list", f"--{kind}", "--versions"])
    except Exception:
        return []
    if listing.returncode != 0:
        return []

    root_flag = "--cellar" if kind == "formula" else "--caskroom"
    try:
        root_result = run(["brew", root_flag])
        root = root_result.stdout.strip() if root_result.returncode == 0 else ""
    except Exception:
        root = ""

    items: List[Dict] = []
    for line in listing.stdout.splitlines():
        parts = line.split()
        if not parts:
            continue
        name = parts[0]
        version = parts[-1] if len(parts) > 1 else ""
        cli_id = derive_cli_id("brew", name)
        if not cli_id:
            continue
        path = f"{root}/{name}/{version}" if root and version else ""
        items.append({"id": cli_id, "label": name, "version": version, "path": path})
    return items


def _scan_mas(run: RunFn) -> List[Dict]:
    if not _manager_available("mas"):
        return []
    try:
        result = run(["mas", "list"])
    except Exception:
        return []
    if result.returncode != 0:
        return []

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
    items.extend(_scan_brew(run, "formula"))
    items.extend(_scan_brew(run, "cask"))
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
