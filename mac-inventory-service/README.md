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
  id = `manager:name` (e.g. `brew:git`, `mas:Xcode`), except Homebrew casks which use
  `brew-cask:name` (e.g. `brew-cask:docker`) so a formula and a cask with the same
  name don't collide. A manager that isn't installed contributes nothing.
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
   `launchctl load ~/Library/LaunchAgents/com.danfletcher.mac-inventory.plist`. The
   plist sets `PATH` to include `/opt/homebrew/bin` and `/usr/local/bin` ahead of the
   system default, since launchd's own default `PATH` doesn't include either and
   `shutil.which` would otherwise never find `brew`/`mas` when run as a launch agent.

## Design notes

- Every shell-out (to `brew`, `mas`, `plutil`, `ifconfig`) goes through
  `mac_inventory/procrun.py`, which enforces an allow list of binaries and a denylist
  of mutating subcommands (install/upgrade/load/unload/etc.) -- see F6/F1 in the spec.
- Each endpoint refreshes on its own background thread, on a fixed interval
  (`REFRESH_INTERVAL_SECONDS` in `config.py`). Requests are always answered from the
  cache, never from a live scan, so a slow or hung scan can never make a request wait.
  Per-endpoint threads also mean a hung `/cli` scan (brew or mas stuck) can't delay
  `/apps` or `/launch-agents` refreshing on schedule.
- A failed scan (non-zero exit, timeout, or any other exception from an *installed*
  manager) keeps the last good data and is recorded as an error; it never empties the
  list. Only a missing binary (`shutil.which` returns `None`) is treated as "not
  installed, contributes nothing" -- everything else from an installed manager is a
  real failure that must not be confused with an empty result.
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
- Every non-`GET` method returns 405, not just POST/PUT/DELETE/PATCH -- `HEAD`,
  `OPTIONS` and any other verb are handled the same way (via a generic fallback in the
  handler), so none of them fall through to `http.server`'s default 501. There's no
  business logic behind any of them.
- `brew`'s own machine-readable listing (`brew info --json=v2 --installed`) is used
  instead of hand-parsing `brew list --versions` text, per the spec's "use each tool's
  machine-readable listing where one exists". One call covers both formulae and
  casks. Casks get a distinct `brew-cask:` id prefix (formulae keep `brew:`), since a
  formula and a cask can share a name (e.g. the `docker` formula and the `docker.app`
  cask) and both need to survive rather than one silently dropping the other.
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
