# FolderSpec

[中文](README.zh-CN.md)

[![CI](https://github.com/Litianyu141/FolderSpecForAgent/actions/workflows/ci.yml/badge.svg)](https://github.com/Litianyu141/FolderSpecForAgent/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Litianyu141/FolderSpecForAgent?label=release)](https://github.com/Litianyu141/FolderSpecForAgent/releases/latest)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-extension-007ACC?logo=visualstudiocode&logoColor=white)](https://github.com/Litianyu141/FolderSpecForAgent/releases/latest)

A repository's structural intent — which directory is responsible for what, where new
things belong — usually lives nowhere but in the maintainer's head. Someone new to the
codebase has to click through directories one at a time to reconstruct it; an AI agent
creating files has no structural constraint at all, and the repository drifts.

FolderSpec lets you declare that intent visually and emit a `.folderspec.md` file that
humans can read and agents can follow. **The tool is read-only**: apart from that one
file it writes nothing to disk, and it never runs `mv` / `mkdir` / `rm`. Changing the
repository is the agent's job. FolderSpec's job is to say clearly what the repository
should look like.

---

## See it in action

### Annotate a directory

Click any file or directory and use the right-hand pane to write an annotation, a
semantic role, and a constraint severity. Annotated nodes carry their text inline in
the tree.

![Annotating a directory](docs/media/demo-annotate.gif)

### Rearrange the structure, virtually

Right-click to declare a directory that does not exist yet, then drag things into it —
**nothing moves on disk**. Switch to the "Actual structure" view to compare the two:
that view is the disk as it really is, and what you just edited is the contract.

![Rearranging the structure](docs/media/demo-restructure.gif)

### Produce the contract

Select a batch of nodes with `Shift` / `Ctrl` and give them one shared annotation.
Saving drops `.folderspec.md` at the repository root — **there is no separate "export"
step**. The storage format is the output format, and that file is itself the artifact
the agent reads.

![Producing the contract](docs/media/demo-output.gif)

---

## Install and run

### VSCode extension (recommended, and the way to hand it to someone else)

Download `folderspec-vscode-<version>.vsix` from
[Releases](https://github.com/Litianyu141/FolderSpecForAgent/releases) and install it
one of two ways:

```bash
code --install-extension folderspec-vscode-0.6.0.vsix
```

Or, from inside VSCode: `Ctrl+Shift+P` → **Extensions: Install from VSIX…** → pick the
file. Reload the window (`Developer: Reload Window`) afterwards.

> It is not on the VS Code Marketplace yet, so searching for it turns up nothing —
> `.vsix` is the only route. That also means **no automatic updates**: moving to a new
> version means downloading and installing again.

### Command line

**The CLI is not published to npm yet**, so `npx folderspec` does not work today. Build
it from source instead:

```bash
git clone https://github.com/Litianyu141/FolderSpecForAgent.git
cd FolderSpecForAgent
pnpm install && pnpm build
node packages/cli/dist/main.js            # open the current directory
node packages/cli/dist/main.js ./some/dir # open a specific directory
```

It starts a local server bound to `127.0.0.1` and tries to open a chromeless window
through Chrome / Edge / Chromium's `--app` mode. On a machine that only has something
like Firefox, which has no `--app` mode, it falls back to an ordinary tab in the default
browser and prints the address to the terminal.

| Argument | Meaning |
|---|---|
| `[dir]` | Workspace path; defaults to the current directory |
| `--port <n>` | Port to listen on; defaults to a random free port |
| `--no-open` | Start the server only, do not open a window |
| `--help` | Print help |

The server shuts down with the process (Ctrl+C). Every start mints a one-shot token and
injects it into the page, and the WebSocket connection must present it — browsers do not
apply the same-origin policy to WebSockets, so without that check any page you happened
to have open while folderspec was running could connect to the local port.

### Using the VSCode extension

Once it is installed, **opening any `.folderspec.md` file** brings up the FolderSpec
visual editor instead of the plain-text view. Use "Open With → Text Editor" when you
want the raw text.

The command palette carries one entry, `FolderSpec：打开结构契约` ("Open structure
contract" — the extension's command titles are not localized yet). If the current
workspace has no `.folderspec.md`, it offers to create one and then opens it.

Saving goes through VSCode's `WorkspaceEdit`, so the dirty marker, `Ctrl+S`, and the
editor's own undo stack all behave the way you expect.

### Letting your agent read it

The storage format is the output format; there is no export step. Add one line of
reference to `CLAUDE.md` / `AGENTS.md`:

```markdown
@.folderspec.md
```

From then on the agent picks the contract up automatically, with nothing extra to do.

---

## The interface

**Three panes**: the repository tree on the left, a read-only preview of the selected
file in the middle (line numbers, line-by-line syntax highlighting), and a persistent
annotation / group pane on the right.

Click a node and it is highlighted in the tree, its contents appear in the middle pane
(child counts, for a directory), and the right pane becomes that node's annotation
editor, where you can set the annotation, `role`, `template`, and `severity`.

**Shift / Ctrl (⌘ on macOS) click extends the selection**: Shift takes the contiguous
range from the previous anchor, Ctrl/⌘ adds or removes one node at a time. With two or
more nodes selected, the right pane switches to **group editing**: one shared annotation
for the whole batch, stored in the `## Groups` section of `.folderspec.md` (see the
[format reference](docs/FORMAT.md) for fields and examples).

**Group annotations and per-node annotations never overwrite each other.** What a group
shares is `Group.text`, which hangs off the group itself and leaves each member's own
`SpecNode.annotation` untouched; annotating a single member likewise leaves its group's
shared text alone. A node can have its own annotation and belong to one or more groups
at the same time — the tree marks each group it belongs to with a dot after the node
name, and clicking a dot jumps to that group and replaces the selection with all of its
members.

Dragging a node declares "this is where it belongs" — **it moves no file on disk**. It
changes the position the contract declares, and the rest is up to the agent.

**The context menu** offers four sets of operations that act on the contract only. The
"contract only" in their names is meant literally — none of them touch the disk:

- **New directory / New file (contract only)**: declare that "there should be an X
  here". Right-click a directory and the new node goes inside it; right-click empty
  space (or use **New** in the toolbar) and it goes under the workspace root;
  right-click a file and it goes into that file's parent. The typical use is laying out
  a directory template for the agent — a whole `templates/cases/fixtures/` skeleton can
  be declared up front while not one of those directories exists on disk yet. The name
  is required at creation time; the contract has no "create first, rename later" path.
- **Rename (contract only)**: this edits the contract's claim about what the node should
  be called. The filename on disk does not change. Paths in the subtree and in group
  membership lists are rewritten to match.
- **Undeclare**: removes a node from the contract. A node that really exists on disk
  **stays in the tree** and simply carries no annotation any more; only spec-only nodes
  (the ones with nothing behind them on disk) disappear entirely. If the subtree still
  contains annotated descendants, the operation is **refused** and you are asked to deal
  with them one by one — losing several hand-written declarations to a single click is
  exactly what this tool should be guarding against.
- **Copy / Paste (contract only)**: declare a second copy of an annotated subtree
  somewhere else — pasting `templates/case-skeleton/` under `src/cases/`, say. The
  destination follows the same rule as **New** (right-click a directory to paste inside
  it, a file to paste into its parent, empty space for the workspace root). Three things
  are worth knowing first:
  - **What gets copied is the contract subtree, not the disk subtree.** Copy a directory
    that was never annotated and paste it, and what you get is one empty declaration
    ("there should be something like this over there too") — **its contents do not come
    along**, because they were never in the contract to begin with. The contract is a
    sparse overlay, not a mirror of the repository; live structure comes from scanning
    the disk. This is not a defect.
  - **Name collisions get a suffix automatically**: `demo` → `demo-copy` →
    `demo-copy-2`, and for files the suffix goes before the extension (`a.ts` →
    `a-copy.ts`). Both contract-side and disk-side siblings are avoided, so a copy can
    never merge into an existing line and mix up two sets of annotations.
  - **Copies join no group.** Select the copy and add it if you want it in one.
  - **Copy** itself is a pure read and stays available in read-only mode (a parse
    failure, or the "Actual structure" view); **Paste** is a write and is disabled there.

**Undo / redo** covers every edit: annotations, drags, creations, renames, pastes,
undeclarations, group edits, language switches. It operates on the in-memory contract
and **writes not one byte to disk** — so what it protects against is not "the operation
broke my repository" but "I dropped that in the wrong place".

**The "Actual structure / My structure" toggle**: the former renders only what the disk
scan found and ignores structural changes from the contract, which is how you check what
you actually changed. Every editing entry point is disabled in the actual-structure view.

**Bilingual (Chinese / English)**: the switch in the top-right corner changes both the
interface strings and the boilerplate we generate inside the contract (title line,
preamble, the four section headings), and writes `lang` into the front matter.
**Nothing you wrote is touched** — node annotations, group text, rule text, template
descriptions, semantic roles, and paths all stay in the language you wrote them in. Only
a title or preamble that is still character-for-character the previous language's
default follows the switch; anything you edited is left alone.

The tree is colored by git status (ignored / untracked / modified and so on).
**Directories take the aggregate status of their whole subtree** — a change anywhere
inside recolors the directory name, the same as VSCode's explorer. Precedence is
`conflict > deleted > modified > added > untracked`, and ignored files do not
participate in the aggregate. Only two levels are scanned for the first paint, and
subdirectories are scanned on demand as you expand them, so the time to open a window is
essentially independent of repository size.

Inside VSCode, the interface colors, fonts, and syntax highlighting palette all follow
the active theme (through the `--vscode-*` variables the webview exposes). The CLI host
has no access to those variables and uses a self-consistent light fallback instead.

---
## Learn more

- **[The `.folderspec.md` format](docs/FORMAT.md)** — section-by-section reference,
  exact line syntax, and the limitations worth knowing before you rely on it
- **[Contributing](CONTRIBUTING.md)** — repository layout, how to build and test
- **[中文说明](README.zh-CN.md)** — Chinese README

## License

Apache-2.0
