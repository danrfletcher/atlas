"""G15 id rules, plus the shared skip/dedup rule for missing or duplicate ids."""

from typing import Dict, List, Mapping, Optional, Sequence


def derive_app_id(info_plist: Mapping[str, object]) -> Optional[str]:
    """apps = bundle id, from Info.plist CFBundleIdentifier."""
    value = info_plist.get("CFBundleIdentifier")
    return value if isinstance(value, str) and value else None


def derive_cli_id(manager: str, name: str) -> Optional[str]:
    """cli = "manager:name" (e.g. brew:git, mas:<name>)."""
    if not manager or not name:
        return None
    return f"{manager}:{name}"


def derive_launch_agent_id(plist: Mapping[str, object]) -> Optional[str]:
    """launch agents = plist Label."""
    value = plist.get("Label")
    return value if isinstance(value, str) and value else None


def dedup_items(items: Sequence[Dict]) -> List[Dict]:
    """Drop items with a missing id; on a duplicate id, the first occurrence wins."""
    seen = set()
    result: List[Dict] = []
    for item in items:
        item_id = item.get("id")
        if not item_id or item_id in seen:
            continue
        seen.add(item_id)
        result.append(item)
    return result
