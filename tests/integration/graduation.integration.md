# Graduation: in-app integration scenarios (IT-1 to IT-12)

**Status: written, not executed by the coder.** The vitest suites (`tests/unit/graduation.test.ts`,
`tests/integration/graduation.test.ts`) cover the same behaviour over the mock `App`. These scenarios
are for the tester, in the desktop container's real Obsidian, through CDP `Runtime.evaluate`.

## Setup

1. Copy `tests/fixtures/graduation-vault/` (everything except `plugin-data.json`) into the container
   vault, fresh for every scenario. Copy `plugin-data.json` to `.obsidian/plugins/atlas/data.json`.
2. Build with `__ATLAS_TEST__` on so `window.__atlasTest` exists. Enable the plugin and reload it.
3. Every snippet below runs against `app.plugins.plugins.atlas` and `window.__atlasTest`.

Harness helpers added in PR-2: `__atlasTest.spyRenameFile()` (returns `{calls, restore}`),
`__atlasTest.graduationState()` (`{pending, ownReverts}`), and the existing `dump()` (views,
manual promotions, saved `data.json`).

Shared helpers:

```js
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const K3XQ = "_pool/20260925143012-k3xq.md", A1B2 = "_pool/20260925150000-a1b2.md";
const f = (p) => app.vault.getAbstractFileByPath(p);
const rename = (p, to) => app.fileManager.renameFile(f(p), to);
const toasts = () => [...document.querySelectorAll(".notice")].map((n) => n.textContent);
const modals = () => [...document.querySelectorAll(".modal-container .modal")];
```

## IT-1 Golden rename (AC-1 to AC-4)

```js
const before = await __atlasTest.dump();
await rename(K3XQ, "_pool/Quarry drone LiDAR.md");
await sleep(2000);
const after = await __atlasTest.dump();
({ moved: !!f("Quarry drone LiDAR.md"), poolGone: f(K3XQ) === null, toasts: toasts(), before, after });
```

Expect: `moved` true, `poolGone` true, `toasts` is exactly `["Moved 'Quarry drone LiDAR' out of the pool"]`.
`u-b1`, `u-b1-dup`, `u-b1-dup2` and the manual promotion hold `Quarry drone LiDAR.md`; `u-b1.explicitStatusId`
is still `doing`; `after.views` deep-equals `before.views` apart from those three paths.

## IT-2 Sequencing under load (EC-14)

Copy `Linker-01..30.md` in first. Log `vault.on("rename" | "modify")` and `metadataCache.on("resolved")`
into an array (unregister in teardown), then run IT-1's rename. Expect the order rename event,
linker modifies, `resolved`, then the graduation rename (`Quarry drone LiDAR.md` appears at the root
last). Every linker reads `[[Quarry drone LiDAR]]` and `app.metadataCache.unresolvedLinks[linker]` is `{}`.

## IT-3 Clash then Create

```js
await rename(A1B2, "_pool/Reading list.md");
await sleep(2000);
const input = document.querySelector(".modal input");
({ modals: modals().length, value: input.value, invalid: input.classList.contains("atlas-name-invalid"),
   message: document.querySelector(".modal .atlas-name-message")?.textContent,
   createDisabled: [...document.querySelectorAll(".modal button")].find((b) => b.textContent === "Create").disabled });
```

Then set `input.value = "Reading list 2"`, dispatch an `input` event, check the `atlas-name-valid` class
and that Create is enabled, click Create, wait 500 ms. Expect `Reading list 2.md` at the root,
`Reading list.md` unchanged (content and mtime), the pool path gone, one toast, no modal left.

## IT-4 Clash then Cancel

As IT-3 with a snapshot of `app.vault.getFiles().map(f => f.path).sort()` and `dump()` taken first.
Click Cancel. Expect `_pool/20260925150000-a1b2.md` back, listing and `dump().data` deep-equal to the
snapshot, no toast, `modals().length === 0`. Repeat dismissing with Escape and with the close X (EC-25).

## IT-5 Non-ID original and chained rename (EC-22, EC-23)

`_pool/Untitled.md` to `Draft`, then at once to `Reading list` (before the 150 ms settle; the pending
record keeps the first path). Wait for the dialog, Cancel. Expect `_pool/Untitled.md`, and
`__atlasTest.spyRenameFile().calls` shows one revert call only. `graduationState()` is
`{pending: 0, ownReverts: []}`. Then rename `_pool/Untitled.md` to `Notes`: it graduates normally.

## IT-6 Never-graduates matrix (EC-1 to EC-12)

For each row, snapshot the listing and `dump().data`, do the action, wait 2 s, assert both equal the
snapshot apart from the action itself:

| Action | Untouched |
| --- | --- |
| `_pool/scan.pdf` to `_pool/scan2.pdf`; `_pool/data.txt` to `_pool/data2.txt`; `_pool/board.canvas` to `_pool/board2.canvas` | stays in the pool |
| `_pool/sub/20260101000000-aaaa.md` to `_pool/sub/Renamed.md` | stays in `_pool/sub` |
| block rename to another ID-shaped name (`_pool/20260925150000-a1b2.md` to `_pool/20260925150000-c3d4.md`) | stays in the pool |
| move a pool block into a folder (`Recipes/...`) | stays where moved |
| rename `Loose.md` to `Loose2.md` (root note) | stays at the root |
| rename a folder in the pool | stays |

## IT-7 Duplicates as one move (EC-31)

```js
const spy = __atlasTest.spyRenameFile();
await rename(K3XQ, "_pool/Quarry drone LiDAR.md");
await sleep(2000);
spy.restore();
spy.calls;
```

Expect exactly two entries: the test's own rename, and one `["_pool/Quarry drone LiDAR.md", "Quarry drone LiDAR.md"]`.
All three view nodes still updated.

## IT-8 Open tab (EC-30)

Open the k3xq block in a leaf, rename it in the pool, type a further line into the editor, wait for
graduation. Expect the same `TFile`, the same leaf count, the tab header now `Quarry drone LiDAR`, and
the editor value equal to the typed content.

## IT-9 Links setting off (EC-33)

`app.vault.setConfig("alwaysUpdateLinks", false)`, then IT-1. Expect the exact "links weren't updated"
notice once (from `noticeIfLinksNotUpdated`) alongside the graduation toast, `Linker.md` unchanged,
Atlas refs rewritten. Restore the setting in teardown.

## IT-10 Pool settings (EC-9)

Write `poolFolder` as `""`, `"/"` and `"."` in `data.json`, reload the plugin, rename pool files.
Expect no graduation and no console errors.

## IT-11 Reload persistence (EC-38)

Reload the plugin after IT-1. `dump().data` and the rendered tree still show `Quarry drone LiDAR.md`.

## IT-12 Sync-delivered move (EC-10)

1. `app.vault.trigger("rename", f("Loose.md"), "_pool/Loose.md")` on a file already at the root:
   nothing happens.
2. `await app.vault.adapter.rename(K3XQ, "Moved by sync.md")`, then wait for Obsidian to report it as a
   finished move: nothing graduates or reverts (it is not a same-folder pool rename).

## Teardown

Unregister the logging listeners, delete the fixture files, restore `alwaysUpdateLinks`, reset
`data.json`, remove any leftover `.modal-container` and `.notice`, and call `spy.restore()`.
