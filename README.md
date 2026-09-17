# Atlas

A replacement file explorer for Obsidian that shows every meaningful unit in your vault — blocks, files, folders — as one flat list, and lets you arrange those units into as many hierarchies as you like, without ever moving anything on disk.

**Status: pre-release, under active development.** Not yet on the community plugin store. See [TASKS.md](TASKS.md) for build progress.

## Why

Folder paths in Obsidian do two jobs at once: they say what a thing *is* (stable) and what status it *has* (changes constantly). Every status change means a move, and every move breaks relative links. Atlas separates the two: the folder hierarchy on disk stays fixed, and you arrange units into any number of named "views" — drawings over the vault, not addresses for it.

Full model write-up: coming in this README once the explorer (F8) ships — see `docs/` for the working design doc in the meantime.

## Installing (development)

This plugin is not yet published. To try it:

```bash
npm install
npm run build   # or `npm run dev` to watch
```

Then enable "Atlas" under Settings → Community plugins in a vault where this folder is `.obsidian/plugins/atlas`.

## Documentation

See `docs/decisions.md` for judgement calls made during the build and why.

## License

MIT — see [LICENSE](LICENSE).
