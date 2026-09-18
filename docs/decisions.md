# Decisions

Judgement calls made during the build, the alternative considered, and why. Newest first.

## F8: keyboard Delete unplaces without a confirmation step — deliberate, not an oversight

**Decision:** `handleRowKeydown`'s `Delete` case calls `unplaceUnit` immediately, with no `ConfirmModal` in between — unlike "Delete view" and "Delete meta folder," which do confirm first.

**Why no confirm here specifically (per review, A8/A9):** unplacing a unit isn't destructive under this model — the unit doesn't disappear, it just returns to the inbox (its own view, or the global one), fully recoverable with the same "Place in view…" flow used to place it in the first place. Nothing on disk changes and no data is lost. Both "Delete view" and "Delete meta folder" *do* confirm (`ConfirmModal`, `showMetaFolderMenu`) even though neither is destructive either in the same disk-safety sense — their placements/children survive (moved to the global inbox, or up one level). The distinguishing factor isn't destructiveness, it's blast radius: those two actions can reshuffle however many placements or children a view/meta-folder holds in one keystroke, where Delete-to-unplace only ever touches the one row under the cursor. A confirmation step earns its place when an action's effect is large or hard to visually verify after the fact, not merely when something is technically reversible; a single-row, single-target action doesn't clear that bar the way a whole-view or whole-folder action does.

**What this means for the spec's "Delete to remove (with confirm)" wording:** read as describing the general shape of a delete-like action in the explorer, not a literal requirement that this specific keyboard shortcut must always confirm — the shape holds (actions with meaningful blast radius confirm; a single-row unplace doesn't have one).

## F8: real bug fixed post-review (A6) — drop-onto-nested-unit escaped to bucket root

**Decision:** `handleDrop`'s branch for "dropped onto a unit node, not a meta folder" (the Part 4 edge case where dropping a unit onto another unit should insert it as a sibling right after the target) hardcoded `parentId = null` regardless of where the target unit actually lived in the tree. `indexInParent` already did the equivalent recursive search to find the right *index* within whatever array the target lives in; this branch just never did the analogous lookup for the right *parent*. Fixed by adding `parentIdOf` — a recursive search returning the id of the meta folder a node lives in, or `null` for the bucket root — and using its result instead of the hardcoded `null`.

**How this was caught:** code review (A6), not live testing — dropping a unit onto another unit that's nested inside a meta folder would incorrectly escape the dropped unit out to the bucket root instead of landing inside that same meta folder as a sibling. This is exactly the failure mode the drag-and-drop-untestable-in-this-container limitation was hiding: none of the non-drag equivalents used throughout this build to verify `placeUnit`/`unplaceUnit` (the "Place in view…" flow, the temporary debug command, "Remove from view") exercise this specific branch of `handleDrop`, because they all call `placeUnit` directly with an already-correct `parentId` rather than going through the target-node → parent-lookup logic this bug lived in. A reminder that "verified the underlying method works" and "verified the UI computes the right arguments to it" are different claims — this build's non-drag substitutes covered the former, not the latter, for this one code path.

**Not separately live-tested even now** — still blocked on the same environment limitation (no working synthetic drag in this container) — but it's now correct by code inspection rather than silently wrong underneath a passing-looking test suite. Real drag-and-drop testing (per A7's recommendation) is the one item in this build genuinely best left for Dan's own hands-on pass.

## F8: temporary debug drag-placement command removed at PR close

**Decision:** the "Debug — place first inbox unit into bucket root" command (added mid-build to verify `placeUnit`'s state management independent of the untestable drag gesture) is removed from `main.ts` now that this PR is closing. It isn't in F10's finalized command list, and its job — proving `placeUnit`/`moveNode`/`unplaceUnit` work correctly — is now covered by non-drag equivalents that are staying: the "Place in view…" context-menu/command-palette flow (`placeUnit`), "Remove from view" (`unplaceUnit`), and view deletion moving orphaned placements to the inbox (also `unplaceUnit`, at a different call site).

**Why remove rather than keep it as a permanent hidden feature:** it was explicitly scoped as temporary when added (see the code comment it shipped with), the native drag-and-drop limitation it worked around is an environment/testing gap rather than something the shipped plugin needs a workaround for, and leaving an unlisted "Debug —" command in a real user's command palette is the kind of rough edge Part 7's "no disk-shape leaks in the UI" spirit argues against even though it's not literally a disk-shape issue — it's internal-testing scaffolding, not a feature.

## F8: Menu has no submenu API — "Place in view ▸" is a two-step modal flow instead

**Decision:** Obsidian's `Menu`/`MenuItem` API (confirmed by grepping `obsidian.d.ts`) has no way to attach a submenu to a menu item. The hand-off doc's "Place in view ▸" context-menu item is implemented instead as: click "Place in view…" → `ViewSuggestModal` (fuzzy-pick the target view) → `MetaFolderSuggestModal` (fuzzy-pick "(bucket root)" or a named meta folder within that view) → `viewsManager.placeUnit(...)`.

**Why not something else:** a flat single-level menu listing every `view › meta-folder` combination was considered and rejected — it doesn't scale (grows with views × meta folders) and reads worse than two short, focused picks. The two-modal flow also reuses the exact same `ViewSuggestModal`/`MetaFolderSuggestModal` classes that F10's `place-active-file-in-view` command already needed, so it isn't one-off scaffolding.

**Verified live, full round-trip:** right-click a unit in the inbox → "Place in view…" → picked "Weekly" → picked the "Ideas" meta folder → the unit (`opencode.jsonc`) appeared correctly nested under "Ideas" in Weekly's bucket, and the inbox count dropped by one. Also used from the command palette (`Atlas: Place active file in view…`) with the same two-step flow, confirming both entry points share the same code path.

## F8/F9: modal and menu button clicks — real coordinates fix what earlier looked like an environment bug

**Decision:** no code change. The PR-4-in-progress note (now corrected) claimed `TextPromptModal`/`ConfirmModal` OK/Cancel buttons were unreliable to click via synthetic X11 input, with keyboard-only interaction as the only proven path. Retested this pass with pixel-precise coordinates (cropped + 4x-upscaled screenshots of the exact button before clicking, rather than eyeballing coordinates from a full screenshot) and both button types clicked correctly and repeatedly: `ConfirmModal`'s red "Delete" button (used twice, once per view-deletion test) and `Menu`'s "Place in view…" item (used twice).

**Why the earlier finding was wrong:** the full-window screenshots returned by this container are rendered at 2056×1178 but displayed to the assistant at 2000×1146 — a ~2.8% scale difference easy to miss when reading pixel coordinates directly off the displayed image. At a 24–30px button height, that error is enough to land clicks one row off or on a button's edge. Cropping the exact control at native resolution before clicking removes the ambiguity. Keyboard-driven interaction (typing right after a modal opens, Enter to submit) remains a fine fallback and was kept as the primary path for `TextPromptModal` text entry throughout this pass — this finding is specifically about *button clicks*, not a reason to distrust the keyboard path.

## F9: rewriteRefPath's rename handling verified live — with one real environment caveat surfaced along the way

**Decision:** no code change; the existing `vault.on('rename')` handler (`unitIndex.onVaultRename` + `viewsManager.onVaultRename`) is correct as built. Verified live by placing a file, renaming it via Obsidian's own in-app rename (command palette → "Rename file", which edits the note's inline H1 title and calls `vault.rename` under the hood), and confirming `data.json`'s `ViewNode.ref.path` updated to the new filename while the node's `id` and position in the tree stayed identical.

**The caveat, surfaced by accident and worth recording precisely:** an *external* rename performed directly on the host filesystem (`mv` from outside Obsidian, while the container's Obsidian instance is running against the same bind-mounted vault) did **not** fire Obsidian's `rename` event — instead it was reported as a delete of the old path (the placement correctly rendered as a greyed "(missing)" row, per spec) with no corresponding pickup of the new file into the same ref. This is a Docker bind-mount file-watching limitation (the same class of issue as the earlier documented native-drag-and-drop gap), not an Atlas defect: Atlas only ever reacts to whatever `rename` event Obsidian itself decides to fire, and Obsidian's own file watcher didn't correlate the unlink+create into a rename over this mount. A real user renaming a file from their OS's file manager on a native (non-Docker-bind-mounted) install would not hit this. Recorded here so it isn't mistaken for an Atlas bug if it resurfaces in future container testing.

**Side effect caught and reverted, not left in the vault:** testing folder-level rename (`Bets` → `Bets Renamed` → `Bets`, both via Obsidian's own native-explorer rename, to exercise the prefix-rewrite branch of `rewriteRefPath` against a folder-unit) triggered Obsidian's own link-updating feature, which rewrote *relative* markdown-style links (e.g. `[steps/bets-sweep-family.md](steps/bets-sweep-family.md)`) in 8 files under `Bets/` incorrectly on the round trip, stripping the `steps/` prefix and leaving broken links. This is a pre-existing Obsidian behavior around relative (non-wikilink) markdown links during folder renames, entirely unrelated to Atlas's own code — Atlas never touches file content. Caught via `git status` immediately after, and reverted with `git checkout --` before doing anything else, so the vault's real content is untouched. Named here as a real, reproducible gotcha for any future container-based rename testing in this vault: prefer testing renames against files, not folders with internal relative-link cross-references, or be ready to check `git status` and revert immediately after.

## F9: inbox mode differential test — the two-view scenario needs a unit placed in only one view

**Decision:** to actually distinguish "This view" from "Global" inbox mode (not just click the toggle and eyeball a count that happens to be the same either way), the live test placed one unit (`Bets`) in *both* views' buckets and a second, different unit (`Content`) in only one view's bucket, then compared inbox counts across both modes and both active views.

**Why this mattered:** the first attempt at this AC placed the same single unit in both views' buckets, which meant "This view" and "Global" produced the identical count for both views (the unit was excluded from the inbox either way) — a passing-looking result that doesn't actually verify the mode distinction. Adding the second unit (placed in only one view) made the two modes diverge as expected: with "Weekly" active, "This view" mode showed 74 (only `Bets`, placed in Weekly, excluded) while "Global" mode showed 73 (`Bets` *and* `Content` excluded, since `Content` is placed somewhere even though not in Weekly). This is the actual shape of AC in Part 3/4 and is worth remembering as the template for testing this distinction again in the future.

## F8/F9 live verification pass — what's carried forward as a real gap vs. deferred by design

**Decision:** native HTML5 drag-and-drop (inbox → bucket, reorder within bucket, bucket → inbox) remains untestable via `xdotool`-driven synthetic X11 input in this container — reconfirmed this pass with careful multi-step `mousedown`/`mousemove`/`mouseup` sequences, same as the original finding during the initial F8 build. Every drag-driven state mutation (`placeUnit`, `moveNode`, `unplaceUnit`) was instead verified live through an equivalent non-drag path that calls the identical method: the temporary debug command, the "Place in view…" context-menu/command-palette flow, and the "Remove from view" context-menu action, respectively. `moveNode`'s reorder-specific logic (splice + circular-placement guard) has no non-drag equivalent and remains code-reviewed only, not live-exercised — named explicitly in TASKS.md rather than left ambiguous.

**Why ship without a code fix for the drag limitation:** this is a testing-environment gap, not a code defect — the drop handlers themselves are wired identically to how every other Obsidian community plugin implements drag-and-drop, and there's no indication real trackpad/mouse input in a real browser or Electron window would behave differently. Re-confirming this each time a new drag-dependent AC comes up (rather than assuming the first finding still holds) is deliberate — environment quirks are exactly the kind of thing that can silently resolve itself with a container/tooling update and shouldn't be trusted from one earlier data point indefinitely.

## F6: self-calibrating suggestion sort (post-PR-4 review A4, refined post-PR-5 review A5)

**Decision (final form):** a unit (`folder-unit`/`free-block`/`promoted-block`) only sorts above plain `file` matches when its own fuzzy-match score is at least as good as the best `file`-kind score in that same result set. Otherwise it's sorted by score alongside files, same as before. No fixed tier, no magic-number margin — the threshold is the query's own best file match, recomputed per query.

**How this evolved (two rounds, both driven by live evidence, not review-only back-and-forth):**
1. **A4** caught that "`[[bets` surfaces the `Bets` folder-unit" was checked off but not actually guaranteed — pure fuzzy-score sort meant a real competing file (e.g. `Bets/notes-on-bets.md`) could out-rank the folder-unit. First fix: an unconditional kind tier (all units always outrank all files). Verified live, closed the gap.
2. **A5** pushed back on that fix after seeing its own live evidence: the unconditional tier meant *any* unit, however weak its match, now outranked *every* file. Confirmed live: typing `bets` surfaced `Kubernetes` and `Objectives` — both incidental weak subsequence matches — above an exact-ish `bets` filename match. The reviewer judged this a bigger behavior change than the hand-off doc's two narrow examples called for, and asked for a margin/threshold instead, suggesting the self-calibrating form specifically to avoid picking an arbitrary constant.

**Why the self-calibrating form over a fixed margin:** a fixed threshold (e.g. "unit score must be within 10 points of the best file score") requires guessing a constant with no principled value, and would need re-tuning if Obsidian's fuzzy-search scoring ever changes. Comparing directly against the best file score in the same query's result set has no constant to pick and degrades sensibly (no files matched → every unit clears the bar trivially, since there's nothing to bury).

**Verified live, both directions, with the same fixture file (`Bets/notes-on-bets.md`) that exposed the original gap:** `Bets`/folder still sorts first (its match against "bets" is competitive with the best file match) — the case A4 cared about. `Kubernetes`/`Objectives` no longer outrank the exact `bets`/`Bets` file matches — the case A5 cared about. Both confirmed in the same test run, not assumed from the code alone.

## F6: native `[[` suggester suppression — implemented per Q3/A3

**Decision:** `AtlasLinkSuggest` (a normal `EditorSuggest`, registered via the public `registerEditorSuggest`) is moved to the front of the undocumented `app.workspace.editorSuggest.suggests` array in `onLayoutReady`, and moved back on `onunload` — see `src/suggester-precedence.ts`. Full reasoning, the alternatives rejected, and the risk classification were reviewed and approved *before* writing this code (Q3/A3 in `_system/Notes/atlas/review/`), following an established real plugin's approach (`saiki77/easy-links`, read directly from its source, not recalled from memory) rather than guessing.

**Verified live, not just trusted from that reference plugin's own code comment:** typed `[[` in the container and confirmed exactly one popup renders (screenshot) — the specific check the reviewer asked not to skip. Also verified the two headline ACs word-for-word against the spec's own examples: `[[obsidian next` surfaced the free block by content despite its ID filename, and `[[bets` surfaced the `Bets` folder-unit.

**One thing Atlas can't control, named so it isn't "discovered" as a bug later (A3's request):** if some other installed community plugin does the same front-of-array reorder trick, the two suggesters could fight over precedence — there's no registry coordinating this. Not solvable and not attempted; just worth knowing if a future user reports Atlas's suggester intermittently losing to another plugin's.

## F6: real bug found live — Obsidian's auto-closed `]]` wasn't consumed

**Decision:** `selectSuggestion` now checks whether the two characters immediately after `context.end` are `]]` (Obsidian's own bracket auto-close, inserted when the triggering `[[` was typed) and extends the replacement range to consume them if so.

**Why:** caught live, not in review — the very first successful suggestion selection produced `[[ID|display text.]]]]`, a duplicated closing bracket. `context.end` only spans up to the typed query text, not the auto-closed brackets sitting just past the cursor, so the original code left them behind. Re-verified live after the fix: correct single `]]`.

## F7: hover preview and `registerHoverLinkSource`

**Decision (partial, follow-up logged rather than closed):** the live-preview widget's `mouseover` handler manually calls `app.workspace.trigger('hover-link', {...})`, which is enough to produce Obsidian's native hover-preview popover. `registerHoverLinkSource` — the API that lets a hover source show up as a configurable toggle in the "Page preview" core plugin's settings — is not wired up yet.

**Why not now:** it's an enhancement (making an already-working hover source user-configurable), not required for the AC itself, and this PR was already large. Logged in TASKS.md as a named follow-up rather than silently skipped. Separately: the widget's `mouseover`-triggered hover path itself was implemented but **not live-tested** this pass (unlike everything else in F6/F7, which was) — flagged as a genuine unknown, not assumed to work because the reading-view case (a different, native code path) did.

## PR 3 review fixes (A2)

Two small fixes applied before merging PR 3, per reviewer sign-off:

1. **Marked three commands `TEMPORARY`** in `commands.ts` (`Open folder-unit…`, `Create interface note for folder…`, `Open promoted block…`) — none are in F10's finalized command list, so the default is removal once F8's real explorer covers the same ground. Not choosing to keep any of them permanently at this point; if that changes later, it gets its own logged decision rather than surviving by omission. `Add block` is unaffected — it's in F10, permanent regardless.
2. **`stripMarkdownLine` now strips table-row syntax** — leading/trailing `|` and internal cell separators collapse to a space (`| Col A | Col B |` → `Col A Col B`). Missed on the first pass despite the hand-off doc naming table rows explicitly as one of five "very long first lines" variants in Part 4; caught by the reviewer reading the diff against that specific line, not by any test (there wasn't one — TASKS.md's checkbox covered it by a general "verified by code review" note that didn't call out this specific gap). Verified with a direct unit check of the pure function this time, one case per named variant, rather than repeating the same general checkmark.

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
