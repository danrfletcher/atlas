import logging

from . import config
from .bind_address import get_bind_address
from .cache import Cache
from .scanners import scan_apps, scan_cli, scan_launch_agents
from .server import create_server


def _load_token() -> str:
    try:
        token = config.TOKEN_PATH.read_text(encoding="utf-8").strip()
    except OSError:
        token = ""
    if not token:
        raise SystemExit(f"refusing to start: token file missing or empty ({config.TOKEN_PATH})")
    return token


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    token = _load_token()
    host = get_bind_address()
    cache = Cache(
        {
            "apps": scan_apps,
            "cli": scan_cli,
            "launch-agents": scan_launch_agents,
        },
        interval=config.REFRESH_INTERVAL_SECONDS,
    )
    cache.start()
    server = create_server(host, config.PORT, token, cache)
    logging.info("mac-inventory listening on %s:%s", host, config.PORT)
    try:
        server.serve_forever()
    finally:
        cache.stop()


if __name__ == "__main__":
    main()
