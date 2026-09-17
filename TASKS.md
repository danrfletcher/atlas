# Atlas v1 — task list

Generated from `atlas-v1-handoff.md` Part 3 (features) and Part 4 (edge cases), per Part 6 step 2. Each feature's acceptance criteria (AC) and the edge cases that belong to it are checkboxes. PRs land in the groups below (see `docs/decisions.md`).

Legend: **MUST** blocks the PR it's grouped in. **SHOULD** expected but may slip with a note in `docs/decisions.md`. **NICE** optional.

---

## PR 1 — F1 Settings, F2 Unit index

### F1 — Settings (MUST)
- [x] Pool folder setting, text, default `_pool`, created on demand if absent (folder creation itself happens at F4 Add-block time)
- [x] Excluded folders setting, list, default = every dot-folder + pool folder + `_to_delete` — see `docs/decisions.md`: Obsidian's vault API never surfaces dot-folders as `TFolder`s at all, so this is a no-op safeguard today, not active filtering
- [x] Interface note convention setting, default `<Folder>/<Folder>.md`, option to also accept `index.md` / `README.md`
- [x] "Replace native explorer on startup" toggle, default on (behavior itself is F8; this PR only stores the setting)
- [x] Block display length setting, default 80
- [x] Default view on launch, dropdown of existing views (one hardcoded "Default" option until F9 ships)
- [x] AC: changing pool folder name re-indexes; old-folder free blocks shown with a warning until moved — implemented (`handlePoolFolderChanged`); code-path verified, not exercised via live GUI (see `docs/decisions.md` container-testing note)
- [x] AC: an excluded folder never renders in any view; its files never appear in any inbox (except pool-folder files) — verified live: container-reported folder-unit count (24) matched `ls` of the fixture vault's top-level folders exactly
- [x] Edge case: pool folder renamed in settings while blocks exist → warning, no data loss

### F2 — Unit index (MUST)
- [x] In-memory index of every unit, rebuilt on load
- [x] Incremental updates from `vault` + `metadataCache` events (create, modify, delete, rename, resolved-links changed)
- [x] Root file unit type — verified live: 50 root-file units matched `ls` of the fixture vault's root files exactly
- [x] Free block unit type (code path in place; no `_pool` folder exists in the fixture yet, so 0 live instances — expected, not a gap)
- [x] Folder-unit type (top-level, plus promoted nested)
- [x] Promoted file unit type (inbound link from outside its top-level folder-unit, or manual) — verified live against real vault content, see below
- [x] Promoted folder unit type (same rule, nested folder's interface note) — code path in place; 0 live instances in the fixture (no nested-folder interface note happens to be linked from outside today)
- [x] Promoted block unit type (`#^id` / `#Heading` link target, any source) — verified live with a synthetic test link (see `docs/decisions.md`)
- [x] Manual promotions stored in plugin data, never by editing the target file — storage + `addManualPromotion`/`removeManualPromotion` wired to `data.json`; exposed via a temporary debug command ahead of F3's real UI
- [ ] AC: 5,000-file vault full rebuild < 2s, incremental update < 100ms (measured + logged) — the measurement/logging code exists and is confirmed working (real fixture vault: full rebuild 2.6–13ms, incremental promotion recompute 2–10ms, incremental single-file events <0.1ms); the literal 5,000-file synthetic scale run is F11's job per this file's own PR grouping, not repeated here
- [x] AC: link from an outside top-level folder promotes a nested file within 1 second, with no reload — verified live on real vault content: `_system/Classroom/Tutor/tutor-playbook.md` promoted correctly via a genuine frontmatter-property wikilink from `FDE Play/...`; promotion recomputes in single-digit ms, far under 1s
- [ ] AC: removing that link demotes it (leaves inbox; placements show greyed "no longer a unit" + remove action) — the "leaves inbox" half only has meaning once F8's explorer exists; demotion-on-link-removal itself not yet exercised live, follow up when F8 lands
- [x] AC: link from inside a top-level folder-unit to another file in the *same* top-level folder-unit does NOT promote — verified by absence: despite hundreds of internal cross-links within `_system`, exactly one real promoted-file surfaced vault-wide, and it was a genuine cross-folder link
- [x] AC: `#^id` link from any other file promotes the block — verified live with a synthetic test link/target pair; also caught and fixed a real bug this test surfaced (see `docs/decisions.md`: a block-only link was incorrectly also promoting its containing file)
- [x] Edge case: link from an excluded folder (e.g. `.trash`) must not promote anything
- [x] Edge case: links inside code fences / inline code must not promote anything (rely on `metadataCache`) — verified live: several vault files contain `[[file#^id]]` as literal documentation text inside code spans, none of them produced false-positive promotions
- [x] Edge case: unresolved links (nonexistent targets) never create units
- [x] Edge case: non-markdown root files (PDF, excalidraw) are root-file units; click opens default viewer
- [ ] Edge case: vault with zero folders; vault with only excluded folders
- [x] Edge case (added post-PR-2 review, A1): a same-file self-link (`[[#^id]]` referencing a heading/block in its *own* file) must not promote it — already correct in code (`destPath === file.path` guard in `computePromotions`), matching the hand-off doc's "any link from *another file*" wording, but wasn't named in Part 3/4 so wasn't test-protected; naming it here so it can't regress silently

---

## PR 2 — F3 Folder-units, F4 Free blocks, F5 Promoted blocks in explorer

**Note on scope for this PR:** F3/F4/F5's ACs describe behavior inside "the explorer," but the explorer's actual rendering surface (the `ItemView`, its toolbar, drag-and-drop) is F8, grouped in PR 4. So this PR ships the underlying mechanics — interface-note lookup/creation, free-block creation + display-text derivation, promoted-block display-text + native navigation — each wired to a command as a stand-in for the eventual explorer-row click/drag, and verified live through that command. Items that are inherently about the rendered list itself (icons, chevrons, drag-and-drop, toolbar buttons) are marked deferred to F8 below rather than checked off against a UI that doesn't exist yet.

**Command cleanup owed at F8 (PR-3 review, A2):** `Open folder-unit…`, `Create interface note for folder…`, and `Open promoted block…` are marked `TEMPORARY` in `commands.ts` — they aren't in F10's finalized command list, so default to removing them once F8's real click/drag handlers cover the same ground, unless one is deliberately kept as a permanent addition (that would be its own logged decision, not a default). `Add block` is permanent — it's in F10.

### F3 — Folder-units (MUST)
- [ ] Every folder renders as one item, folder icon + name — **deferred to F8** (needs the explorer list)
- [x] Click opens interface note if it exists — shipped as `Atlas: Open folder-unit…` (fuzzy folder picker); F8 wires the same lookup to a real click
- [x] If none exists: context menu offers "Create interface note" (`<Folder>/<Folder>.md`, one-line H1) — shipped as `Atlas: Create interface note for folder…`, picker only lists folders that don't have one yet. The "click expands folder" half is **deferred to F8**.
- [ ] Expand (chevron) shows internals as plain physical tree, read-only for structure — **deferred to F8**
- [ ] Context menu "Reveal in native explorer" on internals — **deferred to F8**
- [ ] Dragging an internal file/folder out of expanded tree into a bucket manually promotes it (F2) and places it — the promotion half (`addManualPromotion`) shipped in F2; the drag/placement half is **deferred to F8/F9**
- [x] Folder-unit properties = interface note properties (doc only, no code) — documented in README
- [x] AC: `Bets/` shows as one item; click opens `Bets/Bets.md` — verified live via `Atlas: Open folder-unit…` → `Bets` → opened `Bets/Bets.md`
- [ ] AC: folder with no interface note expands on click, shows create action — the "create action" half verified live (see below); "expands on click" is F8
- [x] AC: dragging `Bets/steps/step-3.md`... — **deferred to F8/F9** (drag-and-drop doesn't exist yet)
- [ ] Edge case: interface note exists but folder renamed → folder-unit still resolves; if note name no longer matches convention, show "interface note: none (found `Old/Old.md`)" + offer rename — **deferred to F8/F9** (needs both the rendered "interface note: none" label and F9's rename-ref-rewriting)
- [ ] Edge case: two folders with the same name at different depths — untested; nothing in the current logic treats depth specially (folder-unit detection is top-level-only, nested folders only ever appear as `promoted-folder`, keyed by full path so no collision), but not exercised live

### F4 — Free blocks: Add block (MUST)
- [x] Toolbar button "Add block" — **toolbar deferred to F8**; command "Atlas: Add block" shipped and verified live (assignable hotkey: any command gets one for free via Obsidian's Hotkeys settings)
- [x] Creates `<pool>/<ID>.md`, `ID = YYYYMMDDHHmmss-xxxx` (4 random base36 chars); opens with cursor on first body line; no title prompt/dialog — verified live: created `_pool/20260917145818-t7tw.md` (pool folder auto-created, didn't exist before), opened directly into the editor, no dialog
- [x] Explorer shows free block by display text: `title` frontmatter if present, else first non-empty body line, markdown stripped, truncated to configured length — the derivation (`getFreeBlockDisplayText`) is implemented and verified live (typed real text into a fresh block, confirmed correct output via console); **wiring it into a rendered row is F8**
- [ ] Display text updates live as user types (debounced) — inherently a UI-refresh concern, **deferred to F8**
- [ ] Free blocks appear in every view's inbox until placed — **deferred to F8/F9** (inbox doesn't exist yet)
- [ ] AC: hotkey creates file + focuses editor in < 200ms; typing lands in body immediately — creation+open verified live and felt instant, but not instrumented with a timer; not checking this off on a feeling
- [ ] AC: explorer row updates to typed text within 1s — **deferred to F8**
- [x] AC: block file with no body shows "(empty block)" — verified live
- [x] AC: two blocks created in the same second get different IDs — code guarantees this (4 random base36 chars + a pre-create existence check/retry loop); two blocks created live got different IDs, though not within the same literal second
- [x] Edge case: pool folder does not exist on first Add block → created — verified live (see above)
- [x] Edge case: very long first lines; first line is a heading, a task, a table row, a code fence opener, or frontmatter only — `stripMarkdownLine` strips heading/task/list/blockquote/code-fence/table-row markers and truncates (table-row handling added post-PR-3-review, A2: `| Col A | Col B |` → `Col A Col B`); verified via a direct unit check of the pure function for each of the five named variants, not just build-clean

### F5 — Promoted blocks in the explorer (MUST)
- [ ] Promoted block renders with block icon + stripped/truncated text (paragraph/list item/heading) — icon/row rendering **deferred to F8**; text derivation (`getPromotedBlockDisplayText`) shipped and verified live
- [x] Click opens source file, scrolls to + highlights block (via Obsidian's native `#^id` / `#Heading` navigation) — shipped as `Atlas: Open promoted block…`; verified live end-to-end: created a real `[[file#^id]]` link, ran the command, it navigated to the source file with the exact block highlighted by Obsidian's own native flash
- [x] Parent file shown as secondary label (e.g. small grey "in Classroom.md") — the suggest-picker shows `<text> — in <file>.md`; verified live
- [x] AC: every `#^id` link target in the vault appears exactly once in the unit list — guaranteed by construction (`promotedBlocks` keyed by `path#subpath`, a `Map`) and confirmed live (single test link produced exactly one entry)
- [x] AC: clicking navigates to the block in the source file — verified live (see above)
- [ ] AC: deleting the `^id` from source demotes the block; placements show greyed + remove action — demotion-on-deletion itself follows from the same live-recompute mechanism F2 already verified for links; the "placements show greyed" half needs F9's views, **deferred**
- [x] Edge case: a block ID appears in two files (copy-paste) → both promoted; disambiguate by parent label — guaranteed by construction (map keyed by full path + subpath, not subpath alone, so two files sharing a block ID text naturally get two separate entries); the "in `<file>.md`" label already disambiguates them, per above
- [x] Edge case: a heading link target has duplicate headings in the file → link to the first (Obsidian behaviour); display once — Obsidian's own `getFirstLinkpathDest`/heading resolution already resolves ambiguous heading links to the first match; combined with the same `path#subpath` map key, this can only ever produce one entry — not exercised with an actual duplicate-heading file, but correct by construction

---

## PR 3 — F6 Link suggester, F7 Block link display

### F6 — Link suggester: match blocks and folders by text (MUST)
- [x] `[[` suggestions include native files (as native) — verified live: `vault.getFiles()` matched by basename, unfiltered by Atlas's own exclusions (matches what native would show)
- [x] `[[` suggestions include folder-units, matched by folder name (excluded folders never suggested); selecting inserts link to interface note, creating it first if absent — verified live: `[[bets` surfaced the `Bets` folder-unit labelled "folder"
- [x] `[[` suggestions include free blocks, matched by display text AND full body text; selecting inserts `[[<ID>|<display text>]]` — verified live end to end, see AC below
- [x] `[[` suggestions include promoted blocks, matched by block text; selecting inserts native `[[file#^id]]` with block-text alias — implemented (same code path as F5's `getPromotedBlockDisplayText` + `generateMarkdownLink`); not separately live-tested this pass (F5 already verified the underlying navigation half live)
- [x] Native `[[` suggester suppressed/superseded cleanly (document the approach + rejected alternative in `docs/decisions.md`) — see decisions.md; approach adapted from a real published plugin's source, reviewed by the delegate reviewer before implementation (Q3/A3)
- [x] AC: typing `[[obsidian next` surfaces the free block whose first line starts "Obsidian Next Runner…" despite ID filename — verified live, exact spec wording reproduced (screenshot)
- [x] AC: typing `[[bets` surfaces the `Bets` folder-unit above internals/other files — **fixed post-PR-4 review (A4)**: originally sorted by fuzzy score alone, so a real competing file could out-rank the folder-unit and the AC wasn't actually guaranteed, just untested-and-hoping. Now sorts by a deterministic kind tier first (all Atlas units outrank plain files) with fuzzy score only breaking ties within a tier. Verified live with a real competing file (`Bets/notes-on-bets.md`, an exact-ish match for "bets") added to the fixture: `Bets`/folder now sorts first, as required. See `docs/decisions.md` for a trade-off this tier approach introduces.
- [ ] AC: typing `[[` inside a code block does nothing — implemented (`isInsideCodeBlock` checks `cache.sections` for a `code`-type section spanning the line) but not exercised live this pass
- [x] AC: selecting a free block inserts the aliased link; rendered link shows the alias, not the ID — verified live; also caught and fixed a real bug here (see decisions.md: Obsidian's auto-closed `]]` was left behind, duplicating the closing bracket)
- [x] AC: only one suggestion popup is ever visible — **verified live via screenshot**, not just trusted from the reference plugin's code comment, per the reviewer's explicit ask (A3)

### F7 — Block link display (SHOULD)
- [x] Alias-less link to a free block (e.g. `[[20260917143201-k7f3]]`) renders as its display text in reading view and live preview — verified live in both modes (screenshots)
- [x] Source mode shows the raw text unchanged — implemented via the same `editorLivePreviewField` check already proven to distinguish modes correctly (reading/live-preview switching was verified live); not separately screenshotted in source mode this pass
- [x] AC: alias-less link renders as first line in both reading view and live preview — verified live (screenshots)
- [ ] AC: editing the block's first line updates rendered links on next render — the underlying mechanism (`FreeBlockTextCache` refreshed on `vault.on('modify')`, decorations re-run on next CM6 doc/viewport/selection change) is implemented but not exercised live this pass
- [ ] AC: hover preview still works — reading view: verified live (the anchor's `href`/`data-href` are untouched, only its text changes, so Obsidian's native hover preview fires with no extra code and was confirmed live). Live preview: the custom widget has a `mouseover` handler that manually calls `workspace.trigger('hover-link', ...)`, but this specific path was **not** live-tested this pass — genuinely unverified, not just unscreenshotted, so left unchecked. `registerHoverLinkSource` (the API for making this configurable like other hover sources) also isn't wired up yet. Both are a follow-up, not a silent gap.

---

## PR 4 — F8 Explorer view, F9 Views storage/integrity, F10 Commands

### F8 — The explorer view (MUST)
- [ ] **Follow-up carried from PR 2 review (A1)**: F1's Settings tab was verified by code review, not a live click-through, because the remote VNC session was too flaky during that pass. Settings is a MUST feature, so Part 6 step 5 owes it a real click-through before v1 ships — do it here, since F8 gives a live reason to be in the Settings UI anyway (the "replace native explorer on startup" toggle only has an observable effect once this feature exists).
- [ ] Custom `ItemView` registered for left sidebar, icon + title "Atlas"
- [ ] Toolbar: view switcher (New/Rename/Delete view), Add block, Add file, Add folder, Add meta folder, sort toggle (manual/A–Z), filter box, collapse-all
- [ ] Bucket section, open by default, drag-and-drop tree
- [ ] Inbox section, collapsed by default, count badge, flat list, "This view"/"Global" toggle, sorted newest first by default
- [ ] Item rendering: type icon (block/file/folder/meta) + display text; folder-units show chevron for internals; promoted items show "promoted" marker; missing units render greyed + remove action
- [ ] Add file / Add folder: create real file/folder at vault root, rename-in-place UI, appear in inbox
- [ ] Add meta folder: branch node in bucket at current selection or root, named in place, unlimited nesting
- [ ] Drag: inbox → bucket places unit
- [ ] Drag: within bucket reorders/re-nests units and meta folders
- [ ] Drag: bucket → inbox area unplaces unit
- [ ] Drag: expanded folder-unit internals → bucket manually promotes + places (F3)
- [ ] Multi-select (shift/cmd-click); drag moves whole selection
- [ ] Code assertion: DnD handlers never call `vault.rename` / `fileManager.renameFile`
- [ ] Context menu: Open, Open in new tab, Reveal in native explorer, Copy link, Remove from view, Promote (internals), Create interface note (folder-units w/o one), Rename meta folder, Delete meta folder (children move up one level), Place in view ▸ (submenu)
- [ ] Active-file tracking: highlighted wherever it appears in current view's bucket; hover tooltip lists every placement across all views as breadcrumbs
- [ ] Keyboard: arrow nav, Enter to open, Space to expand/collapse, Delete to remove (with confirm), F2 to rename meta folder
- [ ] AC: fresh vault, no views → one "Default" view, empty bucket, every unit in inbox
- [ ] AC: drag `Bets` from inbox into meta folder "Career" places it; `Bets/` path on disk unchanged (verify with `ls`)
- [ ] AC: second view "Weekly", place `Bets` there too → in both buckets; absent from global inbox; absent from each view's own inbox
- [ ] AC: remove `Bets` from "Weekly" only → returns to Weekly's inbox, stays in "Career" in first view, absent from global inbox
- [ ] AC: delete meta folder "Career" → children move to bucket root, nothing on disk changes
- [ ] AC: filter box narrows bucket + inbox by display text, live
- [ ] AC: renaming a file on disk (native explorer or agent) keeps it placed in every view (F9)
- [ ] AC: plugin's explorer is the active sidebar view on launch when setting is on; native explorer reachable as a tab
- [ ] Edge case: circular placement — a meta folder cannot be dropped into its own descendant
- [ ] Edge case: dropping a unit onto a unit node (not a meta folder) → insert as sibling after it
- [ ] Edge case: vault with zero folders; vault with only excluded folders (explorer rendering, not just index — cross-ref F2)

### F9 — Views: storage and integrity (MUST)
- [ ] Views stored in plugin's `data.json` (`loadData`/`saveData`); no vault files written for views
- [ ] Data model: `UnitRef`, `ViewNode`, `View`, `AtlasData` per spec shape
- [ ] `vault.on('rename')`: rewrite every matching `UnitRef.path` (exact + prefix `oldPath + '/'`) in every view and `manualPromotions`
- [ ] `vault.on('delete')`: refs NOT removed automatically; render greyed "missing" + remove action
- [ ] Saves debounced (≤500ms) and atomic; crash mid-save must not corrupt views
- [ ] Every unit ref validated against unit index on load; invalid refs render as missing, never crash
- [ ] AC: rename `Blue Passat.md` → `Passat.md` — still placed in every view, correct display text
- [ ] AC: move `Bets/` → `Archive/Bets/` — every ref updates, still placed
- [ ] AC: delete a placed free block — renders greyed "missing"; remove works; rest of view unaffected
- [ ] AC: kill Obsidian during rapid drags, relaunch — views load with at most the last ≤500ms of changes lost
- [ ] Edge case: a free block manually renamed to a real title → now a root file; refs update; still displayed by title (cross-ref F2/F4)
- [ ] Edge case: a free block moved out of the pool by the user → becomes a normal file; refs update
- [ ] Edge case: view names must be unique; renaming to an existing name is refused inline
- [ ] Edge case: deleting the last view recreates "Default"

### F10 — Commands and hotkeys (MUST)
- [ ] `Atlas: Add block`
- [ ] `Atlas: Open explorer`
- [ ] `Atlas: Switch view…` (fuzzy modal)
- [ ] `Atlas: Place active file in view…` (fuzzy modal: view, then meta folder)
- [ ] `Atlas: Reveal active file in Atlas`
- [ ] `Atlas: New view`
- [ ] `Atlas: Rebuild index`

---

## PR 5 — F11 Performance, F12 Mobile, F13 Docs

### F11 — Performance and scale (MUST)
- [ ] Responsive at 5,000 files + 2,000 free blocks
- [ ] Virtualised long lists (inbox can be thousands of rows)
- [ ] Index rebuild + incremental update timings logged at debug level
- [ ] Scale test: script 5,000 files + 2,000 pool blocks into a scratch vault; measure F11 timings

### F12 — Mobile (SHOULD)
- [ ] Explorer view renders and navigates on mobile
- [ ] Drag-and-drop not required on mobile; "Place in view ▸" context menu is the mobile path
- [ ] `isDesktopOnly: false` in manifest

### F13 — Docs (MUST)
- [ ] README: the model (Part 1 in plain words), setup, settings, commands, screenshots
- [ ] `docs/` set up for GitHub Pages, matching Dan's other plugins
- [ ] `docs/decisions.md` current with every judgement call, alternative rejected, and why

---

## Cross-cutting (verify at the end, not tied to one PR)

- [ ] Nothing in the plugin's DnD/promotion/placement code path ever calls `vault.rename` or `fileManager.renameFile` for the bucket/view mechanics (Part 7 — grep-verify across the whole codebase, not just F8)
- [ ] Promotion state is never cached in `data.json` — only `manualPromotions` are stored; everything else is computed live (Part 7)
- [ ] No disk-shape leaks in the UI: no ID filenames shown, no `Bets/Bets.md` breadcrumbs unless internals are explicitly expanded (Part 7)

---

## Test plan (Part 5, run after each PR's features land, full pass before the final PR)

- [ ] Load plugin in the fixture vault; confirm explorer opens as active sidebar view; screenshot
- [ ] Count units in global inbox; sanity-check against `ls` of root files + top-level folders (should match, zero free blocks/promoted items initially)
- [ ] Run every AC above in order F1 → F13, screenshotting each
- [ ] Run every edge case above
- [ ] Scale test per F11
- [ ] Rename/move/delete tests for F9 done from **outside** Obsidian (shell `mv`/`rm` while Obsidian is open), not just inside
