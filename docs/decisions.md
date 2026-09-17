# Decisions

Judgement calls made during the build, the alternative considered, and why. Newest first.

## Repo location and dev/install path

**Decision:** develop directly in `.obsidian/plugins/atlas` inside the fixture vault, cloned from `danrfletcher/atlas`. No separate dev checkout + symlink.

**Alternative rejected:** clone at `.obsidian/atlas` and symlink into `.obsidian/plugins/atlas`. Conductor had already provisioned the nested workspace at `.obsidian/plugins/atlas` directly (it's the actual clone of `danrfletcher/atlas`, on `main`, with Conductor's own checkpoint refs alongside — not unrelated work). Since Obsidian only ever loads plugins from `.obsidian/plugins/<id>`, putting the source there directly is one less moving part than a symlink indirection, with no downside.

## PR granularity

**Decision:** incremental PRs per feature group against `danrfletcher/atlas`, rather than one PR at the end covering all of F1–F13:
1. F1 (Settings) + F2 (Unit index)
2. F3 (Folder-units) + F4 (Free blocks) + F5 (Promoted blocks in explorer)
3. F6 (Link suggester) + F7 (Block link display)
4. F8 (Explorer view) + F9 (Views storage/integrity) + F10 (Commands)
5. F11 (Performance) + F12 (Mobile) + F13 (Docs)

**Why:** confirmed with Dan directly — the hand-off doc's Part 6 reads as a single end-to-end PR, but given the size (13 features, full test matrix) he preferred to review in slices rather than all at once.

## Reference convention folder not present

**Decision:** scaffold from the standard `obsidian-sample-plugin` layout (esbuild + TypeScript + `manifest.json`/`versions.json`/`version-bump.mjs`) rather than copying `_system/Notes/obsidian-file-folder-status-icons-git-repo/`, which the hand-off doc names as the convention to follow.

**Why:** `pangyo` (this fixture vault) is a deliberately stripped-down test copy of Dan's real vault — dev-repo folders like `_system/Notes/obsidian-file-folder-status-icons-git-repo/` were never copied into it in the first place; they exist only in the real vault at `/Users/danfletcher/Documents/Notes`. Not a deletion, just outside this fixture's scope. The sample-plugin layout is what that convention folder would itself have been built from, so the result should be equivalent.

## Build tooling versions

**Decision:** pinned devDependencies to current npm registry latest as of 2026-09-17: `obsidian@1.13.1`, `esbuild@0.28.2`, `@typescript-eslint/*@8.70.0`, `builtin-modules@5.0.0`. `minAppVersion` set to `1.5.0` (a conservative recent stable, not the bleeding edge) in `manifest.json`.

**Why:** no existing convention to match in this vault (see above); picked current stable versions rather than the sample-plugin template's historical pins, which would be stale.

**Correction:** `typescript` pinned to `^5.9.3`, not the registry's latest `7.0.2` — `@typescript-eslint@8.70.0`'s peer range caps at `<6.1.0`, so `7.0.2` breaks `npm install` outright (`ERESOLVE`). 5.9.3 is the newest 5.x line and is what typescript-eslint actually supports today.

## Visual/container testing approach

**Decision:** use the real Docker-based desktop-container workflow described in `_system/Engineering/spin-up-desktop-container.md` / `use-desktop-container.md` for Part 5/6 visual QA, rather than skipping it.

**Why:** confirmed Docker Desktop is reachable directly from this session's shell (already other live `desktop-*` containers from unrelated work, plus a pre-pulled `obsidian-development-template` image), so the spec's actual visual test loop is achievable, not just a headless build/typecheck substitute.
