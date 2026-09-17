# Decisions

Judgement calls made during the build, the alternative considered, and why. Newest first.

## F3/F4/F5 shipped as commands, not explorer rows

**Decision:** F3 (folder-units), F4 (Add block), and F5 (promoted blocks) ship their underlying mechanics now — interface-note lookup/creation, free-block creation + display-text derivation, promoted-block display-text + native navigation — each exposed as a command (`Atlas: Open folder-unit…`, `Atlas: Create interface note for folder…`, `Atlas: Add block`, `Atlas: Open promoted block…`) rather than waiting for F8's real explorer view to exist.

**Why:** the hand-off doc's own ACs for these three features describe behavior "in the explorer," but the actual rendering surface — the `ItemView`, its icons, chevrons, drag-and-drop — is F8, grouped in a later PR. Building throwaway UI now to satisfy these ACs would mean redoing it in F8 anyway. A command is a legitimate stand-in: it exercises the exact same underlying code path a future explorer click/drag handler will call (`findInterfaceNote`/`createInterfaceNote`, `getFreeBlockDisplayText`, `workspace.openLinkText` for block navigation), so verifying it now is real verification, not a placeholder. TASKS.md marks each AC's UI-only half as deferred to F8 rather than silently skipped.

## Found a reliable path through the flaky remote desktop: `xdotool`

**Finding, not really a decision.** The Chrome-relayed VNC clicking that PR 2 struggled with (Settings gear intermittently no-opping) turned out to have a root cause: the container's real X11 display is 2052×1178, but the Chrome tab renders it scaled down to 1456×837 — clicks translated through that scaling were landing close to, but not exactly on, small targets. `xdotool` is installed in the `obsidian-development-template` image and can drive the container's X11 display directly (`docker exec -u abc -e DISPLAY=:1 desktop-atlas xdotool ...`), bypassing the VNC/Chrome relay and its scaling entirely. Coordinates still need converting from a Chrome screenshot (1456×837) to real screen space (×1.409, ×1.408), but once converted, clicks and keystrokes land reliably — used for all of PR 3's live verification, including discovering that `Ctrl+P` opens the command palette fine as long as focus isn't in the editor (the vault's `obsidian-editor-shortcuts` plugin has a real, registered conflict on the same hotkey — visible in Settings → Hotkeys' "Conflicts" filter — that only wins when the editor has focus).

## PR 2 review sign-off (A1)

The delegate reviewer signed off on PR 2 after reading the actual diff (not just the PR description), independently re-derived the 24 folder-unit / 50 root-file counts from the fixture vault, and confirmed the Part 7 model checks (no disk moves, promotion computed live, "outside" scoped to top-level folder-unit) by tracing the code directly. Full detail in `_system/Notes/atlas/review/answers.md` A1.

One correction to their independent count, for the record: they attributed the 24 figure to "25 real top-level folders minus 1 excluded (`_to_delete`)," reasoning that `_to_delete` already existed and was being actively excluded at PR-2 time. It wasn't — `_to_delete` didn't exist as a directory yet when the original 24/50 numbers were captured; I created it (via `mkdir`) only afterward, as the destination for the synthetic block-promotion test's throwaway files. So the original 24 was simply "24 real top-level folders, nothing to exclude yet," not an exercised exclusion check. Their *re-run*, done after my test scratch work, is still a valid and correct independent confirmation that the exclusion mechanism works — just not proof that the original PR-2 number specifically exercised it. Doesn't change the sign-off; logging it so the provenance is accurate if anyone re-derives these numbers again later.

Two follow-ups from the review carried into `TASKS.md`: a live click-through of the Settings tab (owed before v1 ships, parked at F8 per the reviewer's suggestion), and naming the same-file self-link (`[[#^id]]`) non-promotion behavior as an explicit edge case (already correct in code, just wasn't named in Part 3/4).

## Delegate reviewer for day-to-day questions

**Decision:** from PR 2 onward, judgement calls and "ready for review" pings go to a delegate reviewer via `_system/Notes/atlas/review/questions.md` / `answers.md` (append-only, format in that folder's `README.md`), not to Dan directly. Dan is only looped in for: publishing anywhere public, anything needing his GitHub/Obsidian sign-in, or a real product-scope change the reviewer chooses to escalate.

**Why:** Dan set this up mid-build (confirmed via a live peer Conductor session plus the pre-existing `review/README.md` and empty `questions.md`/`answers.md` templates, all created before his instruction landed) so he doesn't have to be on-call for routine build questions.

## Fixed a real bug found via container testing: block-only links were also promoting their containing file

**Decision:** a link with a subpath (`[[file#^id]]` or `[[file#Heading]]`) now promotes only the block, never the file it lives in. Only a subpath-less reference (a bare `[[file]]` link or a whole-file embed) can promote the file/folder itself.

**Why:** the first implementation derived file/folder promotion from `metadataCache.resolvedLinks`, which collapses subpath links down to their target file — so a link to one paragraph was also promoting the whole containing note as a second, separate unit. Caught live in the container: created a throwaway `[[target#^id]]` link between two scratch files, and the target file showed up in both `promotedBlocks` *and* `promotedFiles`. Fixed by driving both file-level and block-level promotion off a single pass over each file's `cache.links`/`cache.embeds`/`cache.frontmatterLinks`, branching on whether the reference carries a subpath — `resolvedLinks` is no longer used at all. Also had to add `cache.frontmatterLinks` to that scan (missed on the first pass of the fix): a real promotion in the fixture vault (`_system/Classroom/Tutor/tutor-playbook.md`, linked from a `playbook: "[[tutor-playbook]]"` YAML property in `FDE Play/...`) briefly disappeared until that was added, since frontmatter-property links live in their own cache array, not `cache.links`.

## Dot-folders are invisible to Obsidian's vault API

**Finding, not a decision — documented so it isn't mistaken for a bug later.** F1's excluded-folders default is supposed to seed with "every dot-folder (`.obsidian`, `.git`, `.trash`, etc.)". `computeDefaultExcludedFolders` does scan for them, but on a real vault it always comes back empty of dot-folders — confirmed live (`data.json` after first load: `excludedFolders: ["_pool", "_to_delete"]`, no dot-folders). Obsidian's own `vault.getRoot().children` never includes dot-folders as `TFolder`s in the first place — they're outside the vault's document model entirely, not merely hidden. So excluding them explicitly is a harmless no-op today, not active filtering; nothing to fix, just don't be surprised the setting's default list never shows them.

## Container-based testing: what was and wasn't exercised live

**Decision:** verified F1/F2 against the real fixture vault running in `desktop-atlas` (Docker, `obsidian-development-template` image, Obsidian 1.13.7, vault bind-mounted at `/config/workspace/vault`) rather than relying on `tsc`/`eslint` alone, per Dan's instruction. Enabled the plugin through the real Settings UI once; after that, verification was via the running app's own console log (piped to a file with `--enable-logging=stderr --v=1`, since the KasmVNC remote desktop has no accessible DevTools panel through screenshots) plus the vault's `hot-reload` community plugin, which picked up each rebuild automatically without restarting Obsidian.

**What this caught, concretely:** full-rebuild and incremental-recompute timings on real data (2.6–13ms full rebuild, 2–10ms promotion recompute, <0.1ms per single-file event — all far under the 2s/100ms budgets); an exact match between reported `folder-unit`/`root-file` counts (24/50) and `ls` of the fixture vault; a real cross-folder promotion (`tutor-playbook.md`) traced back to its actual source link and confirmed genuine, not a false positive; the block-promotion bug above, via a deliberate throwaway test-link pair (created under `Health/`/`Bets/`, verified, then moved to `_to_delete/` — never committed, that folder's gitignored).

**What wasn't exercised live, and why:** the GUI itself was flaky enough in this remote session (clicks on the Settings gear intermittently no-opped or mis-hit) that interactive per-setting AC checks (pool-folder-rename warning, manual-promotion toggle command) were verified by code review and a clean build rather than by clicking through them. Flagged explicitly in `TASKS.md` rather than checked off silently. The literal 5,000-file scale test is F11's job, not repeated here.

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
