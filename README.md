# FolderSpec

[中文](README.zh-CN.md)

[![CI](https://github.com/Litianyu141/FolderSpecForAgent/actions/workflows/ci.yml/badge.svg)](https://github.com/Litianyu141/FolderSpecForAgent/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Litianyu141/FolderSpecForAgent?label=release)](https://github.com/Litianyu141/FolderSpecForAgent/releases/latest)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-extension-007ACC?logo=visualstudiocode&logoColor=white)](https://github.com/Litianyu141/FolderSpecForAgent/releases/latest)

Have you ever been in a situation where an agent creates its own files and folders in your repository without your control? FolderSpec is a tool that lets you intuitively drag and annotate to declare the intended structure of your repository in a human-readable and agent-followable way.

FolderSpec will generate a `.folderspec.md` file that
humans can read and agents can follow. **The tool is read-only**: apart from that one
file it writes nothing to disk, and it never runs `mv` / `mkdir` / `rm`. Changing the
repository is the agent's job. FolderSpec's job is to say clearly what the repository
should look like.

![How FolderSpec works: an agent scatters files, you declare the intended structure, the agent rearranges the repo](docs/media/hero.png)

---

## Three Steps to Make a Folder Contract for Agent

### 1. Annotate a directory

Click any file or directory and use the right-hand pane to write an annotation, a
semantic role, and a constraint severity. Annotated nodes carry their text inline in
the tree.

![Annotating a directory](docs/media/demo-annotate.gif)

### 2. Rearrange the structure, virtually

Right-click to declare a directory that does not exist yet, then drag things into it —
**nothing moves on disk**. Switch to the "Actual structure" view to compare the two:
that view is the disk as it really is, and what you just edited is the contract.

![Rearranging the structure](docs/media/demo-restructure.gif)

### 3. Produce the contract

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
## Learn more

- **[The `.folderspec.md` format](docs/FORMAT.md)** — section-by-section reference,
  exact line syntax, and the limitations worth knowing before you rely on it
- **[Contributing](CONTRIBUTING.md)** — repository layout, how to build and test
- **[中文说明](README.zh-CN.md)** — Chinese README

## License

Apache-2.0
