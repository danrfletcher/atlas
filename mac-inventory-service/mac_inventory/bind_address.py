"""Pick the Tailscale address to bind to. Never 0.0.0.0, never a public interface.

`select_tailscale_address` is the pure, unit-tested rule (Tailscale isn't available in
CI, so the discovery side that shells out to `ifconfig` is exercised only on the real
Mac via tests/smoke_mac.sh).
"""

import ipaddress
import re
from typing import Iterable, List, Optional

from .procrun import run_command as default_run_command

TAILSCALE_NETWORK = ipaddress.ip_network("100.64.0.0/10")

_INET_LINE_RE = re.compile(r"inet\s+(\d{1,3}(?:\.\d{1,3}){3})\b")


def select_tailscale_address(addresses: Iterable[str]) -> Optional[str]:
    for address in addresses:
        try:
            ip = ipaddress.ip_address(address)
        except ValueError:
            continue
        if isinstance(ip, ipaddress.IPv4Address) and ip in TAILSCALE_NETWORK:
            return address
    return None


def discover_local_ipv4_addresses(run=default_run_command) -> List[str]:
    try:
        result = run(["ifconfig"])
    except Exception:
        return []
    if result.returncode != 0:
        return []
    return _INET_LINE_RE.findall(result.stdout)


def get_bind_address(run=default_run_command) -> str:
    address = select_tailscale_address(discover_local_ipv4_addresses(run))
    if not address:
        raise RuntimeError(
            "no Tailscale address found on this interface; refusing to bind a public or wildcard address"
        )
    return address
