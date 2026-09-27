import json
import threading
import time
import unittest
from http.client import HTTPConnection

from mac_inventory.cache import Cache
from mac_inventory.server import create_server

SAMPLE_ITEMS = [
    {"id": "brew:git", "label": "git", "version": "2.43.0", "path": "/opt/homebrew/Cellar/git/2.43.0"},
]


class HttpServerTestCase(unittest.TestCase):
    TOKEN = "integration-test-token"

    def _start_server(self, cache):
        server = create_server("127.0.0.1", 0, self.TOKEN, cache)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.shutdown)
        self.addCleanup(server.server_close)
        self.addCleanup(lambda: thread.join(timeout=2))
        return port

    def _request(self, port, path, token="__use_default__", method="GET"):
        conn = HTTPConnection("127.0.0.1", port, timeout=5)
        headers = {}
        used_token = self.TOKEN if token == "__use_default__" else token
        if used_token is not None:
            headers["Authorization"] = f"Bearer {used_token}"
        conn.request(method, path, headers=headers)
        response = conn.getresponse()
        payload = response.read()
        conn.close()
        return response.status, payload


class RouteShapeTests(HttpServerTestCase):
    def setUp(self):
        cache = Cache(
            {
                "apps": lambda: SAMPLE_ITEMS,
                "cli": lambda: SAMPLE_ITEMS,
                "launch-agents": lambda: SAMPLE_ITEMS,
            },
            interval=100,
        )
        cache.refresh_now()
        self.port = self._start_server(cache)

    def test_all_three_routes_return_the_exact_item_shape(self):
        for path in ("/apps", "/cli", "/launch-agents"):
            status, payload = self._request(self.port, path)
            self.assertEqual(status, 200)
            body = json.loads(payload)
            self.assertEqual(set(body.keys()), {"items"})
            for item in body["items"]:
                self.assertEqual(set(item.keys()), {"id", "label", "version", "path"})

    def test_unknown_path_is_404(self):
        status, _ = self._request(self.port, "/nope")
        self.assertEqual(status, 404)


class AuthMatrixTests(HttpServerTestCase):
    def setUp(self):
        cache = Cache({"apps": lambda: SAMPLE_ITEMS}, interval=100)
        cache.refresh_now()
        self.port = self._start_server(cache)

    def test_missing_token_is_401_with_no_item_data(self):
        status, payload = self._request(self.port, "/apps", token=None)
        self.assertEqual(status, 401)
        self.assertNotIn(b"brew:git", payload)
        body = json.loads(payload)
        self.assertIn("error", body)

    def test_malformed_header_is_401(self):
        conn = HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("GET", "/apps", headers={"Authorization": "Basic abc123"})
        response = conn.getresponse()
        self.assertEqual(response.status, 401)
        response.read()
        conn.close()

    def test_empty_bearer_token_is_401(self):
        conn = HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("GET", "/apps", headers={"Authorization": "Bearer "})
        response = conn.getresponse()
        self.assertEqual(response.status, 401)
        response.read()
        conn.close()

    def test_wrong_token_is_401_never_403(self):
        status, payload = self._request(self.port, "/apps", token="wrong-token")
        self.assertEqual(status, 401)
        self.assertNotIn(b"brew:git", payload)

    def test_correct_token_is_200(self):
        status, payload = self._request(self.port, "/apps")
        self.assertEqual(status, 200)
        body = json.loads(payload)
        self.assertEqual(body["items"], SAMPLE_ITEMS)

    def test_auth_checked_even_for_unknown_paths(self):
        status, _ = self._request(self.port, "/nope", token=None)
        self.assertEqual(status, 401)


class MethodMatrixTests(HttpServerTestCase):
    def setUp(self):
        cache = Cache({"apps": lambda: SAMPLE_ITEMS}, interval=100)
        cache.refresh_now()
        self.port = self._start_server(cache)

    def test_non_get_methods_are_405_and_change_nothing(self):
        for method in ("POST", "PUT", "DELETE", "PATCH"):
            with self.subTest(method=method):
                status, _ = self._request(self.port, "/apps", method=method)
                self.assertEqual(status, 405)
        status, payload = self._request(self.port, "/apps")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(payload)["items"], SAMPLE_ITEMS)


class ColdStartTests(HttpServerTestCase):
    def test_cold_start_returns_quickly_without_data(self):
        cache = Cache({"apps": lambda: SAMPLE_ITEMS}, interval=100)  # never refreshed
        port = self._start_server(cache)

        start = time.time()
        status, payload = self._request(port, "/apps")
        elapsed = time.time() - start

        self.assertLess(elapsed, 1.0)
        self.assertIn(status, (200, 503))
        body = json.loads(payload)
        if status == 503:
            self.assertIn("warming", body.get("error", "").lower())
        else:
            self.assertEqual(body["items"], [])


class SlowScanLatencyGuardTests(HttpServerTestCase):
    def test_requests_return_fast_during_a_slow_background_refresh(self):
        release = threading.Event()

        def slow_scan():
            release.wait(10)  # stands in for the spec's 30s brew hang, scaled for test speed
            return SAMPLE_ITEMS

        cache = Cache({"apps": lambda: SAMPLE_ITEMS}, interval=100)
        cache.refresh_now()  # seed good data first
        port = self._start_server(cache)
        cache._scanners["apps"] = slow_scan

        refresh_thread = threading.Thread(target=cache.refresh_now, args=("apps",))
        refresh_thread.start()
        try:
            time.sleep(0.05)
            start = time.time()
            status, payload = self._request(port, "/apps")
            elapsed = time.time() - start

            self.assertEqual(status, 200)
            self.assertLess(elapsed, 1.0)
            self.assertEqual(json.loads(payload)["items"], SAMPLE_ITEMS)
        finally:
            release.set()
            refresh_thread.join(timeout=10)


if __name__ == "__main__":
    unittest.main()
