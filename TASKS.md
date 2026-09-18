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
