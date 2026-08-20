# FolderSpec

Declare your repository's **structural intent** visually and emit a `.folderspec.md` — a file
humans can read and AI agents can follow.

## The problem

You ask an agent to do some work and it scatters new files wherever. You write "test cases
belong under `src/cases`" in `CLAUDE.md`, and it sometimes reads that and sometimes doesn't —
and the sentence is disconnected from the actual directory tree anyway.

FolderSpec lets you point at the **real tree** and say what you mean. Every line in the
resulting contract corresponds to a node that exists, or that you declared should exist.

## The one thing to know: it does not touch your disk

**FolderSpec writes exactly one file — `.folderspec.md` — and never runs `mv` / `mkdir` / `rm`.**

Dragging, "New directory", and "Rename" only change what the contract *says* about where
things belong and what they should be called. Nothing on disk moves. The agent that reads
the contract is what actually rearranges the repository — and it knows far better than this
tool which imports, build configs, and tests a move would drag along.

## Getting started

1. Open the command palette (`Ctrl+Shift+P`) and run **FolderSpec：打开结构契约**
   (the extension's command title is not localized)
2. Left pane: the repository tree. Middle: a preview of the selected file. Right: the annotation editor.
3. Click a node and write an annotation. `Shift` / `Ctrl` select several nodes at once to give
   them one shared annotation.
4. Right-click for **New directory / New file (contract only)**, **Rename (contract only)**,
   **Remove declaration**, **Copy / Paste**, and **Copy Path / Copy Relative Path**.
5. Save, then reference the contract from `CLAUDE.md` or `AGENTS.md` with `@.folderspec.md`.

## What's in the editor

- **Drag** to declare a new location; **Undo / Redo** covers every edit and touches only memory,
  never the disk — it guards against "I dropped that in the wrong place", not against corruption
- **"Disk Structure" vs "My Structure"** — switch to see what the disk actually looks like,
  so you can compare it against what you have declared
- **Bilingual (中文 / English)** — the toggle switches both the interface and the boilerplate
  headings in the contract. **Your own text is never touched**: annotations, group notes, rule
  text, template descriptions, semantic roles, and paths all keep the language you wrote them in
- **Follows your VS Code theme** — colors, fonts, and syntax highlighting all come from the
  active theme
- **Git status colors** — a directory takes the aggregate status of its whole subtree, the same
  way the built-in explorer does
- Only two levels are scanned up front and subdirectories load on expand, so open time is
  roughly independent of repository size

## What the contract looks like

````markdown
## Structure

- `src/` — engine sources
  - `cases/` `[role:test-case]` — one directory per case; never scatter these under examples/
    - `demo/`
- `docs/` — user-facing documentation only
````

The structure section is a nested Markdown list, one node per line. Template and rule sections
are embedded YAML. Full format reference: [repository README](https://github.com/Litianyu141/FolderSpecForAgent#readme).

## Known limitations

- After a reload the tool cannot tell that `src/cases/foo` in the contract and `examples/foo` on
  disk are the same thing — that is the price of being declarative, and it does not affect the
  main use case
- It emits a contract; it does not verify the repository against it (there is no `folderspec validate`)
- Node names cannot contain backticks or newlines — the current format cannot escape them, so the
  tool refuses at annotation time and names the offending path rather than writing a file it
  cannot read back
- File icons are built in and do not follow your file icon theme (VS Code does not expose the
  active icon theme to webviews)

The fuller list lives in the repository README.

## License

Apache-2.0
