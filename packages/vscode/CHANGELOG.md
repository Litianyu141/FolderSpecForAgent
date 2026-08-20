# Changelog

## 0.6.0

First public release.

- **Annotate** any file or directory with a note, a semantic role, and a constraint severity
- **Declare structure that does not exist yet** — new directory / new file, contract-only:
  nothing is created on disk
- **Rearrange virtually** by dragging; switch to the "Disk Structure" view to compare what
  you declared against what the disk actually holds
- **Rename, remove a declaration, copy / paste a subtree** — all contract-only
- **Copy Path / Copy Relative Path**, available even in read-only states
- **Batch annotation**: `Shift` / `Ctrl` select several nodes and give them one shared note
- **Bilingual (中文 / English)** interface and contract boilerplate — your own text is never
  translated
- **Follows your VS Code theme**; directories take the aggregate git status of their subtree
- **Undo / redo** across every edit, in memory only

The tool writes exactly one file — `.folderspec.md` — and never runs `mv` / `mkdir` / `rm`.
Rearranging the repository is the agent's job.
