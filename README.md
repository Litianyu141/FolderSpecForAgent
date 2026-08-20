# FolderSpec

[中文](README.zh-CN.md)

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
for the whole batch, stored in the `## Groups` section of `.folderspec.md` (fields and
examples below).

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

## The `.folderspec.md` format

One file, three sections, each using the notation it is best at: the structure tree is a
nested Markdown list (the shape LLMs have seen most, the cheapest in tokens, and GitHub
renders it directly), while templates and rules are embedded YAML blocks (they are
structured definitions and would be awkward crammed into a tree).

### Skeleton

````markdown
---
folderspec: 1
root: .
ownership: human
lang: en
---

# Repository Structure Contract

> This file declares the **structural intent** of this repository. It states long-lived invariants, not one-off operations.
> Agents should read this file, compare it against the actual repository, and decide for themselves how to change the disk.
> Agents should not modify this file themselves; if a rule seems wrong, raise it with a human.

## Structure
...

## Templates
...

## Rules
...

## Groups
...
````

`folderspec` in the front matter must be `1`. The `## Structure` section is required;
`## Templates`, `## Rules`, and `## Groups` may all be omitted. `lang: en` is what the
tool writes for an English contract and may be omitted, in which case the contract is
Chinese. Section headings are also accepted in Chinese — `## 结构` / `## 模板` /
`## 规则` / `## 分组` — which is what a Chinese contract contains.

### Line syntax in the structure section

One line = one node:

```
<indent><"- "><`name`>[ <`[tag]`>]*[ " — " <annotation text>]
```

| Element | Rule |
|---|---|
| Indent | 2 spaces = 1 level. Must be a multiple of 2, and must not skip a level |
| Name | **Wrapped in backticks**. A trailing `/` means directory, otherwise file |
| Placeholder | `{xxx}` inside a name is a template variable, e.g. `` `{case-name}/` `` |
| Tag | A backtick-wrapped `` `[key:value]` ``; several are allowed, separated by spaces |
| Annotation | Everything after ` — ` (**space + U+2014 EM DASH + space**). The first occurrence is the separator |

Three tags are defined:

| Tag | Meaning |
|---|---|
| `` `[role:<name>]` `` | Semantic role, so the agent knows what a node *is* rather than only what it is called |
| `` `[template:<name>]` `` | This node follows the same-named template from the templates section |
| `` `[severity:error\|warning\|advisory]` `` | How binding this node's annotation is; defaults to `advisory` (knowledge only) |

For example:

```markdown
## Structure

- `src/` `[role:source-root]` — core source
  - `core/` `[role:core-engine]` `[severity:error]` — core business logic; must not depend on the UI
  - `ui/` `[role:frontend]` — all interface code
  - `cases/` `[role:case-root]` — one directory per self-contained case
    - `{case-name}/` `[template:case]` — a case directory
- `tests/` `[role:test-root]` — automated tests
- `docs/`
  - `specs/` — design documents go here
```

This is a **sparse overlay**: it only needs the nodes someone annotated plus the chain of
parents above them, not a mirror of the whole repository. The full structure comes from
scanning the disk live — it does not need to be persisted, and should not be.

Two nodes with the same name at the same level are not allowed — that is a duplicate
declaration, and the parser rejects it with a line number.

### Templates section

Templates and rules can **only be hand-written as YAML** in the MVP (a visual editor is
a second-phase feature), so the fields are documented in full here.

The top level is a mapping: template name → definition.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `description` | string | no | What this template is |
| `root` | mapping | no | Only `variable` and `naming` are allowed, both strings |
| `root.variable` | string | no | Variable name inside the directory name, matching `{case-name}` in the structure section |
| `root.naming` | string | no | Naming convention, e.g. `kebab-case` (recorded but not enforced in the MVP) |
| `children` | mapping | no | Child name → child definition. **A trailing `/` in the key means directory** |
| `children.<name>.required` | boolean | **yes** | `true` or `false` only; omitting it is an error |
| `children.<name>.role` | string | no | Semantic role of that child |
| `exemplar` | array of strings | no | Points at real reference implementations in the repository for the agent to read |

Any field not in the table above is an error rather than being silently ignored.

````markdown
## Templates

```yaml
case:
  description: A case that can be run and verified on its own
  root:
    variable: case-name
    naming: kebab-case
  children:
    README.md:
      role: case-documentation
      required: true
    input/:
      role: source-input
      required: true
    expected/:
      role: expected-output
      required: true
    test.py:
      role: test-entrypoint
      required: true
    NOTES.md:
      required: false
  exemplar:
    - src/cases/basic-login
```
````

`exemplar` earns its keep more than any other field here: instead of stuffing code into
the prompt, it hands the agent a pointer and lets it read the real implementation and
pick up that repository's habits itself.

### Rules section

The top level is a sequence, one `-` item per rule.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | non-empty string | **yes** | Unique across the file; duplicates are an error |
| `severity` | `error` / `warning` / `advisory` | **yes** | How binding the rule is |
| `scope` | non-empty string | **yes** | A glob expression delimiting where the rule applies |
| `text` | non-empty string | **yes** | The rule itself, written for humans and agents |

Again, any field outside the table is an error.

````markdown
## Rules

```yaml
- id: case-location
  severity: error
  scope: "**"
  text: Every new case must be created as its own directory under src/cases

- id: no-ui-in-core
  severity: error
  scope: "src/core/**"
  text: core must not import anything from the ui layer

- id: case-size
  severity: warning
  scope: "src/cases/*"
  text: A single case should not have more than 10 direct child files
```
````

### Groups section

A group says "treat these nodes as one batch" — a set of related config files, say, or a
pile of legacy files that have not been sorted out yet but clearly need to be handled
together. Groups express **no parent/child hierarchy**; members can come from anywhere in
the tree and **do not need** to appear in the structure section first.

The top level is a sequence, one `-` item per group.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | non-empty string | **yes** | Unique across the file; duplicates are an error. Left blank in the UI it is named automatically: the longest common parent directory name of all members, or `group` if there is none, with `-2`, `-3` appended on collision |
| `members` | array of strings | **yes** | At least one member; each is a **workspace-relative posix path** (`/` separated). Absolute paths, `..` segments, and backslashes are rejected |
| `text` | non-empty string | **yes** | The annotation this batch shares. Clearing it in the UI deletes the group |
| `severity` | `error` / `warning` / `advisory` | no | Absent means "annotation only, not binding" |

Any field outside the table is an error rather than being silently ignored.

````markdown
## Groups

```yaml
- id: legacy-configs
  members:
    - config/old-a.json
    - config/old-b.json
    - scripts/migrate-config.js
  text: Three legacy config files plus their migration script; delete all of them once config/schema.ts lands
  severity: advisory

- id: db-migrations
  members:
    - src/db/migrations/0001_init.sql
    - src/db/migrations/0002_add_users.sql
  text: Applied in filename order; published migrations must never be reordered or renamed
  severity: error
```
````

In the UI: select several nodes (Shift for a contiguous range, Ctrl to add or remove one
at a time) and the right pane switches to group editing. A blank group name is filled in
automatically; the annotation is required, and clearing it deletes the whole group. Nodes
that belong to a group get a dot after their name in the tree, and clicking the dot
replaces the selection with all of that group's members.

**The member set locks while you are editing.** As long as the group pane holds an
uncommitted edit, members cannot be added or removed: the `×` next to each member is
greyed out, and Ctrl/Shift selection changes and group dots in the tree stop affecting
the batch. The reason is that *who you are writing for* has to stay fixed while you type:
if the member set changed, the pane might now be editing a different group, and your
sentence would land on it and overwrite its existing annotation. Clicking anywhere
outside the input commits (and the lock releases once the commit lands) — **including on
a node in the tree**: that click first blurs the input and commits the edit, and only
then changes the selection to the node you clicked. **The tool has no "discard edit"
affordance**; the write semantics are "blur commits", start to finish.

### Annotations, rules, templates, exemplars: who does what

| Concept | Semantics | What it means to an agent |
|---|---|---|
| **Annotation** | "This directory handles database migrations" | Knowledge; aids understanding, not binding |
| **Rule** | "Every migration must live here" | A constraint; must be obeyed |
| **Template** | "A case directory should contain these children" | The structural skeleton to use when creating one |
| **Exemplar** | "See `src/cases/basic-login`" | A pointer; the agent reads the real implementation itself |
| **Group** | "These nodes are one batch, read them together" | Knowledge; treated at the stated strength when `severity` is set |

### Declarative, not imperative

The contract describes **long-lived invariants** ("cases belong under src/cases"), not
**one-off operations** ("move examples/foo to src/cases/foo"). An operation goes stale the
moment it is carried out, and from then on the contract carries a lie. Invariants never
go stale.

That is why dragging a node records **no "where it came from"** in the file. Where a node
sits in the tree *is* where it should be.

### On "agents must not edit the contract"

No technical mechanism can stop an agent from writing a file, so there is no
`agent_permissions`-style pseudo-permission field here (that would only be reassuring to
ourselves). Two things do the actual work: `ownership: human` in the front matter
together with the human-readable statement in the body (LLMs comply with it, and it is
effective), and the fact that the file is in git — any change to the contract shows up in
a diff and goes through normal code review.

---

## Known limitations in the MVP

These are real limitations, written down here rather than pretended away.

1. **How far nested `.gitignore` files reach**: the scanner composes ignore rules
   directory by directory, but only as deep as it has scanned so far. A `.gitignore`
   further down does not take effect until its directory is expanded. You will not notice
   in the vast majority of cases, but this is not equivalent to git's full semantics.
2. **Position differences cannot be detected across sessions**: after a reload, the tool
   has no way to know that `src/cases/foo` in the contract and `examples/foo` on disk are
   the same thing — all it sees is "a declared path that does not exist on disk" and "an
   unannotated directory on disk". That is what staying declarative costs. **It does not
   affect the main use case**: give an agent "`src/cases/{case-name}/` should exist" plus
   "every new case must live under src/cases" and it can scan the repository and work out
   for itself whether something should move — and it knows better than the tool which
   imports, build configs, and tests a move would drag along.
3. **Templates and rules are hand-written YAML only**: there is no visual editor (the
   fields are documented in full above).
4. **No deterministic validation**: the MVP produces the contract, it does not check the
   repository against it. There is no `folderspec validate`.
5. **No compilation to AGENTS.md / .cursor/rules**: it relies on an `@.folderspec.md`
   reference in `CLAUDE.md` / `AGENTS.md`; there is no compiled output.
6. **No incremental refresh**: there is no file watcher. The CLI host **cannot tell** when
   the contract file is changed from outside (by an agent rewriting it, for instance) and
   has to be reloaded by hand. The VSCode host can report external changes, because the
   document is owned by the editor.
7. **Node names cannot contain backticks or newlines**: the current format wraps names in
   backticks and gives each node a whole line, and neither can be escaped. Faced with a
   legal but unrepresentable directory name like ``we`ird``, the tool refuses at annotation
   time and names the path, rather than writing a file it cannot read back. Full escaping
   is a second-phase concern.
8. **The VSCode end-to-end test has never really run outside CI**: the
   `@vscode/test-electron` smoke test needs a graphical environment and cannot run
   locally without a `DISPLAY`.
9. **File icons are our own and do not follow your VSCode file icon theme**: VSCode does
   not expose the user's active icon theme to webviews, so icons in the tree may differ
   from the ones in the native explorer. This is not an implementation flaw.
10. **Syntax highlighting in the middle pane works line by line**: this keeps line numbers
    absolutely reliable (multi-line highlighting lets the highlighter swallow newlines,
    which shifts line numbers out of step with the real ones). The cost is imperfect
    coloring of multi-line string literals and block comments — in a `/* ... */` comment
    spanning three lines, the middle line does not know it is inside a comment. It is a
    deliberate trade-off, not a bug waiting to be fixed.
11. **A group member that is neither in the structure section nor on disk gets no row in
    the tree** (and therefore shows no group dot). This only happens when a file that was
    never annotated on its own is added to a group and then deleted from disk. **The member
    is not lost**: it is still in the groups section of `.folderspec.md` and still listed in
    the group pane; there is simply no node in the tree to hang it on. The tree renders
    nodes declared in the structure section and nodes that really exist on disk, and
    synthesizing extra nodes for group members would break the sparse-overlay invariant.

---

## Development

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
