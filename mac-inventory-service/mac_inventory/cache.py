"""Per-endpoint cache. Requests are always answered from here, never from a live scan.

Each refresh swaps in a whole new Snapshot under a lock, so a reader always gets a
fully-old or fully-new snapshot, never a partial one. A failed scan keeps the last
good items and marks the snapshot stale; it never empties the list.
"""

import threading
import time
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional


@dataclass(frozen=True)
class Snapshot:
    items: List[dict]
    fetched_at: Optional[float]
    ok: bool
    error: Optional[str]
    stale: bool


def _cold_start_snapshot() -> Snapshot:
    return Snapshot(items=[], fetched_at=None, ok=False, error=None, stale=True)


class EndpointCache:
    def __init__(self):
        self._lock = threading.Lock()
        self._snapshot = _cold_start_snapshot()

    def get(self) -> Snapshot:
        with self._lock:
            return self._snapshot

    def refresh(self, scan_fn: Callable[[], List[dict]]) -> Snapshot:
        try:
            items = scan_fn()
        except Exception as exc:
            with self._lock:
                previous = self._snapshot
                self._snapshot = Snapshot(
                    items=previous.items,
                    fetched_at=previous.fetched_at,
                    ok=False,
                    error=str(exc),
                    stale=True,
                )
                return self._snapshot
        with self._lock:
            self._snapshot = Snapshot(items=items, fetched_at=time.time(), ok=True, error=None, stale=False)
            return self._snapshot


class Cache:
    """Owns one EndpointCache per named endpoint and an optional background refresher."""

    def __init__(self, scanners: Dict[str, Callable[[], List[dict]]], interval: float):
        self._scanners = scanners
        self._interval = interval
        self._endpoints = {name: EndpointCache() for name in scanners}
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def get(self, name: str) -> Snapshot:
        return self._endpoints[name].get()

    def refresh_now(self, name: Optional[str] = None) -> None:
        names = [name] if name else list(self._scanners)
        for endpoint_name in names:
            self._endpoints[endpoint_name].refresh(self._scanners[endpoint_name])

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)

    def _run(self) -> None:
        while not self._stop.is_set():
            self.refresh_now()
            self._stop.wait(self._interval)
