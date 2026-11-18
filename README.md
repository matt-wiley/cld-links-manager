# Linkshelf

A local-first links manager that runs entirely in your browser. There's no account and no server: your links live in `localStorage`.

**Live app:** https://matt-wiley.github.io/cld-links-manager/

## What it does

- **Collections** (e.g. "My App") hold your links, organized under **headings and sub-headings**, nested up to 6 levels (the same as markdown `#` to `######`).
- **Links are stored once, by URL** (UUID, name, optional note). Collections and headings only hold references to those UUIDs, so the same link can sit in several places, and editing it once updates it everywhere.
- **Notes** on every link, searchable along with names and URLs.
- **Drag and drop** links and headings to reorder them, nest headings, or move things between collections (drop on a collection in the sidebar). Hold <kbd>⌥</kbd>/<kbd>Alt</kbd> while dropping to copy instead of move.
- **Undo and redo** for everything (<kbd>⌘Z</kbd> / <kbd>⇧⌘Z</kbd>).
- Changes sync live across open tabs.

## Adding links

| How | What happens |
| --- | --- |
| Paste anywhere (<kbd>⌘V</kbd>) | Adds the URL(s) to the selected heading. Click a heading to select it. |
| Add bar | Type `url` or `url Some name`, then press Enter. |
| Drag in | Drop a link or address-bar icon from another window onto a heading or between links. The link text becomes the name. |
| Bookmarklet | Sidebar → *Bookmarklet*. One click saves the current page with its title, and any selected text becomes the note. |
| <kbd>+</kbd> on a heading | Opens the full form (URL, name, note, location). |

## Import and export

- **JSON:** a full backup you can restore or merge. Links are deduplicated by URL on merge.
- **Markdown:** per collection. `#` headings become headings, and `- [name](url)` items become links, with indented lines as the note. Exports round-trip through import without loss, and any markdown list of links imports.

Back up now and then: clearing your browser's site data erases `localStorage`.

## Development

There's no build step and no dependencies. It's plain ES modules.

```bash
npm start   # serves on http://localhost:8080
npm test    # data-layer unit tests (node --test)
```

- `js/store.js`: the data model and every mutation, pure and DOM-free, so it runs under Node for tests.
- `js/app.js`: rendering, dialogs, drag and drop, paste, and the bookmarklet.
- `.github/workflows/pages.yml`: tests, then deploys to GitHub Pages on every push to `main`.
