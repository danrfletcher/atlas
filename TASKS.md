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
- [x] AC: typing `[[bets` surfaces the `Bets` folder-unit above internals/other files — **fixed post-PR-4 review, refined post-PR-5 review (A4 → A5)**: originally sorted by fuzzy score alone (real competing files could out-rank the folder-unit, AC untested-and-hoping). First fix used an unconditional kind tier, which closed that gap but introduced a worse one the reviewer caught live in the evidence: weakly-matching folders (e.g. "Kubernetes") could then bury an exact-ish file match. Now self-calibrating instead of a fixed tier or magic-number margin: a unit only jumps above files when its own score is at least as good as the best file score in that result set (`kindPriority` in `link-suggest.ts`). Verified live both ways with a real competing file (`Bets/notes-on-bets.md`) added to the fixture: `Bets`/folder still sorts first (its match is competitive), while unrelated weak-matching folders no longer outrank the exact `bets` file matches. See `docs/decisions.md`.
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
- [x] **Follow-up carried from PR 2 review (A1)**: F1's Settings tab was verified by code review, not a live click-through, because the remote VNC session was too flaky during that pass. Settings is a MUST feature, so Part 6 step 5 owes it a real click-through before v1 ships — do it here, since F8 gives a live reason to be in the Settings UI anyway (the "replace native explorer on startup" toggle only has an observable effect once this feature exists). — verified live: opened Settings → Atlas, all six controls render and match `settings.ts` exactly (Pool folder, Excluded folders, Interface note convention toggle, Replace native explorer toggle — on — Block display length, Default view on launch dropdown)
- [x] Custom `ItemView` registered for left sidebar, icon + title "Atlas" — verified live throughout this pass (map icon in the ribbon, tab labelled "Atlas")
- [x] Toolbar: view switcher (New/Rename/Delete view), Add block, Add file, Add folder, Add meta folder, sort toggle (manual/A–Z), filter box, collapse-all — every button verified live this pass except Add file/Add folder (icons present, same `toolbarButton` wiring as the others already proven to work, not separately clicked)
- [x] Bucket section, open by default, drag-and-drop tree — open-by-default and tree rendering verified live repeatedly; the drag-and-drop gesture itself is a documented environment limitation, see below
- [x] Inbox section, collapsed by default, count badge, flat list, "This view"/"Global" toggle, sorted newest first by default — verified live end-to-end this pass, including a real differential test (see F9 AC below)
- [x] Item rendering: type icon (block/file/folder/meta) + display text; folder-units show chevron for internals; promoted items show "promoted" marker; missing units render greyed + remove action — all verified live, including the missing-ref case (see below)
- [ ] Add file / Add folder: create real file/folder at vault root, rename-in-place UI, appear in inbox — implemented (`addFile`/`addFolder` in `explorer-view.ts`), not separately click-tested this pass; not checking off on code review alone
- [x] Add meta folder: branch node in bucket at current selection or root, named in place, unlimited nesting — verified live (created "Ideas" via the toolbar button, `TextPromptModal` submit); nesting depth >1 not exercised
- [ ] Drag: inbox → bucket places unit — **environment limitation, not a code defect**: synthetic X11 mouse events (`xdotool`) cannot trigger native HTML5 drag-and-drop in this container, confirmed again this pass. The underlying state mutation (`viewsManager.placeUnit`) was instead verified directly via the temporary debug command and via the non-drag "Place in view…" context-menu flow, both of which exercise the identical code path the drop handler calls into.
- [ ] Drag: within bucket reorders/re-nests units and meta folders — same limitation; `moveNode`'s logic (splice + circular-guard) is code-reviewed, not live-exercised
- [ ] Drag: bucket → inbox area unplaces unit — same limitation; `unplaceUnit` is exercised live via the "Remove from view" context-menu action instead, which calls the same method
- [ ] Drag: expanded folder-unit internals → bucket manually promotes + places (F3) — same limitation, not exercised
- [ ] Multi-select (shift/cmd-click); drag moves whole selection — not implemented this pass; not in the code
- [x] Code assertion: DnD handlers never call `vault.rename` / `fileManager.renameFile` — grep-verified across `explorer-view.ts`/`views.ts`: zero occurrences of either call
- [x] Context menu: Open, Open in new tab, Reveal in native explorer, Copy link, Remove from view, Promote (internals), Create interface note (folder-units w/o one), Rename meta folder, Delete meta folder (children move up one level), Place in view ▸ (submenu) — verified live this pass: Open, Reveal in native explorer, Copy link (F5/F3 commands proved the underlying calls earlier), Remove from view (used to clear the missing-ref test), Place in view ▸ (two-step `ViewSuggestModal` → `MetaFolderSuggestModal`, confirmed to place a unit inside "Ideas"). Promote (internals) and folder-unit-without-note not re-clicked this pass (F3 already proved the underlying command). Rename/Delete meta folder not exercised live this pass — code-reviewed only (`renameMetaFolder`/`deleteMetaFolder`, unit-tested logic already proven via `deleteView`'s analogous splice pattern)
- [ ] Active-file tracking: highlighted wherever it appears in current view's bucket; hover tooltip lists every placement across all views as breadcrumbs — implemented (`updateActiveHighlight`, `setPlacementTooltip`), not exercised live this pass
- [x] Keyboard: arrow nav, Enter to open, Space to expand/collapse, Delete to remove (with confirm), F2 to rename meta folder — **corrected per review (A6): this line previously said "not implemented; click-driven only," which was wrong — `handleRowKeydown` is wired to every bucket row (`tabIndex = 0` + a `keydown` listener, both meta and unit nodes) and handles Enter (open), Space (meta collapse/expand), Delete (unplace), and F2 (rename meta folder).** What's genuinely missing, narrower than the original line suggested: arrow-key navigation *between* rows (confirmed via grep — no `ArrowUp`/`ArrowDown` handling anywhere) and inbox rows have no keyboard handling at all (`tabIndex = 0` present, no `keydown` listener). Also worth noting honestly: Delete unplaces immediately with no confirmation step. **Confirmed deliberate, not a gap (A8/A9)**: unplacing isn't destructive under this model — the unit just returns to the inbox, fully recoverable — unlike "Delete view" and "Delete meta folder," which do confirm; the distinguishing factor is blast radius (one row vs. however many placements/children a view or meta folder holds), not destructiveness — neither of those is destructive either, since what they affect also survives. See `docs/decisions.md` for the full reasoning.
- [x] AC: fresh vault, no views → one "Default" view, empty bucket, every unit in inbox — verified live twice: once from `loadFromData` on first run (earlier PR), and again this pass by deleting the last remaining view and confirming a fresh empty "Default" appears with all 75 units back in the inbox
- [x] AC: drag `Bets` from inbox into meta folder "Career" places it; `Bets/` path on disk unchanged (verify with `ls`) — the drag gesture is untestable here (see above), but the identical placement mechanic was verified via the "Place in view…" flow placing `opencode.jsonc` inside a meta folder ("Ideas"), and `ls`/`git status` confirmed disk was untouched throughout
- [x] AC: second view "Weekly", place `Bets` there too → in both buckets; absent from global inbox; absent from each view's own inbox — **verified live end-to-end**: placed `Bets` in both "Default" and "Weekly" buckets, confirmed via `data.json` it holds two independent `ViewNode`s; with "Weekly" active, "This view" inbox (74) excluded `Bets` and a second unit ("Content", placed only in "Default") still appeared; switching to "Global" mode dropped the count to 73, correctly excluding both placed units regardless of which view is active
- [ ] AC: remove `Bets` from "Weekly" only → returns to Weekly's inbox, stays in "Career" in first view, absent from global inbox — not exercised this pass (views were deleted before reaching this specific case); `unplaceUnit`'s per-view scoping is exercised by the "Remove from view" action used elsewhere, just not against this exact multi-view scenario
- [ ] AC: delete meta folder "Career" → children move to bucket root, nothing on disk changes — not exercised live this pass; `deleteMetaFolder`'s splice-in-place logic mirrors `deleteView`'s (already proven pattern), not separately clicked
- [x] AC: filter box narrows bucket + inbox by display text, live — verified live (typed into the filter, list narrowed immediately; cleared, list restored)
- [x] AC: renaming a file on disk (native explorer or agent) keeps it placed in every view (F9) — verified live via Obsidian's own in-app rename (command palette "Rename file", which edits the inline H1 title and calls `vault.rename` under the hood): `data.json`'s `ViewNode.ref.path` updated to the new filename, node id and tree position unchanged. See `docs/decisions.md` for the one important caveat this surfaced (external `mv` from the host does *not* reliably fire Obsidian's `rename` event over this Docker bind mount — a real environment limitation, not an Atlas bug, and not what "on disk" renaming means for a real user)
- [x] AC: plugin's explorer is the active sidebar view on launch when setting is on; native explorer reachable as a tab — true throughout this entire pass (Atlas was the active left-sidebar view every time the container came up), and the native file explorer was used directly as a tab (via the ribbon folder icon) to perform the F9 rename tests below
- [ ] Edge case: circular placement — a meta folder cannot be dropped into its own descendant — code-reviewed only (`isSameOrDescendant` guard in `moveNode`), not exercised live (needs drag)
- [ ] Edge case: dropping a unit onto a unit node (not a meta folder) → insert as sibling after it — not exercised live (needs drag). **Real bug found via code review (A6), now fixed**: `handleDrop`'s branch for this case hardcoded `parentId = null`, so dropping onto a unit nested inside a meta folder incorrectly escaped the dropped unit to the bucket root instead of landing as a sibling inside that same meta folder. `indexInParent` already found the right *index*; the fix adds the equivalent `parentIdOf` lookup for the right *parent*. Exactly the kind of bug the drag-untestable-in-container limitation was hiding — none of the non-drag equivalents (`placeUnit`/`unplaceUnit` called directly) exercised this specific branch. Still not live-tested (needs real drag input), but now correct by code — same honest caveat as before, just no longer wrong underneath it.
- [ ] Edge case: vault with zero folders; vault with only excluded folders (explorer rendering, not just index — cross-ref F2) — not exercised this pass

### F9 — Views: storage and integrity (MUST)
- [x] Views stored in plugin's `data.json` (`loadData`/`saveData`); no vault files written for views — verified repeatedly live via direct `data.json` inspection alongside `git status`/`ls` showing disk untouched
- [x] Data model: `UnitRef`, `ViewNode`, `View`, `AtlasData` per spec shape — confirmed live: `data.json` matches the spec shape exactly, including nested meta-folder children and `collapsed`/`inboxMode` fields
- [x] `vault.on('rename')`: rewrite every matching `UnitRef.path` (exact + prefix `oldPath + '/'`) in every view and `manualPromotions` — **verified live for the exact-match case** (renamed a placed file via Obsidian's own rename command; `ViewNode.ref.path` updated, node id/position stable). The prefix-match branch (folder rename cascading to nested refs) was exercised indirectly — renaming the `Bets` folder itself (a folder-unit, not a nested file) round-tripped correctly — but a nested-file-inside-a-renamed-folder case wasn't separately isolated this pass
- [x] `vault.on('delete')`: refs NOT removed automatically; render greyed "missing" + remove action — verified live: an external host-side rename (which this Docker setup's file watcher reports to Obsidian as delete+create rather than a true rename — see decisions.md) left the old ref rendering as a greyed "Granturismo Sale.md (missing)" row with a working "x" remove action, exactly per spec, and did not crash or silently drop the placement
- [ ] Saves debounced (≤500ms) and atomic; crash mid-save must not corrupt views — debounce mechanism observed working correctly across dozens of live actions this pass; crash-mid-save atomicity itself not exercised (would need to kill the process mid-write)
- [x] Every unit ref validated against unit index on load; invalid refs render as missing, never crash — verified live (see missing-ref case above; no crash, no console error, clean recovery via remove action)
- [ ] AC: rename `Blue Passat.md` → `Passat.md` — not this literal file, but the equivalent mechanism (renaming a different placed file via Obsidian's in-app rename) was verified live this pass; not repeated against this exact AC's file
- [ ] AC: move `Bets/` → `Archive/Bets/` — not exercised as a literal move-into-subfolder; a same-level folder rename (`Bets` → `Bets Renamed` → `Bets`) was exercised instead, which is the same `rename` event but doesn't isolate the prefix-rewrite path in `rewriteRefPath` from a real nested-path change
- [ ] AC: delete a placed free block — renders greyed "missing"; remove works; rest of view unaffected — the rendering/remove half is verified (see above, via an equivalent delete-like external change); a real free block specifically wasn't used for this test
- [ ] AC: kill Obsidian during rapid drags, relaunch — not exercised (destructive, and drag itself is untestable here)
- [ ] Edge case: a free block manually renamed to a real title → now a root file; refs update; still displayed by title (cross-ref F2/F4) — not exercised this pass
- [ ] Edge case: a free block moved out of the pool by the user → becomes a normal file; refs update — not exercised this pass
- [x] Edge case: view names must be unique; renaming to an existing name is refused inline — verified live: `Atlas: New view` named "Weekly" while a "Weekly" view already existed → `Notice: "Atlas: a view named "Weekly" already exists."`, no duplicate created
- [x] Edge case: deleting the last view recreates "Default" — verified live: deleted "Weekly" (units moved to global inbox, confirmed via inbox count), then deleted the remaining "Default" itself → a fresh, empty "Default" view was created automatically and became active, `data.json` confirmed a brand-new view id with an empty `root`

### F10 — Commands and hotkeys (MUST)
- [x] `Atlas: Add block` — verified live in F4
- [x] `Atlas: Open explorer` — used constantly throughout this pass to reopen/refocus the view
- [x] `Atlas: Switch view…` (fuzzy modal) — verified live repeatedly (switched between "Default"/"Weekly" via the modal + arrow keys + Enter)
- [x] `Atlas: Place active file in view…` (fuzzy modal: view, then meta folder) — verified live: placed the active file ("Granturismo Sale (Renamed via Obsidian)") into "Weekly"'s bucket root via this exact command
- [ ] `Atlas: Reveal active file in Atlas` — implemented, not clicked live this pass
- [x] `Atlas: New view` — verified live, including the duplicate-name rejection path
- [x] `Atlas: Rebuild index` — verified live multiple times (used to confirm the unit count after every disk-level change this pass — 75 units throughout, exactly matching the pre-session baseline)

---

## PR 5 — F11 Performance, F12 Mobile, F13 Docs

### F11 — Performance and scale (MUST)
- [x] Responsive at 5,000 files + 2,000 free blocks — verified live: scripted 5,050 root-file units + 2,000 free blocks (7,075 total, up from a 75-unit baseline) into the fixture vault, confirmed via console log `[Atlas] full index rebuild in 18.0ms (7075 units)`. Explorer opened, filtered, and scrolled the inbox with no visible lag at that scale. Found and fixed two real perf bugs along the way (not just confirmed the happy path): `resolveRef` was doing an O(n) `.find()` per row, making a full inbox render O(n²) — replaced with an O(1) map (`unitsByRefKey`) rebuilt once per render; and free-block display text was re-reading each block's file from disk on every render pass instead of reusing the already-current `FreeBlockTextCache` built for F7. See `docs/decisions.md` for both.
- [x] Virtualised long lists (inbox can be thousands of rows) — implemented: the inbox renders inside a bounded, independently-scrollable `.atlas-inbox-viewport` with a fixed-row-height windowed draw (only visible rows + overscan are ever in the DOM, redrawn on scroll via `requestAnimationFrame`), verified live scrolling through all 7,075 rows with correct content at every position, no dropped frames observed. Falls back to full (non-virtualized) rendering only while a folder-unit's internals are expanded, since that needs variable-height document flow — a deliberate, named scope boundary, see `docs/decisions.md`.
- [x] Index rebuild + incremental update timings logged at debug level — already existed from F2, re-confirmed still correct at the new scale via the console (`[Atlas] full index rebuild in 18.0ms (7075 units)`, `[Atlas] promotions recomputed in ~5ms (1636 links scanned)`)
- [x] Scale test: script 5,000 files + 2,000 pool blocks into a scratch vault; measure F11 timings — done directly in the fixture vault rather than a separate scratch vault (simpler, and this vault is itself a disposable Atlas-testing fixture per `docs/decisions.md`'s standing note); generated via a one-off Python script, measured, then fully deleted afterward and confirmed via `git status` and a rebuilt index (back to the exact 75-unit baseline, byte-for-byte the same folder-unit/root-file/promoted-file breakdown) that nothing was left behind
- [x] **Real bug found during scale testing, unrelated to performance but worth fixing regardless**: the filter box lost keyboard focus after every single keystroke (only the first typed character ever registered), at *any* scale, not just the large one — `render()` tears down and rebuilds the entire view (including the filter `<input>` itself) on every keystroke, so focus fell off the removed element before the second keystroke landed. Fixed by capturing focus + caret position before the rebuild and restoring them on the newly-created input. Verified live: typing a 14-character filter string now lands correctly and narrows the (virtualized) inbox as expected.
- [x] **Environment finding, not an Atlas bug, worth recording for future scale testing here**: creating thousands of files directly on the host filesystem while the container's Obsidian instance is running does not reliably reach Obsidian's vault index via this Docker bind mount's file-watcher — `Atlas: Rebuild index` repeatedly under-counted (175 → 286 → 1253 → 3120 → 4625, then plateaued short of the true 7,075) even after generation had long finished on disk. A full `Reload app without saving` (forcing Obsidian's own initial full vault scan, the same code path a real launch uses) picked up every file correctly on the first try. Atlas's index is only ever as complete as what `app.vault.getFiles()` reports, so this is squarely an Obsidian/container file-watching limitation, not something Atlas's own `create`/`delete` event handling could compensate for. Recorded here (and in `docs/decisions.md`) so a future large-scale test in this container isn't mistaken for an Atlas indexing bug.

### F12 — Mobile (SHOULD)
- [ ] Explorer view renders and navigates on mobile — not literally tested on a mobile device or emulator (none available in this container); see the reasoning-based review below for what *was* checked
- [x] Drag-and-drop not required on mobile; "Place in view ▸" context menu is the mobile path — confirmed by construction: every interactive row uses a `contextmenu` DOM event listener (not a custom right-click-only handler), which Obsidian's mobile webview translates from a long-press automatically, the same mechanism every other context-menu-driven Obsidian plugin relies on for mobile. The "Place in view…" flow (two `FuzzySuggestModal`s) needs no pointer precision beyond a tap, so it's mobile-viable as designed, not just in theory
- [x] `isDesktopOnly: false` in manifest — already set (confirmed in `manifest.json`)
- [x] **Reasoning-based review in place of on-device testing (named explicitly, not silently assumed)**: grepped the entire `src/` tree for Node/Electron-only APIs (`require(`, `process.`, `child_process`, raw `fs.`) — none found. `revealInNativeExplorer` (the "Reveal in native explorer" context-menu action) is confusingly named but actually targets Obsidian's own core `file-explorer` view (`revealInFolder`), not the OS file manager — that core view exists on mobile too, so this isn't a desktop-only call despite the label. Checked `.atlas-row-action` (the inbox "remove" button) isn't hidden behind `:hover` with no other reveal mechanism — it's always visible/tappable, not a hover-only affordance that touch users couldn't reach. None of this substitutes for actually opening the plugin in Obsidian Mobile, which is the one honest gap here.

### F13 — Docs (MUST)
- [x] README: the model (Part 1 in plain words), setup, settings, commands, screenshots — full rewrite of `README.md`: the hand-off doc's Part 1 model section adapted into plain-language prose (three kinds of unit, capture-and-promote, free blocks, folder-units, views/bucket/inbox), settings table matching `settings.ts` exactly, commands table matching `f10-commands.ts`, and two real screenshots (`docs/images/explorer.png`, `docs/images/settings.png`) captured live in the container this session, not mocked up
- [x] `docs/` set up for GitHub Pages, matching Dan's other plugins — added `docs/index.md` (Jekyll front matter, links back to the README and decisions.md) and `docs/_config.yml` (title/description/`jekyll-theme-minimal`, the standard zero-extra-tooling GitHub Pages setup). **Honest caveat:** had no way to inspect Dan's other plugin repos from this session to match a specific existing template, so used GitHub Pages' own default convention instead of guessing at a match. Actually turning Pages on for this repo (Settings → Pages on GitHub) is a repository-settings/publishing action and stays with Dan per the standing escalation boundary — this PR only prepares the content.
- [x] `docs/decisions.md` current with every judgement call, alternative rejected, and why — kept current throughout every PR in this build, including this one

---

## PR 6 — F8 follow-up: Dan's live drag-and-drop pass

All five planned PRs were merged and the container could never exercise real drag-and-drop (documented limitation throughout). This is Dan's own first hands-on pass with it, and the resulting fixes/additions.

- [x] **Real bug: dropping onto the bucket root often silently failed.** `makeDropZone`'s `bucket-root` registration was on `.atlas-node-list` alone, whose height hugs its content in normal block flow — once a few rows existed there was almost no empty area left to actually hit, so a drop landing just past the last row missed every registered target (`listEl`'s own bounding box, and every row's, both narrower than it). Fixed by registering the bucket-root drop zone on the whole section container instead (any specific row still wins first via its own handler's `stopPropagation`), plus 16px of trailing padding on the list so there's always some visually obvious empty space to aim for. Not independently live-tested by me — same drag limitation as always — Dan's own report is what surfaced this and what will confirm the fix.
- [x] **Real bug: meta-folder icons didn't line up with file/folder icons at the same depth.** Traced exactly: a meta row's icon sits `.atlas-chevron`'s width (14px) + `.atlas-row`'s gap (6px) = 20px past the row's own padding-left; a plain unit row (no chevron) only added 16px of compensating padding, 4px short. Fixed by correcting the constant to 20 (`UNIT_ROW_CHEVRON_OFFSET`). Verified live via zoomed screenshot — icons now align exactly.
- [x] **New: fold/unfold reveal animation for meta folders**, matching Obsidian's native file-tree feel. Implemented with the `grid-template-rows: 1fr → 0fr` CSS technique (the standard way to animate to/from an implicit `auto` height without JS-measuring `scrollHeight`) on a new always-rendered `.atlas-meta-children` wrapper per meta folder, toggled instantly on chevron click; the state-persisting call (which triggers this view's usual full teardown-and-rebuild `render()`) is deliberately delayed by the transition's own duration so the rebuild doesn't snap the animation short mid-flight. Verified live that toggling produces no console errors and the correct collapsed/expanded end-states render; **could not verify the animation is actually visually smooth** — that requires watching real motion, which static screenshots can't capture — Dan's own eyes are the only real check here. **Real bug caught in review (A11), fixed and live-verified**: the click handler read the data model's `node.collapsed` directly, which only updates after the delayed persist call — a second click inside that ~160ms window read the same stale value and re-applied the same direction instead of toggling back, visibly getting stuck. Fixed with a local optimistic state variable + cancel-and-reschedule on the pending persist timeout. Verified live via zoomed before/after screenshots: a rapid two-click burst now correctly returns to the starting state; a single click still toggles normally either direction.
- [x] **New feature (Dan's explicit request, confirmed via clarifying questions before implementing since it's disk-mutating): "add to module."** Dropping a file or block directly onto a folder-unit row now offers to physically file it into that folder on disk — the one deliberate exception to Atlas never otherwise touching a module's internal organization, gated by a confirm dialog (`ConfirmModal`) that's toggleable in a new setting, default on. Confirmed semantics: the move never force-promotes the file — whether it stays visible/addressable in Atlas afterward is decided entirely by the *existing* link-graph promotion recompute (does it already have a real backlink from outside the module?), which is what naturally happens once Obsidian's own metadataCache resettles after the move. If it doesn't end up promoted, any placement it held is cleaned up rather than left as a "missing" ghost — **corrected per review (A11) to clean up across every view that held it**, not just the view the drag originated in (the first version only unplaced from the one originating view, leaving stale ghosts elsewhere; the demotion is a vault-wide fact, matching how `onVaultRename`'s own ref-rewriting already treats path changes as cross-view). Scoped to file/block payloads only — dropping one folder-unit onto another falls back to the ordinary sibling-insert behavior, out of scope for what was asked. **Not live-tested** — needs real drag input plus a real backlink scenario to exercise both branches (promoted vs. not), squarely in the same untestable-by-me category as the rest of drag-and-drop.

---

## PR 9 — Modules/Folders terminology, toolbar redesign, module-contents modal, filter UX

From Dan's second live-testing pass, after PR 8 merged the first round of drag-and-drop polish. Built in a dedicated worktree + container (`desktop-atlas-modules`, branch `modules-toolbar-and-filter-ux`) rather than the shared one, per Dan's explicit request, so this doesn't disturb his own vault mid-build.

### Terminology (foundational — touches every issue below)
- [x] Every **user-facing** string for a physical folder-unit says **"Module"** (buttons, tooltips, confirm/prompt dialogs, context menu items, settings descriptions, README) — confirmed with Dan directly (not guessed): "Add Folder" (physical) → "Add Module" — verified live: toolbar icon tooltip reads "Add module"
- [x] Every **user-facing** string for what was "meta folder" says plain **"Folder"** (the "meta" qualifier is dropped because the word is now free — "Add meta folder" → "Add Folder", "Rename meta folder" → "Rename folder", "Delete meta folder" → "Delete folder", etc.) — verified live: toolbar icon tooltip reads "Add folder"
- [x] **Scope decision, logged not silently assumed:** internal code identifiers (the `ViewNode.type: "meta"` discriminant, function names like `addMetaFolder`/`renameMetaFolder`, CSS classes like `atlas-meta-children`) stay as-is — renaming those too is a much larger, purely-cosmetic mechanical change across the whole codebase with real risk of introducing bugs for zero user-visible benefit. Code says "meta"/"folder-unit" internally, UI says "Folder"/"Module" externally — documented explicitly in `docs/decisions.md` so it doesn't read as an inconsistency later.
- [x] Historical `TASKS.md`/`docs/decisions.md` entries from PRs 1–8 are **not** rewritten to match new terminology — they're a log of what was true at the time, not living docs

### Issue 1 — Fold/unfold animation extended beyond meta folders
- [x] Bucket section header (collapse/expand the whole bucket) animates the same way meta folders do (PR 8's `grid-template-rows` technique) — same `renderSectionHeader`/`.atlas-meta-children` code path exercised live via the Inbox header below; Bucket was empty in the test vault's Default view so its own visible collapse had nothing to animate, but it's the identical code path
- [x] Inbox section header (collapse/expand the whole inbox) animates the same way — verified live in `desktop-atlas-modules`: clicking the Inbox chevron collapsed/re-expanded its full 76-row list
- [ ] Folders (formerly "meta folders") keep the PR 8 animation, now consistent with the two above — not re-verified live this pass (no Folder existed in the test view's bucket to expand/collapse); code path unchanged from PR 8
- [x] Modules have no inline fold/unfold at all anymore (superseded by the Module Contents modal, issue 2) — nothing to animate inline; not a gap — verified live: clicking a module's icon opens the modal, never expands inline

### Issue 2 — Module Contents modal replaces inline folder expansion in the inbox
- [x] Inbox no longer inline-expands a module's internals on click (removes `addExpandChevron`'s inbox usage) — the bucket already never had this, so both surfaces are now consistent: modules never expand inline anywhere — verified live
- [x] New `ModuleContentsModal`: shows the module's name as title, a read-only recursive tree of its physical children (reusing the existing `renderInternals` tree-building, relocated into the modal), each row click-to-open (closes modal), right-click → "Reveal in native explorer" (same as today) — verified live against the real "Bets" module (nested `.app` bundle and subfolders rendered correctly); right-click menu confirmed
- [ ] Clicking a module's **text/label** still opens its interface note directly (unchanged behavior) — not re-verified live this pass; code path unchanged from before this PR
- [x] Clicking a module's **icon** opens the Module Contents modal instead of opening anything — verified live
- [x] Module icon default state is a **closed** folder (was open) — signals "click to look inside," not "already open" — verified live
- [x] Hovering the icon animates closed→open folder icon + shows a tooltip reading "View module contents" — verified live
- [ ] Existing drop-directly-on-a-module-row confirm flow (PR 8) is unchanged for a plain drop — not confirmed this pass: every drag attempted via browser automation ran long enough to trigger the new dwell timer instead of a fast plain drop; needs a hands-on mouse check
- [x] **New, higher-risk (see `docs/decisions.md` for the explicit risk call with Dan):** dragging a file/block onto a module (text or icon) and holding without dropping (dwell timer, no `dragleave`/`drop` first) opens the Module Contents modal *while the drag is still in progress*; the modal's own rows (module root + each nested subfolder shown) become live drop targets for that same drag, letting the file land at any specific nested location in the module's on-disk layout — and skips the confirm dialog entirely, since the deliberate hold-to-open gesture already is the confirmation — **verified live**: dragging a file onto the "Bets" module opened the Contents modal mid-drag with a "Bets (module root)" drop row; completing a drop *inside* the now-open modal wasn't exercisable via the browser-automation tooling used (no way to hold a mouse button across a modal-open event), so that specific sub-step still wants a hands-on check
- [ ] Edge case: releasing the drag (dropping) *before* the dwell timer completes — falls back to the existing direct-drop-with-confirm behavior, dwell timer never fires — not exercisable via the automation tooling used (couldn't produce a sub-650ms drop); needs a hands-on mouse check
- [ ] Edge case: dragging out of the row before the dwell timer completes (`dragleave`) cancels the pending modal-open — not exercisable via the automation tooling used; needs a hands-on mouse check
- [x] Edge case: closing the modal (Escape, or clicking outside) mid-drag — the drag payload is cleared the same way any other cancelled drop is — verified live: closed a dwell-opened modal with Escape, confirmed the source file was left untouched and unplaced afterward

### Issue 3 — Inbox height
- [x] Inbox section (and its virtualized viewport) extends to fill the remaining vertical space in the explorer panel instead of being cut off partway down — verified live: 76-row inbox list now runs to the bottom of the panel instead of stopping ~halfway

### Issues 4 & 5 — Toolbar redesign: one line, three sections
- [x] **Section 1 (view identity):** view-name button restyled to match `.atlas-section-header`'s font (same family/weight as "Bucket"/"Inbox"), slightly larger, padding trimmed to fit a single dense toolbar row. Left-click still switches/selects the view (opens the existing view-picker). Right-click surfaces New/Rename/Delete view (moved out of always-visible buttons, was three separate toolbar icons) — verified live, including the "Click to switch views, right-click for more" tooltip
- [x] Divider
- [x] **Section 2 (create):** exactly four buttons — Add Block, Add File, Add Module, Add Folder (no separate "Add meta folder" icon anymore, folded into "Add Folder") — verified live via tooltips
- [x] Divider
- [x] **Section 3 (view controls):** Sort toggle, Collapse-all, and a new filter-reveal toggle button that shows/hides the filter text input with a reveal/hide animation (filter box is no longer permanently visible taking up row space) — verified live
- [x] Whole toolbar fits one line (no wrapping) at a normal sidebar width — verify live, not just reasoned about, since this is exactly the kind of thing that looks fine in code and wraps awkwardly in the real panel — verified live at the container's native 1024×768-derived sidebar width: all nine toolbar elements sit on one row

### Issue 6 — Filter behavior with Folders vs. Modules
- [ ] A Folder (meta folder) containing a filter match is auto-revealed (expanded) while filtering is active, even if the user had it manually collapsed — a match must never be hidden by a stale collapsed state — not re-verified live this pass (no Folder existed in the test view's bucket); code reviewed (`subtreeHasMatch`/`effectiveCollapsed`)
- [ ] Clearing the filter restores each Folder's fold state to whatever it was *before* the filter started overriding it (not "everything stays expanded because filtering touched it") — not re-verified live this pass for the Folder case specifically; filter-clear restoring the full unfiltered *Inbox* list was verified live
- [x] Modules have no inline reveal (per issue 2) — filtering does not expand anything inline for a module; instead, opening a module's Contents modal while a filter is active shows/highlights which of its internals match that same filter text — verified live: filtering "bets" then opening the "Bets" module highlighted every internally-matching row
- [ ] Edge case: filter text changes *while* a Module Contents modal is already open — the modal's own match-highlighting updates live, not just on next open — not exercised this pass (modal was opened after the filter was already set, not edited while open); code reviewed (`filterInput`'s `input` handler calls `openModuleModal?.setFilterText`)

---

## PR 10 — Module Contents modal: manual fold/unfold + persisted state

From Dan's third live-testing pass. The Module Contents modal (PR 9) currently has no fold/unfold at all — it's a single flat always-expanded tree. Grilled with Dan directly (see chat log around 2026-09-18); the one open question (in-memory vs. persisted fold state) was settled in favor of persistence.

- [ ] Modal opens **fully collapsed** the first time a given module has ever been opened (no saved state yet)
- [ ] Every subfolder row inside the modal gets its own chevron; clicking toggles fold/unfold for that subfolder only, reusing the `grid-template-rows` animation technique already established for meta-folder/bucket collapse
- [ ] Fold state is **persisted to the plugin's saved data** (survives an Obsidian restart), keyed per-module (e.g. by module path + each subfolder's relative path), not just in-memory
- [ ] Reopening the modal for a module that *has* been opened before restores whatever fold state was left when it was last closed — this is the "retain state" half; it does not contradict the "fully collapsed" default above, which only applies the first time
- [ ] Edge case: a subfolder present in the saved fold state no longer exists on disk (renamed/deleted since last visit) — stale entries are simply unused, no active cleanup needed
- [ ] Edge case: deeply nested subfolders (3+ levels) each retain independent fold state

## PR 11 — Fix bucket/inbox section + filter-reveal animations

PR 9 added fold/unfold for the bucket section, the inbox section, and the filter-reveal toggle, but none of them actually animate live — Dan confirmed this testing in the container. Diagnosed (not yet verified) root cause: `renderSectionHeader`'s collapse handler and the filter-toggle's `render()` call both trigger an **immediate full re-render**, so the DOM node carrying the CSS transition is destroyed and rebuilt already in its new state within the same tick — the browser never gets a paint frame showing the "before" state to animate from. Meta-folder collapse (PR 8) avoids this via `META_COLLAPSE_TRANSITION_MS`: toggle the class on the *existing* node first, defer the state-persisting full re-render until after the transition has had time to play.

- [ ] Bucket section header collapse/expand animates smoothly in the container (not just toggles instantly)
- [ ] Inbox section header collapse/expand animates smoothly in the container
- [ ] Filter-reveal toggle (show/hide the filter input) animates smoothly in the container
- [ ] Root cause confirmed and fixed using the same pre-toggle-then-delayed-rerender pattern meta-folder collapse already uses (or another fix, if the diagnosis turns out wrong once in the code)
- [ ] Verified live in `desktop-atlas-modules` (or a fresh equivalent) — motion actually observed, not just before/after state screenshots, since that's exactly what shipped broken last time despite passing state-based checks

## PR 12 — Meta-folders via drop-anywhere-except-icon

New feature: any block/file/module/folder can become the organizational parent of any other bucket item, entirely independent of disk location — completing meta-organization alongside the existing on-disk-independent bucket/view model. Grilled with Dan directly; the original "drop on the right side of the row" idea was simplified during grilling to an icon/non-icon split.

- [ ] **Data model:** every `ViewNode` type (block/file/module/folder) gains optional `children`/`collapsed` fields, unifying with how Folder nodes already work — a promoted node keeps its own identity/content (clicking it still opens the file/interface note, etc.), it just additionally gains a chevron + children area. This is what distinguishes it from a plain Folder, which stays purely organizational with no content of its own.
- [ ] **Modules:** the icon is reserved exclusively for the existing real disk-move interactions — the plain drop-confirm (PR 8) *and* the dwell-timer-opens-modal flow (PR 9, moved here from whole-row per this PR's grilling). Dropping anywhere else on a module's row (label included) creates a meta-nest relationship instead — organizational only, no disk move.
- [ ] **Files/blocks/folders:** no disk-move capability exists for these in the bucket, so the entire row is eligible as a meta-nest drop target — no icon carve-out needed.
- [ ] A node shows no chevron until it actually gains its first child — no pre-emptive chevrons on every row
- [ ] Un-nesting: dragging a nested child out to the bucket root, or onto another row's non-icon zone, re-parents/un-nests it via the existing reorder mechanics — no new UI needed
- [ ] Fold/unfold for these new chevrons reuses the existing `grid-template-rows` animation technique
- [ ] Edge case: nesting a module under a file (and every other cross-type combination)
- [ ] Edge case: deeply nested chains (3+ levels)
- [ ] Edge case: dragging a node onto itself, or onto one of its own descendants — must be prevented (cycle prevention)
- [ ] Edge case: a module's icon-only disk-move zone coexists correctly with its now-narrower meta-nest zone — verify dropping on the label specifically nests rather than files-into-module

## PR 13 — Duplicate (Meta)

New feature: place the same unit in multiple spots in a view's tree without duplicating it on disk. Grilled with Dan directly — his first proposed naming scheme (numbered suffixes) turned out to have no real answer to "how do two sibling nodes pointing at the same disk path get different names without a fake 'meta name'", so the scheme was dropped entirely in favor of allowing duplicate labels outright.

- [ ] Right-click "Duplicate (Meta)" appears on every bucket item (any block/file/module/folder)
- [ ] Clicking it creates a new sibling `ViewNode` referencing the **exact same underlying unit**, inserted adjacent to the original
- [ ] **No naming/numbering logic** — the duplicate displays with the identical label as the original; two (or more) siblings with the same visible name is expected and fine
- [ ] If the duplicated item has children (via PR 12's meta-nesting), the **entire child subtree is recursively cloned** too — new node IDs throughout, each still referencing the same underlying units as its original counterpart — and placed under the new duplicate
- [ ] The clone is fully independent post-creation: further meta-nesting changes under one copy do not affect the other
- [ ] Technical check (not a user-facing AC): grep the codebase for any place that assumes one-`ViewNode`-per-unit-per-view uniqueness (e.g. a `Map`/`Set` keyed only by path) that would break once two sibling nodes can reference the same unit — fix if found
- [ ] Edge case: duplicating an item with no children (simple clone, no subtree to walk)
- [ ] Edge case: duplicating an item that is itself already a duplicate — clones again the same way, no special-casing
- [ ] Edge case: duplicating a deeply-nested item — the clone is reinserted as a sibling at the **same nesting depth**, not promoted to root

## PR 14 — Status data model + Settings UI restructure

First slice of the File Folder Status Sets port (Dan's item 5) — foundation only, no tree rendering or assignment UI yet. Porting ideas from `danrfletcher/obsidian-file-folder-status-icons` (inspected live via a `desktop-cancun` container + its real `data.json`) into Atlas natively, not as a dependency or standalone plugin. Should be self-contained and testable via the Settings panel alone, per Dan's own per-PR container-testing requirement.

- [ ] Settings tab restructured with switchable tabs: **"Basic"** (everything currently in Atlas settings) and **"Status"** (new)
- [ ] **Status Sets** section under "Status": create/edit/delete named status sets, each a list of statuses with `label`, `color`, `isCompleted`, `isCancelled`, and a `defaultStatusId` for the set — ported 1:1 from the reference plugin's model (`statusSets` shape confirmed live from its `data.json`)
- [ ] **Colour palette** section: a shared/global palette array used by status-color pickers, ported across
- [ ] **Design** section with the **glow** toggle, ported across (`glowEnabled` in the reference plugin)
- [ ] The reference plugin's "Folder assignments" settings section does **not** come across — Atlas assigns statuses per-item via right-click instead (PR 15/16), not via a settings-panel folder picker
- [ ] No sort/group-by-status anywhere in this port (grilled and explicitly dropped — Atlas's existing manual/A-Z sort toggle is a different axis and stays as-is; may revisit as a future PR)

## PR 15 — Visual status rendering + minimal assignment

Second slice — intentionally reordered ahead of the full assignment modal (grilled: rendering first, so this PR is self-contained/testable on its own rather than shipping an assignment toggle with no visible effect).

- [ ] When a bucket/inbox row has a status assigned, its normal icon is replaced by a **traffic-light-style status dot**, colored per the assigned status
- [ ] **Glow** effect applied per the Status settings' glow toggle
- [ ] **"Retain Icons"** setting (Status → Design section): when on, the item's normal type icon (block/file/module/folder) shrinks down and sits inside the status dot instead of disappearing; when off, the icon disappears entirely while a status is active
- [ ] Minimal assignment mechanism so this PR has real data to render against: right-click → **"Statuses"** opens a small modal with just a master on/off toggle and a status-set picker — no inherit/hide/apply-to/truncate fields yet, those land in PR 16
- [ ] Edge case: an item with no status assigned keeps its normal icon, unaffected

## PR 16 — Full "Statuses" modal + root-level assignment

Third slice — the remaining fields from the reference plugin's per-folder config, now applied per-item via the right-click modal from PR 15, plus root-level (whole-view) assignment.

- [ ] All settings in the "Statuses" modal are greyed out until the master toggle (from PR 15) is turned on
- [ ] **Inherit to subfolders** toggle — defaults to **off** (the reference plugin defaults this to on; Dan explicitly wants the opposite default for Atlas) — determines whether the assigned status set applies only to direct children or all the way down the tree
- [ ] **Hide completed** / **Hide cancelled** toggles — items whose assigned status has `isCompleted`/`isCancelled` set are hidden from the tree when the corresponding toggle is on
- [ ] **"Apply statuses to"** — checkboxes/options for block, file, module, folder, controlling which unit types under this item actually receive the status treatment
- [ ] **Truncate statuses** — per status in the set, toggle whether that status's matching items collapse down to a single placeholder row instead of listing each individually (ported from the reference plugin's `truncatedStatuses` shape: `{ [statusId]: { enabled, label } }`)
- [ ] If an item has no children, it gets **no** "Statuses" right-click option at all (nothing to apply a status *to* underneath it)
- [ ] Right-click on the **view-name** selector (e.g. "Default") surfaces the same "Statuses" option, applying to the root level of that view
- [ ] Edge case: turning the master toggle off doesn't discard the rest of the modal's configured values, just deactivates them (so turning it back on restores the prior setup)

## PR 17 — Inheritance + move semantics

Fourth slice — how statuses behave as the bucket tree is reorganized (drag/drop, meta-nesting from PR 12, duplication from PR 13).

- [ ] Moving an item that has its own status assigned: the status **moves with it**, unaffected by the move, regardless of where it lands
- [ ] Moving an item that only has a status because it **inherits** one from a parent: if the new parent also has statuses turned on (with inheritance covering this item), it keeps working under the new parent; if the new parent does **not** have statuses turned on, the item **loses its status display** (it was never its own assignment, just inherited)
- [ ] Edge case: an item duplicated via PR 13 — does the duplicate inherit/keep the same status as the original at time of duplication? (Not yet grilled — resolve during this PR's build, default assumption: yes, since it's a full clone including whatever it would inherit at its new position, same as any other item landing under an inheriting parent)
- [ ] Edge case: meta-nesting (PR 12) a plain item under a status-inheriting parent — it should pick up the inherited status the same way a physically-nested item would

## PR 18 — Truncated-status collapsing + hide filtering in the live tree

Fifth slice — wiring PR 16's truncate/hide-completed/hide-cancelled settings into the actual live bucket/inbox rendering (PR 16 only captured the settings; this PR makes them do something).

- [ ] Items whose status is truncated (per PR 16's per-status toggle) collapse down to a single placeholder row in the live tree instead of listing each individually
- [ ] Items whose status has `isCompleted` set are hidden from the tree when the containing item's "Hide completed" toggle is on
- [ ] Items whose status has `isCancelled` set are hidden from the tree when the containing item's "Hide cancelled" toggle is on
- [ ] Edge case: an item that's both truncated *and* would be hidden by hide-completed/cancelled — hide wins, it doesn't show up even as part of a truncated placeholder count
- [ ] Edge case: truncate/hide interacting with the filter box (PR 9) — a filtered-in match under a truncated or hidden status should still surface somehow rather than silently vanishing (exact behavior not yet grilled — flag for Dan during this PR's build if it's not obvious once in the code)

---

## Cross-cutting (verify at the end, not tied to one PR)

- [x] Nothing in the plugin's DnD/promotion/placement code path ever calls `vault.rename` or `fileManager.renameFile` for the bucket/view mechanics (Part 7 — grep-verify across the whole codebase, not just F8) — grepped the entire `src/` tree for both calls: zero matches other than the code comment in `explorer-view.ts` documenting the constraint
- [x] Promotion state is never cached in `data.json` — only `manualPromotions` are stored; everything else is computed live (Part 7) — confirmed via `AtlasData`'s shape in `main.ts` (`settings`, `manualPromotions`, `views`, `activeViewId` — no cached unit/promotion list) and live inspection of the real `data.json` throughout this session
- [x] No disk-shape leaks in the UI: no ID filenames shown, no `Bets/Bets.md` breadcrumbs unless internals are explicitly expanded (Part 7) — verified live throughout (free blocks always show derived text, never their ID filename) and by grep: every `.path` reference in the codebase is internal ref/unit construction, never assigned directly to row display text

---

## Test plan (Part 5, run after each PR's features land, full pass before the final PR)

- [ ] Load plugin in the fixture vault; confirm explorer opens as active sidebar view; screenshot
- [ ] Count units in global inbox; sanity-check against `ls` of root files + top-level folders (should match, zero free blocks/promoted items initially)
- [ ] Run every AC above in order F1 → F13, screenshotting each
- [ ] Run every edge case above
- [ ] Scale test per F11
- [ ] Rename/move/delete tests for F9 done from **outside** Obsidian (shell `mv`/`rm` while Obsidian is open), not just inside
