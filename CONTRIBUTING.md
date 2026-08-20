# Contributing

[← Back to README](README.md) · [中文](CONTRIBUTING.zh-CN.md)


Requirements: Node ≥ 20 and pnpm.

```bash
pnpm install
pnpm typecheck      # builds core first; the other packages depend on its .d.ts
pnpm -r test
pnpm -r build
```

Four packages:

| Package | Responsibility |
|---|---|
| `@folderspec/core` | Pure logic: parsing, serialization, scanning, git status, merge, and the host-agnostic `Session` |
| `@folderspec/ui` | React SPA; talks to its host only through the `Bridge` abstraction and knows nothing about which host it is |
| `folderspec` | CLI host: HTTP + WebSocket + a chromeless browser window |
| `folderspec-vscode` | VSCode host: `CustomTextEditorProvider` |

**`@folderspec/core` has to be built first** for the other packages to typecheck
(`pnpm typecheck` already does this).

The VSCode end-to-end smoke test runs separately and needs a graphical environment:

```bash
pnpm -C packages/vscode test:e2e
```

### Two invariants

- **Every write to disk is self-checked first**: `serialize → parse` runs as a round trip,
  and the write is aborted if the result cannot be read back. That gate lives in
  `Session.raw()`, so both the CLI, which writes directly, and VSCode, which goes through
  `WorkspaceEdit`, are covered by it.
- **A user's file is never overwritten with an empty contract**: if the contract fails to
  parse, or exists but cannot be read (permissions, another process holding it, …), the
  session goes read-only and shows why, instead of treating the situation as "no file
  here" and starting from scratch.
