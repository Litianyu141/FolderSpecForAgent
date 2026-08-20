# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Environment

Node and pnpm exist **only inside the `folderspec` conda environment** — they are not on the default PATH. Before running any command:

```bash
export PATH="$HOME/miniconda3/envs/folderspec/bin:$PATH"   # node v26 + pnpm 9
```

Skip this and you'll get `pnpm: command not found`.

## Common commands

```bash
pnpm test                                    # full suite: core 143 + ui 70 + cli 21
pnpm build                                   # core(tsc) → ui(vite) → cli(tsc + copy ui output)
pnpm typecheck                               # builds core first, then tsc --noEmit per package

pnpm -C packages/core test                   # single package
pnpm -C packages/core test -- src/merge.test.ts   # single file
pnpm -C packages/core test -- -t "截断"       # filter by test name

pnpm -C packages/ui dev                      # Vite dev server (no host, so Bridge can't connect)
node packages/cli/dist/main.js [directory]   # run the CLI, needs pnpm build first
```

**`@folderspec/core` points to `dist/` via `exports`, not `src`.** As a result:

- `packages/cli`'s tests actually import core at runtime (`server.ts` uses `Session`), so **cli tests fail if core hasn't been built**. Before running tests for the first time after cloning, run `pnpm -C packages/core build` (the `pnpm typecheck` script already does this; `pnpm test` does not).
- `packages/ui` only ever does `import type` from core, so it has no runtime dependency on `dist` — but `tsc` still needs `dist/*.d.ts`.

`core` and `cli`'s tsconfigs exclude `src/**/*.test.ts` from typechecking; `ui`'s does not, so its tests get typechecked too.

## What this project is

A visualization tool: it reads the current repo's directory tree, lets a person annotate directories/files and declare structural intent, and produces `.folderspec.md` — a file meant to be read by humans and used by an Agent as a structural contract.

The design doc is the source of truth; read it before making changes: `docs/superpowers/specs/2026-08-19-folderspec-design.md` (377 lines; covers competitive research, technology-choice rationale, and rejected alternatives with reasons). The implementation plan and per-task history live in `docs/superpowers/plans/2026-08-19-folderspec-mvp.md` and `.superpowers/sdd/` (the latter is not checked in).

## Invariants that must not be violated

These four come from §3 of the design doc. Violating any one of them is a design error, not a style issue:

1. **The only file this tool writes is `.folderspec.md`.** Never `mv` / `mkdir` / `rm`. Actually moving files is the Agent's job, not this tool's. Corollary: no undo stack, dry-run, or rollback is needed. (`Session.undoStack` — see `packages/core/src/session.ts` — does not violate this: the original reasoning here was about *safety* — this tool never touches anything on disk besides `.folderspec.md`, so there is no "an operation broke the repo, roll it back" scenario. The undo stack users later asked for solves a different problem, "undo a mistake," and it only ever acts on the in-memory `Spec`; it still writes zero bytes to disk, so the read-only law stands unshaken.)
2. **Declarative, not imperative.** The contract describes long-lived invariants ("cases should live under src/cases"), not one-off operations ("move examples/foo over there"). **A drag-and-drop must never record "where it came from"** — an action log goes stale the instant it is executed, and from then on the contract carries a lie.
3. **A sparse overlay.** The file holds only nodes a human has annotated, plus their ancestor chain — it is not a mirror of the repo. The complete structure comes from a live scan.
4. **Storage format is the output format.** There is no separate "export" step, no second artifact that has to be kept in sync.

Concrete prohibitions that follow from this — easy to trip over when changing code:

- **No derived state is ever persisted.** Tags explicitly rejected for this reason: `[planned]` (whether it exists on disk is something a scan can compute), `[required]`/`[optional]` (that belongs to the template's YAML, not duplicated onto the tree), and pseudo-permission fields like `agent_permissions:` (there is no technical means to stop an Agent from writing a file — such a field would be nothing but false comfort).
- **Never overwrite a user's file with an empty spec.** A parse failure means read-only mode plus a line-numbered report, not a silent rewrite. `Session` uses an explicit `opened` state flag so "never opened" can't be mistaken for "opened successfully with an empty contract."
- **Before writing to disk, a `serialize → parse` self-check is mandatory** — if the round trip doesn't match, the write is aborted (`Session.save`).
- **The only harm this tool can do is lose a human-written annotation.** Any change that touches the spec lifecycle should be judged against that. `spec-only` nodes (present in the spec, absent on disk) are **kept forever, never auto-deleted** — "not yet created" and "already deleted" are indistinguishable from what's observable.

## Architecture

pnpm workspace, dependencies flow one way:

```
packages/core/    @folderspec/core   pure TS · no DOM · no UI · the only package that touches the filesystem
packages/ui/      @folderspec/ui     React SPA · zero node dependencies · has no notion of the filesystem
packages/cli/     folderspec         host: http + ws + browser --app frameless window
packages/vscode/  folderspec-vscode  host: CustomTextEditorProvider
```

All four packages are implemented. `packages/vscode`'s end-to-end smoke test (`src/test/suite/smoke.test.ts`) requires a graphics environment: it won't run locally without a `DISPLAY`, and only runs in CI via `xvfb-run`.

### Bridge: how one UI serves two hosts

`packages/core/src/api.ts` defines `Api` (7 methods: `workspace/open`, `tree/get`, `tree/expand`, `spec/annotate`, `spec/move`, `spec/save`, `spec/raw`) and the `Bridge` interface. This file has **zero node dependencies** — the UI only imports its types.

- CLI host: `packages/ui/src/ws-bridge.ts` ↔ same-origin WebSocket ↔ `packages/cli/src/server.ts`
- VSCode host: `window.__folderspecBridge` is injected by the webview ahead of time; `main.tsx` picks it up first if it's present
- Tests: `FakeBridge` in `packages/ui/src/test-bridge.ts`, which never touches the filesystem

`ui` never knows which host it's running under, and `core` never knows who's calling it. **When adding a feature, ask first: should the new method join the `Api` type contract, or should it not cross this boundary at all?**

### Three-source merge

```
disk scan (scan)       ┐
git status (gitStatus) ├→ merge() pure function → ViewNode tree → UI
.folderspec.md          ┘
```

Only the third source is persistent; the other two are never written to disk. `merge` is a pure, IO-free function and the focus of testing; `ViewNode.origin` enumerates four cases: `both` / `spec-only` (dashed, never deleted) / `actual-only` / `unscanned` (that directory hasn't been lazily loaded yet). **`merge` must be idempotent with respect to a missing branch on the actual side** — lazy loading means it only ever operates on the portion of the tree that has already been loaded.

There is exactly one write path: UI edit → mutate the in-memory `Spec` → `serializeSpec` → write `.folderspec.md`.

### Session

`packages/core/src/session.ts` is a host-agnostic session controller; both hosts share the same logic through `session.handle(method, params)`, leaving each host as a thin shell.

`Session` itself **doesn't handle switching workspaces** — `workspace/open` only re-scans its own root. Switching roots means the host swaps in a new `Session` (see `cli/src/server.ts`).

The session's `hidden` set records the old position from the current drag operation; it's transient UI state, cleared on `open()`, and never persisted (this follows from invariant 2).

### `.folderspec.md` format

A single file, three sections, each playing to its own strengths (see design doc §4 for details):

- **Structure section**: a nested Markdown list. One node per line: `<2n spaces>- \`name/\` \`[role:x]\` — comment`. Indentation must be a multiple of 2 and may not skip a level; the comment delimiter is ` — ` (space + U+2014 EM DASH + space) — whichever one appears first wins.
- **Template / rules sections**: embedded YAML blocks. Rules are cross-cutting — they carry an id, a glob scope, a severity — and don't attach to any single tree node.

The parser is split across four files: `parse/sections.ts` (splits the three sections) → `structure.ts` / `templates.ts` / `rules.ts`, chained together by `parse/index.ts`. **The writer guarantees well-formed output; the reader is tolerant and reports line numbers** — errors must carry a line number, never crash, and never silently drop data.

`Session.annotate` rejects format-breaking values right at the input boundary: a `role`/`template` containing a backtick, `]`, or whitespace triggers an immediate error (silently mangling an identifier is worse than raising one); a newline inside a comment gets normalized to a space (the panel is a textarea, and pressing Enter is a natural thing to do).

### Performance constraints

Target: sub-200ms first paint for a 100k-file repo. Means: the first paint only scans to depth=2 (`DEFAULT_DEPTH`), scanning further on expand; `ignore` rules prune **at the directory level** (a match skips the whole subtree without descending into it); git status comes from a single batched call — `git status --porcelain=v2 -z --untracked-files=all --ignored=matching` — that gets all three states at once, **never a per-file query**; react-arborist virtualizes the list; serialization complexity is O(annotated nodes), not O(repo files).

A single directory beyond `MAX_CHILDREN` (10k) is truncated and flagged; a `readdir` failure (usually a permissions issue) is marked `unreadable` and scanning continues rather than aborting; symlinks are not followed by default.

## Conventions

**Chinese.** Code comments, error messages, UI copy, and commit messages are all written in Chinese. Commits use a conventional-commits prefix plus a Chinese subject line, e.g. `feat(core): 三源合成 merge 纯函数`.

**Comments explain "why," not "what."** Nearly every long comment in the codebase records a hard-won lesson or a judgment call (for example, why `decodeURIComponent` must be wrapped in try in `cli/src/server.ts`, or why the `useEffect` dependency in `ui/src/AnnotationPanel.tsx` can only be `node?.path`). **Don't trim these down to one line** — they are the only thing stopping someone later from "fixing" it back to the broken version.

**TDD: tests before code.** `core`'s coverage target is 100%.

**Regression tests require RED/GREEN proof.** This project's history has **six** recorded cases of "a regression test that couldn't detect the regression it was meant to catch" (see `.superpowers/sdd/*/progress.md`). When adding a regression test, you must first apply the exact single-point mutation it's meant to guard against, watch it fail (go red) with your own eyes, then revert and watch it pass (go green). A verbal assertion doesn't count.

Key test: `core/src/roundtrip.test.ts` uses fast-check for a property test — a random `Spec` → serialize → parse → must be strictly equal to the original. **This is exactly what protects the single most critical invariant — "never lose an annotation" — and it's the first gate any change to the serializer or parser has to pass.**
