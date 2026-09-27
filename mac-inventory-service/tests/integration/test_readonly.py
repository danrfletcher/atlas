"""Fence regressions F1 and F6.

F6: only allow-listed read commands are ever spawned, no mutating subcommand is ever
executed, and the process runner is the single choke point every scanner goes through.
F1: the service exposes no POST/PUT/DELETE handling and no endpoint that lets request
input reach a shelled-out command -- because requests only ever read the Cache, they
never trigger a scan at all.
"""

import threading
import unittest
from http.client import HTTPConnection

from mac_inventory.cache import Cache
from mac_inventory.procrun import ALLOWED_COMMANDS, DisallowedCommandError, validate_command
from mac_inventory.server import create_server


class ProcessRunnerAllowListTests(unittest.TestCase):
    def test_rejects_non_allow_listed_binaries(self):
        for argv in (["rm", "-rf", "/"], ["launchctl", "load", "/tmp/x.plist"], ["curl", "http://evil"]):
            with self.subTest(argv=argv):
                with self.assertRaises(DisallowedCommandError):
                    validate_command(argv)

    def test_rejects_mutating_brew_subcommands(self):
        for argv in (
            ["brew", "install", "git"],
            ["brew", "upgrade"],
            ["brew", "uninstall", "git"],
            ["brew", "services", "start", "x"],
        ):
            with self.subTest(argv=argv):
                with self.assertRaises(DisallowedCommandError):
                    validate_command(argv)

    def test_rejects_mas_install(self):
        with self.assertRaises(DisallowedCommandError):
            validate_command(["mas", "install", "12345"])

    def test_rejects_empty_command(self):
        with self.assertRaises(DisallowedCommandError):
            validate_command([])

    def test_accepts_the_commands_the_scanners_actually_use(self):
        allowed = [
            ["brew", "list", "--formula", "--versions"],
            ["brew", "list", "--cask", "--versions"],
            ["brew", "--cellar"],
            ["brew", "--caskroom"],
            ["mas", "list"],
            ["plutil", "-convert", "json", "-o", "-", "/Applications/Docker.app/Contents/Info.plist"],
            ["ifconfig"],
        ]
        for argv in allowed:
            with self.subTest(argv=argv):
                validate_command(argv)  # must not raise

    def test_allow_list_has_no_write_capable_tool(self):
        self.assertEqual(ALLOWED_COMMANDS, {"brew", "mas", "plutil", "ifconfig"})


SAMPLE_ITEMS = [{"id": "a", "label": "A", "version": "1", "path": "/Applications/A.app"}]


class RequestsNeverReachACommandTests(unittest.TestCase):
    """The HTTP layer only ever reads the Cache; a request can never trigger a scan."""

    def setUp(self):
        self.token = "fence-test-token"
        self.scan_calls = {"apps": 0}

        def spy_scan():
            self.scan_calls["apps"] += 1
            return SAMPLE_ITEMS

        self.cache = Cache({"apps": spy_scan}, interval=100)
        self.cache.refresh_now()  # seed once, outside of any request
        self.server = create_server("127.0.0.1", 0, self.token, self.cache)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.server.shutdown)
        self.addCleanup(self.server.server_close)
        self.addCleanup(lambda: self.thread.join(timeout=2))

    def _request(self, method, path, token="fence-test-token", body=None):
        conn = HTTPConnection("127.0.0.1", self.port, timeout=5)
        headers = {}
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"
        conn.request(method, path, body=body, headers=headers)
        response = conn.getresponse()
        payload = response.read()
        conn.close()
        return response.status, payload

    def test_get_requests_never_trigger_a_scan(self):
        baseline = self.scan_calls["apps"]
        self._request("GET", "/apps")
        self._request("GET", "/apps?evil=%24%28rm%20-rf%20%2F%29")
        self._request("GET", "/apps/../../etc/passwd")
        self.assertEqual(self.scan_calls["apps"], baseline)

    def test_write_methods_are_405_and_trigger_no_scan(self):
        baseline = self.scan_calls["apps"]
        for method in ("POST", "PUT", "DELETE", "PATCH"):
            status, _ = self._request(method, "/apps", body=b'{"inject": "; rm -rf /"}')
            self.assertEqual(status, 405)
        self.assertEqual(self.scan_calls["apps"], baseline)

    def test_query_string_never_changes_the_response_or_triggers_a_scan(self):
        baseline = self.scan_calls["apps"]
        status, payload = self._request("GET", "/apps?cmd=touch%20/tmp/pwned")
        self.assertEqual(status, 200)
        self.assertEqual(self.scan_calls["apps"], baseline)


class NoUnexpectedFilesystemWritesTests(unittest.TestCase):
    def test_a_full_refresh_and_request_cycle_writes_no_files(self):
        write_attempts = []
        real_open = open

        def guarded_open(path, mode="r", *args, **kwargs):
            if any(flag in mode for flag in ("w", "a", "x")):
                write_attempts.append((path, mode))
            return real_open(path, mode, *args, **kwargs)

        cache = Cache({"apps": lambda: SAMPLE_ITEMS}, interval=100)
        cache.refresh_now()
        server = create_server("127.0.0.1", 0, "token", cache)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            import builtins

            original = builtins.open
            builtins.open = guarded_open
            try:
                conn = HTTPConnection("127.0.0.1", port, timeout=5)
                conn.request("GET", "/apps", headers={"Authorization": "Bearer token"})
                conn.getresponse().read()
                conn.close()
                cache.refresh_now()
            finally:
                builtins.open = original
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

        self.assertEqual(write_attempts, [])


if __name__ == "__main__":
    unittest.main()
