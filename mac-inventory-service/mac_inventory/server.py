"""G14 HTTP surface: GET /apps, /cli, /launch-agents behind a bearer token.

Every request is answered from the Cache; a request never triggers a scan, so no
request can ever wait on a slow brew/mas/plutil call (E3), and no request input can
ever reach a shelled-out command (F1). Auth is checked before path/method, so an
unauthenticated caller can't learn whether a route or a resource exists.
"""

import hmac
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .cache import Cache

ROUTE_TO_CACHE_KEY = {
    "/apps": "apps",
    "/cli": "cli",
    "/launch-agents": "launch-agents",
}


def _tokens_match(supplied: str, expected: str) -> bool:
    return hmac.compare_digest(supplied.encode("utf-8"), expected.encode("utf-8"))


def make_handler(cache: Cache, token: str):
    class Handler(BaseHTTPRequestHandler):
        server_version = "MacInventory/1.0"

        def log_message(self, format, *args):  # noqa: A002 - stdlib signature
            pass  # never echo request lines (they can carry the Authorization header)

        def _send_json(self, status: int, payload: dict) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _check_auth(self) -> bool:
            header = self.headers.get("Authorization", "")
            if not header.startswith("Bearer "):
                return False
            supplied = header[len("Bearer "):].strip()
            if not supplied:
                return False
            return _tokens_match(supplied, token)

        def _dispatch(self, method: str) -> None:
            if not self._check_auth():
                self._send_json(401, {"error": "unauthorized"})
                return
            if method != "GET":
                self._send_json(405, {"error": "method not allowed"})
                return

            path = self.path.split("?", 1)[0]
            cache_key = ROUTE_TO_CACHE_KEY.get(path)
            if cache_key is None:
                self._send_json(404, {"error": "not found"})
                return

            snapshot = cache.get(cache_key)
            if snapshot.fetched_at is None:
                self._send_json(503, {"error": "warming up"})
                return
            self._send_json(200, {"items": snapshot.items})

        def do_GET(self):
            self._dispatch("GET")

        def do_POST(self):
            self._dispatch("POST")

        def do_PUT(self):
            self._dispatch("PUT")

        def do_DELETE(self):
            self._dispatch("DELETE")

        def do_PATCH(self):
            self._dispatch("PATCH")

    return Handler


def create_server(host: str, port: int, token: str, cache: Cache) -> ThreadingHTTPServer:
    handler = make_handler(cache, token)
    return ThreadingHTTPServer((host, port), handler)
