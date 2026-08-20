# FolderSpec

[English](README.md)

[![CI](https://github.com/Litianyu141/FolderSpecForAgent/actions/workflows/ci.yml/badge.svg)](https://github.com/Litianyu141/FolderSpecForAgent/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Litianyu141/FolderSpecForAgent?label=release)](https://github.com/Litianyu141/FolderSpecForAgent/releases/latest)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-extension-007ACC?logo=visualstudiocode&logoColor=white)](https://github.com/Litianyu141/FolderSpecForAgent/releases/latest)

你有没有遇到过这种情况：Agent 在你的仓库里自作主张地建文件、建目录，完全不受你控制？
FolderSpec 让你用拖拽和写注释的方式，直观地声明仓库应有的结构——人能读懂，Agent 也能照着做。

FolderSpec 会产出一个 `.folderspec.md` 文件：既能被人读，也能被 Agent 遵守。
**它是只读工具**——除了这一个文件，它不写磁盘上的任何东西，不执行 `mv` / `mkdir` / `rm`。
真正改动仓库的是 Agent，FolderSpec 只负责把"应该长成什么样"说清楚。

![FolderSpec 的工作方式：Agent 把文件散得到处都是 → 你声明应有的结构 → Agent 照着契约去搬](docs/media/folderspec-intent-flow-v2.png)

---

## 给 Agent 立一份目录契约，三步

### 1. 给目录写注释

单击任意文件或目录，右栏写注释、语义角色、约束强度。写过的节点在树上直接带出注释文字。

![给目录写注释](docs/media/demo-annotate.gif)

### 2. 虚拟重排结构

右键声明一个尚不存在的目录，把东西拖进去——**磁盘一个字节都没动**。
切到「原始结构」视图即可对照：那才是磁盘的真实样子，你改的只是契约。

![虚拟重排结构](docs/media/demo-restructure.gif)

### 3. 产出契约

`Shift` / `Ctrl` 多选一批节点，给它们写一条共享注释。保存后 `.folderspec.md` 就落在仓库根上——
**没有单独的"导出"步骤**，存储格式就是输出格式，那个文件本身就是给 Agent 读的产物。

![产出契约](docs/media/demo-output.gif)

---

## 安装与运行

### VSCode 扩展（推荐，也是分发给别人的方式）

从 [Releases](https://github.com/Litianyu141/FolderSpecForAgent/releases) 下载
`folderspec-vscode-<版本>.vsix`，然后任选一种装法：

```bash
code --install-extension folderspec-vscode-0.6.0.vsix
```

或者在 VSCode 里：`Ctrl+Shift+P` → **Extensions: Install from VSIX…** → 选那个文件。
装完重载窗口（`Developer: Reload Window`）即可。

### VSCode 扩展怎么用

两个入口，看契约文件存不存在。

**从零开始——走命令面板：**

1. 按 `Ctrl+Shift+P`（macOS 是 `⌘⇧P`）调出顶部命令搜索栏
2. 输入 **FolderSpec**，选中 `FolderSpec：打开结构契约`
3. 当前工作区还没有 `.folderspec.md` 时会弹框问你要不要创建，点「创建」，
   可视化编辑器随即在新文件上打开

**打开已经存在的那份：**

直接打开 `.folderspec.md` 就行——FolderSpec 已注册为它的默认编辑器，会代替纯文本视图。
想显式选择就右键该文件 → **打开方式（Open With…）** → **FolderSpec 结构契约**。
想看回原始文本也是这个菜单，选**文本编辑器**。

保存走的是 VSCode 的 `WorkspaceEdit`，所以脏标记、`Ctrl+S`、撤销栈都正常工作。

### 让 Agent 读到它

存储格式就是输出格式，没有单独的"导出"步骤。在 `CLAUDE.md` / `AGENTS.md` 里加一行引用即可：

```markdown
@.folderspec.md
```

Agent 每次都会自动读到这份契约，零额外操作。

---

## 延伸阅读

- **[`.folderspec.md` 的格式](docs/FORMAT.zh-CN.md)** —— 逐节参考、结构区的行语法，
  以及依赖它之前值得先知道的那些限制
- **[参与开发](CONTRIBUTING.zh-CN.md)** —— 仓库结构、怎么构建与测试
- **[English README](README.md)**

## 许可

Apache-2.0
