# mac-inventory-service

A small, read-only Python 3 stdlib HTTP server that lists what's installed on the
Mac -- apps, CLI packages, launch agents -- for the Atlas API-backed folders (PR 2+)
to consume. It never modifies the Mac and never triggers a backup (F6).

It is a standalone service, independent of the Atlas Obsidian plugin in the rest of
this repo; this PR touches no plugin code.

## Endpoints

All three require `Authorization: Bearer <token>` and only respond to `GET`.

- `GET /apps` -- installed `.app` bundles from `/Applications`, `~/Applications`,
  `/System/Applications`. id = bundle id (`CFBundleIdentifier`).
- `GET /cli` -- Homebrew formulae, Homebrew casks, and Mac App Store apps (`mas`).
  id = `manager:name` (e.g. `brew:git`, `mas:Xcode`). A manager that isn't installed
  contributes nothing.
- `GET /launch-agents` -- merged listing of `~/Library/LaunchAgents`,
  `/Library/LaunchAgents`, `/Library/LaunchDaemons`. id = plist `Label`.

Each returns `{"items": [{"id": ..., "label": ..., "version": ..., "path": ...}]}`.
Errors return `{"error": "..."}` with status 401 (bad/missing token, never 403), 404
(unknown path), 405 (non-GET), or 503 (cache still warming up on cold start).

## Running it

1. Create the token file (any random string) with owner-only permissions:
   ```sh
   mkdir -p ~/.config/mac-inventory
   openssl rand -hex 32 > ~/.config/mac-inventory/token
   chmod 600 ~/.config/mac-inventory/token
   ```
   The service refuses to start if this file is missing or empty, and never logs
   the token.
2. Run it directly for a quick check: `python3 -m mac_inventory` (from this
   directory). It binds the Mac's Tailscale address (100.64.0.0/10) on port 8787 and
   refuses to start if no Tailscale address is found -- it never binds `0.0.0.0` or a
   public interface.
3. For always-on use, install it as a launch agent: copy
   `launchd/com.danfletcher.mac-inventory.plist` to `~/Library/LaunchAgents/`, fill in
   the real absolute path for `WorkingDirectory`, then
   `launchctl load ~/Library/LaunchAgents/com.danfletcher.mac-inventory.plist`.

## Design notes

- Every shell-out (to `brew`, `mas`, `plutil`, `ifconfig`) goes through
  `mac_inventory/procrun.py`, which enforces an allow list of binaries and a denylist
  of mutating subcommands (install/upgrade/load/unload/etc.) -- see F6/F1 in the spec.
- A background thread refreshes each endpoint's cache on a fixed interval
  (`REFRESH_INTERVAL_SECONDS` in `config.py`). Requests are always answered from the
  cache, never from a live scan, so a slow or hung scan can never make a request wait.
  A failed scan keeps the last good data and is recorded as an error; it never empties
  the list.
- Before the first successful scan, endpoints answer `503 {"error": "warming up"}`
  rather than blocking.

## Judgement calls (spec was silent or offered a choice)

- Cold start responds `503 "warming up"` rather than `{"items": []}`, so a real empty
  result is never confused with "not scanned yet".
- Response body is exactly `{"items": [...]}` with no extra top-level fields (e.g. no
  staleness flag) -- Atlas's connection dot (G11) is driven by whether its own fetch
  succeeds, not by a field from this service.
- Auth is checked before path/method, so an unauthenticated request to an unknown path
  still gets 401, not 404 (never reveals which routes exist).
- POST/PUT/DELETE/PATCH are handled uniformly to return 405; there's no business logic
  behind them.
- Refresh interval defaults to 300s (5 min); not specified in the spec.
- `path` is left as `""` for `mas` CLI items and for launch agents' `version`, where
  there's no natural filesystem path/version to report.
- Bind-address discovery shells out to `ifconfig` (added to the allow list alongside
  brew/mas/plutil) to find the Tailscale interface; the address-selection rule itself
  (CGNAT range 100.64.0.0/10) is a pure, unit-tested function.

## Tests

```sh
cd mac-inventory-service
python3 -m unittest discover -s tests -p 'test_*.py' -v
```

`tests/smoke_mac.sh` is a manual script for the real Mac (not run in CI): it curls
each endpoint over the real Tailscale address and sanity-checks counts and ids.
