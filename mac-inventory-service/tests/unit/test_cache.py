import threading
import time
import unittest

from mac_inventory.cache import Cache, EndpointCache


class EndpointCacheTests(unittest.TestCase):
    def test_cold_start_before_first_refresh(self):
        cache = EndpointCache()
        snapshot = cache.get()
        self.assertEqual(snapshot.items, [])
        self.assertIsNone(snapshot.fetched_at)
        self.assertFalse(snapshot.ok)

    def test_successful_refresh_updates_snapshot(self):
        cache = EndpointCache()
        cache.refresh(lambda: [{"id": "a"}])
        snapshot = cache.get()
        self.assertTrue(snapshot.ok)
        self.assertEqual(snapshot.items, [{"id": "a"}])
        self.assertIsNotNone(snapshot.fetched_at)
        self.assertFalse(snapshot.stale)
        self.assertIsNone(snapshot.error)

    def test_failed_refresh_keeps_last_good_and_marks_stale(self):
        cache = EndpointCache()
        cache.refresh(lambda: [{"id": "a"}])
        first_fetched_at = cache.get().fetched_at

        def boom():
            raise RuntimeError("scan exploded")

        cache.refresh(boom)
        snapshot = cache.get()
        self.assertEqual(snapshot.items, [{"id": "a"}])  # never emptied
        self.assertTrue(snapshot.stale)
        self.assertFalse(snapshot.ok)
        self.assertIn("scan exploded", snapshot.error)
        self.assertEqual(snapshot.fetched_at, first_fetched_at)

    def test_failed_refresh_before_any_success_keeps_cold_start_shape(self):
        cache = EndpointCache()

        def boom():
            raise RuntimeError("no data yet")

        cache.refresh(boom)
        snapshot = cache.get()
        self.assertEqual(snapshot.items, [])
        self.assertIsNone(snapshot.fetched_at)
        self.assertTrue(snapshot.stale)

    def test_concurrent_refresh_and_read_never_sees_a_partial_snapshot(self):
        cache = EndpointCache()
        cache.refresh(lambda: [{"id": "old-1"}, {"id": "old-2"}])
        release = threading.Event()

        def slow_scan():
            release.wait(5)
            return [{"id": "new-1"}, {"id": "new-2"}, {"id": "new-3"}]

        seen_lengths = set()
        stop = threading.Event()

        def reader():
            while not stop.is_set():
                seen_lengths.add(len(cache.get().items))

        reader_thread = threading.Thread(target=reader)
        reader_thread.start()
        refresher_thread = threading.Thread(target=cache.refresh, args=(slow_scan,))
        refresher_thread.start()
        time.sleep(0.1)
        release.set()
        refresher_thread.join(timeout=5)
        stop.set()
        reader_thread.join(timeout=5)

        self.assertTrue(seen_lengths.issubset({2, 3}))
        self.assertEqual(
            [item["id"] for item in cache.get().items],
            ["new-1", "new-2", "new-3"],
        )


class CacheSchedulingTests(unittest.TestCase):
    def test_refresh_now_updates_only_the_named_endpoint(self):
        calls = {"apps": 0, "cli": 0}

        def make_scanner(name):
            def scan():
                calls[name] += 1
                return []

            return scan

        cache = Cache({"apps": make_scanner("apps"), "cli": make_scanner("cli")}, interval=100)
        cache.refresh_now("apps")
        self.assertEqual(calls, {"apps": 1, "cli": 0})

    def test_refresh_now_without_a_name_updates_every_endpoint(self):
        calls = {"apps": 0, "cli": 0}

        def make_scanner(name):
            def scan():
                calls[name] += 1
                return []

            return scan

        cache = Cache({"apps": make_scanner("apps"), "cli": make_scanner("cli")}, interval=100)
        cache.refresh_now()
        self.assertEqual(calls, {"apps": 1, "cli": 1})

    def test_background_refresher_runs_on_a_fixed_interval(self):
        calls = []
        cache = Cache({"apps": lambda: calls.append(1) or []}, interval=0.05)
        cache.start()
        time.sleep(0.2)
        cache.stop()
        self.assertGreaterEqual(len(calls), 2)

    def test_a_hung_endpoint_does_not_block_another_endpoints_refresh(self):
        # R8: each endpoint refreshes on its own thread, so a scan stuck on a hung
        # brew/mas call can't delay another endpoint's background refresh.
        block = threading.Event()
        fast_calls = []

        def hung_scan():
            block.wait(5)
            return []

        def fast_scan():
            fast_calls.append(1)
            return []

        cache = Cache({"slow": hung_scan, "fast": fast_scan}, interval=0.05)
        cache.start()
        try:
            time.sleep(0.3)
            self.assertGreaterEqual(len(fast_calls), 2)
            self.assertTrue(cache.get("fast").ok)
            self.assertIsNone(cache.get("slow").fetched_at)  # still stuck on its first scan
        finally:
            block.set()
            cache.stop()


if __name__ == "__main__":
    unittest.main()
