# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 环境

Node 与 pnpm **只存在于 conda 环境 `folderspec` 里**，不在默认 PATH 上。任何一条命令之前先：

```bash
export PATH="$HOME/miniconda3/envs/folderspec/bin:$PATH"   # node v26 + pnpm 9
```

否则会得到 `pnpm: command not found`。

## 常用命令

```bash
pnpm test                                    # 全量：core 143 + ui 70 + cli 21
pnpm build                                   # core(tsc) → ui(vite) → cli(tsc + 复制 ui 产物)
pnpm typecheck                               # 先 build core，再逐包 tsc --noEmit

pnpm -C packages/core test                   # 单包
pnpm -C packages/core test -- src/merge.test.ts   # 单文件
pnpm -C packages/core test -- -t "截断"       # 按用例名过滤

pnpm -C packages/ui dev                      # Vite dev server（无宿主，Bridge 会连不上）
node packages/cli/dist/main.js [目录]        # 跑 CLI，需先 pnpm build
```

**`@folderspec/core` 通过 `exports` 指向 `dist/`，不是 src。** 因此：

- `packages/cli` 的测试运行时真的 import 了 core（`server.ts` 用 `Session`），**core 未 build 时 cli 测试会失败**。克隆后第一次跑测试前先 `pnpm -C packages/core build`（`pnpm typecheck` 脚本已内置这一步，`pnpm test` 没有）。
- `packages/ui` 对 core 全是 `import type`，运行时不依赖 dist，但 tsc 需要 `dist/*.d.ts`。

`core` 与 `cli` 的 tsconfig 把 `src/**/*.test.ts` 排除在 typecheck 之外；`ui` 的没有排除，它的测试会被类型检查。

## 这个项目是什么

一个可视化工具：读当前仓库的目录树，让人给目录/文件写注释、声明结构意图，产出 `.folderspec.md` ——一份既给人读、也给 Agent 当结构契约的文件。

设计文档是权威来源，改动前先读：`docs/superpowers/specs/2026-08-19-folderspec-design.md`（377 行，含竞品调研、技术选型依据、被否决方案及理由）。实现计划与逐任务记录在 `docs/superpowers/plans/2026-08-19-folderspec-mvp.md` 与 `.superpowers/sdd/`（后者不入库）。

## 不可违反的不变量

这四条来自设计文档第 3 节，违反其一即为设计错误，不是风格问题：

1. **只写 `.folderspec.md` 这一个文件。** 绝不 `mv` / `mkdir` / `rm`。真正搬文件的是 Agent，不是本工具。推论：不需要 undo 栈、dry-run、回滚。（`Session.undoStack`——见 `packages/core/src/session.ts`——不违反这条：这里的原判断针对的是"安全"，本工具从不改动磁盘上除 `.folderspec.md` 外的任何文件，没有"操作把仓库弄坏了要回滚"这回事；用户后来要的撤销栈解决的是另一件事——"纠正误操作"，只作用于内存里的 `Spec`，一样一个字节都不写磁盘，只读铁律没有被动摇。）
2. **声明式，不是命令式。** 契约描述长期不变量（"case 应该在 src/cases 下"），不描述一次性操作（"把 examples/foo 移过去"）。**拖拽后绝不记录"从哪儿来"**——操作记录一被执行就过期，契约从此携带一条谎言。
3. **稀疏覆盖层。** 文件只含被人工标注过的节点及其父级链条，不是仓库镜像。完整结构由实时扫描提供。
4. **存储格式即输出格式。** 没有单独的"导出"步骤，没有需要保持同步的第二份产物。

由此推导出的具体禁令，改代码时容易踩：

- **派生状态一律不落盘。** 已被明确否决的标签：`[planned]`（磁盘上存不存在由扫描算出）、`[required]`/`[optional]`（属于模板的 YAML，不重复到树上）、`agent_permissions:` 之类伪权限字段（没有技术手段能阻止 Agent 写文件，写了只是自我安慰）。
- **绝不用空 spec 覆盖用户文件。** 解析失败 → 只读模式 + 报行号，不静默重写。`Session` 用显式的 `opened` 状态位保证"从未打开"不会被当成"打开成功且契约为空"。
- **写盘前必须 `serialize → parse` 自校验**，round-trip 不一致就中止写入（`Session.save`）。
- **本工具唯一能造成的伤害是弄丢人写的注释。** 任何触碰 spec 生命周期的改动都按这条评估。`spec-only` 节点（spec 里有、磁盘上没有）**永远保留、永不自动删除**——"待创建"与"已被删除"在可观测状态上不可区分。

## 架构

pnpm workspace，依赖单向：

```
packages/core/   @folderspec/core   纯 TS · 无 DOM · 无 UI · 是唯一碰文件系统的地方
packages/ui/     @folderspec/ui     React SPA · 零 node 依赖 · 不认识文件系统
packages/cli/    folderspec         宿主：http + ws + 浏览器 --app 无边框窗口
packages/vscode/                    宿主：CustomTextEditorProvider —— 设计里有，尚未实现
```

`packages/vscode` 与端到端冒烟测试（计划的 Task 16/17）**还没做**。设计文档按四个包写，实际仓库只有三个。

### Bridge：一份 UI 跑两个宿主的关键

`packages/core/src/api.ts` 定义 `Api`（7 个方法：`workspace/open`、`tree/get`、`tree/expand`、`spec/annotate`、`spec/move`、`spec/save`、`spec/raw`）与 `Bridge` 接口。这个文件**零 node 依赖**，UI 只 import 它的类型。

- CLI 宿主：`packages/ui/src/ws-bridge.ts` ↔ 同源 WebSocket ↔ `packages/cli/src/server.ts`
- VSCode 宿主（待实现）：`window.__folderspecBridge` 由 webview 预先注入，`main.tsx` 优先取它
- 测试：`packages/ui/src/test-bridge.ts` 的 `FakeBridge`，不碰文件系统

`ui` 永远不知道自己跑在哪个宿主，`core` 永远不知道谁在调它。**加功能时先问：新方法该进 `Api` 类型契约，还是根本不该跨过这条边界。**

### 三源合成

```
磁盘扫描 (scan)      ┐
git 状态 (gitStatus) ├→ merge() 纯函数 → ViewNode 树 → UI
.folderspec.md       ┘
```

只有第三个是持久的，前两个从不存盘。`merge` 是纯函数、无 IO，是测试重点，`ViewNode.origin` 穷举四种情形：`both` / `spec-only`（虚线，永不删）/ `actual-only` / `unscanned`（该目录尚未懒加载）。**`merge` 必须对"actual 侧缺失分支"幂等**——懒加载意味着它每次只作用于已加载的那部分树。

写路径只有一条：UI 编辑 → 改内存 `Spec` → `serializeSpec` → 写 `.folderspec.md`。

### Session

`packages/core/src/session.ts` 是宿主无关的会话控制器，两个宿主都通过 `session.handle(method, params)` 复用同一套逻辑，宿主本身只剩一层薄壳。

`Session` 自己**不处理换工作区**——`workspace/open` 只重扫它自己的 root。切换根目录 = 由宿主换一个新 `Session`（见 `cli/src/server.ts`）。

会话内的 `hidden` 集合记录当次拖拽的旧位置，是临时 UI 状态，`open()` 时清空，永不落盘（对应不变量 2）。

### `.folderspec.md` 格式

单文件三区，各用各的强项（详见设计文档 §4）：

- **结构区**：Markdown 嵌套列表。一行一节点，`<2n空格>- \`名称/\` \`[role:x]\` — 注释`。缩进必须是 2 的倍数且不得跳级；注释分隔符是 ` — `（空格 + U+2014 EM DASH + 空格），首次出现的那个生效。
- **模板区 / 规则区**：内嵌 YAML 块。规则是横切的（有 id、glob scope、severity），挂不到任何单个树节点上。

解析器分四个文件：`parse/sections.ts`（切三区）→ `structure.ts` / `templates.ts` / `rules.ts`，`parse/index.ts` 串联。**写入端保证格式规范，读取端容错并报行号**——错误必须带上行号，不能崩溃、不能静默丢数据。

`Session.annotate` 在输入边界就拦下会破坏格式的值：`role`/`template` 含反引号、`]`、空白 → 直接报错（悄悄改掉一个标识符比报错更糟）；注释里的换行 → 归一化为空格（面板是 textarea，用户按回车是自然动作）。

### 性能约束

目标：10 万文件仓库首屏 < 200ms。手段：首屏只扫 depth=2（`DEFAULT_DEPTH`）、展开时按需扫；`ignore` 规则做**目录级剪枝**（命中即整棵不进入）；git 状态一次 `git status --porcelain=v2 -z --untracked-files=all --ignored=matching` 批量拿三态，**绝不逐文件查询**；react-arborist 虚拟化；序列化复杂度是 O(标注节点数) 而非 O(仓库文件数)。

单目录超过 `MAX_CHILDREN`(10k) 截断并打标；readdir 失败（通常是权限）标 `unreadable` 继续走，不中断；符号链接默认不跟随。

## 约定

**中文。** 代码注释、错误信息、UI 文案、commit 说明全是中文。commit 用 conventional commits 前缀 + 中文主题：`feat(core): 三源合成 merge 纯函数`。

**注释解释"为什么"，不解释"做什么"。** 现有代码里的长注释几乎都在记录一次踩坑或一条裁定（例如 `cli/src/server.ts` 里为什么 `decodeURIComponent` 必须包在 try 里、`ui/src/AnnotationPanel.tsx` 里为什么 useEffect 依赖只能是 `node?.path`）。**别把这类注释删成一行**——它们是防止后人"修回去"的唯一屏障。

**TDD，先测后码。** `core` 覆盖率目标 100%。

**回归测试必须做 RED/GREEN 实证。** 项目记录里出现过**六次**"回归测试无法侦测它要防的回归"（见 `.superpowers/sdd/*/progress.md`）。补回归测试时，必须先施加它要防的那个单点变异、亲眼看它变红，再恢复看它变绿。口头断言不作数。

关键测试：`core/src/roundtrip.test.ts` 用 fast-check 做 property test——随机 `Spec` → serialize → parse → 必须严格等于原对象。**这条保护的正是"不丢注释"这个最关键的不变量，改序列化或解析器时它是第一道闸门。**
