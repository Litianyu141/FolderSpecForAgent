# FolderSpec 设计文档

日期：2026-08-19
状态：已批准，待实现计划

---

## 1. 背景与动机

当前的 AI Coding Agent 还无法完全自主工作，人类的参与是必要的。两个具体痛点：

1. **人类看不懂陌生仓库**——想快速理解一个仓库的职责划分，只能一个个目录点开看。
2. **Agent 不知道该把东西放哪**——新建文件时缺乏结构约束，容易乱放，久而久之仓库结构熵增。

这两件事其实是同一件事的两面：**仓库的结构意图没有被显式记录下来**。它只存在于维护者脑子里。

FolderSpec 的目标是提供一个可视化工具，让人类以最低成本把"这个仓库应该长什么样、每个目录是干什么的"声明出来，产出一份既能被人读、也能被 Agent 遵守的**结构契约**。

## 2. 竞品调研结论

| 类别 | 代表 | 与本项目的关系 |
|---|---|---|
| 仓库打包给 LLM | Repomix（~21k★，tree-sitter 压缩省 ~70% token，有 MCP server）、Gitingest（URL 换字即用）、code2prompt（Rust，模板系统）、Aider repo-map | 只读、全自动、**无人工注释、无结构意图** |
| VSCode 目录树导出 | vscode-file-tree、FileTree Exporter、File Tree Generator | 一次性"复制成文本树"，无编辑无注释 |
| 从文本树建结构 | TreeForge | 本项目的反向操作，可作二期落地功能的参考 |
| 代码注释聚合 | Todo Tree、Better Comments | 代码**行内**注释，非目录级 |
| AI 目录规范 | agent-folder-init、ICM template、Google agents-cli | 写死的固定模板，不可视化编辑 |
| 目录级文档 | 每目录放 README 的手工约定 | 无工具化产品 |

**结论：不存在同时具备「可视化树 + 人工目录级注释 + 声明式结构意图 + git 状态着色 + 编译为 Agent 约束」的工具。** 最接近的是 Repomix ∪ TreeForge ∪ VSCode FileDecorationProvider 的并集，但"人在回路"的注释与结构意图声明这两个核心环节无人覆盖。

## 3. 核心原则

这四条原则约束后续所有设计决策，违反其一即为设计错误。

### 3.1 只读——工具永不写磁盘

FolderSpec **只写 `.folderspec.md` 这一个文件**，绝不执行任何 `mv` / `mkdir` / `rm`。真正修改仓库的是 Agent。

推论：不需要 undo 栈、冲突检测、dry-run 预览、回滚机制。破坏性风险为零。

### 3.2 声明式，不是命令式

契约描述的是**长期不变量**（"case 应该在 src/cases 下"），不是**一次性操作**（"把 examples/foo 移到 src/cases/foo"）。

理由：操作记录一旦被执行就过期，契约从此携带一条谎言。不变量永不过期。

推论：**拖拽节点后，文件里不记录"从哪儿来"**。树上节点所在的位置就是它应该在的位置。actual 与 desired 的差异由工具实时扫描算出并在 UI 显示，**绝不落盘**。

### 3.3 稀疏覆盖层

`.folderspec.md` 只包含**被人工标注过的节点及其父级链条**，不是整个仓库的镜像。

理由：真实仓库上万文件，全量写入会导致文件巨大、git diff 无法阅读、token 成本高昂。完整结构由实时扫描提供，无需持久化。

### 3.4 存储格式即输出格式

保存的文件本身就是喂给 LLM 的文件，**不存在单独的"导出"步骤**，不存在需要保持同步的第二份产物。

推论：用户可在 `CLAUDE.md` / `AGENTS.md` 中写 `@.folderspec.md` 引用它，Agent 每次自动读取，零额外操作即完成约束。

## 4. 文件格式：`.folderspec.md`

### 4.1 分区设计

单文件，内部按各自强项分三区：

| 区 | 格式 | 理由 |
|---|---|---|
| 结构树 | Markdown 嵌套列表 | 树形是 LLM 见过最多的表示法，零解释成本、token 最省、GitHub/VSCode 直接渲染、人手改不易出错 |
| 模板 | 内嵌 YAML 块 | 模板是结构化定义，有必填/可选/角色等字段 |
| 规则 | 内嵌 YAML 块 | 规则是横切的（有 id、glob scope、severity），不挂在任何单个树节点上，塞进树里会别扭 |

被明确否决的两个方案及理由：

- **纯 YAML/JSON 作为 source of truth，编译出 Markdown**：会产生两份文件。AGENTS.md 之类的产物是人会手改的，一改就漂移，且用户不知道该改哪个。同时牺牲了主消费者（LLM）的读取效率。
- **全 Markdown 自由散文**：无法可靠表达 required/optional、error/warning、规则优先级。

### 4.2 完整示例

````markdown
---
folderspec: 1
root: .
ownership: human
---

# 仓库结构契约

> 本文件声明本仓库的**结构意图**，是长期不变量，不是一次性操作指令。
> Agent 应读取本文件、对照实际仓库、自行决定如何变更磁盘。
> Agent 不应自行修改本文件；若认为规则不合理，请向人类提出修改建议。

## 结构

- `src/` `[role:source-root]` — 核心源码
  - `core/` `[role:core-engine]` — 核心业务逻辑，禁止依赖 UI
  - `ui/` `[role:frontend]` — 所有界面代码
  - `cases/` `[role:case-root]` — 每个独立案例一个目录
    - `{case-name}/` `[template:case]` — 案例目录
- `tests/` `[role:test-root]` — 自动化测试
- `docs/`
  - `specs/` — 设计文档放这里

## 模板

```yaml
case:
  description: 一个能独立运行和验证的案例
  root: { variable: case-name, naming: kebab-case }
  children:
    README.md: { role: case-documentation, required: true }
    input/:    { role: source-input,       required: true }
    expected/: { role: expected-output,    required: true }
    test.py:   { role: test-entrypoint,    required: true }
  exemplar: [src/cases/basic-login]
```

## 规则

```yaml
- id: case-location
  severity: error
  scope: "**"
  text: 所有新案例必须作为独立目录创建在 src/cases 下
- id: no-ui-in-core
  severity: error
  scope: "src/core/**"
  text: core 不得 import ui 层任何模块
- id: case-size
  severity: warning
  scope: "src/cases/*"
  text: 单个 case 直接子文件不宜超过 10 个
```
````

### 4.3 语法定义（结构区）

一行 = 一个节点。语法：

```
<缩进><"- "><`名称`>[ <`[标签]`>]*[ " — " <注释文本>]
```

| 元素 | 规则 |
|---|---|
| 缩进 | 2 空格 = 1 层。缩进必须是 2 的倍数，且不得跳级 |
| 名称 | 反引号包裹。末尾 `/` 表示目录，否则为文件 |
| 占位符 | 名称中的 `{xxx}` 为模板变量，如 `{case-name}/` |
| 标签 | 反引号包裹的 `[key:value]` 或 `[key]`，可有多个 |
| 注释 | ` — `（空格 + em dash + 空格）之后的全部内容。首次出现的分隔符生效，之后的 `—` 属于注释正文 |

已定义标签：

| 标签 | 含义 |
|---|---|
| `[role:<name>]` | 语义角色，如 `core-engine`、`expected-output`。让 Agent 理解"这是什么"而非仅"叫什么" |
| `[template:<name>]` | 该节点适用模板区中定义的同名模板 |
| `[severity:error\|warning\|advisory]` | 该节点注释的约束强度。缺省为 advisory（纯知识） |

**刻意不设的标签**，因为它们是派生状态，存进文件就会过期（与原则 3.2 同类错误）：

- `[planned]`——"磁盘上尚不存在"由扫描实时算出。一旦目录被创建，存下来的标签就是谎言。
- `[required]` / `[optional]`——必需性是模板的属性，归属模板区的 YAML，不重复出现在树上。

`[severity:...]` 出现在两处，语义不同且不冲突：树节点上的 severity 修饰**该节点自身的注释**；规则区里的 severity 修饰**该条规则**。

写入端由软件保证格式规范；读取端为容错解析器，遇错报行号。

### 4.4 语义四层

| 概念 | 语义 | 对 Agent 的意义 | UI 着色 |
|---|---|---|---|
| **Annotation** | "这个目录负责处理数据库迁移" | 知识，帮助理解 | 🔵 |
| **Rule** | "任何 migration 必须放这里" | 约束，必须遵守 | 🔴 error / 🟠 warning |
| **Template** | "case 目录应包含这些子项" | 新建时的结构骨架 | — |
| **Exemplar** | "参考 src/cases/basic-login" | 指针，让 Agent 自己去读真实实现学习习惯，无需把代码塞进 prompt | — |

Annotation 与 Rule 的区分是必要的：前者不强制，后者强制，Agent 的处理方式完全不同。

### 4.5 关于「Agent 不得修改契约」

存在一个真实的失败模式：

```
契约：不允许把 case 放 src 根目录
Agent：我想把 case 放 src 根目录
Agent：那我改契约，现在允许了
✓ 校验通过
```

**但没有任何技术机制能阻止 Agent 写文件。** 因此本设计不引入 `agent_permissions:` 之类的伪权限字段（那只是自我安慰）。实际手段是两条：

1. front-matter 中 `ownership: human` + 正文中一句人类可读的声明——LLM 会照做，这是有效的
2. 该文件进 git，任何契约变更都会出现在 diff 里，走正常 code review

Agent 若认为规则不合理，应向人类提出修改建议，而非自行修改。

## 5. 架构

pnpm monorepo，四个包，依赖单向：

```
packages/
  core/    @folderspec/core   纯 TS · 无 DOM · 无 vscode 依赖 · 无 UI
  ui/      @folderspec/ui     React SPA · 无 node 依赖 · 不认识文件系统
  vscode/  folderspec-vscode  VSCode 扩展（宿主）  → 依赖 core + ui
  cli/     folderspec         npx CLI（宿主）      → 依赖 core + ui
```

### 5.1 技术选型依据

| 决策 | 选择 | 依据 |
|---|---|---|
| 语言 | 全 TypeScript | `fdir` 在 Node 中 1 秒爬完 100 万文件，性能需求纯 TS 即可满足；VSCode 扩展塞 Rust 原生模块需为每平台单独打 VSIX、有代码签名失败先例、且**用了原生模块就无法在 vscode.dev / github.dev 运行** |
| 树组件 | react-arborist | react-window + react-dnd，专为虚拟化树 + 拖拽设计，10k–100k 节点稳定，即照 VSCode 侧边栏模式设计 |
| 目录遍历 | fdir + ignore(npm) | fdir 最快；ignore 包套 `.gitignore` 规则，目录级剪枝 |
| git 状态 | 子进程调 git | 一次 `git status --porcelain=v2 --untracked-files=all --ignored=matching` 同时拿到已忽略/未跟踪/已修改三态，与 VSCode 自带 git 插件同等代价，无需任何库 |
| VSCode 集成 | CustomEditorProvider | `package.json` 中用 `filenamePattern` 绑定 `.folderspec.md`，双击即打开可视化界面 |
| 独立 GUI | 浏览器 `--app` 模式无边框窗口 | 不下载 Chromium。Tauri 需 Rust 后端（与全 TS 冲突），Electron 装机包 80–200MB、内存 120MB+，与"安装简单快捷""运行要快"冲突 |

被否决的方案：**Rust core + Tauri**（性能与包体最优，但 VSCode 端分发复杂度高、vscode.dev 不可用、开发周期至少翻倍，对一个 I/O 密集且 Node 已足够快的场景不划算）；**Electron**（安装包过大）。

### 5.2 Bridge 抽象

让一份 UI 跑在两个宿主里的关键：

```ts
interface Bridge {
  request<K extends keyof Api>(method: K, params: Api[K]['params']): Promise<Api[K]['result']>
  on(event: 'tree-updated' | 'spec-changed' | 'scan-progress', cb: (p: any) => void): () => void
}
```

- VSCode 宿主实现走 `webview.postMessage` / `window.addEventListener('message')`
- CLI 宿主实现走 WebSocket 到 localhost

`ui` 只认这个接口，永远不知道自己跑在哪个宿主。`core` 只吃路径吐数据，永远不知道谁在调它。**这两条边界成立，两个宿主就各是一层约 200–300 行的薄壳。**

### 5.3 core 的公开接口

```ts
scan(root: string, opts: ScanOpts): Promise<ActualTree>
gitStatus(root: string): Promise<Map<string, GitState>>
parseSpec(markdown: string): Result<Spec, ParseError[]>
serializeSpec(spec: Spec): string
merge(actual: ActualTree, git: Map<string, GitState>, spec: Spec): ViewTree  // 纯函数，无 IO
```

`merge` 是纯函数，是测试的重点。

## 6. 数据流

三个数据源合成一个视图，**只有一个是持久的**：

| 源 | 来自 | 生命周期 | 规模 |
|---|---|---|---|
| Actual tree | 磁盘扫描 | 内存，从不存盘 | 全仓库 |
| Git states | git 子进程一次调用 | 内存，缓存 | 变更文件数 |
| **Spec overlay** | `.folderspec.md` | **持久，进 git** | **稀疏，仅含标注过的节点** |

合成规则（`merge` 的完整行为表）：

| spec | 磁盘 | 结果 |
|---|---|---|
| 有 | 有 | 合并，显示注释色 |
| 有 | 无 | `spec-only`：虚线边框，**永不自动删除** |
| 无 | 有 | `actual-only`：普通节点，仅 git 颜色 |
| 有 | 该目录尚未扫描（懒加载） | `unscanned`：中性显示，展开扫描后自动重解析 |

**`planned` 与 `missing` 已合并为单一的 `spec-only`。** 原设计把二者分开（按父目录是否存在判定），但这同样是不可计算的：工具无法区分"人声明了一个待创建的目录"和"人标注过的目录后来被删了"——两者的可观测状态完全相同（spec 里有，磁盘上没有）。UI 统一渲染为虚线，tooltip 写明"spec 中声明，磁盘上不存在——可能待创建，也可能已被删除"。无论哪种，行为都一样：**保留，永不自动删除**。

**写路径只有一条**：UI 编辑 → 改内存中的 Spec 对象 → `serializeSpec` → 写 `.folderspec.md`。全程只写这一个文件。

### 6.1 位置差异的可检测性——一个刻意接受的限制

原则 3.2 规定不记录"从哪儿移来"。这带来一个必须诚实承认的后果：**重新加载文件后，工具无法知道 spec 里的 `src/cases/foo/` 和磁盘上的 `examples/foo/` 是同一个东西。** 它只能看到"spec 声明的 `src/cases/foo` 在磁盘上不存在"和"磁盘上有个未标注的 `examples/foo`"。

分三种情形处理：

- **拖拽当次会话内**：UI 持有拖拽前后的内存状态，直接显示移动指示。属临时 UI 状态，不落盘。
- **重新加载后**：降级为两个独立事实——一个 planned 节点 + 一个未标注目录。
- **二期功能 12**：用 basename 启发式重建关联并提示"`examples/foo` 疑似应位于 `src/cases/foo`"。

**这个限制不影响主用途。** Agent 拿到的是"`src/cases/{case-name}/` 应存在且符合 case 模板"加上规则"所有新案例必须在 src/cases 下"，它自己扫描仓库就能判断 `examples/foo` 是不是一个 case、该不该搬——而且它比工具更清楚搬动会牵连哪些 import、构建配置和测试。这正是把迁移决策留给 Agent 的理由。

### 6.2 merge 与懒加载的关系

`merge` 作用于**当前已加载的那部分 actual tree**，而非全量。spec 中位于尚未扫描的子树下的节点照常物化显示，等该子树被展开扫描后再与实况合并。因此 `merge` 必须对"actual 侧缺失分支"保持幂等——这是它的单测要覆盖的一类。

## 7. 性能

目标：**10 万文件仓库首屏 < 200ms，全量扫描 < 1s。**

1. **首屏只扫 depth=2**，展开时按需扫子目录 → 开窗时间与仓库规模基本无关
2. 全量扫描后台跑：CLI 端用 `worker_threads`；VSCode 端 extension host 单线程，用分块 + `await` 让出，不卡 UI
3. `ignore` 规则做**目录级剪枝**——命中 ignore 的目录整棵不进入
4. git 状态一次子进程批量获取，绝不逐文件查询
5. react-arborist 虚拟化，只渲染视口内节点
6. 序列化复杂度是 `O(标注节点数)` 而非 `O(仓库文件数)`——稀疏覆盖层的最大性能红利

## 8. 错误处理

本工具唯一能造成的伤害是**弄丢人工书写的注释**。以下策略围绕这一点设计。

| 情况 | 处理 |
|---|---|
| **`.folderspec.md` 解析失败** | **绝不用空 spec 覆盖用户文件。** 显示"第 N 行无法解析：<原因>"，UI 进入只读模式，提供"用文本编辑器打开原文件"按钮 |
| **写盘前** | 先 `serialize → parse` 自校验，round-trip 不一致则中止写入并报错 |
| 不是 git 仓库 / git 不在 PATH | 降级：不显示 git 颜色，其余功能完全正常 |
| 目录权限拒绝 | 跳过、标灰、继续扫描，不中断 |
| 符号链接 | 默认不跟随（防环），节点上标记 |
| 单目录 > 10k 直接子项 | 截断显示 + "展开全部"按钮，防 UI 卡死 |
| spec 引用的路径已被删除 | 归入 `spec-only`（与"待创建"不可区分，见 §6），**保留**，由人决定删否——人写的东西不能自动丢 |
| 外部（或 Agent）修改了 `.folderspec.md` | 监听变更，提示"文件已在外部修改，重载？"，不静默覆盖 |
| 系统无支持 `--app` 的浏览器（如仅装 Firefox 的 Linux） | 回退为在默认浏览器中开普通标签页，并在终端打印 URL |

## 9. 测试策略

按 TDD 执行，先测后码。

**`core` 是测试重点**（纯逻辑，覆盖率目标 100%）：

- **Round-trip property test**：随机生成 `Spec` → `serialize` → `parse` → 必须严格等于原对象。**这条测试保护的是"不丢注释"这个最关键的不变量**
- 解析器：喂入各种畸形 markdown，断言报出正确行号，而非崩溃或静默丢数据
- `merge`：纯函数，穷举第 6 节合成规则表的每一行

其余：

- **扫描器**：fixture 目录 + `memfs`，覆盖权限拒绝、符号链接环、超大目录三种边界
- **git 状态**：临时目录中真实创建 git 仓库，造出 ignored / untracked / modified 三种文件后断言
- **`ui`**：Vitest + Testing Library，Bridge 注入 mock 实现，不碰真实文件系统
- **端到端**：`@vscode/test-electron` 冒烟测试——打开 `.folderspec.md`、写一条注释、存盘、断言文件内容

## 10. 范围

### MVP

| # | 功能 |
|---|---|
| 1 | 虚拟化树 + 懒加载扫描 |
| 2 | gitignore 过滤 |
| 3 | git 状态着色（忽略 / 未跟踪 / 已修改） |
| 4 | 右侧常驻面板写注释（description + role + severity） |
| 5 | 有注释节点变色 + 🔴🟠🔵 分级 |
| 6 | 拖拽虚拟重排（= 编辑 desired structure） |
| 7 | `.folderspec.md` 读写（三区解析 / 序列化） |
| 8 | VSCode 扩展（CustomEditorProvider 绑定 `.folderspec.md`） |
| 9 | `npx folderspec` + 浏览器 `--app` 独立窗口 |
| 10 | 工作区路径切换 |
| 11 | 树内搜索 / 过滤 |

### 二期

| # | 功能 |
|---|---|
| 12 | actual vs desired 差异高亮 |
| 13 | 右键"从此子树创建模板" |
| 14 | 规则可视化编辑器（MVP 先手写 YAML 块） |
| 15 | `folderspec validate` 确定性校验 |
| 16 | `export agents / cursor / copilot` 编译器 |
| 17 | chokidar 增量刷新 |

### 明确不做

- 文件系统写操作（mv / mkdir / rm）——违反原则 3.1
- undo / redo 栈、dry-run、回滚——只读工具不需要
- `agent_permissions` 伪权限字段——见 4.5
- JSON Schema 全套校验引擎、命名风格引擎、Agent 生命周期建模、双向审批 UI——三年后的功能，不进当前范围

## 11. 交互设计

**左树 + 右侧常驻面板。** 单击节点即选中，右侧面板立即显示并可编辑该节点的注释。

选择依据：不与拖拽的按下动作冲突；无弹窗遮挡；连续给多个目录写注释时效率最高。

左上角为工作区路径载入入口。命令行启动时默认打开当前工作目录。
