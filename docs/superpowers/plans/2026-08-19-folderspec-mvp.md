# FolderSpec MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个只读的可视化工具，让人类以最低成本把仓库的结构意图（目录职责、结构规则、目录模板）声明进单个 `.folderspec.md` 文件，供 AI Agent 长期遵守。

**Architecture:** pnpm monorepo，四个包，依赖单向。`@folderspec/core` 是纯 TypeScript 逻辑层（扫描、git 状态、契约文件解析/序列化、三源合成、会话控制），不含 UI 也不含宿主 API；`@folderspec/ui` 是 React SPA，只通过 `Bridge` 接口收发消息，永远不知道自己跑在哪；`vscode/` 与 `cli/` 是两层各约 200–300 行的薄壳宿主，各自把 `Bridge` 接到 `core.Session` 上。

**Tech Stack:** TypeScript (strict, ESM) · Node ≥ 20 · pnpm workspaces · Vitest + fast-check · React 18 + react-arborist · yaml · ignore · Vite · esbuild · @vscode/test-electron

**Spec:** [`docs/superpowers/specs/2026-08-19-folderspec-design.md`](../specs/2026-08-19-folderspec-design.md)

## Global Constraints

这些约束隐含地属于每一个任务的验收条件。

- **Node ≥ 20**，全部包 `"type": "module"`（ESM），TypeScript `strict: true`。
- **只读铁律**：整个程序只允许写入 `.folderspec.md` 一个文件。任何任务中出现 `fs.rename` / `fs.mkdir` / `fs.rm` / `fs.unlink`（测试夹具搭建除外）即为实现错误。
- **包边界**：`core` 不得 import 任何 DOM、`vscode`、`react` 相关模块。`ui` 不得 import 任何 Node 内置模块（`node:fs`、`node:path`、`node:child_process` 等）。`ui` 只能从 `@folderspec/core/api` 这个**纯类型子路径**导入类型。
- **路径规范**：所有对外暴露的路径一律是**相对于工作区根、使用 posix 分隔符 `/`** 的字符串。根节点自身的 path 是空字符串 `''`。Windows 上的 `\` 必须在进入 core 边界时转换。
- **不可计算的区分一律不做**：设计文档 §3.2、§4.3、§6 已三次删除"看似有用但工具算不出来"的状态（`moved-from`、`[planned]` 标签、`planned`/`missing` 二分）。新增任何字段前先自问：重新加载文件后，仅凭 spec 文件 + 磁盘扫描能否算出它？不能就不要存。
- **注释不可丢**：解析失败时**绝不**用空 spec 覆盖用户文件；写盘前**必须**先 `serialize → parse` 自校验。
- **契约文件的规范章节标题**是中文（`## 结构` / `## 模板` / `## 规则`）；解析器额外接受英文别名（`## Structure` / `## Templates` / `## Rules`），序列化器只输出中文。

## 与 spec 的一处实现偏离

设计文档 §5.1 选定 `fdir` 做目录遍历。实现改用 **`node:fs.readdir` 递归**（Task 6），理由：

1. 需要**逐目录**组合 `.gitignore`（`fdir` 的 `exclude` 回调是同步的，无法在其中读文件）；
2. 需要**逐目录**处理权限错误与 >10k 子项截断，`fdir` 的扁平输出难以承载这两种逐目录状态；
3. 默认扫描深度只有 2，热路径极小，`readdir` + `withFileTypes`（免 stat）已足够快。

`fdir` 保留为二期功能 17（全量后台扫描）的优化选项。

第二处：设计文档 §9 的扫描器测试写的是 `memfs`，计划改用**真实临时目录**（`fs.mkdtemp`）。理由是本任务要覆盖权限拒绝、符号链接、超大目录三类边界，它们都依赖真实文件系统语义；`memfs` 对这些的模拟本身就是需要被信任的一层假设。代价是测试稍慢（建 1 万个文件约 10 秒）且权限那条在 Windows 上需跳过——已在 Task 6 中注明。

## File Structure

```
package.json                              根：workspaces + 统一脚本
pnpm-workspace.yaml
tsconfig.base.json                        共享编译选项

packages/core/
  package.json                            双导出：'.' 与 './api'（纯类型）
  src/api.ts                              纯类型：Api 方法表、Bridge 接口。ui 唯一可 import 的 core 文件
  src/types.ts                            Spec/SpecNode/Template/Rule/ActualNode/GitState/ViewNode/Result
  src/parse/sections.ts                   文档分区：front-matter / 标题 / 引言 / 三个区块
  src/parse/structure.ts                  结构区行语法解析
  src/parse/templates.ts                  模板区 YAML 解析与校验
  src/parse/rules.ts                      规则区 YAML 解析与校验
  src/parse/index.ts                      parseSpec：串起上面四个
  src/serialize.ts                        serializeSpec
  src/scan.ts                             目录扫描 + gitignore 分层过滤
  src/git.ts                              git status --porcelain=v2 解析
  src/merge.ts                            纯函数：三源合成 ViewNode 树
  src/spec-edit.ts                        纯函数：对 Spec 做注释/移动编辑
  src/session.ts                          Session：Api 的宿主无关实现
  src/index.ts                            公开导出

packages/ui/
  src/bridge.ts                           Bridge 类型再导出 + InMemoryBridge（测试用）
  src/App.tsx                             布局：左树 + 右面板
  src/Tree.tsx                            react-arborist 树 + 拖拽
  src/NodeRow.tsx                         单行渲染 + 着色
  src/AnnotationPanel.tsx                 右侧常驻注释面板
  src/Toolbar.tsx                         工作区载入 + 搜索框
  src/colors.ts                           git 状态与 severity 的颜色映射（CSS 变量名）
  src/main.tsx                            入口：从 window 取 Bridge 实现并挂载

packages/vscode/
  src/extension.ts                        activate + CustomTextEditorProvider 注册
  src/editor.ts                           FolderSpecEditorProvider：webview ↔ Session 桥接
  package.json                            customEditors 贡献点，filenamePattern: .folderspec.md

packages/cli/
  src/main.ts                             参数解析 + 启动
  src/server.ts                           http 静态服务 + WebSocket ↔ Session 桥接
  src/open-window.ts                      浏览器 --app 无边框窗口，带回退
```

---

## Phase A — `@folderspec/core`（Task 1–9）

产出一个可独立发布、100% 单测覆盖的纯逻辑库。Phase A 结束时，`core` 能完整走通"扫描 → 读契约 → 合成视图 → 改注释 → 存盘"，但还没有界面。

---

### Task 1: monorepo 脚手架

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/vitest.config.ts`
- Create: `packages/core/src/index.ts`
- Test: `packages/core/src/index.test.ts`
- Modify: `.gitignore`（追加 `node_modules/`、`dist/`）

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: 可运行的 `pnpm test`、`pnpm typecheck`、`pnpm build`；`@folderspec/core` 导出 `CORE_VERSION: string`

- [ ] **Step 1: 写失败的测试**

`packages/core/src/index.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { CORE_VERSION } from './index.js'

describe('@folderspec/core', () => {
  it('导出版本号', () => {
    expect(CORE_VERSION).toBe('0.1.0')
  })
})
```

- [ ] **Step 2: 建立工作区文件**

`package.json`：

```json
{
  "name": "folderspec-monorepo",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "pnpm -r test",
    "build": "pnpm -r build",
    "typecheck": "pnpm -r typecheck"
  },
  "devDependencies": {
    "typescript": "^5.6.3",
    "vitest": "^2.1.8"
  }
}
```

`pnpm-workspace.yaml`：

```yaml
packages:
  - 'packages/*'
```

`tsconfig.base.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "verbatimModuleSyntax": true
  }
}
```

`packages/core/package.json`：

```json
{
  "name": "@folderspec/core",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./api": { "types": "./dist/api.d.ts", "default": "./dist/api.js" }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.6.3",
    "vitest": "^2.1.8"
  }
}
```

`packages/core/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"]
}
```

`packages/core/vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['src/**/*.test.ts'] },
})
```

`packages/core/src/index.ts`：

```ts
export const CORE_VERSION = '0.1.0'
```

追加到 `.gitignore`：

```
node_modules/
dist/
```

- [ ] **Step 3: 安装依赖并运行测试**

```bash
pnpm install
pnpm -C packages/core test
```

预期：1 个测试通过。

- [ ] **Step 4: 验证类型检查通过**

```bash
pnpm typecheck
```

预期：无输出、退出码 0。

- [ ] **Step 5: 提交**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json packages/core .gitignore
git commit -m "chore: monorepo 脚手架与 @folderspec/core 骨架"
```

---

### Task 2: 核心类型与文档分区

**Files:**
- Create: `packages/core/src/types.ts`
- Create: `packages/core/src/parse/sections.ts`
- Test: `packages/core/src/parse/sections.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: Task 1 的工作区
- Produces:
  - `type Severity = 'error' | 'warning' | 'advisory'`
  - `interface SpecNode { name: string; isDir: boolean; role?: string; template?: string; severity?: Severity; annotation?: string; children: SpecNode[] }`
  - `interface TemplateChild { name: string; isDir: boolean; role?: string; required: boolean }`
  - `interface Template { name: string; description?: string; rootVariable?: string; rootNaming?: string; children: TemplateChild[]; exemplar: string[] }`
  - `interface Rule { id: string; severity: Severity; scope: string; text: string }`
  - `interface Spec { version: number; root: string; ownership: string; title: string; preamble: string[]; nodes: SpecNode[]; templates: Template[]; rules: Rule[] }`
  - `interface ParseError { line: number; message: string }`
  - `type Result<T> = { ok: true; value: T } | { ok: false; errors: ParseError[] }`
  - `interface RawSections { frontMatter: Record<string, string>; title: string; preamble: string[]; structure: Line[]; templatesYaml: { text: string; startLine: number } | null; rulesYaml: { text: string; startLine: number } | null }`
  - `interface Line { line: number; text: string }`
  - `function splitSections(md: string): Result<RawSections>`

- [ ] **Step 1: 写失败的测试**

`packages/core/src/parse/sections.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { splitSections } from './sections.js'

const DOC = [
  '---',
  'folderspec: 1',
  'root: .',
  'ownership: human',
  '---',
  '',
  '# 仓库结构契约',
  '',
  '> 本文件声明结构意图。',
  '> Agent 不应自行修改本文件。',
  '',
  '## 结构',
  '',
  '- `src/` — 核心源码',
  '',
  '## 模板',
  '',
  '```yaml',
  'case:',
  '  description: 一个案例',
  '```',
  '',
  '## 规则',
  '',
  '```yaml',
  '- id: r1',
  '```',
  '',
].join('\n')

describe('splitSections', () => {
  it('切出 front-matter、标题、引言、三个区块', () => {
    const r = splitSections(DOC)
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    expect(r.value.frontMatter).toEqual({ folderspec: '1', root: '.', ownership: 'human' })
    expect(r.value.title).toBe('仓库结构契约')
    expect(r.value.preamble).toEqual(['本文件声明结构意图。', 'Agent 不应自行修改本文件。'])
    expect(r.value.structure).toEqual([{ line: 14, text: '- `src/` — 核心源码' }])
    expect(r.value.templatesYaml?.text).toBe('case:\n  description: 一个案例')
    expect(r.value.templatesYaml?.startLine).toBe(19)
    expect(r.value.rulesYaml?.text).toBe('- id: r1')
  })

  it('接受英文章节别名', () => {
    const doc = DOC.replace('## 结构', '## Structure')
    const r = splitSections(doc)
    expect(r.ok).toBe(true)
  })

  it('缺少 front-matter 时报第 1 行', () => {
    const r = splitSections('# 标题\n\n## 结构\n')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toEqual({ line: 1, message: '文件必须以 --- 开头的 YAML front-matter 起始' })
  })

  it('缺少结构区时报错', () => {
    const doc = ['---', 'folderspec: 1', '---', '', '# 标题', ''].join('\n')
    const r = splitSections(doc)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].message).toContain('缺少 "## 结构" 区块')
  })

  it('模板区不是 yaml 代码块时报行号', () => {
    const doc = DOC.replace('```yaml\ncase:', '```\ncase:')
    const r = splitSections(doc)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].message).toContain('必须是 ```yaml 代码块')
  })

  it('templates/rules 区块缺失时为 null 而非报错', () => {
    const doc = DOC.slice(0, DOC.indexOf('## 模板'))
    const r = splitSections(doc)
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    expect(r.value.templatesYaml).toBeNull()
    expect(r.value.rulesYaml).toBeNull()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm -C packages/core test
```

预期：FAIL，`Failed to resolve import "./sections.js"`。

- [ ] **Step 3: 写类型定义**

`packages/core/src/types.ts`：

```ts
export type Severity = 'error' | 'warning' | 'advisory'

export interface SpecNode {
  name: string
  isDir: boolean
  role?: string
  template?: string
  severity?: Severity
  annotation?: string
  children: SpecNode[]
}

export interface TemplateChild {
  name: string
  isDir: boolean
  role?: string
  required: boolean
}

export interface Template {
  name: string
  description?: string
  rootVariable?: string
  rootNaming?: string
  children: TemplateChild[]
  exemplar: string[]
}

export interface Rule {
  id: string
  severity: Severity
  scope: string
  text: string
}

export interface Spec {
  version: number
  root: string
  ownership: string
  title: string
  preamble: string[]
  nodes: SpecNode[]
  templates: Template[]
  rules: Rule[]
}

export interface ParseError {
  line: number
  message: string
}

export type Result<T> = { ok: true; value: T } | { ok: false; errors: ParseError[] }

export interface Line {
  line: number
  text: string
}

export interface YamlBlock {
  text: string
  startLine: number
}

export interface RawSections {
  frontMatter: Record<string, string>
  title: string
  preamble: string[]
  structure: Line[]
  templatesYaml: YamlBlock | null
  rulesYaml: YamlBlock | null
}

export const SEVERITIES: readonly Severity[] = ['error', 'warning', 'advisory']

export function isSeverity(v: unknown): v is Severity {
  return typeof v === 'string' && (SEVERITIES as readonly string[]).includes(v)
}
```

- [ ] **Step 4: 写分区实现**

`packages/core/src/parse/sections.ts`：

```ts
import type { Line, ParseError, RawSections, Result, YamlBlock } from '../types.js'

const SECTION_ALIASES: Record<string, 'structure' | 'templates' | 'rules'> = {
  '结构': 'structure',
  'Structure': 'structure',
  '模板': 'templates',
  'Templates': 'templates',
  '规则': 'rules',
  'Rules': 'rules',
}

export function splitSections(md: string): Result<RawSections> {
  const errors: ParseError[] = []
  const lines = md.split('\n')
  let i = 0

  // ---- front-matter ----
  if (lines[0]?.trim() !== '---') {
    return { ok: false, errors: [{ line: 1, message: '文件必须以 --- 开头的 YAML front-matter 起始' }] }
  }
  const frontMatter: Record<string, string> = {}
  i = 1
  let closed = false
  for (; i < lines.length; i++) {
    const t = lines[i]
    if (t.trim() === '---') { closed = true; i++; break }
    const idx = t.indexOf(':')
    if (idx === -1) {
      errors.push({ line: i + 1, message: `front-matter 行必须是 "键: 值"，实际是 "${t}"` })
      continue
    }
    frontMatter[t.slice(0, idx).trim()] = t.slice(idx + 1).trim()
  }
  if (!closed) {
    return { ok: false, errors: [{ line: 1, message: 'front-matter 缺少收尾的 ---' }] }
  }

  // ---- 标题 ----
  let title = ''
  for (; i < lines.length; i++) {
    const t = lines[i]
    if (t.trim() === '') continue
    if (t.startsWith('# ')) { title = t.slice(2).trim(); i++ }
    break
  }

  // ---- 引言（连续的 > 行）----
  const preamble: string[] = []
  for (; i < lines.length; i++) {
    const t = lines[i]
    if (t.trim() === '') { if (preamble.length) break; continue }
    if (!t.startsWith('>')) break
    preamble.push(t.replace(/^>\s?/, '').trimEnd())
  }

  // ---- 三个区块 ----
  const structure: Line[] = []
  let templatesYaml: YamlBlock | null = null
  let rulesYaml: YamlBlock | null = null
  let current: 'structure' | 'templates' | 'rules' | null = null
  let seenStructure = false

  for (; i < lines.length; i++) {
    const t = lines[i]
    const h = /^## +(.+?) *$/.exec(t)
    if (h) {
      const kind = SECTION_ALIASES[h[1]]
      if (!kind) {
        errors.push({ line: i + 1, message: `未知区块标题 "## ${h[1]}"，只允许 结构/模板/规则` })
        current = null
        continue
      }
      current = kind
      if (kind === 'structure') seenStructure = true
      continue
    }
    if (current === 'structure') {
      if (t.trim() !== '') structure.push({ line: i + 1, text: t })
      continue
    }
    if (current === 'templates' || current === 'rules') {
      if (t.trim() === '') continue
      if (!/^```ya?ml\s*$/.test(t.trim())) {
        if (t.trim().startsWith('```')) {
          errors.push({ line: i + 1, message: '模板区与规则区必须是 ```yaml 代码块' })
        } else {
          errors.push({ line: i + 1, message: `区块内只允许 \`\`\`yaml 代码块，实际是 "${t.trim()}"` })
        }
        current = null
        continue
      }
      const startLine = i + 2
      const body: string[] = []
      i++
      let fenceClosed = false
      for (; i < lines.length; i++) {
        if (lines[i].trim() === '```') { fenceClosed = true; break }
        body.push(lines[i])
      }
      if (!fenceClosed) {
        errors.push({ line: startLine, message: 'yaml 代码块缺少收尾的 ```' })
        continue
      }
      const block: YamlBlock = { text: body.join('\n').replace(/\n+$/, ''), startLine }
      if (current === 'templates') templatesYaml = block
      else rulesYaml = block
      current = null
    }
  }

  if (!seenStructure) {
    errors.push({ line: lines.length, message: '缺少 "## 结构" 区块' })
  }
  if (errors.length) return { ok: false, errors }
  return { ok: true, value: { frontMatter, title, preamble, structure, templatesYaml, rulesYaml } }
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
pnpm -C packages/core test
```

预期：sections.test.ts 6 个测试全部 PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/types.ts packages/core/src/parse/sections.ts packages/core/src/parse/sections.test.ts
git commit -m "feat(core): 核心类型定义与 .folderspec.md 文档分区"
```

---

### Task 3: 结构区行语法解析

**Files:**
- Create: `packages/core/src/parse/structure.ts`
- Test: `packages/core/src/parse/structure.test.ts`

**Interfaces:**
- Consumes: `Line`, `SpecNode`, `Result`, `ParseError`, `isSeverity`（Task 2）
- Produces: `function parseStructure(lines: Line[]): Result<SpecNode[]>`

行语法（spec §4.3）：

```
<缩进(2的倍数)><"- "><`名称`>[ <`[标签]`>]*[ " — " <注释>]
```

已定义标签只有三个：`[role:x]`、`[template:x]`、`[severity:error|warning|advisory]`。**未知标签必须报错而非忽略**——静默忽略等于丢数据。

- [ ] **Step 1: 写失败的测试**

`packages/core/src/parse/structure.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { parseStructure } from './structure.js'
import type { Line } from '../types.js'

const L = (...texts: string[]): Line[] => texts.map((text, k) => ({ line: k + 1, text }))

describe('parseStructure', () => {
  it('解析单个目录节点与注释', () => {
    const r = parseStructure(L('- `src/` — 核心源码'))
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    expect(r.value).toEqual([
      { name: 'src', isDir: true, annotation: '核心源码', children: [] },
    ])
  })

  it('文件节点不带尾斜杠', () => {
    const r = parseStructure(L('- `README.md` — 说明'))
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    expect(r.value[0].isDir).toBe(false)
    expect(r.value[0].name).toBe('README.md')
  })

  it('无注释的节点 annotation 为 undefined', () => {
    const r = parseStructure(L('- `docs/`'))
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    expect(r.value[0].annotation).toBeUndefined()
  })

  it('解析两层嵌套', () => {
    const r = parseStructure(L(
      '- `src/` — 源码',
      '  - `core/` — 内核',
      '    - `walk.ts` — 遍历',
      '- `docs/`',
    ))
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    expect(r.value).toHaveLength(2)
    expect(r.value[0].children[0].name).toBe('core')
    expect(r.value[0].children[0].children[0].name).toBe('walk.ts')
    expect(r.value[1].name).toBe('docs')
  })

  it('解析三种标签', () => {
    const r = parseStructure(L(
      '- `cases/` `[role:case-root]` — 案例根',
      '  - `{case-name}/` `[template:case]` `[severity:error]` — 案例目录',
    ))
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    expect(r.value[0].role).toBe('case-root')
    const child = r.value[0].children[0]
    expect(child.name).toBe('{case-name}')
    expect(child.template).toBe('case')
    expect(child.severity).toBe('error')
  })

  it('注释正文中的长破折号不再被当作分隔符', () => {
    const r = parseStructure(L('- `src/` — 源码 — 含子模块'))
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    expect(r.value[0].annotation).toBe('源码 — 含子模块')
  })

  it('奇数缩进报行号', () => {
    const r = parseStructure(L('- `src/`', '   - `core/`'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toEqual({ line: 2, message: '缩进必须是 2 的倍数，实际 3 个空格' })
  })

  it('缩进跳级报行号', () => {
    const r = parseStructure(L('- `src/`', '    - `deep/`'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].message).toContain('缩进跳级')
    expect(r.errors[0].line).toBe(2)
  })

  it('未知标签报行号而非静默忽略', () => {
    const r = parseStructure(L('- `src/` `[planned]` — 源码'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toEqual({ line: 1, message: '未知标签 [planned]，只允许 role/template/severity' })
  })

  it('非法 severity 报行号', () => {
    const r = parseStructure(L('- `src/` `[severity:fatal]`'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].message).toContain('severity 只能是 error/warning/advisory')
  })

  it('名称未用反引号包裹时报错', () => {
    const r = parseStructure(L('- src/ — 源码'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].message).toContain('节点名必须用反引号包裹')
  })

  it('文件节点下挂子节点时报错', () => {
    const r = parseStructure(L('- `a.txt`', '  - `b.txt`'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].message).toContain('不是目录，不能有子项')
  })

  it('分隔符不是 " — " 时报错', () => {
    const r = parseStructure(L('- `src/`: 源码'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].message).toContain('注释前必须是 " — "')
  })

  it('收集多行的多个错误', () => {
    const r = parseStructure(L('- `a/` `[bogus]`', '- `b/` `[severity:x]`'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors).toHaveLength(2)
    expect(r.errors.map(e => e.line)).toEqual([1, 2])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm -C packages/core test src/parse/structure.test.ts
```

预期：FAIL，`Failed to resolve import "./structure.js"`。

- [ ] **Step 3: 写实现**

`packages/core/src/parse/structure.ts`：

```ts
import { isSeverity } from '../types.js'
import type { Line, ParseError, Result, SpecNode } from '../types.js'

const BULLET_RE = /^( *)- (.*)$/
const NAME_RE = /^`([^`]+)`/
const TAG_RE = /^ +`\[([A-Za-z-]+)(?::([^\]]*))?\]`/

/** 注释分隔符：空格 + U+2014 EM DASH + 空格 */
export const ANNOTATION_SEPARATOR = ' — '

export function parseStructure(lines: Line[]): Result<SpecNode[]> {
  const errors: ParseError[] = []
  const roots: SpecNode[] = []
  const stack: SpecNode[] = []
  let prevDepth = -1

  for (const { line, text } of lines) {
    if (text.trim() === '') continue

    const bullet = BULLET_RE.exec(text)
    if (!bullet) {
      errors.push({ line, message: '结构行必须形如 "- `名称`"' })
      continue
    }
    const indent = bullet[1].length
    if (indent % 2 !== 0) {
      errors.push({ line, message: `缩进必须是 2 的倍数，实际 ${indent} 个空格` })
      continue
    }
    const depth = indent / 2
    if (depth > prevDepth + 1) {
      errors.push({ line, message: `缩进跳级：上一行深度 ${prevDepth}，本行深度 ${depth}` })
      continue
    }

    let rest = bullet[2]
    const nameMatch = NAME_RE.exec(rest)
    if (!nameMatch) {
      errors.push({ line, message: '节点名必须用反引号包裹，例如 `src/`' })
      continue
    }
    rest = rest.slice(nameMatch[0].length)
    const raw = nameMatch[1]
    const isDir = raw.endsWith('/')
    const name = isDir ? raw.slice(0, -1) : raw
    if (name === '') {
      errors.push({ line, message: '节点名为空' })
      continue
    }

    const node: SpecNode = { name, isDir, children: [] }

    let tagError = false
    for (;;) {
      const tag = TAG_RE.exec(rest)
      if (!tag) break
      rest = rest.slice(tag[0].length)
      const key = tag[1]
      const value = tag[2]
      if (key === 'role' || key === 'template') {
        if (!value) {
          errors.push({ line, message: `[${key}:...] 缺少取值` })
          tagError = true
          break
        }
        if (key === 'role') node.role = value
        else node.template = value
      } else if (key === 'severity') {
        if (!isSeverity(value)) {
          errors.push({ line, message: `severity 只能是 error/warning/advisory，实际 "${value ?? ''}"` })
          tagError = true
          break
        }
        node.severity = value
      } else {
        errors.push({ line, message: `未知标签 [${key}]，只允许 role/template/severity` })
        tagError = true
        break
      }
    }
    if (tagError) continue

    if (rest.length > 0) {
      if (!rest.startsWith(ANNOTATION_SEPARATOR)) {
        errors.push({ line, message: '注释前必须是 " — "（空格 + 长破折号 + 空格）' })
        continue
      }
      const annotation = rest.slice(ANNOTATION_SEPARATOR.length)
      if (annotation !== '') node.annotation = annotation
    }

    if (depth === 0) {
      roots.push(node)
    } else {
      const parent = stack[depth - 1]
      if (!parent) {
        errors.push({ line, message: '找不到父节点' })
        continue
      }
      if (!parent.isDir) {
        errors.push({ line, message: `父节点 \`${parent.name}\` 不是目录，不能有子项` })
        continue
      }
      parent.children.push(node)
    }
    stack[depth] = node
    stack.length = depth + 1
    prevDepth = depth
  }

  if (errors.length) return { ok: false, errors }
  return { ok: true, value: roots }
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pnpm -C packages/core test src/parse/structure.test.ts
```

预期：14 个测试全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/parse/structure.ts packages/core/src/parse/structure.test.ts
git commit -m "feat(core): 结构区行语法解析器"
```

---

### Task 4: 模板区与规则区 YAML 解析

**Files:**
- Create: `packages/core/src/parse/templates.ts`
- Create: `packages/core/src/parse/rules.ts`
- Create: `packages/core/src/parse/index.ts`
- Test: `packages/core/src/parse/templates.test.ts`
- Test: `packages/core/src/parse/rules.test.ts`
- Test: `packages/core/src/parse/index.test.ts`
- Modify: `packages/core/package.json`（加 `yaml` 依赖）

**Interfaces:**
- Consumes: `splitSections`（Task 2）、`parseStructure`（Task 3）、`YamlBlock`、`Template`、`Rule`
- Produces:
  - `function parseTemplates(block: YamlBlock | null): Result<Template[]>`
  - `function parseRules(block: YamlBlock | null): Result<Rule[]>`
  - `function parseSpec(markdown: string): Result<Spec>`

- [ ] **Step 1: 装依赖**

```bash
pnpm -C packages/core add yaml@^2.6.1
```

- [ ] **Step 2: 写失败的测试**

`packages/core/src/parse/templates.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { parseTemplates } from './templates.js'

const block = (text: string) => ({ text, startLine: 10 })

describe('parseTemplates', () => {
  it('null 区块返回空数组', () => {
    const r = parseTemplates(null)
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    expect(r.value).toEqual([])
  })

  it('解析完整模板', () => {
    const r = parseTemplates(block([
      'case:',
      '  description: 一个能独立运行的案例',
      '  root: { variable: case-name, naming: kebab-case }',
      '  children:',
      '    README.md: { role: case-documentation, required: true }',
      '    input/: { role: source-input, required: true }',
      '    notes.md: { required: false }',
      '  exemplar: [src/cases/basic-login]',
    ].join('\n')))
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    expect(r.value).toEqual([{
      name: 'case',
      description: '一个能独立运行的案例',
      rootVariable: 'case-name',
      rootNaming: 'kebab-case',
      children: [
        { name: 'README.md', isDir: false, role: 'case-documentation', required: true },
        { name: 'input', isDir: true, role: 'source-input', required: true },
        { name: 'notes.md', isDir: false, required: false },
      ],
      exemplar: ['src/cases/basic-login'],
    }])
  })

  it('省略的可选字段不出现在结果里', () => {
    const r = parseTemplates(block('bare:\n  children:\n    a.txt: { required: true }'))
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    expect(r.value[0]).toEqual({
      name: 'bare',
      children: [{ name: 'a.txt', isDir: false, required: true }],
      exemplar: [],
    })
  })

  it('YAML 语法错误换算成文件行号', () => {
    const r = parseTemplates(block('case:\n  - [unclosed'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].line).toBeGreaterThanOrEqual(10)
  })

  it('顶层不是映射时报错', () => {
    const r = parseTemplates(block('- a\n- b'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].message).toContain('模板区顶层必须是映射')
  })

  it('required 不是布尔时报错', () => {
    const r = parseTemplates(block('case:\n  children:\n    a.txt: { required: yes-please }'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].message).toContain('required 必须是 true 或 false')
  })

  it('exemplar 不是字符串数组时报错', () => {
    const r = parseTemplates(block('case:\n  children: {}\n  exemplar: 42'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].message).toContain('exemplar 必须是字符串数组')
  })
})
```

`packages/core/src/parse/rules.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { parseRules } from './rules.js'

const block = (text: string) => ({ text, startLine: 20 })

describe('parseRules', () => {
  it('null 区块返回空数组', () => {
    const r = parseRules(null)
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    expect(r.value).toEqual([])
  })

  it('解析规则列表', () => {
    const r = parseRules(block([
      '- id: case-location',
      '  severity: error',
      '  scope: "**"',
      '  text: 所有新案例必须在 src/cases 下',
      '- id: case-size',
      '  severity: warning',
      '  scope: "src/cases/*"',
      '  text: 直接子文件不宜超过 10 个',
    ].join('\n')))
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    expect(r.value).toHaveLength(2)
    expect(r.value[0]).toEqual({
      id: 'case-location', severity: 'error', scope: '**',
      text: '所有新案例必须在 src/cases 下',
    })
  })

  it('顶层不是序列时报错', () => {
    const r = parseRules(block('id: x'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].message).toContain('规则区顶层必须是序列')
  })

  it('id 重复时报错', () => {
    const r = parseRules(block([
      '- { id: dup, severity: error, scope: "**", text: a }',
      '- { id: dup, severity: error, scope: "**", text: b }',
    ].join('\n')))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].message).toContain('规则 id "dup" 重复')
  })

  it('缺少必填字段时逐条报错', () => {
    const r = parseRules(block('- { id: x, scope: "**" }'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    const msgs = r.errors.map(e => e.message).join(' | ')
    expect(msgs).toContain('severity')
    expect(msgs).toContain('text')
  })

  it('非法 severity 时报错', () => {
    const r = parseRules(block('- { id: x, severity: fatal, scope: "**", text: t }'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].message).toContain('severity 只能是 error/warning/advisory')
  })
})
```

`packages/core/src/parse/index.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { parseSpec } from './index.js'

const DOC = [
  '---',
  'folderspec: 1',
  'root: .',
  'ownership: human',
  '---',
  '',
  '# 仓库结构契约',
  '',
  '> Agent 不应自行修改本文件。',
  '',
  '## 结构',
  '',
  '- `src/` `[role:source-root]` — 核心源码',
  '  - `cases/` — 案例',
  '',
  '## 规则',
  '',
  '```yaml',
  '- { id: r1, severity: error, scope: "**", text: 规则一 }',
  '```',
  '',
].join('\n')

describe('parseSpec', () => {
  it('串起全部区块', () => {
    const r = parseSpec(DOC)
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    expect(r.value.version).toBe(1)
    expect(r.value.root).toBe('.')
    expect(r.value.ownership).toBe('human')
    expect(r.value.title).toBe('仓库结构契约')
    expect(r.value.preamble).toEqual(['Agent 不应自行修改本文件。'])
    expect(r.value.nodes[0].role).toBe('source-root')
    expect(r.value.nodes[0].children[0].name).toBe('cases')
    expect(r.value.templates).toEqual([])
    expect(r.value.rules).toHaveLength(1)
  })

  it('folderspec 版本号非 1 时报错', () => {
    const r = parseSpec(DOC.replace('folderspec: 1', 'folderspec: 2'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].message).toContain('不支持的 folderspec 版本')
  })

  it('把各区块的错误合并上报并按行号排序', () => {
    const bad = DOC
      .replace('- `src/` `[role:source-root]` — 核心源码', '- `src/` `[bogus]`')
      .replace('- { id: r1, severity: error, scope: "**", text: 规则一 }', '- { id: r1, scope: "**" }')
    const r = parseSpec(bad)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors.length).toBeGreaterThanOrEqual(2)
    const sorted = [...r.errors].sort((a, b) => a.line - b.line)
    expect(r.errors).toEqual(sorted)
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

```bash
pnpm -C packages/core test src/parse
```

预期：三个新测试文件都因模块解析失败而 FAIL。

- [ ] **Step 4: 写模板解析实现**

`packages/core/src/parse/templates.ts`：

```ts
import { parseDocument } from 'yaml'
import type { ParseError, Result, Template, TemplateChild, YamlBlock } from '../types.js'

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 把 yaml 块内的相对行号换算成整个文件的行号 */
function yamlErrors(doc: ReturnType<typeof parseDocument>, block: YamlBlock): ParseError[] {
  return doc.errors.map(e => ({
    line: block.startLine + (e.linePos?.[0].line ?? 1) - 1,
    message: `YAML 语法错误：${e.message}`,
  }))
}

export function parseTemplates(block: YamlBlock | null): Result<Template[]> {
  if (block === null) return { ok: true, value: [] }

  const doc = parseDocument(block.text)
  if (doc.errors.length) return { ok: false, errors: yamlErrors(doc, block) }

  const raw: unknown = doc.toJS()
  if (raw === null || raw === undefined) return { ok: true, value: [] }
  if (!isPlainObject(raw)) {
    return { ok: false, errors: [{ line: block.startLine, message: '模板区顶层必须是映射（模板名 → 定义）' }] }
  }

  const errors: ParseError[] = []
  const templates: Template[] = []

  for (const [name, def] of Object.entries(raw)) {
    if (!isPlainObject(def)) {
      errors.push({ line: block.startLine, message: `模板 "${name}" 的定义必须是映射` })
      continue
    }
    const tpl: Template = { name, children: [], exemplar: [] }

    if (def.description !== undefined) {
      if (typeof def.description !== 'string') {
        errors.push({ line: block.startLine, message: `模板 "${name}" 的 description 必须是字符串` })
      } else {
        tpl.description = def.description
      }
    }

    if (def.root !== undefined) {
      if (!isPlainObject(def.root)) {
        errors.push({ line: block.startLine, message: `模板 "${name}" 的 root 必须是映射` })
      } else {
        if (typeof def.root.variable === 'string') tpl.rootVariable = def.root.variable
        if (typeof def.root.naming === 'string') tpl.rootNaming = def.root.naming
      }
    }

    if (def.children !== undefined) {
      if (!isPlainObject(def.children)) {
        errors.push({ line: block.startLine, message: `模板 "${name}" 的 children 必须是映射` })
      } else {
        for (const [rawName, spec] of Object.entries(def.children)) {
          if (!isPlainObject(spec)) {
            errors.push({ line: block.startLine, message: `模板 "${name}" 的子项 "${rawName}" 必须是映射` })
            continue
          }
          if (typeof spec.required !== 'boolean') {
            errors.push({ line: block.startLine, message: `模板 "${name}" 子项 "${rawName}" 的 required 必须是 true 或 false` })
            continue
          }
          const isDir = rawName.endsWith('/')
          const child: TemplateChild = {
            name: isDir ? rawName.slice(0, -1) : rawName,
            isDir,
            required: spec.required,
          }
          if (spec.role !== undefined) {
            if (typeof spec.role !== 'string') {
              errors.push({ line: block.startLine, message: `模板 "${name}" 子项 "${rawName}" 的 role 必须是字符串` })
              continue
            }
            child.role = spec.role
          }
          tpl.children.push(child)
        }
      }
    }

    if (def.exemplar !== undefined) {
      if (!Array.isArray(def.exemplar) || def.exemplar.some(x => typeof x !== 'string')) {
        errors.push({ line: block.startLine, message: `模板 "${name}" 的 exemplar 必须是字符串数组` })
      } else {
        tpl.exemplar = def.exemplar as string[]
      }
    }

    templates.push(tpl)
  }

  if (errors.length) return { ok: false, errors }
  return { ok: true, value: templates }
}
```

- [ ] **Step 5: 写规则解析实现**

`packages/core/src/parse/rules.ts`：

```ts
import { parseDocument } from 'yaml'
import { isSeverity } from '../types.js'
import type { ParseError, Result, Rule, YamlBlock } from '../types.js'

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function parseRules(block: YamlBlock | null): Result<Rule[]> {
  if (block === null) return { ok: true, value: [] }

  const doc = parseDocument(block.text)
  if (doc.errors.length) {
    return {
      ok: false,
      errors: doc.errors.map(e => ({
        line: block.startLine + (e.linePos?.[0].line ?? 1) - 1,
        message: `YAML 语法错误：${e.message}`,
      })),
    }
  }

  const raw: unknown = doc.toJS()
  if (raw === null || raw === undefined) return { ok: true, value: [] }
  if (!Array.isArray(raw)) {
    return { ok: false, errors: [{ line: block.startLine, message: '规则区顶层必须是序列（每条规则一个 - 项）' }] }
  }

  const errors: ParseError[] = []
  const rules: Rule[] = []
  const seen = new Set<string>()

  raw.forEach((item, idx) => {
    const at = { line: block.startLine + idx }
    if (!isPlainObject(item)) {
      errors.push({ ...at, message: `第 ${idx + 1} 条规则必须是映射` })
      return
    }
    const id = item.id
    if (typeof id !== 'string' || id === '') {
      errors.push({ ...at, message: `第 ${idx + 1} 条规则缺少非空的 id` })
      return
    }
    if (seen.has(id)) {
      errors.push({ ...at, message: `规则 id "${id}" 重复` })
      return
    }
    seen.add(id)

    let bad = false
    if (!isSeverity(item.severity)) {
      errors.push({ ...at, message: `规则 "${id}" 的 severity 只能是 error/warning/advisory` })
      bad = true
    }
    if (typeof item.scope !== 'string' || item.scope === '') {
      errors.push({ ...at, message: `规则 "${id}" 缺少非空的 scope（glob 表达式）` })
      bad = true
    }
    if (typeof item.text !== 'string' || item.text === '') {
      errors.push({ ...at, message: `规则 "${id}" 缺少非空的 text` })
      bad = true
    }
    if (bad) return

    rules.push({
      id,
      severity: item.severity as Rule['severity'],
      scope: item.scope as string,
      text: item.text as string,
    })
  })

  if (errors.length) return { ok: false, errors }
  return { ok: true, value: rules }
}
```

- [ ] **Step 6: 写 parseSpec 串联**

`packages/core/src/parse/index.ts`：

```ts
import { splitSections } from './sections.js'
import { parseStructure } from './structure.js'
import { parseTemplates } from './templates.js'
import { parseRules } from './rules.js'
import type { ParseError, Result, Spec } from '../types.js'

export { splitSections } from './sections.js'
export { parseStructure, ANNOTATION_SEPARATOR } from './structure.js'
export { parseTemplates } from './templates.js'
export { parseRules } from './rules.js'

export const SUPPORTED_VERSION = 1

export function parseSpec(markdown: string): Result<Spec> {
  const sections = splitSections(markdown)
  if (!sections.ok) return sections
  const s = sections.value

  const errors: ParseError[] = []

  const version = Number(s.frontMatter.folderspec)
  if (!Number.isInteger(version) || version !== SUPPORTED_VERSION) {
    errors.push({ line: 2, message: `不支持的 folderspec 版本 "${s.frontMatter.folderspec ?? ''}"，本工具支持 ${SUPPORTED_VERSION}` })
  }

  const nodes = parseStructure(s.structure)
  if (!nodes.ok) errors.push(...nodes.errors)

  const templates = parseTemplates(s.templatesYaml)
  if (!templates.ok) errors.push(...templates.errors)

  const rules = parseRules(s.rulesYaml)
  if (!rules.ok) errors.push(...rules.errors)

  if (errors.length) {
    errors.sort((a, b) => a.line - b.line)
    return { ok: false, errors }
  }

  return {
    ok: true,
    value: {
      version,
      root: s.frontMatter.root ?? '.',
      ownership: s.frontMatter.ownership ?? 'human',
      title: s.title,
      preamble: s.preamble,
      nodes: (nodes as { ok: true; value: Spec['nodes'] }).value,
      templates: (templates as { ok: true; value: Spec['templates'] }).value,
      rules: (rules as { ok: true; value: Spec['rules'] }).value,
    },
  }
}
```

- [ ] **Step 7: 运行测试确认通过**

```bash
pnpm -C packages/core test src/parse
```

预期：sections 6 + structure 14 + templates 7 + rules 6 + index 3 = 36 个测试全部 PASS。

- [ ] **Step 8: 提交**

```bash
git add packages/core/package.json packages/core/src/parse
git commit -m "feat(core): 模板区与规则区 YAML 解析，parseSpec 串联全部区块"
```

---

### Task 5: 序列化与 round-trip property test

这是**整个项目最关键的一个任务**。round-trip property test 保护的是"人工书写的注释永不丢失"这个不变量（spec §9）。

**Files:**
- Create: `packages/core/src/serialize.ts`
- Test: `packages/core/src/serialize.test.ts`
- Test: `packages/core/src/roundtrip.test.ts`
- Modify: `packages/core/package.json`（加 `fast-check` 开发依赖）

**Interfaces:**
- Consumes: `Spec`、`SpecNode`、`Template`、`Rule`（Task 2）、`parseSpec`、`ANNOTATION_SEPARATOR`（Task 4）
- Produces: `function serializeSpec(spec: Spec): string`

**注释首尾空白的规范**：序列化时对 `annotation` 做 `trim()`。行尾空白在任何编辑器里都不可靠，把它当有效数据是自找麻烦。这条规范让 round-trip 对"已归一化的 Spec"成立。

- [ ] **Step 1: 装依赖**

```bash
pnpm -C packages/core add -D fast-check@^3.23.1
```

- [ ] **Step 2: 写失败的单元测试**

`packages/core/src/serialize.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { serializeSpec } from './serialize.js'
import type { Spec } from './types.js'

const base: Spec = {
  version: 1, root: '.', ownership: 'human',
  title: '仓库结构契约', preamble: ['Agent 不应自行修改本文件。'],
  nodes: [], templates: [], rules: [],
}

describe('serializeSpec', () => {
  it('输出 front-matter、标题、引言与结构区', () => {
    const out = serializeSpec({
      ...base,
      nodes: [{ name: 'src', isDir: true, annotation: '核心源码', children: [] }],
    })
    expect(out).toBe([
      '---',
      'folderspec: 1',
      'root: .',
      'ownership: human',
      '---',
      '',
      '# 仓库结构契约',
      '',
      '> Agent 不应自行修改本文件。',
      '',
      '## 结构',
      '',
      '- `src/` — 核心源码',
      '',
    ].join('\n'))
  })

  it('标签按 role → template → severity 的固定顺序输出', () => {
    const out = serializeSpec({
      ...base,
      nodes: [{
        name: 'cases', isDir: true, severity: 'error',
        template: 'case', role: 'case-root', children: [],
      }],
    })
    expect(out).toContain('- `cases/` `[role:case-root]` `[template:case]` `[severity:error]`')
  })

  it('嵌套按 2 空格缩进', () => {
    const out = serializeSpec({
      ...base,
      nodes: [{
        name: 'src', isDir: true, children: [
          { name: 'core', isDir: true, children: [
            { name: 'a.ts', isDir: false, annotation: '入口', children: [] },
          ] },
        ],
      }],
    })
    expect(out).toContain('- `src/`\n  - `core/`\n    - `a.ts` — 入口')
  })

  it('去除注释首尾空白', () => {
    const out = serializeSpec({
      ...base,
      nodes: [{ name: 'src', isDir: true, annotation: '  有空白  ', children: [] }],
    })
    expect(out).toContain('- `src/` — 有空白\n')
  })

  it('templates 为空时不输出模板区', () => {
    const out = serializeSpec(base)
    expect(out).not.toContain('## 模板')
    expect(out).not.toContain('## 规则')
  })

  it('输出模板区与规则区', () => {
    const out = serializeSpec({
      ...base,
      templates: [{
        name: 'case', description: '一个案例',
        rootVariable: 'case-name', rootNaming: 'kebab-case',
        children: [
          { name: 'README.md', isDir: false, role: 'case-documentation', required: true },
          { name: 'input', isDir: true, required: false },
        ],
        exemplar: ['src/cases/basic-login'],
      }],
      rules: [{ id: 'r1', severity: 'error', scope: '**', text: '规则一' }],
    })
    expect(out).toContain('## 模板')
    expect(out).toContain('```yaml')
    expect(out).toContain('README.md:')
    expect(out).toContain('input/:')
    expect(out).toContain('## 规则')
    expect(out).toContain('id: r1')
  })
})
```

- [ ] **Step 3: 写失败的 round-trip property test**

`packages/core/src/roundtrip.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { serializeSpec } from './serialize.js'
import { parseSpec } from './parse/index.js'
import type { Rule, Spec, SpecNode, Template } from './types.js'

const chars = (pool: string, min: number, max: number) =>
  fc.array(fc.constantFrom(...pool.split('')), { minLength: min, maxLength: max })
    .map(a => a.join(''))

const nameArb = chars('abzAZ09._-{}', 1, 10)
const identArb = chars('abz09-', 1, 8).filter(s => s !== '')
const textArb = chars('ab中文 ,.—!', 1, 20).map(s => s.trim()).filter(s => s !== '')

const nodeArb: fc.Arbitrary<SpecNode> = fc.letrec<{ node: SpecNode }>(tie => ({
  node: fc.record({
    name: nameArb,
    isDir: fc.boolean(),
    role: fc.option(identArb, { nil: undefined }),
    template: fc.option(identArb, { nil: undefined }),
    severity: fc.option(fc.constantFrom('error' as const, 'warning' as const, 'advisory' as const), { nil: undefined }),
    annotation: fc.option(textArb, { nil: undefined }),
    children: fc.oneof(
      { depthSize: 'small' },
      fc.constant([] as SpecNode[]),
      fc.array(tie('node'), { maxLength: 3 }),
    ),
  }).map(n => (n.isDir ? n : { ...n, children: [] })),
})).node

const templateArb: fc.Arbitrary<Template> = fc.record({
  name: identArb,
  description: fc.option(textArb, { nil: undefined }),
  rootVariable: fc.option(identArb, { nil: undefined }),
  rootNaming: fc.option(identArb, { nil: undefined }),
  children: fc.array(fc.record({
    name: nameArb,
    isDir: fc.boolean(),
    role: fc.option(identArb, { nil: undefined }),
    required: fc.boolean(),
  }), { maxLength: 4 }),
  exemplar: fc.array(chars('abz/-', 1, 12), { maxLength: 3 }),
}).map(t => ({
  ...t,
  // 同名子项在 YAML 映射里会互相覆盖，生成器层面去重
  children: t.children.filter((c, i, all) =>
    all.findIndex(o => o.name === c.name && o.isDir === c.isDir) === i),
}))

const ruleArb: fc.Arbitrary<Rule> = fc.record({
  id: identArb,
  severity: fc.constantFrom('error' as const, 'warning' as const, 'advisory' as const),
  scope: chars('abz/*-', 1, 10).filter(s => s !== ''),
  text: textArb,
})

const specArb: fc.Arbitrary<Spec> = fc.record({
  version: fc.constant(1),
  root: fc.constant('.'),
  ownership: fc.constant('human'),
  title: fc.oneof(fc.constant(''), textArb),
  preamble: fc.array(textArb, { maxLength: 3 }),
  nodes: fc.array(nodeArb, { maxLength: 4 }),
  templates: fc.array(templateArb, { maxLength: 2 }),
  rules: fc.array(ruleArb, { maxLength: 3 }),
}).map(s => ({
  ...s,
  nodes: dedupeSiblings(s.nodes),
  templates: s.templates.filter((t, i, all) => all.findIndex(o => o.name === t.name) === i),
  rules: s.rules.filter((r, i, all) => all.findIndex(o => o.id === r.id) === i),
}))

/** 同一层出现同名节点在语义上是重复声明，生成器层面去重 */
function dedupeSiblings(nodes: SpecNode[]): SpecNode[] {
  const seen = new Set<string>()
  const out: SpecNode[] = []
  for (const n of nodes) {
    const key = `${n.name}|${n.isDir}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ ...n, children: dedupeSiblings(n.children) })
  }
  return out
}

/** 对齐 undefined 属性的表示，让比较只关注实际数据 */
const norm = (v: unknown) => JSON.parse(JSON.stringify(v))

describe('serializeSpec ↔ parseSpec round-trip', () => {
  it('任意 Spec 序列化后再解析必须完全相等', () => {
    fc.assert(
      fc.property(specArb, spec => {
        const text = serializeSpec(spec)
        const back = parseSpec(text)
        if (!back.ok) {
          throw new Error(`解析失败 ${JSON.stringify(back.errors)}\n--- 原文 ---\n${text}`)
        }
        expect(norm(back.value)).toEqual(norm(spec))
      }),
      { numRuns: 500 },
    )
  })

  it('序列化是幂等的', () => {
    fc.assert(
      fc.property(specArb, spec => {
        const once = serializeSpec(spec)
        const back = parseSpec(once)
        if (!back.ok) throw new Error(JSON.stringify(back.errors))
        expect(serializeSpec(back.value)).toBe(once)
      }),
      { numRuns: 300 },
    )
  })
})
```

- [ ] **Step 4: 运行测试确认失败**

```bash
pnpm -C packages/core test src/serialize.test.ts src/roundtrip.test.ts
```

预期：FAIL，`Failed to resolve import "./serialize.js"`。

- [ ] **Step 5: 写实现**

`packages/core/src/serialize.ts`：

```ts
import { stringify } from 'yaml'
import { ANNOTATION_SEPARATOR } from './parse/structure.js'
import type { Rule, Spec, SpecNode, Template } from './types.js'

export function serializeSpec(spec: Spec): string {
  const out: string[] = []

  out.push('---')
  out.push(`folderspec: ${spec.version}`)
  out.push(`root: ${spec.root}`)
  out.push(`ownership: ${spec.ownership}`)
  out.push('---')
  out.push('')

  if (spec.title !== '') {
    out.push(`# ${spec.title}`)
    out.push('')
  }

  if (spec.preamble.length > 0) {
    for (const p of spec.preamble) out.push(p === '' ? '>' : `> ${p}`)
    out.push('')
  }

  out.push('## 结构')
  out.push('')
  for (const n of spec.nodes) emitNode(out, n, 0)
  out.push('')

  if (spec.templates.length > 0) {
    out.push('## 模板')
    out.push('')
    out.push('```yaml')
    out.push(templatesToYaml(spec.templates))
    out.push('```')
    out.push('')
  }

  if (spec.rules.length > 0) {
    out.push('## 规则')
    out.push('')
    out.push('```yaml')
    out.push(rulesToYaml(spec.rules))
    out.push('```')
    out.push('')
  }

  return out.join('\n')
}

function emitNode(out: string[], n: SpecNode, depth: number): void {
  let line = `${' '.repeat(depth * 2)}- \`${n.name}${n.isDir ? '/' : ''}\``
  if (n.role) line += ` \`[role:${n.role}]\``
  if (n.template) line += ` \`[template:${n.template}]\``
  if (n.severity) line += ` \`[severity:${n.severity}]\``
  const annotation = n.annotation?.trim()
  if (annotation) line += `${ANNOTATION_SEPARATOR}${annotation}`
  out.push(line)
  for (const c of n.children) emitNode(out, c, depth + 1)
}

function templatesToYaml(templates: Template[]): string {
  const obj: Record<string, unknown> = {}
  for (const t of templates) {
    const def: Record<string, unknown> = {}
    if (t.description) def.description = t.description
    if (t.rootVariable || t.rootNaming) {
      const root: Record<string, string> = {}
      if (t.rootVariable) root.variable = t.rootVariable
      if (t.rootNaming) root.naming = t.rootNaming
      def.root = root
    }
    if (t.children.length > 0) {
      const children: Record<string, unknown> = {}
      for (const c of t.children) {
        const entry: Record<string, unknown> = {}
        if (c.role) entry.role = c.role
        entry.required = c.required
        children[`${c.name}${c.isDir ? '/' : ''}`] = entry
      }
      def.children = children
    }
    if (t.exemplar.length > 0) def.exemplar = t.exemplar
    obj[t.name] = def
  }
  return stringify(obj).replace(/\n+$/, '')
}

function rulesToYaml(rules: Rule[]): string {
  return stringify(rules.map(r => ({
    id: r.id, severity: r.severity, scope: r.scope, text: r.text,
  }))).replace(/\n+$/, '')
}
```

- [ ] **Step 6: 运行测试确认通过**

```bash
pnpm -C packages/core test
```

预期：全部 PASS，包括 500 次随机 round-trip。**若 property test 失败，fast-check 会打印最小反例——把该反例加成一条固定的回归单测，再修实现。**

- [ ] **Step 7: 提交**

```bash
git add packages/core/package.json packages/core/src/serialize.ts packages/core/src/serialize.test.ts packages/core/src/roundtrip.test.ts
git commit -m "feat(core): .folderspec.md 序列化器与 round-trip property test"
```

---

### Task 6: 目录扫描与分层 gitignore 过滤

**Files:**
- Create: `packages/core/src/scan.ts`
- Test: `packages/core/src/scan.test.ts`
- Modify: `packages/core/package.json`（加 `ignore` 依赖）
- Modify: `packages/core/src/types.ts`（追加扫描相关类型）

**Interfaces:**
- Consumes: `Result`（Task 2）
- Produces:
  - `type FileKind = 'file' | 'dir' | 'symlink'`
  - `interface ActualNode { name: string; path: string; kind: FileKind; children?: ActualNode[]; truncated?: boolean; unreadable?: boolean }`
  - `interface ScanOpts { subPath?: string; depth?: number }`
  - `function scan(root: string, opts?: ScanOpts): Promise<ActualNode>`
  - `const MAX_CHILDREN = 10000`、`const DEFAULT_DEPTH = 2`

**关键语义**：`children === undefined` 表示**该目录尚未扫描**（懒加载边界），与 `children === []`（已扫描且为空）严格区分。Task 8 的 `merge` 依赖这个区分。

- [ ] **Step 1: 装依赖**

```bash
pnpm -C packages/core add ignore@^6.0.2
```

- [ ] **Step 2: 追加类型**

在 `packages/core/src/types.ts` 末尾追加：

```ts
export type FileKind = 'file' | 'dir' | 'symlink'

export interface ActualNode {
  name: string
  /** 相对工作区根的 posix 路径；根节点为 '' */
  path: string
  kind: FileKind
  /** undefined = 该目录尚未扫描（懒加载边界）；[] = 已扫描且为空 */
  children?: ActualNode[]
  /** 直接子项超过 MAX_CHILDREN，已截断 */
  truncated?: boolean
  /** readdir 失败（通常是权限） */
  unreadable?: boolean
}

export interface ScanOpts {
  /** 相对根的子路径，扫描从这里开始；默认 '' 即根本身 */
  subPath?: string
  /** 从起点往下扫几层；默认 2 */
  depth?: number
}
```

- [ ] **Step 3: 写失败的测试**

`packages/core/src/scan.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { scan, MAX_CHILDREN } from './scan.js'
import type { ActualNode } from './types.js'

let root: string

const kid = (n: ActualNode, name: string): ActualNode => {
  const found = n.children?.find(c => c.name === name)
  if (!found) throw new Error(`未找到子节点 ${name}，实际有 ${n.children?.map(c => c.name).join(',')}`)
  return found
}

beforeAll(async () => {
  root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'folderspec-scan-'))
  await fs.mkdir(nodePath.join(root, 'src/core'), { recursive: true })
  await fs.mkdir(nodePath.join(root, 'src/deep/deeper'), { recursive: true })
  await fs.mkdir(nodePath.join(root, 'node_modules/pkg'), { recursive: true })
  await fs.mkdir(nodePath.join(root, '.git/objects'), { recursive: true })
  await fs.mkdir(nodePath.join(root, 'sub'), { recursive: true })
  await fs.mkdir(nodePath.join(root, 'sub/build'), { recursive: true })
  await fs.writeFile(nodePath.join(root, '.gitignore'), 'node_modules\n*.log\n')
  await fs.writeFile(nodePath.join(root, 'sub/.gitignore'), 'build\n')
  await fs.writeFile(nodePath.join(root, 'src/core/walk.ts'), '')
  await fs.writeFile(nodePath.join(root, 'debug.log'), '')
  await fs.writeFile(nodePath.join(root, 'README.md'), '')
  await fs.symlink(nodePath.join(root, 'src'), nodePath.join(root, 'link-to-src'), 'dir')
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('scan', () => {
  it('默认扫两层，第三层的 children 为 undefined', async () => {
    const t = await scan(root)
    expect(t.path).toBe('')
    const deep = kid(kid(t, 'src'), 'deep')
    expect(deep.children).toBeUndefined()
    expect(kid(t, 'src').children).toBeDefined()
  })

  it('应用根 .gitignore：排除 node_modules 与 *.log', async () => {
    const t = await scan(root)
    const names = t.children!.map(c => c.name)
    expect(names).not.toContain('node_modules')
    expect(names).not.toContain('debug.log')
    expect(names).toContain('README.md')
  })

  it('无条件排除 .git', async () => {
    const t = await scan(root)
    expect(t.children!.map(c => c.name)).not.toContain('.git')
  })

  it('应用子目录自己的 .gitignore', async () => {
    const t = await scan(root, { depth: 3 })
    expect(kid(t, 'sub').children!.map(c => c.name)).not.toContain('build')
  })

  it('符号链接标为 symlink 且不递归进入', async () => {
    const t = await scan(root)
    const link = kid(t, 'link-to-src')
    expect(link.kind).toBe('symlink')
    expect(link.children).toBeUndefined()
  })

  it('path 是相对根的 posix 路径', async () => {
    const t = await scan(root)
    expect(kid(kid(t, 'src'), 'core').path).toBe('src/core')
  })

  it('子项排序：目录在前，同类按名称', async () => {
    const t = await scan(root)
    const names = t.children!.map(c => c.name)
    const firstFile = names.findIndex(n => n === 'README.md')
    const lastDir = names.lastIndexOf('src')
    expect(lastDir).toBeLessThan(firstFile)
  })

  it('可从子路径开始扫描', async () => {
    const t = await scan(root, { subPath: 'src', depth: 1 })
    expect(t.path).toBe('src')
    expect(t.children!.map(c => c.name).sort()).toEqual(['core', 'deep'])
    expect(kid(t, 'core').children).toBeUndefined()
  })

  it('不可读目录标 unreadable 且不中断扫描', async () => {
    const secret = nodePath.join(root, 'secret')
    await fs.mkdir(secret, { recursive: true })
    await fs.chmod(secret, 0o000)
    try {
      const t = await scan(root, { depth: 2 })
      const s = kid(t, 'secret')
      expect(s.unreadable).toBe(true)
      expect(s.children).toEqual([])
      expect(kid(t, 'src').children).toBeDefined()
    } finally {
      await fs.chmod(secret, 0o755)
      await fs.rm(secret, { recursive: true, force: true })
    }
  })

  it('超过 MAX_CHILDREN 时截断并标记', async () => {
    const big = nodePath.join(root, 'big')
    await fs.mkdir(big, { recursive: true })
    await Promise.all(
      Array.from({ length: MAX_CHILDREN + 5 }, (_, i) =>
        fs.writeFile(nodePath.join(big, `f${i}.txt`), '')),
    )
    try {
      const t = await scan(root, { subPath: 'big', depth: 1 })
      expect(t.truncated).toBe(true)
      expect(t.children).toHaveLength(MAX_CHILDREN)
    } finally {
      await fs.rm(big, { recursive: true, force: true })
    }
  }, 60_000)
})
```

- [ ] **Step 4: 运行测试确认失败**

```bash
pnpm -C packages/core test src/scan.test.ts
```

预期：FAIL，`Failed to resolve import "./scan.js"`。

- [ ] **Step 5: 写实现**

`packages/core/src/scan.ts`：

```ts
import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'
import ignore from 'ignore'
import type { Ignore } from 'ignore'
import type { ActualNode, FileKind, ScanOpts } from './types.js'

export const MAX_CHILDREN = 10_000
export const DEFAULT_DEPTH = 2

/** 无论 .gitignore 怎么写都不进入的目录 */
const ALWAYS_IGNORED = ['.git']

/** 一层 ignore 规则；base 是它生效的目录（相对根的 posix 路径，根为 ''） */
interface IgnoreLayer {
  base: string
  ig: Ignore
}

export async function scan(root: string, opts: ScanOpts = {}): Promise<ActualNode> {
  const subPath = toPosix(opts.subPath ?? '')
  const depth = opts.depth ?? DEFAULT_DEPTH

  const layers = await buildAncestorLayers(root, subPath)
  const node: ActualNode = {
    name: subPath === '' ? nodePath.basename(nodePath.resolve(root)) : basename(subPath),
    path: subPath,
    kind: 'dir',
  }
  await walk(root, node, layers, depth)
  return node
}

async function walk(root: string, dir: ActualNode, inherited: IgnoreLayer[], depth: number): Promise<void> {
  if (depth <= 0) return

  const abs = nodePath.join(root, dir.path)
  let entries: Awaited<ReturnType<typeof fs.readdir>>
  try {
    entries = await fs.readdir(abs, { withFileTypes: true })
  } catch {
    dir.unreadable = true
    dir.children = []
    return
  }

  const own = await readLayer(abs, dir.path)
  const layers = own ? [...inherited, own] : inherited

  const children: ActualNode[] = []
  for (const e of entries) {
    const rel = dir.path === '' ? e.name : `${dir.path}/${e.name}`
    const isSymlink = e.isSymbolicLink()
    const isDir = !isSymlink && e.isDirectory()
    if (isIgnored(layers, rel, isDir)) continue
    const kind: FileKind = isSymlink ? 'symlink' : isDir ? 'dir' : 'file'
    children.push({ name: e.name, path: rel, kind })
    if (children.length >= MAX_CHILDREN) {
      dir.truncated = true
      break
    }
  }

  children.sort(compareNodes)
  dir.children = children

  // 只递归真实目录；符号链接一律不进入，避免成环
  for (const c of children) {
    if (c.kind === 'dir') await walk(root, c, layers, depth - 1)
  }
}

export function compareNodes(a: ActualNode, b: ActualNode): number {
  const ad = a.kind === 'dir' ? 0 : 1
  const bd = b.kind === 'dir' ? 0 : 1
  if (ad !== bd) return ad - bd
  return a.name.localeCompare(b.name, 'en')
}

/** 为 subPath 的每一级祖先（含根、含 subPath 自身的父级）建立 ignore 层 */
async function buildAncestorLayers(root: string, subPath: string): Promise<IgnoreLayer[]> {
  const layers: IgnoreLayer[] = []
  const rootLayer = await readLayer(root, '')
  if (rootLayer) layers.push(rootLayer)
  if (subPath === '') return layers

  const parts = subPath.split('/')
  let acc = ''
  for (let i = 0; i < parts.length - 1; i++) {
    acc = acc === '' ? parts[i] : `${acc}/${parts[i]}`
    const layer = await readLayer(nodePath.join(root, acc), acc)
    if (layer) layers.push(layer)
  }
  return layers
}

async function readLayer(absDir: string, base: string): Promise<IgnoreLayer | null> {
  const patterns: string[] = base === '' ? [...ALWAYS_IGNORED] : []
  for (const file of ['.gitignore', '.ignore']) {
    try {
      patterns.push(await fs.readFile(nodePath.join(absDir, file), 'utf8'))
    } catch {
      // 该目录没有这个 ignore 文件，正常情况
    }
  }
  if (patterns.length === 0) return null
  return { base, ig: ignore().add(patterns) }
}

function isIgnored(layers: IgnoreLayer[], relPath: string, isDir: boolean): boolean {
  const target = isDir ? `${relPath}/` : relPath
  for (const { base, ig } of layers) {
    if (base !== '' && !target.startsWith(`${base}/`)) continue
    const sub = base === '' ? target : target.slice(base.length + 1)
    if (sub === '' || sub === '/') continue
    if (ig.ignores(sub)) return true
  }
  return false
}

function toPosix(p: string): string {
  return p.split(nodePath.sep).join('/').replace(/^\/+|\/+$/g, '')
}

function basename(posixPath: string): string {
  const i = posixPath.lastIndexOf('/')
  return i === -1 ? posixPath : posixPath.slice(i + 1)
}
```

- [ ] **Step 6: 运行测试确认通过**

```bash
pnpm -C packages/core test src/scan.test.ts
```

预期：10 个测试全部 PASS。截断那条会跑 10 秒左右（要建 1 万个文件）。

> **Windows 提示**：`不可读目录` 那条测试依赖 POSIX 权限位，在 Windows 上 `chmod 0o000` 无效。若在 Windows 上开发，用 `it.skipIf(process.platform === 'win32')` 跳过该条，并在 CI 的 Linux job 上保证它跑到。

- [ ] **Step 7: 提交**

```bash
git add packages/core/package.json packages/core/src/scan.ts packages/core/src/scan.test.ts packages/core/src/types.ts
git commit -m "feat(core): 懒加载目录扫描与分层 gitignore 过滤"
```

---

### Task 7: git 状态查询

**Files:**
- Create: `packages/core/src/git.ts`
- Test: `packages/core/src/git.test.ts`
- Modify: `packages/core/src/types.ts`（追加 git 类型）

**Interfaces:**
- Consumes: 无
- Produces:
  - `type GitState = 'ignored' | 'untracked' | 'modified' | 'added' | 'deleted' | 'conflicted'`
  - `type GitStates = Map<string, GitState>`（键是相对根的 posix 路径）
  - `function gitStatus(root: string): Promise<GitStates>`

一次子进程调用同时拿到三态（spec §5.1）。**不是 git 仓库或 git 不在 PATH 时返回空 Map 并降级，绝不抛错**（spec §8）。

- [ ] **Step 1: 追加类型**

在 `packages/core/src/types.ts` 末尾追加：

```ts
export type GitState = 'ignored' | 'untracked' | 'modified' | 'added' | 'deleted' | 'conflicted'

/** 键是相对工作区根的 posix 路径 */
export type GitStates = Map<string, GitState>
```

- [ ] **Step 2: 写失败的测试**

`packages/core/src/git.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { gitStatus } from './git.js'

const run = promisify(execFile)
let repo: string

beforeAll(async () => {
  repo = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'folderspec-git-'))
  const git = (...args: string[]) => run('git', args, { cwd: repo })
  await git('init', '-q')
  await git('config', 'user.email', 'test@example.com')
  await git('config', 'user.name', 'Test')
  await fs.writeFile(nodePath.join(repo, '.gitignore'), 'ignored.txt\n')
  await fs.writeFile(nodePath.join(repo, 'tracked.txt'), 'v1\n')
  await fs.mkdir(nodePath.join(repo, 'sub'), { recursive: true })
  await fs.writeFile(nodePath.join(repo, 'sub/nested.txt'), 'v1\n')
  await git('add', '.')
  await git('commit', '-q', '-m', 'init')

  await fs.writeFile(nodePath.join(repo, 'tracked.txt'), 'v2\n')          // modified
  await fs.writeFile(nodePath.join(repo, 'fresh.txt'), 'new\n')           // untracked
  await fs.writeFile(nodePath.join(repo, 'ignored.txt'), 'junk\n')        // ignored
  await fs.writeFile(nodePath.join(repo, 'staged.txt'), 'added\n')
  await git('add', 'staged.txt')                                          // added
})

afterAll(async () => {
  await fs.rm(repo, { recursive: true, force: true })
})

describe('gitStatus', () => {
  it('识别已修改文件', async () => {
    expect((await gitStatus(repo)).get('tracked.txt')).toBe('modified')
  })

  it('识别未跟踪文件', async () => {
    expect((await gitStatus(repo)).get('fresh.txt')).toBe('untracked')
  })

  it('识别已忽略文件', async () => {
    expect((await gitStatus(repo)).get('ignored.txt')).toBe('ignored')
  })

  it('识别已暂存的新增文件', async () => {
    expect((await gitStatus(repo)).get('staged.txt')).toBe('added')
  })

  it('未变更的已跟踪文件不出现在结果里', async () => {
    expect((await gitStatus(repo)).has('sub/nested.txt')).toBe(false)
  })

  it('路径用 posix 分隔符', async () => {
    await fs.writeFile(nodePath.join(repo, 'sub/another.txt'), 'x\n')
    const states = await gitStatus(repo)
    expect(states.has('sub/another.txt')).toBe(true)
    await fs.rm(nodePath.join(repo, 'sub/another.txt'))
  })

  it('识别重命名（porcelain v2 的 2 记录多一个 NUL 字段）', async () => {
    const git = (...args: string[]) => run('git', args, { cwd: repo })
    await git('mv', 'sub/nested.txt', 'sub/renamed.txt')
    try {
      const states = await gitStatus(repo)
      expect(states.get('sub/renamed.txt')).toBeDefined()
      // 关键：重命名记录的额外字段没有把后续记录解析歪
      expect(states.get('fresh.txt')).toBe('untracked')
    } finally {
      await git('mv', 'sub/renamed.txt', 'sub/nested.txt')
    }
  })

  it('不是 git 仓库时返回空 Map 而非抛错', async () => {
    const plain = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'folderspec-plain-'))
    try {
      expect((await gitStatus(plain)).size).toBe(0)
    } finally {
      await fs.rm(plain, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

```bash
pnpm -C packages/core test src/git.test.ts
```

预期：FAIL，`Failed to resolve import "./git.js"`。

- [ ] **Step 4: 写实现**

`packages/core/src/git.ts`：

```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GitState, GitStates } from './types.js'

const run = promisify(execFile)

const ARGS = [
  'status',
  '--porcelain=v2',
  '-z',
  '--untracked-files=all',
  '--ignored=matching',
]

export async function gitStatus(root: string): Promise<GitStates> {
  const states: GitStates = new Map()

  let stdout: string
  try {
    const result = await run('git', ARGS, { cwd: root, maxBuffer: 64 * 1024 * 1024 })
    stdout = result.stdout
  } catch {
    // 不是 git 仓库、git 不在 PATH、或 git 返回非零——一律降级为"无 git 信息"
    return states
  }

  const records = stdout.split('\0')
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]
    if (rec === '') continue

    const type = rec[0]
    if (type === '?') {
      states.set(rec.slice(2), 'untracked')
      continue
    }
    if (type === '!') {
      states.set(rec.slice(2), 'ignored')
      continue
    }
    if (type !== '1' && type !== '2' && type !== 'u') continue

    const fields = rec.split(' ')
    // porcelain v2 字段布局：
    //   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>              → path 在下标 8
    //   2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X score> <path>    → path 在下标 9，且后跟一个额外的 NUL 字段 origPath
    //   u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>    → path 在下标 10
    let path: string
    if (type === '2') {
      path = fields.slice(9).join(' ')
      i++ // 跳过紧随其后的 origPath 记录，否则后续记录会整体错位
    } else if (type === 'u') {
      path = fields.slice(10).join(' ')
    } else {
      path = fields.slice(8).join(' ')
    }
    if (path === '') continue

    states.set(path, toState(type, fields[1] ?? ''))
  }

  return states
}

function toState(type: string, xy: string): GitState {
  if (type === 'u') return 'conflicted'
  if (xy.includes('A')) return 'added'
  if (xy.includes('D')) return 'deleted'
  return 'modified'
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
pnpm -C packages/core test src/git.test.ts
```

预期：8 个测试全部 PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/git.ts packages/core/src/git.test.ts packages/core/src/types.ts
git commit -m "feat(core): git 状态查询（一次 porcelain=v2 调用拿三态）"
```

---

### Task 8: 三源合成（merge 纯函数）

**Files:**
- Create: `packages/core/src/merge.ts`
- Test: `packages/core/src/merge.test.ts`
- Modify: `packages/core/src/types.ts`（追加 ViewNode）

**Interfaces:**
- Consumes: `ActualNode`（Task 6）、`GitStates`（Task 7）、`Spec`/`SpecNode`（Task 2）
- Produces:
  - `type NodeOrigin = 'both' | 'spec-only' | 'actual-only' | 'unscanned'`
  - `interface ViewNode { name: string; path: string; isDir: boolean; origin: NodeOrigin; gitState?: GitState; annotation?: string; role?: string; template?: string; severity?: Severity; children?: ViewNode[]; truncated?: boolean; unreadable?: boolean }`
  - `function merge(actual: ActualNode, git: GitStates, spec: Spec, hidden?: ReadonlySet<string>): ViewNode`

合成规则来自 spec §6：

| spec | 磁盘 | origin |
|---|---|---|
| 有 | 有 | `both` |
| 有 | 无（该目录已扫描） | `spec-only` |
| 无 | 有 | `actual-only` |
| 有 | 所在目录尚未扫描 | `unscanned` |

`hidden` 是**当次会话的临时状态**（拖走的节点在旧位置隐藏），由 Session 传入，**永不落盘**（spec §6.1）。

- [ ] **Step 1: 追加类型**

在 `packages/core/src/types.ts` 末尾追加：

```ts
export type NodeOrigin = 'both' | 'spec-only' | 'actual-only' | 'unscanned'

export interface ViewNode {
  name: string
  path: string
  isDir: boolean
  origin: NodeOrigin
  gitState?: GitState
  annotation?: string
  role?: string
  template?: string
  severity?: Severity
  children?: ViewNode[]
  truncated?: boolean
  unreadable?: boolean
}
```

- [ ] **Step 2: 写失败的测试**

`packages/core/src/merge.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { merge } from './merge.js'
import type { ActualNode, GitStates, Spec, SpecNode, ViewNode } from './types.js'

const dir = (name: string, path: string, children?: ActualNode[]): ActualNode =>
  children === undefined ? { name, path, kind: 'dir' } : { name, path, kind: 'dir', children }
const file = (name: string, path: string): ActualNode => ({ name, path, kind: 'file' })

const sdir = (name: string, children: SpecNode[] = [], extra: Partial<SpecNode> = {}): SpecNode =>
  ({ name, isDir: true, children, ...extra })

const spec = (nodes: SpecNode[]): Spec => ({
  version: 1, root: '.', ownership: 'human', title: '', preamble: [],
  nodes, templates: [], rules: [],
})

const find = (n: ViewNode, path: string): ViewNode => {
  if (n.path === path) return n
  for (const c of n.children ?? []) {
    try { return find(c, path) } catch { /* 继续找 */ }
  }
  throw new Error(`未找到 ${path}`)
}

const NO_GIT: GitStates = new Map()

describe('merge', () => {
  it('spec 有 + 磁盘有 → both，并带上注释', () => {
    const actual = dir('r', '', [dir('src', 'src', [])])
    const s = spec([sdir('src', [], { annotation: '核心源码', role: 'source-root' })])
    const v = merge(actual, NO_GIT, s)
    const src = find(v, 'src')
    expect(src.origin).toBe('both')
    expect(src.annotation).toBe('核心源码')
    expect(src.role).toBe('source-root')
  })

  it('spec 有 + 磁盘无 → spec-only', () => {
    const actual = dir('r', '', [])
    const s = spec([sdir('docs', [sdir('specs', [], { annotation: '设计文档' })])])
    const v = merge(actual, NO_GIT, s)
    expect(find(v, 'docs').origin).toBe('spec-only')
    expect(find(v, 'docs/specs').origin).toBe('spec-only')
    expect(find(v, 'docs/specs').annotation).toBe('设计文档')
  })

  it('spec 无 + 磁盘有 → actual-only', () => {
    const actual = dir('r', '', [file('README.md', 'README.md')])
    const v = merge(actual, NO_GIT, spec([]))
    expect(find(v, 'README.md').origin).toBe('actual-only')
  })

  it('目录尚未扫描时 spec 子节点为 unscanned', () => {
    const actual = dir('r', '', [dir('src', 'src')]) // children undefined
    const s = spec([sdir('src', [sdir('core', [], { annotation: '内核' })])])
    const v = merge(actual, NO_GIT, s)
    expect(find(v, 'src').origin).toBe('both')
    expect(find(v, 'src/core').origin).toBe('unscanned')
    expect(find(v, 'src/core').annotation).toBe('内核')
  })

  it('对未扫描分支是幂等的：扫描后重新合成得到确定结果', () => {
    const s = spec([sdir('src', [
      sdir('core', [], { annotation: '内核' }),
      sdir('gone', [], { annotation: '不存在' }),
    ])])
    const before = merge(dir('r', '', [dir('src', 'src')]), NO_GIT, s)
    expect(find(before, 'src/core').origin).toBe('unscanned')
    expect(find(before, 'src/gone').origin).toBe('unscanned')

    const after = merge(dir('r', '', [dir('src', 'src', [dir('core', 'src/core', [])])]), NO_GIT, s)
    expect(find(after, 'src/core').origin).toBe('both')
    expect(find(after, 'src/gone').origin).toBe('spec-only')
  })

  it('附上 git 状态', () => {
    const actual = dir('r', '', [file('a.txt', 'a.txt'), file('b.txt', 'b.txt')])
    const git: GitStates = new Map([['a.txt', 'modified'], ['b.txt', 'ignored']])
    const v = merge(actual, git, spec([]))
    expect(find(v, 'a.txt').gitState).toBe('modified')
    expect(find(v, 'b.txt').gitState).toBe('ignored')
  })

  it('透传 truncated 与 unreadable', () => {
    const actual: ActualNode = {
      name: 'r', path: '', kind: 'dir',
      children: [
        { name: 'big', path: 'big', kind: 'dir', children: [], truncated: true },
        { name: 'secret', path: 'secret', kind: 'dir', children: [], unreadable: true },
      ],
    }
    const v = merge(actual, NO_GIT, spec([]))
    expect(find(v, 'big').truncated).toBe(true)
    expect(find(v, 'secret').unreadable).toBe(true)
  })

  it('子项排序：目录在前，同类按名称，与来源无关', () => {
    const actual = dir('r', '', [file('z.txt', 'z.txt'), dir('m', 'm', [])])
    const s = spec([sdir('a'), { name: 'b.txt', isDir: false, children: [] }])
    const v = merge(actual, NO_GIT, s)
    expect(v.children!.map(c => c.name)).toEqual(['a', 'm', 'b.txt', 'z.txt'])
  })

  it('hidden 集合里的路径不出现在结果中（拖走后的旧位置）', () => {
    const actual = dir('r', '', [dir('examples', 'examples', [dir('foo', 'examples/foo', [])])])
    const s = spec([sdir('src', [sdir('cases', [sdir('foo', [], { annotation: '案例' })])])])
    const v = merge(actual, NO_GIT, s, new Set(['examples/foo']))
    expect(() => find(v, 'examples/foo')).toThrow()
    expect(find(v, 'src/cases/foo').origin).toBe('spec-only')
  })

  it('根节点 path 为空字符串', () => {
    const v = merge(dir('myrepo', '', []), NO_GIT, spec([]))
    expect(v.path).toBe('')
    expect(v.name).toBe('myrepo')
    expect(v.origin).toBe('both')
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

```bash
pnpm -C packages/core test src/merge.test.ts
```

预期：FAIL，`Failed to resolve import "./merge.js"`。

- [ ] **Step 4: 写实现**

`packages/core/src/merge.ts`：

```ts
import type { ActualNode, GitStates, NodeOrigin, Spec, SpecNode, ViewNode } from './types.js'

const NO_HIDDEN: ReadonlySet<string> = new Set()

export function merge(
  actual: ActualNode,
  git: GitStates,
  spec: Spec,
  hidden: ReadonlySet<string> = NO_HIDDEN,
): ViewNode {
  const root: ViewNode = { name: actual.name, path: actual.path, isDir: true, origin: 'both' }
  if (actual.truncated) root.truncated = true
  if (actual.unreadable) root.unreadable = true
  const children = mergeChildren(actual.path, actual.children, spec.nodes, git, hidden)
  if (children) root.children = children
  return root
}

function mergeChildren(
  parentPath: string,
  actualKids: ActualNode[] | undefined,
  specKids: SpecNode[],
  git: GitStates,
  hidden: ReadonlySet<string>,
): ViewNode[] | undefined {
  // 该目录尚未扫描：spec 子节点原样物化为 unscanned，等展开后重新合成
  if (actualKids === undefined) {
    if (specKids.length === 0) return undefined
    return sortView(specKids
      .map(s => fromSpec(parentPath, s, 'unscanned', git, hidden))
      .filter((v): v is ViewNode => v !== null))
  }

  const bySpecName = new Map(specKids.map(s => [s.name, s]))
  const out: ViewNode[] = []

  for (const a of actualKids) {
    if (hidden.has(a.path)) {
      bySpecName.delete(a.name)
      continue
    }
    const s = bySpecName.get(a.name)
    if (s) bySpecName.delete(a.name)
    out.push(fromActual(a, s, git, hidden))
  }

  for (const s of bySpecName.values()) {
    const v = fromSpec(parentPath, s, 'spec-only', git, hidden)
    if (v) out.push(v)
  }

  return sortView(out)
}

function fromActual(
  a: ActualNode,
  s: SpecNode | undefined,
  git: GitStates,
  hidden: ReadonlySet<string>,
): ViewNode {
  const v: ViewNode = {
    name: a.name,
    path: a.path,
    isDir: a.kind === 'dir',
    origin: s ? 'both' : 'actual-only',
  }
  const g = git.get(a.path)
  if (g) v.gitState = g
  if (a.truncated) v.truncated = true
  if (a.unreadable) v.unreadable = true
  applySpecFields(v, s)

  if (a.kind === 'dir') {
    const children = mergeChildren(a.path, a.children, s?.children ?? [], git, hidden)
    if (children) v.children = children
  }
  return v
}

function fromSpec(
  parentPath: string,
  s: SpecNode,
  origin: NodeOrigin,
  git: GitStates,
  hidden: ReadonlySet<string>,
): ViewNode | null {
  const path = parentPath === '' ? s.name : `${parentPath}/${s.name}`
  if (hidden.has(path)) return null

  const v: ViewNode = { name: s.name, path, isDir: s.isDir, origin }
  const g = git.get(path)
  if (g) v.gitState = g
  applySpecFields(v, s)

  if (s.isDir && s.children.length > 0) {
    const kids = s.children
      .map(c => fromSpec(path, c, origin, git, hidden))
      .filter((c): c is ViewNode => c !== null)
    v.children = sortView(kids)
  }
  return v
}

function applySpecFields(v: ViewNode, s: SpecNode | undefined): void {
  if (!s) return
  if (s.annotation) v.annotation = s.annotation
  if (s.role) v.role = s.role
  if (s.template) v.template = s.template
  if (s.severity) v.severity = s.severity
}

function sortView(nodes: ViewNode[]): ViewNode[] {
  return nodes.sort((a, b) => {
    const ad = a.isDir ? 0 : 1
    const bd = b.isDir ? 0 : 1
    if (ad !== bd) return ad - bd
    return a.name.localeCompare(b.name, 'en')
  })
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
pnpm -C packages/core test src/merge.test.ts
```

预期：10 个测试全部 PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/merge.ts packages/core/src/merge.test.ts packages/core/src/types.ts
git commit -m "feat(core): 三源合成 merge 纯函数"
```

---

### Task 9: Spec 编辑纯函数

**Files:**
- Create: `packages/core/src/spec-edit.ts`
- Test: `packages/core/src/spec-edit.test.ts`

**Interfaces:**
- Consumes: `Spec`、`SpecNode`、`Severity`（Task 2）
- Produces:
  - `interface AnnotationPatch { annotation?: string | null; role?: string | null; template?: string | null; severity?: Severity | null }`
  - `function setAnnotation(spec: Spec, path: string, isDir: boolean, patch: AnnotationPatch): Spec`
  - `function moveNode(spec: Spec, from: string, toParent: string, isDir: boolean): Spec`
  - `function emptySpec(): Spec`

**为什么"清理空节点"必须沿路径而不是全树**：给 `src/core/` 写注释会自动创建 `src` 这个祖先节点；清空该注释后 `src/core` 变成空叶子，应当一并移除。但**拖拽产生的空节点是有意义的**——它声明"这里应该有这个东西"，绝不能被当作垃圾清掉。二者在文件里长得一模一样，无法用字段区分，所以只能靠**编辑作用域**区分：清理只在本次编辑触碰的那条路径上进行。

- [ ] **Step 1: 写失败的测试**

`packages/core/src/spec-edit.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { emptySpec, moveNode, setAnnotation } from './spec-edit.js'
import type { Spec, SpecNode } from './types.js'

const find = (nodes: SpecNode[], path: string): SpecNode | null => {
  const segs = path.split('/')
  let list = nodes
  let node: SpecNode | null = null
  for (const seg of segs) {
    node = list.find(n => n.name === seg) ?? null
    if (!node) return null
    list = node.children
  }
  return node
}

describe('setAnnotation', () => {
  it('为深层路径写注释时自动创建祖先目录节点', () => {
    const s = setAnnotation(emptySpec(), 'src/core/walk.ts', false, { annotation: '遍历入口' })
    expect(find(s.nodes, 'src')?.isDir).toBe(true)
    expect(find(s.nodes, 'src/core')?.isDir).toBe(true)
    const leaf = find(s.nodes, 'src/core/walk.ts')
    expect(leaf?.isDir).toBe(false)
    expect(leaf?.annotation).toBe('遍历入口')
  })

  it('不修改传入的 spec（返回新对象）', () => {
    const before = emptySpec()
    const after = setAnnotation(before, 'src', true, { annotation: 'x' })
    expect(before.nodes).toEqual([])
    expect(after.nodes).toHaveLength(1)
  })

  it('去除注释首尾空白', () => {
    const s = setAnnotation(emptySpec(), 'src', true, { annotation: '  有空白  ' })
    expect(find(s.nodes, 'src')?.annotation).toBe('有空白')
  })

  it('设置 role 与 severity', () => {
    const s = setAnnotation(emptySpec(), 'src', true, { role: 'source-root', severity: 'error' })
    expect(find(s.nodes, 'src')?.role).toBe('source-root')
    expect(find(s.nodes, 'src')?.severity).toBe('error')
  })

  it('未提供的字段保持不变', () => {
    let s = setAnnotation(emptySpec(), 'src', true, { annotation: 'a', role: 'r' })
    s = setAnnotation(s, 'src', true, { annotation: 'b' })
    expect(find(s.nodes, 'src')?.role).toBe('r')
    expect(find(s.nodes, 'src')?.annotation).toBe('b')
  })

  it('传 null 清除字段', () => {
    let s = setAnnotation(emptySpec(), 'src', true, { annotation: 'a', role: 'r' })
    s = setAnnotation(s, 'src', true, { role: null })
    expect(find(s.nodes, 'src')?.role).toBeUndefined()
    expect(find(s.nodes, 'src')?.annotation).toBe('a')
  })

  it('传空字符串等同清除', () => {
    let s = setAnnotation(emptySpec(), 'src', true, { annotation: 'a' })
    s = setAnnotation(s, 'src', true, { annotation: '   ' })
    expect(find(s.nodes, 'src')).toBeNull()
  })

  it('清空后沿路径回收变空的祖先', () => {
    let s = setAnnotation(emptySpec(), 'src/core/walk.ts', false, { annotation: 'x' })
    s = setAnnotation(s, 'src/core/walk.ts', false, { annotation: null })
    expect(s.nodes).toEqual([])
  })

  it('清空时不回收仍有内容的祖先', () => {
    let s = setAnnotation(emptySpec(), 'src', true, { annotation: '源码' })
    s = setAnnotation(s, 'src/core/walk.ts', false, { annotation: 'x' })
    s = setAnnotation(s, 'src/core/walk.ts', false, { annotation: null })
    expect(find(s.nodes, 'src')?.annotation).toBe('源码')
    expect(find(s.nodes, 'src/core')).toBeNull()
  })
})

describe('moveNode', () => {
  it('把 spec 中已有的节点连同子树移到新父级下', () => {
    let s = setAnnotation(emptySpec(), 'examples/foo', true, { annotation: '一个案例' })
    s = setAnnotation(s, 'examples/foo/input.json', false, { annotation: '输入' })
    s = moveNode(s, 'examples/foo', 'src/cases', true)
    expect(find(s.nodes, 'examples')).toBeNull()
    expect(find(s.nodes, 'src/cases/foo')?.annotation).toBe('一个案例')
    expect(find(s.nodes, 'src/cases/foo/input.json')?.annotation).toBe('输入')
  })

  it('移动 spec 中尚不存在的节点时，在目标位置声明它', () => {
    const s = moveNode(emptySpec(), 'examples/foo', 'src/cases', true)
    const moved = find(s.nodes, 'src/cases/foo')
    expect(moved).not.toBeNull()
    expect(moved?.isDir).toBe(true)
  })

  it('移动产生的空节点不被回收', () => {
    let s = moveNode(emptySpec(), 'examples/foo', 'src/cases', true)
    // 对无关路径做一次编辑，确认移动结果仍在
    s = setAnnotation(s, 'docs', true, { annotation: '文档' })
    expect(find(s.nodes, 'src/cases/foo')).not.toBeNull()
  })

  it('移到根下（toParent 为空字符串）', () => {
    let s = setAnnotation(emptySpec(), 'src/cases/foo', true, { annotation: 'x' })
    s = moveNode(s, 'src/cases/foo', '', true)
    expect(find(s.nodes, 'foo')?.annotation).toBe('x')
    expect(find(s.nodes, 'src')).toBeNull()
  })

  it('目标下已有同名节点时合并，被移动方的字段优先', () => {
    let s = setAnnotation(emptySpec(), 'src/cases/foo', true, { annotation: '旧的', role: 'keep-me' })
    s = setAnnotation(s, 'examples/foo', true, { annotation: '新的' })
    s = moveNode(s, 'examples/foo', 'src/cases', true)
    expect(find(s.nodes, 'src/cases/foo')?.annotation).toBe('新的')
    expect(find(s.nodes, 'src/cases/foo')?.role).toBe('keep-me')
  })

  it('移动后回收源路径上变空的祖先', () => {
    let s = setAnnotation(emptySpec(), 'a/b/c', true, { annotation: 'x' })
    s = moveNode(s, 'a/b/c', 'z', true)
    expect(find(s.nodes, 'a')).toBeNull()
    expect(find(s.nodes, 'z/c')?.annotation).toBe('x')
  })

  it('拒绝把节点移进它自己的子树', () => {
    const s = setAnnotation(emptySpec(), 'a/b', true, { annotation: 'x' })
    expect(() => moveNode(s, 'a', 'a/b', true)).toThrow('不能把节点移动到它自己的子树下')
  })
})

describe('emptySpec', () => {
  it('带上给 Agent 的声明式引言', () => {
    const s: Spec = emptySpec()
    expect(s.version).toBe(1)
    expect(s.ownership).toBe('human')
    expect(s.preamble.join('\n')).toContain('Agent 不应自行修改本文件')
    expect(s.nodes).toEqual([])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm -C packages/core test src/spec-edit.test.ts
```

预期：FAIL，`Failed to resolve import "./spec-edit.js"`。

- [ ] **Step 3: 写实现**

`packages/core/src/spec-edit.ts`：

```ts
import type { Severity, Spec, SpecNode } from './types.js'

export interface AnnotationPatch {
  annotation?: string | null
  role?: string | null
  template?: string | null
  severity?: Severity | null
}

export function emptySpec(): Spec {
  return {
    version: 1,
    root: '.',
    ownership: 'human',
    title: '仓库结构契约',
    preamble: [
      '本文件声明本仓库的**结构意图**，是长期不变量，不是一次性操作指令。',
      'Agent 应读取本文件、对照实际仓库、自行决定如何变更磁盘。',
      'Agent 不应自行修改本文件；若认为规则不合理，请向人类提出修改建议。',
    ],
    nodes: [],
    templates: [],
    rules: [],
  }
}

export function setAnnotation(spec: Spec, path: string, isDir: boolean, patch: AnnotationPatch): Spec {
  const segs = toSegments(path)
  if (segs.length === 0) throw new Error('路径不能为空')

  const next = structuredClone(spec)
  const node = ensure(next.nodes, segs, isDir)

  applyText(node, 'annotation', patch.annotation)
  applyText(node, 'role', patch.role)
  applyText(node, 'template', patch.template)
  if (patch.severity !== undefined) {
    if (patch.severity === null) delete node.severity
    else node.severity = patch.severity
  }

  pruneAlong(next.nodes, segs)
  return next
}

export function moveNode(spec: Spec, from: string, toParent: string, isDir: boolean): Spec {
  const fromSegs = toSegments(from)
  if (fromSegs.length === 0) throw new Error('不能移动根节点')
  const toSegs = toSegments(toParent)

  const fromPrefix = `${fromSegs.join('/')}/`
  if (`${toSegs.join('/')}/`.startsWith(fromPrefix)) {
    throw new Error('不能把节点移动到它自己的子树下')
  }

  const next = structuredClone(spec)
  const name = fromSegs[fromSegs.length - 1]

  // spec 里没有该节点时，新建一个空节点——它表达"我声明它应该在这里"，本身就是有效数据
  const detached = detach(next.nodes, fromSegs) ?? { name, isDir, children: [] }
  pruneAlong(next.nodes, fromSegs.slice(0, -1))

  const list = toSegs.length === 0 ? next.nodes : ensure(next.nodes, toSegs, true).children
  const existing = list.find(n => n.name === detached.name)
  if (existing) mergeInto(existing, detached)
  else list.push(detached)

  return next
}

export function findSpecNode(nodes: SpecNode[], path: string): SpecNode | null {
  let list = nodes
  let node: SpecNode | null = null
  for (const seg of toSegments(path)) {
    node = list.find(n => n.name === seg) ?? null
    if (!node) return null
    list = node.children
  }
  return node
}

// ---------- 内部 ----------

function toSegments(path: string): string[] {
  return path.split('/').filter(s => s !== '')
}

/** 沿路径确保节点存在；缺失的祖先一律按目录创建 */
function ensure(nodes: SpecNode[], segs: string[], lastIsDir: boolean): SpecNode {
  let list = nodes
  let node!: SpecNode
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]
    const isLast = i === segs.length - 1
    let found = list.find(n => n.name === seg)
    if (!found) {
      found = { name: seg, isDir: isLast ? lastIsDir : true, children: [] }
      list.push(found)
    } else if (isLast && found.isDir !== lastIsDir) {
      found.isDir = lastIsDir
    }
    node = found
    list = found.children
  }
  return node
}

function detach(nodes: SpecNode[], segs: string[]): SpecNode | null {
  let list = nodes
  for (let i = 0; i < segs.length - 1; i++) {
    const found = list.find(n => n.name === segs[i])
    if (!found) return null
    list = found.children
  }
  const idx = list.findIndex(n => n.name === segs[segs.length - 1])
  if (idx === -1) return null
  return list.splice(idx, 1)[0]
}

function mergeInto(target: SpecNode, incoming: SpecNode): void {
  if (incoming.annotation) target.annotation = incoming.annotation
  if (incoming.role) target.role = incoming.role
  if (incoming.template) target.template = incoming.template
  if (incoming.severity) target.severity = incoming.severity
  target.isDir = incoming.isDir
  for (const c of incoming.children) {
    const existing = target.children.find(t => t.name === c.name)
    if (existing) mergeInto(existing, c)
    else target.children.push(c)
  }
}

function applyText(node: SpecNode, key: 'annotation' | 'role' | 'template', v: string | null | undefined): void {
  if (v === undefined) return
  const text = v === null ? '' : v.trim()
  if (text === '') delete node[key]
  else node[key] = text
}

function isEmptyNode(n: SpecNode): boolean {
  return n.children.length === 0 && !n.annotation && !n.role && !n.template && !n.severity
}

/**
 * 只沿本次编辑触碰的那条路径自底向上回收空叶子。
 * 绝不做全树回收——拖拽声明出来的空节点是有效数据，全树回收会把它清掉。
 */
function pruneAlong(rootList: SpecNode[], segs: string[]): void {
  const chain: Array<{ parent: SpecNode[]; node: SpecNode }> = []
  let list = rootList
  for (const seg of segs) {
    const node = list.find(n => n.name === seg)
    if (!node) break
    chain.push({ parent: list, node })
    list = node.children
  }
  for (let i = chain.length - 1; i >= 0; i--) {
    const { parent, node } = chain[i]
    if (isEmptyNode(node)) {
      const idx = parent.indexOf(node)
      if (idx !== -1) parent.splice(idx, 1)
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pnpm -C packages/core test src/spec-edit.test.ts
```

预期：17 个测试全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/spec-edit.ts packages/core/src/spec-edit.test.ts
git commit -m "feat(core): Spec 编辑纯函数（注释、移动、沿路径回收）"
```

---

### Task 10: Api 类型契约与 Session

Phase A 的收口。`Session` 是宿主无关的会话控制器，两个宿主都只是把它接到各自的消息通道上。

**Files:**
- Create: `packages/core/src/api.ts`（**纯类型，不得 import 任何 node 模块**）
- Create: `packages/core/src/session.ts`
- Test: `packages/core/src/session.test.ts`
- Modify: `packages/core/src/index.ts`（导出全部公开 API）

**Interfaces:**
- Consumes: Task 4 `parseSpec`、Task 5 `serializeSpec`、Task 6 `scan`、Task 7 `gitStatus`、Task 8 `merge`、Task 9 `setAnnotation`/`moveNode`/`emptySpec`
- Produces:
  - `const SPEC_FILENAME = '.folderspec.md'`
  - `interface OpenResult { root: string; rootName: string; hasSpec: boolean; specPath: string; parseErrors: ParseError[] | null; tree: ViewNode }`
  - `interface Api`（方法表，见下）
  - `interface Bridge { request<K extends keyof Api>(method: K, params: Api[K]['params']): Promise<Api[K]['result']>; on(event: BridgeEvent, cb: (payload: unknown) => void): () => void }`
  - `class Session`：`open()`、`tree()`、`expand(path)`、`annotate(params)`、`move(params)`、`save()`、`raw()`、`reload()`、`handle(method, params)`

- [ ] **Step 1: 写失败的测试**

`packages/core/src/session.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { Session, SPEC_FILENAME } from './session.js'
import { parseSpec } from './parse/index.js'
import type { ViewNode } from './types.js'

let root: string

const find = (n: ViewNode, path: string): ViewNode | null => {
  if (n.path === path) return n
  for (const c of n.children ?? []) {
    const hit = find(c, path)
    if (hit) return hit
  }
  return null
}

beforeEach(async () => {
  root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'folderspec-session-'))
  await fs.mkdir(nodePath.join(root, 'src/core'), { recursive: true })
  await fs.mkdir(nodePath.join(root, 'src/deep/deeper'), { recursive: true })
  await fs.writeFile(nodePath.join(root, 'README.md'), '')
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('Session.open', () => {
  it('无契约文件时以空 spec 打开', async () => {
    const s = new Session(root)
    const r = await s.open()
    expect(r.hasSpec).toBe(false)
    expect(r.parseErrors).toBeNull()
    expect(r.specPath).toBe(nodePath.join(root, SPEC_FILENAME))
    expect(find(r.tree, 'src')?.origin).toBe('actual-only')
  })

  it('读取已存在的契约文件并合成注释', async () => {
    await fs.writeFile(nodePath.join(root, SPEC_FILENAME), [
      '---', 'folderspec: 1', 'root: .', 'ownership: human', '---',
      '', '# T', '', '## 结构', '', '- `src/` — 核心源码', '',
    ].join('\n'))
    const r = await new Session(root).open()
    expect(r.hasSpec).toBe(true)
    expect(find(r.tree, 'src')?.annotation).toBe('核心源码')
    expect(find(r.tree, 'src')?.origin).toBe('both')
  })

  it('契约文件解析失败时进入只读模式且不清空数据', async () => {
    await fs.writeFile(nodePath.join(root, SPEC_FILENAME), '不是合法的契约文件\n')
    const s = new Session(root)
    const r = await s.open()
    expect(r.parseErrors).not.toBeNull()
    expect(r.parseErrors![0].line).toBe(1)
    expect(() => s.annotate({ path: 'src', isDir: true, annotation: 'x' })).toThrow('只读模式')
    await expect(s.save()).rejects.toThrow('只读模式')
  })
})

describe('Session 编辑与保存', () => {
  it('写注释后树上立即可见，且标记为 dirty', async () => {
    const s = new Session(root)
    await s.open()
    const r = s.annotate({ path: 'src', isDir: true, annotation: '核心源码', role: 'source-root' })
    expect(r.dirty).toBe(true)
    expect(find(r.tree, 'src')?.annotation).toBe('核心源码')
    expect(find(r.tree, 'src')?.role).toBe('source-root')
  })

  it('save 把契约写到磁盘且内容可被重新解析', async () => {
    const s = new Session(root)
    await s.open()
    s.annotate({ path: 'src/core', isDir: true, annotation: '内核' })
    const { written } = await s.save()
    expect(written).toBe(true)

    const text = await fs.readFile(nodePath.join(root, SPEC_FILENAME), 'utf8')
    const back = parseSpec(text)
    expect(back.ok).toBe(true)
    expect(text).toContain('- `core/` — 内核')
  })

  it('save 之后 dirty 复位', async () => {
    const s = new Session(root)
    await s.open()
    s.annotate({ path: 'src', isDir: true, annotation: 'x' })
    await s.save()
    expect(s.isDirty()).toBe(false)
  })

  it('save 只写契约文件，不碰任何其他路径', async () => {
    const before = (await fs.readdir(root)).sort()
    const s = new Session(root)
    await s.open()
    s.annotate({ path: 'src', isDir: true, annotation: 'x' })
    await s.save()
    const after = (await fs.readdir(root)).sort()
    expect(after).toEqual([...before, SPEC_FILENAME].sort())
  })

  it('拖拽后旧位置在当次会话中隐藏，新位置出现', async () => {
    await fs.mkdir(nodePath.join(root, 'examples/foo'), { recursive: true })
    const s = new Session(root)
    await s.open()
    const r = s.move({ from: 'examples/foo', toParent: 'src/cases', isDir: true })
    expect(find(r.tree, 'examples/foo')).toBeNull()
    expect(find(r.tree, 'src/cases/foo')?.origin).toBe('spec-only')
  })

  it('隐藏状态是临时的：重新 open 后旧位置重新出现', async () => {
    await fs.mkdir(nodePath.join(root, 'examples/foo'), { recursive: true })
    const s = new Session(root)
    await s.open()
    s.move({ from: 'examples/foo', toParent: 'src/cases', isDir: true })
    await s.save()

    const fresh = new Session(root)
    const r = await fresh.open()
    expect(find(r.tree, 'examples/foo')?.origin).toBe('actual-only')
    expect(find(r.tree, 'src/cases/foo')?.origin).toBe('spec-only')
  })
})

describe('Session.expand', () => {
  it('展开后原本 undefined 的子层被填充', async () => {
    const s = new Session(root)
    const r0 = await s.open()
    expect(find(r0.tree, 'src/deep')?.children).toBeUndefined()
    const tree = await s.expand('src/deep')
    expect(find(tree, 'src/deep/deeper')).not.toBeNull()
  })

  it('展开把 unscanned 的 spec 节点重新解析为 spec-only', async () => {
    const s = new Session(root)
    await s.open()
    s.annotate({ path: 'src/deep/ghost', isDir: true, annotation: '不存在' })
    expect(find(s.tree(), 'src/deep/ghost')?.origin).toBe('unscanned')
    const tree = await s.expand('src/deep')
    expect(find(tree, 'src/deep/ghost')?.origin).toBe('spec-only')
  })
})

describe('Session.handle', () => {
  it('按方法名分发，供两个宿主复用', async () => {
    const s = new Session(root)
    const opened = await s.handle('workspace/open', { root })
    expect((opened as { hasSpec: boolean }).hasSpec).toBe(false)
    const annotated = await s.handle('spec/annotate', { path: 'src', isDir: true, annotation: 'x' })
    expect((annotated as { dirty: boolean }).dirty).toBe(true)
  })

  it('未知方法名抛错', async () => {
    const s = new Session(root)
    await expect(s.handle('nope' as never, {} as never)).rejects.toThrow('未知方法')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm -C packages/core test src/session.test.ts
```

预期：FAIL，`Failed to resolve import "./session.js"`。

- [ ] **Step 3: 写 Api 类型契约**

`packages/core/src/api.ts`（**这个文件不得 import 任何 node 模块——`ui` 靠它拿类型**）：

```ts
import type { ParseError, Severity, ViewNode } from './types.js'

export interface OpenResult {
  root: string
  rootName: string
  hasSpec: boolean
  specPath: string
  /** 非 null 表示契约文件解析失败，当前处于只读模式 */
  parseErrors: ParseError[] | null
  tree: ViewNode
}

export interface AnnotateParams {
  path: string
  isDir: boolean
  annotation?: string | null
  role?: string | null
  template?: string | null
  severity?: Severity | null
}

export interface MoveParams {
  from: string
  toParent: string
  isDir: boolean
}

export interface EditResult {
  tree: ViewNode
  dirty: boolean
}

export interface Api {
  'workspace/open': { params: { root: string }; result: OpenResult }
  'tree/get': { params: Record<string, never>; result: { tree: ViewNode } }
  'tree/expand': { params: { path: string }; result: { tree: ViewNode } }
  'spec/annotate': { params: AnnotateParams; result: EditResult }
  'spec/move': { params: MoveParams; result: EditResult }
  'spec/save': { params: Record<string, never>; result: { written: boolean } }
  'spec/raw': { params: Record<string, never>; result: { markdown: string } }
}

export type ApiMethod = keyof Api

export type BridgeEvent = 'spec-changed' | 'scan-progress' | 'external-change'

export interface Bridge {
  request<K extends ApiMethod>(method: K, params: Api[K]['params']): Promise<Api[K]['result']>
  on(event: BridgeEvent, cb: (payload: unknown) => void): () => void
}
```

- [ ] **Step 4: 写 Session**

`packages/core/src/session.ts`：

```ts
import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'
import { parseSpec } from './parse/index.js'
import { serializeSpec } from './serialize.js'
import { scan, DEFAULT_DEPTH } from './scan.js'
import { gitStatus } from './git.js'
import { merge } from './merge.js'
import { emptySpec, moveNode, setAnnotation } from './spec-edit.js'
import type { Api, ApiMethod, AnnotateParams, EditResult, MoveParams, OpenResult } from './api.js'
import type { ActualNode, GitStates, ParseError, Spec, ViewNode } from './types.js'

export const SPEC_FILENAME = '.folderspec.md'

export class Session {
  private actual: ActualNode = { name: '', path: '', kind: 'dir', children: [] }
  private git: GitStates = new Map()
  private spec: Spec = emptySpec()
  /** 当次会话内被拖走的旧位置；临时状态，永不落盘（spec §6.1） */
  private hidden = new Set<string>()
  private dirty = false
  private parseErrors: ParseError[] | null = null

  constructor(readonly root: string) {}

  get specPath(): string {
    return nodePath.join(this.root, SPEC_FILENAME)
  }

  isDirty(): boolean {
    return this.dirty
  }

  async open(): Promise<OpenResult> {
    this.hidden.clear()
    this.dirty = false

    const [actual, git] = await Promise.all([
      scan(this.root, { depth: DEFAULT_DEPTH }),
      gitStatus(this.root),
    ])
    this.actual = actual
    this.git = git

    let hasSpec = false
    let raw: string | null = null
    try {
      raw = await fs.readFile(this.specPath, 'utf8')
      hasSpec = true
    } catch {
      // 没有契约文件是完全正常的起始状态
    }

    if (raw === null) {
      this.spec = emptySpec()
      this.parseErrors = null
    } else {
      const parsed = parseSpec(raw)
      if (parsed.ok) {
        this.spec = parsed.value
        this.parseErrors = null
      } else {
        // 解析失败：保留空 spec 仅供显示，绝不写回覆盖用户文件（spec §8）
        this.spec = emptySpec()
        this.parseErrors = parsed.errors
      }
    }

    return {
      root: this.root,
      rootName: this.actual.name,
      hasSpec,
      specPath: this.specPath,
      parseErrors: this.parseErrors,
      tree: this.tree(),
    }
  }

  async reload(): Promise<OpenResult> {
    return this.open()
  }

  tree(): ViewNode {
    return merge(this.actual, this.git, this.spec, this.hidden)
  }

  async expand(path: string): Promise<ViewNode> {
    const sub = await scan(this.root, { subPath: path, depth: DEFAULT_DEPTH })
    const target = findActual(this.actual, path)
    if (target) {
      target.children = sub.children
      if (sub.truncated) target.truncated = true
      if (sub.unreadable) target.unreadable = true
    }
    return this.tree()
  }

  annotate(params: AnnotateParams): EditResult {
    this.assertWritable()
    const { path, isDir, ...patch } = params
    this.spec = setAnnotation(this.spec, path, isDir, patch)
    this.dirty = true
    return { tree: this.tree(), dirty: true }
  }

  move(params: MoveParams): EditResult {
    this.assertWritable()
    this.spec = moveNode(this.spec, params.from, params.toParent, params.isDir)
    // 旧位置在当次会话中隐藏；重新 open 后自然消失（不落盘）
    this.hidden.add(params.from)
    this.dirty = true
    return { tree: this.tree(), dirty: true }
  }

  raw(): string {
    return serializeSpec(this.spec)
  }

  async save(): Promise<{ written: boolean }> {
    this.assertWritable()
    const text = serializeSpec(this.spec)

    // 写盘前自校验：序列化的结果必须能被自己解析回来（spec §8）
    const verify = parseSpec(text)
    if (!verify.ok) {
      throw new Error(
        `序列化自校验失败，已中止写入以免损坏契约文件：${verify.errors.map(e => `第 ${e.line} 行 ${e.message}`).join('；')}`,
      )
    }

    await fs.writeFile(this.specPath, text, 'utf8')
    this.dirty = false
    return { written: true }
  }

  /**
   * 注意：'workspace/open' 只重新扫描 **本 Session 自己的 root**，忽略 params.root。
   * 切换工作区意味着换一个 Session——由宿主负责（见 CLI 的 server.ts 与 VSCode 的 editor.ts）。
   */
  async handle<K extends ApiMethod>(method: K, params: Api[K]['params']): Promise<Api[K]['result']> {
    switch (method) {
      case 'workspace/open':
        return (await this.open()) as Api[K]['result']
      case 'tree/get':
        return { tree: this.tree() } as Api[K]['result']
      case 'tree/expand':
        return { tree: await this.expand((params as Api['tree/expand']['params']).path) } as Api[K]['result']
      case 'spec/annotate':
        return this.annotate(params as AnnotateParams) as Api[K]['result']
      case 'spec/move':
        return this.move(params as MoveParams) as Api[K]['result']
      case 'spec/save':
        return (await this.save()) as Api[K]['result']
      case 'spec/raw':
        return { markdown: this.raw() } as Api[K]['result']
      default:
        throw new Error(`未知方法 "${String(method)}"`)
    }
  }

  private assertWritable(): void {
    if (this.parseErrors !== null) {
      throw new Error('契约文件解析失败，当前为只读模式，请先修复文件')
    }
  }
}

function findActual(node: ActualNode, path: string): ActualNode | null {
  if (node.path === path) return node
  for (const c of node.children ?? []) {
    const hit = findActual(c, path)
    if (hit) return hit
  }
  return null
}
```

- [ ] **Step 5: 导出公开 API**

`packages/core/src/index.ts` 整体替换为：

```ts
export const CORE_VERSION = '0.1.0'

export * from './types.js'
export * from './api.js'
export { parseSpec, parseStructure, parseTemplates, parseRules, splitSections, SUPPORTED_VERSION, ANNOTATION_SEPARATOR } from './parse/index.js'
export { serializeSpec } from './serialize.js'
export { scan, MAX_CHILDREN, DEFAULT_DEPTH } from './scan.js'
export { gitStatus } from './git.js'
export { merge } from './merge.js'
export { emptySpec, setAnnotation, moveNode, findSpecNode } from './spec-edit.js'
export type { AnnotationPatch } from './spec-edit.js'
export { Session, SPEC_FILENAME } from './session.js'
```

- [ ] **Step 6: 运行全部测试与类型检查**

```bash
pnpm -C packages/core test
pnpm -C packages/core typecheck
```

预期：全部 PASS（约 100 个测试）。

- [ ] **Step 7: 验证 api.ts 没有 node 依赖**

```bash
grep -n "node:" packages/core/src/api.ts packages/core/src/types.ts
```

预期：**无输出**。有输出说明 `ui` 的包边界被破坏了。

- [ ] **Step 8: 提交**

```bash
git add packages/core/src/api.ts packages/core/src/session.ts packages/core/src/session.test.ts packages/core/src/index.ts
git commit -m "feat(core): Api 类型契约与宿主无关的 Session 会话控制器"
```

**Phase A 完成。** `@folderspec/core` 已能完整走通"扫描 → 读契约 → 合成视图 → 改注释/拖拽 → 自校验 → 存盘"。

---

## Phase B — `@folderspec/ui`（Task 11–14）

一份 React SPA，只认 `Bridge` 接口。**本阶段所有测试都用 `FakeBridge`，不碰真实文件系统，也不 import 任何 node 模块。**

---

### Task 11: UI 脚手架、配色映射与 FakeBridge

**Files:**
- Create: `packages/ui/package.json`
- Create: `packages/ui/tsconfig.json`
- Create: `packages/ui/vite.config.ts`
- Create: `packages/ui/vitest.config.ts`
- Create: `packages/ui/index.html`
- Create: `packages/ui/src/colors.ts`
- Create: `packages/ui/src/test-bridge.ts`
- Create: `packages/ui/src/styles.css`
- Test: `packages/ui/src/colors.test.ts`
- Modify: `packages/core/src/api.ts`（再导出 ui 需要的类型）

**Interfaces:**
- Consumes: `Bridge`、`Api`、`ViewNode`、`GitState`、`Severity`、`NodeOrigin`（`@folderspec/core/api`）
- Produces:
  - `const GIT_COLOR_VAR: Record<GitState, string>`
  - `const SEVERITY_BADGE: Record<Severity, string>`
  - `function nodeColorVar(node: ViewNode): string | undefined`
  - `class FakeBridge implements Bridge`（含 `calls: Array<{ method: string; params: unknown }>`）

**配色策略**：UI 只使用自己的 CSS 变量（`--fs-git-modified` 等）。每个宿主提供一张映射表把它们指到宿主的主题色上——VSCode 宿主指到 `--vscode-gitDecoration-*`，CLI 宿主指到内置的浅/深色值。这样 UI 完全不知道宿主的存在。

- [ ] **Step 1: 在 core 的 api.ts 中补充类型再导出**

在 `packages/core/src/api.ts` 顶部的 import 之后追加：

```ts
export type { GitState, NodeOrigin, ParseError, Severity, Spec, SpecNode, ViewNode } from './types.js'
```

- [ ] **Step 2: 建立 ui 包**

`packages/ui/package.json`：

```json
{
  "name": "@folderspec/ui",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "vite build",
    "dev": "vite",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-arborist": "^3.4.0"
  },
  "devDependencies": {
    "@folderspec/core": "workspace:*",
    "@testing-library/react": "^16.1.0",
    "@testing-library/user-event": "^14.5.2",
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    "jsdom": "^25.0.1",
    "typescript": "^5.6.3",
    "vite": "^6.0.3",
    "vitest": "^2.1.8"
  }
}
```

`packages/ui/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "noEmit": true,
    "types": ["vite/client"]
  },
  "include": ["src"]
}
```

`packages/ui/vite.config.ts`：

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // 两个宿主都以本地文件方式加载产物，必须用相对路径
  base: './',
  build: { outDir: 'dist', emptyOutDir: true },
})
```

`packages/ui/vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: { environment: 'jsdom', include: ['src/**/*.test.{ts,tsx}'], globals: true },
})
```

`packages/ui/index.html`：

```html
<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>FolderSpec</title></head>
  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>
```

`packages/ui/src/styles.css`：

```css
:root {
  --fs-git-ignored: #7a7a7a;
  --fs-git-untracked: #3fa34d;
  --fs-git-modified: #d1a000;
  --fs-git-added: #3fa34d;
  --fs-git-deleted: #c74e39;
  --fs-git-conflicted: #c74e39;
  --fs-annotated: #4aa3ff;
  --fs-fg: #1f1f1f;
  --fs-bg: #ffffff;
  --fs-border: #d4d4d4;
  --fs-selected-bg: #e4ecf7;
}

* { box-sizing: border-box; }
body { margin: 0; font: 13px/1.5 system-ui, sans-serif; color: var(--fs-fg); background: var(--fs-bg); }
.fs-layout { display: flex; height: 100vh; }
.fs-left { display: flex; flex-direction: column; flex: 1 1 auto; min-width: 0; border-right: 1px solid var(--fs-border); }
.fs-right { flex: 0 0 320px; padding: 12px; overflow: auto; }
.fs-toolbar { display: flex; gap: 8px; padding: 8px; border-bottom: 1px solid var(--fs-border); }
.fs-toolbar input { flex: 1 1 auto; min-width: 0; }
.fs-row { display: flex; align-items: center; gap: 6px; height: 100%; padding-right: 8px; cursor: pointer; white-space: nowrap; }
.fs-row[data-selected='true'] { background: var(--fs-selected-bg); }
.fs-row[data-origin='spec-only'] { border: 1px dashed currentColor; border-radius: 3px; opacity: 0.85; }
.fs-row[data-annotated='true'] .fs-name { color: var(--fs-annotated); font-weight: 600; }
.fs-annotation { opacity: 0.65; overflow: hidden; text-overflow: ellipsis; }
.fs-banner { padding: 8px 12px; background: #fde8e8; color: #7a1c1c; border-bottom: 1px solid var(--fs-border); }
.fs-banner ul { margin: 4px 0 0; padding-left: 18px; }
```

- [ ] **Step 3: 写失败的测试**

`packages/ui/src/colors.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { GIT_COLOR_VAR, SEVERITY_BADGE, nodeColorVar, isAnnotated } from './colors.js'
import type { ViewNode } from '@folderspec/core/api'

const node = (over: Partial<ViewNode> = {}): ViewNode =>
  ({ name: 'x', path: 'x', isDir: false, origin: 'actual-only', ...over })

describe('colors', () => {
  it('每个 git 状态都有对应的 CSS 变量', () => {
    expect(Object.keys(GIT_COLOR_VAR).sort()).toEqual(
      ['added', 'conflicted', 'deleted', 'ignored', 'modified', 'untracked'],
    )
    expect(GIT_COLOR_VAR.modified).toBe('--fs-git-modified')
  })

  it('三级 severity 各有一个徽标', () => {
    expect(SEVERITY_BADGE).toEqual({ error: '🔴', warning: '🟠', advisory: '🔵' })
  })

  it('有 git 状态时用 git 颜色', () => {
    expect(nodeColorVar(node({ gitState: 'ignored' }))).toBe('var(--fs-git-ignored)')
  })

  it('无 git 状态时不返回颜色', () => {
    expect(nodeColorVar(node())).toBeUndefined()
  })

  it('注释、role、severity 任一存在即视为已标注', () => {
    expect(isAnnotated(node())).toBe(false)
    expect(isAnnotated(node({ annotation: 'x' }))).toBe(true)
    expect(isAnnotated(node({ role: 'core' }))).toBe(true)
    expect(isAnnotated(node({ severity: 'error' }))).toBe(true)
    expect(isAnnotated(node({ template: 'case' }))).toBe(true)
  })
})
```

- [ ] **Step 4: 运行测试确认失败**

```bash
pnpm install
pnpm -C packages/ui test
```

预期：FAIL，`Failed to resolve import "./colors.js"`。

- [ ] **Step 5: 写实现**

`packages/ui/src/colors.ts`：

```ts
import type { GitState, Severity, ViewNode } from '@folderspec/core/api'

export const GIT_COLOR_VAR: Record<GitState, string> = {
  ignored: '--fs-git-ignored',
  untracked: '--fs-git-untracked',
  modified: '--fs-git-modified',
  added: '--fs-git-added',
  deleted: '--fs-git-deleted',
  conflicted: '--fs-git-conflicted',
}

export const SEVERITY_BADGE: Record<Severity, string> = {
  error: '🔴',
  warning: '🟠',
  advisory: '🔵',
}

export function nodeColorVar(node: ViewNode): string | undefined {
  if (!node.gitState) return undefined
  return `var(${GIT_COLOR_VAR[node.gitState]})`
}

export function isAnnotated(node: ViewNode): boolean {
  return Boolean(node.annotation || node.role || node.severity || node.template)
}
```

`packages/ui/src/test-bridge.ts`：

```ts
import type { Api, ApiMethod, Bridge, BridgeEvent } from '@folderspec/core/api'

type Handlers = { [K in ApiMethod]?: (params: Api[K]['params']) => Api[K]['result'] }

/** 测试用 Bridge：不碰文件系统，按脚本回应并记录全部调用 */
export class FakeBridge implements Bridge {
  readonly calls: Array<{ method: ApiMethod; params: unknown }> = []
  private listeners = new Map<BridgeEvent, Set<(p: unknown) => void>>()

  constructor(private handlers: Handlers = {}) {}

  async request<K extends ApiMethod>(method: K, params: Api[K]['params']): Promise<Api[K]['result']> {
    this.calls.push({ method, params })
    const handler = this.handlers[method] as ((p: Api[K]['params']) => Api[K]['result']) | undefined
    if (!handler) throw new Error(`FakeBridge 未配置方法 "${method}"`)
    return handler(params)
  }

  on(event: BridgeEvent, cb: (payload: unknown) => void): () => void {
    const set = this.listeners.get(event) ?? new Set()
    set.add(cb)
    this.listeners.set(event, set)
    return () => set.delete(cb)
  }

  emit(event: BridgeEvent, payload: unknown): void {
    for (const cb of this.listeners.get(event) ?? []) cb(payload)
  }

  lastCall(method: ApiMethod): unknown {
    for (let i = this.calls.length - 1; i >= 0; i--) {
      if (this.calls[i].method === method) return this.calls[i].params
    }
    return undefined
  }
}
```

- [ ] **Step 6: 运行测试确认通过**

```bash
pnpm -C packages/ui test
```

预期：5 个测试全部 PASS。

- [ ] **Step 7: 验证 ui 没有 node 依赖**

```bash
grep -rn "node:" packages/ui/src/ || echo "无 node 依赖，符合包边界"
```

预期：输出 `无 node 依赖，符合包边界`。

- [ ] **Step 8: 提交**

```bash
git add packages/ui packages/core/src/api.ts
git commit -m "feat(ui): UI 脚手架、配色变量映射与测试用 FakeBridge"
```

---

### Task 12: 树行渲染与着色

**Files:**
- Create: `packages/ui/src/NodeRow.tsx`
- Create: `packages/ui/src/Tree.tsx`
- Test: `packages/ui/src/NodeRow.test.tsx`
- Test: `packages/ui/src/Tree.test.tsx`

**Interfaces:**
- Consumes: `nodeColorVar`、`isAnnotated`、`SEVERITY_BADGE`（Task 11）、`ViewNode`
- Produces:
  - `function NodeRow(props: NodeRendererProps<ViewNode>): JSX.Element`
  - `interface TreeProps { data: ViewNode[]; selectedPath: string | null; searchTerm: string; onSelect(path: string, node: ViewNode): void; onExpand(path: string): void; onMove(from: string, toParent: string, isDir: boolean): void; disabled: boolean }`
  - `function SpecTree(props: TreeProps): JSX.Element`
  - `function makeMoveHandler(nodes, onMove): (args: { dragIds: string[]; parentId: string | null }) => void`（导出以便直接单测，无需渲染虚拟列表）
  - `function matchesSearch(node: ViewNode, term: string): boolean`

- [ ] **Step 1: 写失败的测试**

`packages/ui/src/NodeRow.test.tsx`：

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { NodeRow } from './NodeRow.js'
import type { ViewNode } from '@folderspec/core/api'

const make = (over: Partial<ViewNode> = {}): ViewNode =>
  ({ name: 'walk.ts', path: 'src/walk.ts', isDir: false, origin: 'actual-only', ...over })

const renderRow = (data: ViewNode, opts: { selected?: boolean; open?: boolean } = {}) => {
  const node = {
    data,
    isSelected: opts.selected ?? false,
    isOpen: opts.open ?? false,
    isLeaf: !data.isDir,
    toggle: vi.fn(),
  }
  return render(
    <NodeRow
      node={node as never}
      style={{}}
      dragHandle={undefined}
      tree={{} as never}
      preview={false}
    />,
  )
}

describe('NodeRow', () => {
  it('显示节点名', () => {
    renderRow(make())
    expect(screen.getByText('walk.ts')).toBeTruthy()
  })

  it('目录名带尾斜杠', () => {
    renderRow(make({ name: 'src', path: 'src', isDir: true }))
    expect(screen.getByText('src/')).toBeTruthy()
  })

  it('git 状态映射到颜色变量', () => {
    const { container } = renderRow(make({ gitState: 'modified' }))
    const name = container.querySelector('.fs-name') as HTMLElement
    expect(name.style.color).toContain('--fs-git-modified')
  })

  it('已标注节点带 data-annotated 标记', () => {
    const { container } = renderRow(make({ annotation: '遍历入口' }))
    expect(container.querySelector('.fs-row')?.getAttribute('data-annotated')).toBe('true')
  })

  it('未标注节点不带该标记', () => {
    const { container } = renderRow(make())
    expect(container.querySelector('.fs-row')?.getAttribute('data-annotated')).toBe('false')
  })

  it('显示 severity 徽标', () => {
    renderRow(make({ severity: 'error', annotation: 'x' }))
    expect(screen.getByText('🔴')).toBeTruthy()
  })

  it('spec-only 节点带 data-origin 供 CSS 画虚线', () => {
    const { container } = renderRow(make({ origin: 'spec-only' }))
    expect(container.querySelector('.fs-row')?.getAttribute('data-origin')).toBe('spec-only')
  })

  it('行内显示注释摘要', () => {
    renderRow(make({ annotation: '并行遍历入口' }))
    expect(screen.getByText('并行遍历入口')).toBeTruthy()
  })

  it('截断的目录显示提示', () => {
    renderRow(make({ name: 'big', path: 'big', isDir: true, truncated: true }))
    expect(screen.getByTitle(/已截断/)).toBeTruthy()
  })

  it('不可读目录显示提示', () => {
    renderRow(make({ name: 'secret', path: 'secret', isDir: true, unreadable: true }))
    expect(screen.getByTitle(/无法读取/)).toBeTruthy()
  })
})
```

`packages/ui/src/Tree.test.tsx`：

```tsx
import { describe, it, expect, vi } from 'vitest'
import { makeMoveHandler, matchesSearch } from './Tree.js'
import type { ViewNode } from '@folderspec/core/api'

const tree: ViewNode[] = [
  { name: 'src', path: 'src', isDir: true, origin: 'both', children: [
    { name: 'core', path: 'src/core', isDir: true, origin: 'both', children: [] },
  ] },
  { name: 'examples', path: 'examples', isDir: true, origin: 'actual-only', children: [
    { name: 'foo', path: 'examples/foo', isDir: true, origin: 'actual-only', children: [] },
  ] },
  { name: 'README.md', path: 'README.md', isDir: false, origin: 'actual-only' },
]

describe('makeMoveHandler', () => {
  it('把 react-arborist 的 dragIds/parentId 翻译成 move 调用', () => {
    const onMove = vi.fn()
    makeMoveHandler(tree, onMove)({ dragIds: ['examples/foo'], parentId: 'src' })
    expect(onMove).toHaveBeenCalledWith('examples/foo', 'src', true)
  })

  it('parentId 为 null 表示移到根下，toParent 为空字符串', () => {
    const onMove = vi.fn()
    makeMoveHandler(tree, onMove)({ dragIds: ['src/core'], parentId: null })
    expect(onMove).toHaveBeenCalledWith('src/core', '', true)
  })

  it('传递 isDir=false 给文件节点', () => {
    const onMove = vi.fn()
    makeMoveHandler(tree, onMove)({ dragIds: ['README.md'], parentId: 'src' })
    expect(onMove).toHaveBeenCalledWith('README.md', 'src', false)
  })

  it('多选拖拽逐个上报', () => {
    const onMove = vi.fn()
    makeMoveHandler(tree, onMove)({ dragIds: ['src/core', 'README.md'], parentId: 'examples' })
    expect(onMove).toHaveBeenCalledTimes(2)
  })

  it('忽略树里找不到的 id', () => {
    const onMove = vi.fn()
    makeMoveHandler(tree, onMove)({ dragIds: ['ghost'], parentId: 'src' })
    expect(onMove).not.toHaveBeenCalled()
  })
})

describe('matchesSearch', () => {
  const n = (name: string, annotation?: string): ViewNode =>
    ({ name, path: name, isDir: false, origin: 'actual-only', ...(annotation ? { annotation } : {}) })

  it('匹配名称，忽略大小写', () => {
    expect(matchesSearch(n('README.md'), 'readme')).toBe(true)
  })

  it('也匹配注释内容', () => {
    expect(matchesSearch(n('a.ts', '并行遍历入口'), '遍历')).toBe(true)
  })

  it('不匹配时返回 false', () => {
    expect(matchesSearch(n('a.ts'), 'zzz')).toBe(false)
  })

  it('空搜索词一律匹配', () => {
    expect(matchesSearch(n('a.ts'), '')).toBe(true)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm -C packages/ui test
```

预期：两个新测试文件都因模块解析失败而 FAIL。

- [ ] **Step 3: 写 NodeRow**

`packages/ui/src/NodeRow.tsx`：

```tsx
import type { NodeRendererProps } from 'react-arborist'
import type { ViewNode } from '@folderspec/core/api'
import { SEVERITY_BADGE, isAnnotated, nodeColorVar } from './colors.js'

export function NodeRow({ node, style, dragHandle }: NodeRendererProps<ViewNode>) {
  const d = node.data
  const color = nodeColorVar(d)
  const annotated = isAnnotated(d)

  return (
    <div
      ref={dragHandle}
      style={style}
      className="fs-row"
      data-selected={node.isSelected}
      data-origin={d.origin}
      data-annotated={annotated}
      onClick={() => { if (d.isDir) node.toggle() }}
    >
      <span className="fs-caret" aria-hidden="true">
        {d.isDir ? (node.isOpen ? '▾' : '▸') : ' '}
      </span>
      {d.severity ? <span className="fs-badge">{SEVERITY_BADGE[d.severity]}</span> : null}
      <span className="fs-name" style={color ? { color } : undefined}>
        {d.name}{d.isDir ? '/' : ''}
      </span>
      {d.truncated ? <span title={`子项过多，已截断显示`}>⋯</span> : null}
      {d.unreadable ? <span title={`无法读取该目录（通常是权限不足）`}>🚫</span> : null}
      {d.annotation ? <span className="fs-annotation">{d.annotation}</span> : null}
    </div>
  )
}
```

- [ ] **Step 4: 写 Tree**

`packages/ui/src/Tree.tsx`：

```tsx
import { Tree } from 'react-arborist'
import type { ViewNode } from '@folderspec/core/api'
import { NodeRow } from './NodeRow.js'

export interface TreeProps {
  data: ViewNode[]
  selectedPath: string | null
  searchTerm: string
  width: number
  height: number
  disabled: boolean
  onSelect(path: string, node: ViewNode): void
  onExpand(path: string): void
  onMove(from: string, toParent: string, isDir: boolean): void
}

export function flatten(nodes: ViewNode[]): Map<string, ViewNode> {
  const map = new Map<string, ViewNode>()
  const visit = (list: ViewNode[]) => {
    for (const n of list) {
      map.set(n.path, n)
      if (n.children) visit(n.children)
    }
  }
  visit(nodes)
  return map
}

/** 把 react-arborist 的 onMove 回调翻译成本项目的 move 语义 */
export function makeMoveHandler(
  data: ViewNode[],
  onMove: (from: string, toParent: string, isDir: boolean) => void,
) {
  return ({ dragIds, parentId }: { dragIds: string[]; parentId: string | null }) => {
    const index = flatten(data)
    for (const id of dragIds) {
      const node = index.get(id)
      if (!node) continue
      onMove(id, parentId ?? '', node.isDir)
    }
  }
}

export function matchesSearch(node: ViewNode, term: string): boolean {
  if (term === '') return true
  const t = term.toLowerCase()
  return node.name.toLowerCase().includes(t) || (node.annotation ?? '').toLowerCase().includes(t)
}

export function SpecTree(props: TreeProps) {
  const { data, selectedPath, searchTerm, width, height, disabled, onSelect, onExpand, onMove } = props
  return (
    <Tree<ViewNode>
      data={data}
      selection={selectedPath ?? undefined}
      idAccessor="path"
      childrenAccessor="children"
      openByDefault={false}
      width={width}
      height={height}
      indent={16}
      rowHeight={24}
      searchTerm={searchTerm}
      searchMatch={(node, term) => matchesSearch(node.data, term)}
      disableDrag={disabled}
      disableDrop={({ parentNode }) => disabled || !parentNode.data.isDir}
      onMove={makeMoveHandler(data, onMove)}
      onToggle={id => { const n = flatten(data).get(id); if (n?.isDir && n.children === undefined) onExpand(id) }}
      onSelect={nodes => { const n = nodes[0]; if (n) onSelect(n.data.path, n.data) }}
    >
      {NodeRow}
    </Tree>
  )
}
```

> **注意**：`onToggle` 里判断 `children === undefined` 才请求展开，正是 Task 6 定下的懒加载边界语义——`undefined` 是"未扫描"，`[]` 是"已扫描且为空"。

- [ ] **Step 5: 运行测试确认通过**

```bash
pnpm -C packages/ui test
```

预期：colors 5 + NodeRow 10 + Tree 9 = 24 个测试全部 PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/ui/src/NodeRow.tsx packages/ui/src/Tree.tsx packages/ui/src/NodeRow.test.tsx packages/ui/src/Tree.test.tsx
git commit -m "feat(ui): 虚拟化树渲染、git 与注释着色、拖拽语义翻译"
```

---

### Task 13: 右侧常驻注释面板

**Files:**
- Create: `packages/ui/src/AnnotationPanel.tsx`
- Test: `packages/ui/src/AnnotationPanel.test.tsx`

**Interfaces:**
- Consumes: `ViewNode`、`Severity`、`SEVERITY_BADGE`（Task 11）
- Produces:
  - `interface PanelPatch { annotation?: string | null; role?: string | null; severity?: Severity | null }`
  - `interface AnnotationPanelProps { node: ViewNode | null; disabled: boolean; onChange(patch: PanelPatch): void }`
  - `function AnnotationPanel(props: AnnotationPanelProps): JSX.Element`

交互定为**失焦提交**：编辑时只改本地状态，`blur` 时才向上派发。这样不会给每个按键都产生一次 spec 编辑与整棵树的重建。

- [ ] **Step 1: 写失败的测试**

`packages/ui/src/AnnotationPanel.test.tsx`：

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AnnotationPanel } from './AnnotationPanel.js'
import type { ViewNode } from '@folderspec/core/api'

const node = (over: Partial<ViewNode> = {}): ViewNode =>
  ({ name: 'core', path: 'src/core', isDir: true, origin: 'both', ...over })

describe('AnnotationPanel', () => {
  it('未选中节点时给出提示', () => {
    render(<AnnotationPanel node={null} disabled={false} onChange={vi.fn()} />)
    expect(screen.getByText('在左侧选中一个文件或目录')).toBeTruthy()
  })

  it('显示选中节点的路径', () => {
    render(<AnnotationPanel node={node()} disabled={false} onChange={vi.fn()} />)
    expect(screen.getByText('src/core')).toBeTruthy()
  })

  it('回填已有的注释、role 与 severity', () => {
    render(<AnnotationPanel
      node={node({ annotation: '内核', role: 'core-engine', severity: 'error' })}
      disabled={false} onChange={vi.fn()} />)
    expect((screen.getByLabelText('注释') as HTMLTextAreaElement).value).toBe('内核')
    expect((screen.getByLabelText('语义角色') as HTMLInputElement).value).toBe('core-engine')
    expect((screen.getByLabelText('约束强度') as HTMLSelectElement).value).toBe('error')
  })

  it('注释失焦时提交', () => {
    const onChange = vi.fn()
    render(<AnnotationPanel node={node()} disabled={false} onChange={onChange} />)
    const ta = screen.getByLabelText('注释')
    fireEvent.change(ta, { target: { value: '文件系统扫描层' } })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.blur(ta)
    expect(onChange).toHaveBeenCalledWith({ annotation: '文件系统扫描层' })
  })

  it('清空注释时提交 null', () => {
    const onChange = vi.fn()
    render(<AnnotationPanel node={node({ annotation: '旧的' })} disabled={false} onChange={onChange} />)
    const ta = screen.getByLabelText('注释')
    fireEvent.change(ta, { target: { value: '' } })
    fireEvent.blur(ta)
    expect(onChange).toHaveBeenCalledWith({ annotation: null })
  })

  it('内容没变时不提交', () => {
    const onChange = vi.fn()
    render(<AnnotationPanel node={node({ annotation: '内核' })} disabled={false} onChange={onChange} />)
    fireEvent.blur(screen.getByLabelText('注释'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('切换 severity 立即提交', () => {
    const onChange = vi.fn()
    render(<AnnotationPanel node={node()} disabled={false} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('约束强度'), { target: { value: 'warning' } })
    expect(onChange).toHaveBeenCalledWith({ severity: 'warning' })
  })

  it('severity 选空值时提交 null', () => {
    const onChange = vi.fn()
    render(<AnnotationPanel node={node({ severity: 'error' })} disabled={false} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('约束强度'), { target: { value: '' } })
    expect(onChange).toHaveBeenCalledWith({ severity: null })
  })

  it('切换选中节点时重置为新节点的内容', () => {
    const { rerender } = render(
      <AnnotationPanel node={node({ annotation: 'A' })} disabled={false} onChange={vi.fn()} />)
    rerender(
      <AnnotationPanel node={node({ path: 'src/ui', annotation: 'B' })} disabled={false} onChange={vi.fn()} />)
    expect((screen.getByLabelText('注释') as HTMLTextAreaElement).value).toBe('B')
  })

  it('只读模式下全部控件禁用', () => {
    render(<AnnotationPanel node={node()} disabled={true} onChange={vi.fn()} />)
    expect((screen.getByLabelText('注释') as HTMLTextAreaElement).disabled).toBe(true)
    expect((screen.getByLabelText('语义角色') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText('约束强度') as HTMLSelectElement).disabled).toBe(true)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm -C packages/ui test src/AnnotationPanel.test.tsx
```

预期：FAIL，`Failed to resolve import "./AnnotationPanel.js"`。

- [ ] **Step 3: 写实现**

`packages/ui/src/AnnotationPanel.tsx`：

```tsx
import { useEffect, useState } from 'react'
import type { Severity, ViewNode } from '@folderspec/core/api'
import { SEVERITY_BADGE } from './colors.js'

export interface PanelPatch {
  annotation?: string | null
  role?: string | null
  severity?: Severity | null
}

export interface AnnotationPanelProps {
  node: ViewNode | null
  disabled: boolean
  onChange(patch: PanelPatch): void
}

export function AnnotationPanel({ node, disabled, onChange }: AnnotationPanelProps) {
  const [annotation, setAnnotation] = useState('')
  const [role, setRole] = useState('')

  // 切换选中节点时用新节点的内容重置本地编辑态
  useEffect(() => {
    setAnnotation(node?.annotation ?? '')
    setRole(node?.role ?? '')
  }, [node?.path, node?.annotation, node?.role])

  if (!node) {
    return <div className="fs-panel-empty">在左侧选中一个文件或目录</div>
  }

  const commit = (key: 'annotation' | 'role', local: string, original: string | undefined) => {
    const trimmed = local.trim()
    if (trimmed === (original ?? '')) return
    onChange({ [key]: trimmed === '' ? null : trimmed })
  }

  return (
    <div className="fs-panel">
      <h2 className="fs-panel-path">{node.path === '' ? '（工作区根）' : node.path}</h2>
      <p className="fs-panel-origin">
        {node.origin === 'spec-only'
          ? 'spec 中声明，磁盘上不存在——可能待创建，也可能已被删除'
          : node.origin === 'unscanned'
            ? '所在目录尚未扫描，展开后自动重新解析'
            : node.isDir ? '目录' : '文件'}
      </p>

      <label className="fs-field">
        <span>注释</span>
        <textarea
          aria-label="注释"
          rows={6}
          value={annotation}
          disabled={disabled}
          onChange={e => setAnnotation(e.target.value)}
          onBlur={() => commit('annotation', annotation, node.annotation)}
        />
      </label>

      <label className="fs-field">
        <span>语义角色</span>
        <input
          aria-label="语义角色"
          type="text"
          placeholder="例如 core-engine"
          value={role}
          disabled={disabled}
          onChange={e => setRole(e.target.value)}
          onBlur={() => commit('role', role, node.role)}
        />
      </label>

      <label className="fs-field">
        <span>约束强度</span>
        <select
          aria-label="约束强度"
          value={node.severity ?? ''}
          disabled={disabled}
          onChange={e => onChange({ severity: e.target.value === '' ? null : (e.target.value as Severity) })}
        >
          <option value="">（仅注释，不强制）</option>
          <option value="advisory">{SEVERITY_BADGE.advisory} advisory — 建议</option>
          <option value="warning">{SEVERITY_BADGE.warning} warning — 应遵守，违反须说明</option>
          <option value="error">{SEVERITY_BADGE.error} error — 必须遵守</option>
        </select>
      </label>
    </div>
  )
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pnpm -C packages/ui test src/AnnotationPanel.test.tsx
```

预期：10 个测试全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/ui/src/AnnotationPanel.tsx packages/ui/src/AnnotationPanel.test.tsx
git commit -m "feat(ui): 右侧常驻注释面板（失焦提交）"
```

---

### Task 14: App 组装、工具栏与只读横幅

Phase B 的收口。

**Files:**
- Create: `packages/ui/src/Toolbar.tsx`
- Create: `packages/ui/src/App.tsx`
- Create: `packages/ui/src/main.tsx`
- Test: `packages/ui/src/App.test.tsx`

**Interfaces:**
- Consumes: `SpecTree`（Task 12）、`AnnotationPanel`（Task 13）、`Bridge`/`OpenResult`/`ViewNode`
- Produces:
  - `interface ToolbarProps { root: string; searchTerm: string; dirty: boolean; disabled: boolean; onOpenRoot(path: string): void; onSearch(term: string): void; onSave(): void }`
  - `function Toolbar(props: ToolbarProps): JSX.Element`
  - `interface AppProps { bridge: Bridge; initialRoot: string }`
  - `function App(props: AppProps): JSX.Element`
  - `packages/ui/src/main.tsx` 从 `window.__folderspecBridge` 取宿主注入的 Bridge 并挂载

- [ ] **Step 1: 写失败的测试**

`packages/ui/src/App.test.tsx`：

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { App } from './App.js'
import { FakeBridge } from './test-bridge.js'
import type { OpenResult, ViewNode } from '@folderspec/core/api'

const tree = (children: ViewNode[]): ViewNode =>
  ({ name: 'repo', path: '', isDir: true, origin: 'both', children })

const SRC: ViewNode = { name: 'src', path: 'src', isDir: true, origin: 'actual-only', children: [] }

const openResult = (over: Partial<OpenResult> = {}): OpenResult => ({
  root: '/tmp/repo',
  rootName: 'repo',
  hasSpec: false,
  specPath: '/tmp/repo/.folderspec.md',
  parseErrors: null,
  tree: tree([SRC]),
  ...over,
})

const bridgeWith = (over: Partial<Record<string, unknown>> = {}) => new FakeBridge({
  'workspace/open': () => openResult(over as Partial<OpenResult>),
  'spec/annotate': () => ({ tree: tree([{ ...SRC, annotation: '核心源码', origin: 'both' }]), dirty: true }),
  'spec/move': () => ({ tree: tree([SRC]), dirty: true }),
  'spec/save': () => ({ written: true }),
  'tree/expand': () => ({ tree: tree([SRC]) }),
} as never)

describe('App', () => {
  it('挂载时打开初始工作区', async () => {
    const bridge = bridgeWith()
    render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => expect(bridge.lastCall('workspace/open')).toEqual({ root: '/tmp/repo' }))
  })

  it('工具栏回填当前根路径', async () => {
    render(<App bridge={bridgeWith()} initialRoot="/tmp/repo" />)
    await waitFor(() =>
      expect((screen.getByLabelText('工作区路径') as HTMLInputElement).value).toBe('/tmp/repo'))
  })

  it('点击载入按钮用新路径重新打开', async () => {
    const bridge = bridgeWith()
    render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))
    fireEvent.change(screen.getByLabelText('工作区路径'), { target: { value: '/tmp/other' } })
    fireEvent.click(screen.getByText('载入'))
    await waitFor(() => expect(bridge.lastCall('workspace/open')).toEqual({ root: '/tmp/other' }))
  })

  it('解析失败时显示只读横幅并列出行号', async () => {
    const bridge = bridgeWith({ parseErrors: [{ line: 7, message: '未知标签 [planned]' }] })
    render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => expect(screen.getByText(/只读模式/)).toBeTruthy())
    expect(screen.getByText(/第 7 行：未知标签 \[planned\]/)).toBeTruthy()
  })

  it('只读模式下保存按钮禁用', async () => {
    const bridge = bridgeWith({ parseErrors: [{ line: 1, message: 'x' }] })
    render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => expect((screen.getByText('保存') as HTMLButtonElement).disabled).toBe(true))
  })

  it('无未保存改动时保存按钮禁用', async () => {
    render(<App bridge={bridgeWith()} initialRoot="/tmp/repo" />)
    await waitFor(() => expect((screen.getByText('保存') as HTMLButtonElement).disabled).toBe(true))
  })

  it('搜索框把词传给树', async () => {
    render(<App bridge={bridgeWith()} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('搜索'))
    fireEvent.change(screen.getByLabelText('搜索'), { target: { value: 'core' } })
    expect((screen.getByLabelText('搜索') as HTMLInputElement).value).toBe('core')
  })

  it('面板改动经 bridge 发出 spec/annotate 并刷新树', async () => {
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    // 直接触发 App 暴露给树的选中回调，避开虚拟列表的测量问题
    const row = container.querySelector('.fs-row')
    if (row) fireEvent.click(row)
    await waitFor(() => screen.getByLabelText('注释'))

    const ta = screen.getByLabelText('注释')
    fireEvent.change(ta, { target: { value: '核心源码' } })
    fireEvent.blur(ta)

    await waitFor(() => expect(bridge.lastCall('spec/annotate')).toMatchObject({
      path: 'src', isDir: true, annotation: '核心源码',
    }))
    await waitFor(() => expect((screen.getByText('保存') as HTMLButtonElement).disabled).toBe(false))
  })

  it('点击保存调用 spec/save 并清除脏标记', async () => {
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))
    const row = container.querySelector('.fs-row')
    if (row) fireEvent.click(row)
    await waitFor(() => screen.getByLabelText('注释'))
    fireEvent.change(screen.getByLabelText('注释'), { target: { value: 'x' } })
    fireEvent.blur(screen.getByLabelText('注释'))
    await waitFor(() => expect((screen.getByText('保存') as HTMLButtonElement).disabled).toBe(false))

    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(bridge.calls.some(c => c.method === 'spec/save')).toBe(true))
    await waitFor(() => expect((screen.getByText('保存') as HTMLButtonElement).disabled).toBe(true))
  })

  it('收到 external-change 事件时提示可重载', async () => {
    const bridge = bridgeWith()
    render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))
    bridge.emit('external-change', {})
    await waitFor(() => expect(screen.getByText(/已在外部修改/)).toBeTruthy())
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm -C packages/ui test src/App.test.tsx
```

预期：FAIL，`Failed to resolve import "./App.js"`。

- [ ] **Step 3: 写 Toolbar**

`packages/ui/src/Toolbar.tsx`：

```tsx
import { useEffect, useState } from 'react'

export interface ToolbarProps {
  root: string
  searchTerm: string
  dirty: boolean
  disabled: boolean
  onOpenRoot(path: string): void
  onSearch(term: string): void
  onSave(): void
}

export function Toolbar({ root, searchTerm, dirty, disabled, onOpenRoot, onSearch, onSave }: ToolbarProps) {
  const [draft, setDraft] = useState(root)
  useEffect(() => { setDraft(root) }, [root])

  return (
    <div className="fs-toolbar">
      <input
        aria-label="工作区路径"
        type="text"
        value={draft}
        placeholder="工作区路径"
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') onOpenRoot(draft) }}
      />
      <button type="button" onClick={() => onOpenRoot(draft)}>载入</button>
      <input
        aria-label="搜索"
        type="search"
        value={searchTerm}
        placeholder="按名称或注释筛选"
        onChange={e => onSearch(e.target.value)}
      />
      <button type="button" disabled={disabled || !dirty} onClick={onSave}>
        保存{dirty ? ' •' : ''}
      </button>
    </div>
  )
}
```

- [ ] **Step 4: 写 App**

`packages/ui/src/App.tsx`：

```tsx
import { useCallback, useEffect, useState } from 'react'
import type { Bridge, OpenResult, ParseError, ViewNode } from '@folderspec/core/api'
import { SpecTree, flatten } from './Tree.js'
import { AnnotationPanel } from './AnnotationPanel.js'
import type { PanelPatch } from './AnnotationPanel.js'
import { Toolbar } from './Toolbar.js'

export interface AppProps {
  bridge: Bridge
  initialRoot: string
}

export function App({ bridge, initialRoot }: AppProps) {
  const [root, setRoot] = useState(initialRoot)
  const [tree, setTree] = useState<ViewNode | null>(null)
  const [parseErrors, setParseErrors] = useState<ParseError[] | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [dirty, setDirty] = useState(false)
  const [externalChange, setExternalChange] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [size, setSize] = useState({ width: 600, height: 600 })

  useEffect(() => {
    const onResize = () => setSize({
      width: Math.max(240, window.innerWidth - 320),
      height: Math.max(200, window.innerHeight - 44),
    })
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const openRoot = useCallback(async (path: string) => {
    try {
      const r: OpenResult = await bridge.request('workspace/open', { root: path })
      setRoot(r.root)
      setTree(r.tree)
      setParseErrors(r.parseErrors)
      setSelectedPath(null)
      setDirty(false)
      setExternalChange(false)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [bridge])

  useEffect(() => { void openRoot(initialRoot) }, [openRoot, initialRoot])

  useEffect(() => bridge.on('external-change', () => setExternalChange(true)), [bridge])

  const readOnly = parseErrors !== null

  const handleExpand = useCallback(async (path: string) => {
    const r = await bridge.request('tree/expand', { path })
    setTree(r.tree)
  }, [bridge])

  const handleMove = useCallback(async (from: string, toParent: string, isDir: boolean) => {
    try {
      const r = await bridge.request('spec/move', { from, toParent, isDir })
      setTree(r.tree)
      setDirty(r.dirty)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [bridge])

  const handlePatch = useCallback(async (patch: PanelPatch) => {
    if (selectedPath === null || tree === null) return
    const node = flatten(tree.children ?? []).get(selectedPath)
    if (!node) return
    try {
      const r = await bridge.request('spec/annotate', { path: selectedPath, isDir: node.isDir, ...patch })
      setTree(r.tree)
      setDirty(r.dirty)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [bridge, selectedPath, tree])

  const handleSave = useCallback(async () => {
    try {
      await bridge.request('spec/save', {})
      setDirty(false)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [bridge])

  const selectedNode = tree && selectedPath !== null
    ? flatten(tree.children ?? []).get(selectedPath) ?? null
    : null

  return (
    <div className="fs-layout">
      <div className="fs-left">
        <Toolbar
          root={root}
          searchTerm={searchTerm}
          dirty={dirty}
          disabled={readOnly}
          onOpenRoot={p => void openRoot(p)}
          onSearch={setSearchTerm}
          onSave={() => void handleSave()}
        />

        {parseErrors && (
          <div className="fs-banner" role="alert">
            契约文件解析失败，当前为<strong>只读模式</strong>。已保留你的原文件未做任何改动，请修复后重新载入。
            <ul>
              {parseErrors.map(e => <li key={`${e.line}-${e.message}`}>第 {e.line} 行：{e.message}</li>)}
            </ul>
          </div>
        )}

        {externalChange && (
          <div className="fs-banner" role="status">
            契约文件已在外部修改。
            <button type="button" onClick={() => void openRoot(root)}>重新载入</button>
          </div>
        )}

        {error && <div className="fs-banner" role="alert">{error}</div>}

        {tree && (
          <SpecTree
            data={tree.children ?? []}
            selectedPath={selectedPath}
            searchTerm={searchTerm}
            width={size.width}
            height={size.height}
            disabled={readOnly}
            onSelect={path => setSelectedPath(path)}
            onExpand={path => void handleExpand(path)}
            onMove={(from, toParent, isDir) => void handleMove(from, toParent, isDir)}
          />
        )}
      </div>

      <div className="fs-right">
        <AnnotationPanel
          node={selectedNode}
          disabled={readOnly}
          onChange={patch => void handlePatch(patch)}
        />
      </div>
    </div>
  )
}
```

- [ ] **Step 5: 写入口**

`packages/ui/src/main.tsx`：

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Bridge } from '@folderspec/core/api'
import { App } from './App.js'
import './styles.css'

declare global {
  interface Window {
    __folderspecBridge?: Bridge
    __folderspecRoot?: string
  }
}

const bridge = window.__folderspecBridge
if (!bridge) throw new Error('宿主未注入 window.__folderspecBridge')

const el = document.getElementById('root')
if (!el) throw new Error('缺少 #root 挂载点')

createRoot(el).render(
  <StrictMode>
    <App bridge={bridge} initialRoot={window.__folderspecRoot ?? '.'} />
  </StrictMode>,
)
```

- [ ] **Step 6: 运行全部 ui 测试与类型检查**

```bash
pnpm -C packages/ui test
pnpm -C packages/ui typecheck
```

预期：colors 5 + NodeRow 10 + Tree 9 + AnnotationPanel 10 + App 10 = 44 个测试全部 PASS。

- [ ] **Step 7: 验证构建产物可用相对路径加载**

```bash
pnpm -C packages/ui build
grep -o 'src="[^"]*"' packages/ui/dist/index.html
```

预期：输出形如 `src="./assets/index-xxxx.js"`（相对路径）。若是 `/assets/...` 说明 `base: './'` 没生效，两个宿主都会加载失败。

- [ ] **Step 8: 提交**

```bash
git add packages/ui/src/App.tsx packages/ui/src/Toolbar.tsx packages/ui/src/main.tsx packages/ui/src/App.test.tsx
git commit -m "feat(ui): App 组装、工具栏、只读横幅与外部变更提示"
```

**Phase B 完成。** UI 已可用 `FakeBridge` 完整跑通全部交互，且不含一行 node 代码。

---

## Phase C — 两个宿主（Task 15–17）

各约 200–300 行的薄壳：把 `Bridge` 接到 `core.Session` 上，仅此而已。

---

### Task 15: CLI 宿主（`npx folderspec`）

**Files:**
- Create: `packages/cli/package.json`
- Create: `packages/cli/tsconfig.json`
- Create: `packages/cli/vitest.config.ts`
- Create: `packages/cli/scripts/copy-ui.mjs`
- Create: `packages/cli/src/protocol.ts`
- Create: `packages/cli/src/server.ts`
- Create: `packages/cli/src/open-window.ts`
- Create: `packages/cli/src/main.ts`
- Test: `packages/cli/src/server.test.ts`
- Test: `packages/cli/src/open-window.test.ts`

**Interfaces:**
- Consumes: `Session`（Task 10）、`@folderspec/ui` 的 `dist` 构建产物
- Produces:
  - `interface RpcRequest { id: number; method: ApiMethod; params: unknown }`
  - `type RpcResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string }`
  - `interface ServerHandle { port: number; url: string; close(): Promise<void> }`
  - `function startServer(opts: { root: string; port?: number; uiDir: string }): Promise<ServerHandle>`
  - `interface BrowserCandidate { command: string; appMode: boolean }`
  - `function pickBrowser(platform: NodeJS.Platform, available: readonly string[]): BrowserCandidate | null`

**独立 GUI 的实现**：找一个支持 `--app=<url>` 的 Chromium 系浏览器，用无边框窗口打开——看起来是原生应用，但不多下载一个字节。找不到就回退成普通标签页并在终端打印 URL（spec §8）。

- [ ] **Step 1: 建立包**

`packages/cli/package.json`：

```json
{
  "name": "folderspec",
  "version": "0.1.0",
  "type": "module",
  "bin": { "folderspec": "./dist/main.js" },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json && node scripts/copy-ui.mjs",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@folderspec/core": "workspace:*",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@folderspec/ui": "workspace:*",
    "@types/node": "^22.10.2",
    "@types/ws": "^8.5.13",
    "typescript": "^5.6.3",
    "vitest": "^2.1.8"
  }
}
```

`packages/cli/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src", "types": ["node"] },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"]
}
```

`packages/cli/vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['src/**/*.test.ts'] } })
```

`packages/cli/scripts/copy-ui.mjs`：

```js
import { cp, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 把 ui 的构建产物复制进 cli 的 dist，避免运行时依赖包解析
const here = dirname(fileURLToPath(import.meta.url))
const from = resolve(here, '../../ui/dist')
const to = resolve(here, '../dist/ui')
await mkdir(dirname(to), { recursive: true })
await cp(from, to, { recursive: true })
console.log(`已复制 UI 产物：${from} → ${to}`)
```

- [ ] **Step 2: 写失败的测试**

`packages/cli/src/open-window.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { pickBrowser } from './open-window.js'

describe('pickBrowser', () => {
  it('Linux 上优先选支持 --app 的 Chromium 系', () => {
    const b = pickBrowser('linux', ['firefox', 'google-chrome'])
    expect(b).toEqual({ command: 'google-chrome', appMode: true })
  })

  it('macOS 上用 open -a 走 Chrome', () => {
    const b = pickBrowser('darwin', ['/Applications/Google Chrome.app'])
    expect(b?.appMode).toBe(true)
  })

  it('只有 Firefox 时回退到非 app 模式', () => {
    const b = pickBrowser('linux', ['firefox'])
    expect(b).toEqual({ command: 'firefox', appMode: false })
  })

  it('一个浏览器都没有时返回 null', () => {
    expect(pickBrowser('linux', [])).toBeNull()
  })

  it('候选顺序稳定：chrome 优先于 chromium 优先于 edge', () => {
    const b = pickBrowser('linux', ['microsoft-edge', 'chromium', 'google-chrome'])
    expect(b?.command).toBe('google-chrome')
  })
})
```

`packages/cli/src/server.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import WebSocket from 'ws'
import { startServer } from './server.js'
import type { ServerHandle } from './server.js'
import { SPEC_FILENAME } from '@folderspec/core'

let repo: string
let uiDir: string
let server: ServerHandle

const rpc = (ws: WebSocket, id: number, method: string, params: unknown) =>
  new Promise<{ ok: boolean; result?: unknown; error?: string }>((resolve, reject) => {
    const onMessage = (raw: WebSocket.RawData) => {
      const msg = JSON.parse(String(raw))
      if (msg.id !== id) return
      ws.off('message', onMessage)
      resolve(msg)
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ id, method, params }), err => { if (err) reject(err) })
  })

beforeAll(async () => {
  repo = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'folderspec-cli-'))
  await fs.mkdir(nodePath.join(repo, 'src'), { recursive: true })
  uiDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'folderspec-ui-'))
  await fs.writeFile(
    nodePath.join(uiDir, 'index.html'),
    '<!doctype html><html><head></head><body><p>ui</p></body></html>',
  )
  server = await startServer({ root: repo, uiDir })
})

afterAll(async () => {
  await server.close()
  await fs.rm(repo, { recursive: true, force: true })
  await fs.rm(uiDir, { recursive: true, force: true })
})

describe('startServer', () => {
  it('监听在一个可用端口上', () => {
    expect(server.port).toBeGreaterThan(0)
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/`)
  })

  it('提供 index.html', async () => {
    const res = await fetch(server.url)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('ui')
  })

  it('把注入脚本插进 index.html', async () => {
    const html = await (await fetch(server.url)).text()
    expect(html).toContain('__folderspecRoot')
  })

  it('拒绝跳出 uiDir 的路径穿越', async () => {
    // 必须用百分号编码：裸的 ../ 会被 fetch 在发出前归一化掉，测不到守卫
    const res = await fetch(`${server.url}%2e%2e%2f%2e%2e%2fetc%2fpasswd`)
    expect(res.status).toBe(404)
  })

  it('通过 WebSocket 响应 RPC 请求', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`)
    await new Promise(r => ws.once('open', r))
    try {
      const opened = await rpc(ws, 1, 'workspace/open', { root: repo })
      expect(opened.ok).toBe(true)
      expect((opened.result as { rootName: string }).rootName).toBe(nodePath.basename(repo))
    } finally {
      ws.close()
    }
  })

  it('走完整的注释与保存链路', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`)
    await new Promise(r => ws.once('open', r))
    try {
      await rpc(ws, 1, 'workspace/open', { root: repo })
      const edited = await rpc(ws, 2, 'spec/annotate', { path: 'src', isDir: true, annotation: '核心源码' })
      expect(edited.ok).toBe(true)
      const saved = await rpc(ws, 3, 'spec/save', {})
      expect(saved.ok).toBe(true)
      const text = await fs.readFile(nodePath.join(repo, SPEC_FILENAME), 'utf8')
      expect(text).toContain('- `src/` — 核心源码')
    } finally {
      ws.close()
    }
  })

  it('用不同的 root 再次 open 会切换到新工作区', async () => {
    const other = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'folderspec-other-'))
    await fs.mkdir(nodePath.join(other, 'lib'), { recursive: true })
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`)
    await new Promise(r => ws.once('open', r))
    try {
      await rpc(ws, 1, 'workspace/open', { root: repo })
      const opened = await rpc(ws, 2, 'workspace/open', { root: other })
      expect(opened.ok).toBe(true)
      const result = opened.result as { root: string; tree: { children?: Array<{ name: string }> } }
      expect(result.root).toBe(other)
      expect(result.tree.children?.map(c => c.name)).toEqual(['lib'])
    } finally {
      ws.close()
      await fs.rm(other, { recursive: true, force: true })
    }
  })

  it('把错误作为 ok:false 回传而不是断开连接', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`)
    await new Promise(r => ws.once('open', r))
    try {
      const res = await rpc(ws, 1, 'no/such/method', {})
      expect(res.ok).toBe(false)
      expect(res.error).toContain('未知方法')
      expect(ws.readyState).toBe(WebSocket.OPEN)
    } finally {
      ws.close()
    }
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

```bash
pnpm install
pnpm -C packages/cli test
```

预期：两个测试文件都因模块解析失败而 FAIL。

- [ ] **Step 4: 写协议类型**

`packages/cli/src/protocol.ts`：

```ts
import type { ApiMethod } from '@folderspec/core'

export interface RpcRequest {
  id: number
  method: ApiMethod
  params: unknown
}

export type RpcResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }

export interface RpcEvent {
  event: string
  payload: unknown
}
```

- [ ] **Step 5: 写服务端**

`packages/cli/src/server.ts`：

```ts
import * as http from 'node:http'
import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'
import { WebSocketServer } from 'ws'
import { Session } from '@folderspec/core'
import type { ApiMethod } from '@folderspec/core'
import type { RpcRequest, RpcResponse } from './protocol.js'

export interface ServerHandle {
  port: number
  url: string
  close(): Promise<void>
}

export interface ServerOpts {
  root: string
  uiDir: string
  port?: number
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

export async function startServer(opts: ServerOpts): Promise<ServerHandle> {
  let session = new Session(nodePath.resolve(opts.root))
  const uiDir = nodePath.resolve(opts.uiDir)

  const server = http.createServer((req, res) => {
    void serveStatic(req, res, uiDir, opts.root)
  })

  const wss = new WebSocketServer({ server })
  wss.on('connection', socket => {
    socket.on('message', async raw => {
      let req: RpcRequest
      try {
        req = JSON.parse(String(raw)) as RpcRequest
      } catch {
        return
      }
      let response: RpcResponse
      try {
        // 切换工作区 = 换一个 Session。Session 自己不处理换根。
        if (req.method === 'workspace/open') {
          const wanted = nodePath.resolve((req.params as { root?: string }).root ?? session.root)
          if (wanted !== session.root) session = new Session(wanted)
        }
        const result = await session.handle(req.method as ApiMethod, req.params as never)
        response = { id: req.id, ok: true, result }
      } catch (e) {
        response = { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) }
      }
      socket.send(JSON.stringify(response))
    })
  })

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') resolve(addr.port)
      else reject(new Error('无法确定监听端口'))
    })
  })

  return {
    port,
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>(resolve => {
        wss.close(() => server.close(() => resolve()))
      }),
  }
}

async function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  uiDir: string,
  root: string,
): Promise<void> {
  const rawPath = (req.url ?? '/').split('?')[0]
  const rel = rawPath === '/' ? 'index.html' : decodeURIComponent(rawPath.replace(/^\/+/, ''))
  const abs = nodePath.resolve(uiDir, rel)

  // 路径穿越防护：解析后必须仍在 uiDir 之内
  if (abs !== uiDir && !abs.startsWith(uiDir + nodePath.sep)) {
    res.writeHead(404).end('not found')
    return
  }

  let body: Buffer
  try {
    body = await fs.readFile(abs)
  } catch {
    res.writeHead(404).end('not found')
    return
  }

  const ext = nodePath.extname(abs)
  if (ext === '.html') {
    const injected = String(body).replace(
      '</head>',
      `<script>window.__folderspecRoot=${JSON.stringify(root)};</script></head>`,
    )
    res.writeHead(200, { 'content-type': MIME['.html'] }).end(injected)
    return
  }

  res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' }).end(body)
}
```

> **注入的是根路径，不是 Bridge 本身。** WebSocket Bridge 的实现随 UI 产物一起打包（见 Step 7），页面加载后自行连接 `ws://` 同源地址。

- [ ] **Step 6: 写浏览器窗口启动**

`packages/cli/src/open-window.ts`：

```ts
import { spawn } from 'node:child_process'

export interface BrowserCandidate {
  command: string
  appMode: boolean
}

/** 支持 --app 无边框窗口的 Chromium 系，按优先级排列 */
const APP_CAPABLE: Record<string, readonly string[]> = {
  linux: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'],
  darwin: ['/Applications/Google Chrome.app', '/Applications/Microsoft Edge.app', '/Applications/Chromium.app'],
  win32: ['chrome.exe', 'msedge.exe'],
}

/** 不支持 --app，只能开普通标签页 */
const FALLBACK: readonly string[] = ['firefox', 'firefox-esr', '/Applications/Firefox.app']

export function pickBrowser(platform: NodeJS.Platform, available: readonly string[]): BrowserCandidate | null {
  for (const c of APP_CAPABLE[platform] ?? []) {
    if (available.includes(c)) return { command: c, appMode: true }
  }
  for (const c of FALLBACK) {
    if (available.includes(c)) return { command: c, appMode: false }
  }
  const first = available[0]
  return first ? { command: first, appMode: false } : null
}

export function launch(candidate: BrowserCandidate, url: string, platform: NodeJS.Platform): void {
  const args = candidate.appMode
    ? [`--app=${url}`, '--window-size=1200,800']
    : [url]

  if (platform === 'darwin') {
    spawn('open', ['-na', candidate.command, '--args', ...args], { detached: true, stdio: 'ignore' }).unref()
    return
  }
  spawn(candidate.command, args, { detached: true, stdio: 'ignore' }).unref()
}
```

- [ ] **Step 7: 写 WebSocket Bridge（打包进 UI 产物）**

`packages/ui/src/ws-bridge.ts`（属于 ui 包，因为它在浏览器里运行）：

```ts
import type { Api, ApiMethod, Bridge, BridgeEvent } from '@folderspec/core/api'

/** 浏览器宿主用的 Bridge：走同源 WebSocket */
export function createWebSocketBridge(url: string): Bridge {
  const socket = new WebSocket(url)
  const ready = new Promise<void>(resolve => socket.addEventListener('open', () => resolve(), { once: true }))
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()
  const listeners = new Map<BridgeEvent, Set<(p: unknown) => void>>()
  let nextId = 1

  socket.addEventListener('message', ev => {
    const msg = JSON.parse(String(ev.data))
    if (typeof msg.event === 'string') {
      for (const cb of listeners.get(msg.event as BridgeEvent) ?? []) cb(msg.payload)
      return
    }
    const slot = pending.get(msg.id)
    if (!slot) return
    pending.delete(msg.id)
    if (msg.ok) slot.resolve(msg.result)
    else slot.reject(new Error(msg.error))
  })

  return {
    async request<K extends ApiMethod>(method: K, params: Api[K]['params']): Promise<Api[K]['result']> {
      await ready
      const id = nextId++
      return new Promise<Api[K]['result']>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
    on(event, cb) {
      const set = listeners.get(event) ?? new Set()
      set.add(cb)
      listeners.set(event, set)
      return () => set.delete(cb)
    },
  }
}
```

在 `packages/ui/src/main.tsx` 中，把取 Bridge 的那几行替换为：

```tsx
import { createWebSocketBridge } from './ws-bridge.js'

// VSCode 宿主会预先注入 __folderspecBridge；浏览器宿主则连同源 WebSocket
const bridge = window.__folderspecBridge
  ?? createWebSocketBridge(`ws://${window.location.host}/`)
```

- [ ] **Step 8: 写命令行入口**

`packages/cli/src/main.ts`：

```ts
#!/usr/bin/env node
import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer } from './server.js'
import { launch, pickBrowser } from './open-window.js'
import type { BrowserCandidate } from './open-window.js'

const HELP = `folderspec — 可视化声明仓库结构意图

用法：
  folderspec [目录]          在指定目录（默认为当前目录）打开
  folderspec --port <n>      指定端口（默认随机可用端口）
  folderspec --no-open       只起服务，不自动开窗口
  folderspec --help          显示本帮助
`

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP)
    return
  }

  const noOpen = argv.includes('--no-open')
  const portIdx = argv.indexOf('--port')
  const port = portIdx !== -1 ? Number(argv[portIdx + 1]) : undefined
  const positional = argv.filter((a, i) =>
    !a.startsWith('-') && !(portIdx !== -1 && i === portIdx + 1))
  const root = nodePath.resolve(positional[0] ?? process.cwd())

  const here = nodePath.dirname(fileURLToPath(import.meta.url))
  const uiDir = nodePath.join(here, 'ui')

  const server = await startServer({ root, uiDir, ...(port ? { port } : {}) })
  process.stdout.write(`FolderSpec 已启动\n  工作区：${root}\n  地址：  ${server.url}\n`)

  if (!noOpen) {
    const candidate = await detectBrowser()
    if (candidate) {
      launch(candidate, server.url, process.platform)
      if (!candidate.appMode) {
        process.stdout.write('未找到支持无边框窗口的浏览器，已在普通标签页中打开。\n')
      }
    } else {
      process.stdout.write('未检测到可用浏览器，请手动打开上面的地址。\n')
    }
  }

  const shutdown = () => { void server.close().then(() => process.exit(0)) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

async function detectBrowser(): Promise<BrowserCandidate | null> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)

  const probe = async (name: string): Promise<boolean> => {
    if (name.startsWith('/')) {
      try { await fs.access(name); return true } catch { return false }
    }
    try {
      await run(process.platform === 'win32' ? 'where' : 'which', [name])
      return true
    } catch { return false }
  }

  const all = [
    'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge',
    'chrome.exe', 'msedge.exe', 'firefox', 'firefox-esr',
    '/Applications/Google Chrome.app', '/Applications/Microsoft Edge.app',
    '/Applications/Chromium.app', '/Applications/Firefox.app',
  ]
  const available: string[] = []
  for (const name of all) if (await probe(name)) available.push(name)
  return pickBrowser(process.platform, available)
}

void main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
  process.exit(1)
})
```

- [ ] **Step 9: 运行测试确认通过**

```bash
pnpm -C packages/ui build
pnpm -C packages/cli test
```

预期：open-window 5 + server 8 = 13 个测试全部 PASS。

- [ ] **Step 10: 手动冒烟**

```bash
pnpm -C packages/ui build && pnpm -C packages/cli build
node packages/cli/dist/main.js --no-open --port 7777
```

另开一个终端：

```bash
curl -s http://127.0.0.1:7777/ | head -c 200
```

预期：输出含 `__folderspecRoot` 的 HTML。确认后 Ctrl-C 停掉。

- [ ] **Step 11: 提交**

```bash
git add packages/cli packages/ui/src/ws-bridge.ts packages/ui/src/main.tsx
git commit -m "feat(cli): 本地服务 + WebSocket Bridge + 浏览器无边框窗口宿主"
```

---

### Task 16: VSCode 宿主（CustomTextEditorProvider）

**Files:**
- Create: `packages/vscode/package.json`
- Create: `packages/vscode/tsconfig.json`
- Create: `packages/vscode/vitest.config.ts`
- Create: `packages/vscode/scripts/copy-ui.mjs`
- Create: `packages/vscode/src/webview-html.ts`
- Create: `packages/vscode/src/editor.ts`
- Create: `packages/vscode/src/extension.ts`
- Create: `packages/ui/src/vscode-bridge.ts`
- Test: `packages/vscode/src/webview-html.test.ts`
- Modify: `packages/ui/src/main.tsx`（按宿主自动选择 Bridge 实现）

**Interfaces:**
- Consumes: `Session`、`emptySpec`、`serializeSpec`、`SPEC_FILENAME`（core）；`@folderspec/ui` 的 `dist`
- Produces:
  - `function buildWebviewHtml(opts: { indexHtml: string; assetBase: string; cspSource: string; nonce: string }): string`
  - `class FolderSpecEditorProvider implements vscode.CustomTextEditorProvider`
  - `function createVscodeBridge(): Bridge`（在 ui 包中）

**关键设计：`spec/save` 在 VSCode 宿主里被改写。** 其余方法直接转给 `Session`，但保存不走 `session.save()` 直接写盘——而是把 `session.raw()` 的结果作为一次 `WorkspaceEdit` 应用到 `TextDocument` 上，再 `document.save()`。这样 VSCode 自己的脏标记、Ctrl+S、撤销栈全部正常工作，用户拿到的是和文本编辑器一致的体验。**这是 Bridge 抽象带来的直接好处：宿主可以只重写一个方法。**

- [ ] **Step 1: 建立包**

`packages/vscode/package.json`：

```json
{
  "name": "folderspec-vscode",
  "displayName": "FolderSpec",
  "description": "可视化声明仓库结构意图，产出给 AI Agent 遵守的结构契约",
  "version": "0.1.0",
  "publisher": "folderspec",
  "engines": { "vscode": "^1.90.0" },
  "categories": ["Visualization", "Other"],
  "main": "./dist/extension.js",
  "activationEvents": ["onCommand:folderspec.open"],
  "contributes": {
    "customEditors": [
      {
        "viewType": "folderspec.editor",
        "displayName": "FolderSpec 结构契约",
        "selector": [{ "filenamePattern": ".folderspec.md" }],
        "priority": "default"
      }
    ],
    "commands": [
      { "command": "folderspec.open", "title": "FolderSpec：打开结构契约" }
    ]
  },
  "scripts": {
    "build": "node scripts/copy-ui.mjs && esbuild src/extension.ts --bundle --outfile=dist/extension.js --external:vscode --format=cjs --platform=node",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": { "@folderspec/core": "workspace:*" },
  "devDependencies": {
    "@folderspec/ui": "workspace:*",
    "@types/node": "^22.10.2",
    "@types/vscode": "^1.90.0",
    "esbuild": "^0.24.0",
    "typescript": "^5.6.3",
    "vitest": "^2.1.8"
  }
}
```

`packages/vscode/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"],
    "verbatimModuleSyntax": false
  },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"]
}
```

`packages/vscode/vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['src/**/*.test.ts'] } })
```

`packages/vscode/scripts/copy-ui.mjs`：

```js
import { cp, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const from = resolve(here, '../../ui/dist')
const to = resolve(here, '../media/ui')
await mkdir(dirname(to), { recursive: true })
await cp(from, to, { recursive: true })
console.log(`已复制 UI 产物：${from} → ${to}`)
```

- [ ] **Step 2: 写失败的测试**

`packages/vscode/src/webview-html.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { buildWebviewHtml } from './webview-html.js'

const INDEX = [
  '<!doctype html>',
  '<html><head><link rel="stylesheet" href="./assets/index-abc.css"></head>',
  '<body><div id="root"></div><script type="module" src="./assets/index-abc.js"></script></body></html>',
].join('\n')

const build = () => buildWebviewHtml({
  indexHtml: INDEX,
  assetBase: 'https://vscode-webview.example/media/ui',
  cspSource: 'https://vscode-webview.example',
  nonce: 'NONCE123',
})

describe('buildWebviewHtml', () => {
  it('把相对资源路径改写成 webview URI', () => {
    const html = build()
    expect(html).toContain('https://vscode-webview.example/media/ui/assets/index-abc.js')
    expect(html).toContain('https://vscode-webview.example/media/ui/assets/index-abc.css')
    expect(html).not.toContain('"./assets/')
  })

  it('给所有 script 标签打上 nonce', () => {
    const html = build()
    const scripts = html.match(/<script/g) ?? []
    const nonces = html.match(/nonce="NONCE123"/g) ?? []
    expect(nonces.length).toBe(scripts.length)
  })

  it('注入 CSP，且脚本只允许带 nonce 的', () => {
    const html = build()
    expect(html).toContain('Content-Security-Policy')
    expect(html).toContain("script-src 'nonce-NONCE123'")
    expect(html).toContain("default-src 'none'")
  })

  it('注入把 --fs-* 指向 VSCode 主题色的样式', () => {
    const html = build()
    expect(html).toContain('--fs-git-modified: var(--vscode-gitDecoration-modifiedResourceForeground')
    expect(html).toContain('--fs-git-ignored: var(--vscode-gitDecoration-ignoredResourceForeground')
    expect(html).toContain('--fs-fg: var(--vscode-foreground')
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

```bash
pnpm install
pnpm -C packages/vscode test
```

预期：FAIL，`Failed to resolve import "./webview-html.js"`。

- [ ] **Step 4: 写 webview HTML 构建**

`packages/vscode/src/webview-html.ts`：

```ts
export interface WebviewHtmlOpts {
  indexHtml: string
  assetBase: string
  cspSource: string
  nonce: string
}

/** 把 UI 的 --fs-* 变量指到 VSCode 主题色上，UI 本身对宿主一无所知 */
const THEME_BRIDGE = `
:root {
  --fs-git-ignored: var(--vscode-gitDecoration-ignoredResourceForeground, #7a7a7a);
  --fs-git-untracked: var(--vscode-gitDecoration-untrackedResourceForeground, #3fa34d);
  --fs-git-modified: var(--vscode-gitDecoration-modifiedResourceForeground, #d1a000);
  --fs-git-added: var(--vscode-gitDecoration-addedResourceForeground, #3fa34d);
  --fs-git-deleted: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39);
  --fs-git-conflicted: var(--vscode-gitDecoration-conflictingResourceForeground, #c74e39);
  --fs-annotated: var(--vscode-textLink-foreground, #4aa3ff);
  --fs-fg: var(--vscode-foreground, #1f1f1f);
  --fs-bg: var(--vscode-editor-background, #ffffff);
  --fs-border: var(--vscode-panel-border, #d4d4d4);
  --fs-selected-bg: var(--vscode-list-activeSelectionBackground, #e4ecf7);
}
`

export function buildWebviewHtml(opts: WebviewHtmlOpts): string {
  const { indexHtml, assetBase, cspSource, nonce } = opts

  const csp = [
    `default-src 'none'`,
    `img-src ${cspSource} data:`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `font-src ${cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ')

  let html = indexHtml
    .replace(/(src|href)="\.\/(.*?)"/g, (_m, attr: string, path: string) => `${attr}="${assetBase}/${path}"`)
    .replace(/<script(?![^>]*\bnonce=)/g, `<script nonce="${nonce}"`)

  const head = [
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    `<style>${THEME_BRIDGE}</style>`,
  ].join('\n')

  return html.replace('<head>', `<head>\n${head}`)
}
```

- [ ] **Step 5: 写 VSCode Bridge（在 ui 包中）**

`packages/ui/src/vscode-bridge.ts`：

```ts
import type { Api, ApiMethod, Bridge, BridgeEvent } from '@folderspec/core/api'

interface VsCodeApi {
  postMessage(msg: unknown): void
}

declare function acquireVsCodeApi(): VsCodeApi

/** VSCode webview 宿主用的 Bridge：走 postMessage */
export function createVscodeBridge(): Bridge {
  const vscode = acquireVsCodeApi()
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()
  const listeners = new Map<BridgeEvent, Set<(p: unknown) => void>>()
  let nextId = 1

  window.addEventListener('message', ev => {
    const msg = ev.data as { id?: number; ok?: boolean; result?: unknown; error?: string; event?: string; payload?: unknown }
    if (typeof msg.event === 'string') {
      for (const cb of listeners.get(msg.event as BridgeEvent) ?? []) cb(msg.payload)
      return
    }
    if (typeof msg.id !== 'number') return
    const slot = pending.get(msg.id)
    if (!slot) return
    pending.delete(msg.id)
    if (msg.ok) slot.resolve(msg.result)
    else slot.reject(new Error(msg.error ?? '未知错误'))
  })

  return {
    request<K extends ApiMethod>(method: K, params: Api[K]['params']): Promise<Api[K]['result']> {
      const id = nextId++
      return new Promise<Api[K]['result']>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
        vscode.postMessage({ id, method, params })
      })
    },
    on(event, cb) {
      const set = listeners.get(event) ?? new Set()
      set.add(cb)
      listeners.set(event, set)
      return () => set.delete(cb)
    },
  }
}
```

- [ ] **Step 6: 整体替换 `packages/ui/src/main.tsx`**

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Bridge } from '@folderspec/core/api'
import { App } from './App.js'
import { createWebSocketBridge } from './ws-bridge.js'
import { createVscodeBridge } from './vscode-bridge.js'
import './styles.css'

declare global {
  interface Window {
    __folderspecRoot?: string
    acquireVsCodeApi?: unknown
  }
}

// 宿主自识别：VSCode webview 里有 acquireVsCodeApi，浏览器里没有
const bridge: Bridge = typeof window.acquireVsCodeApi === 'function'
  ? createVscodeBridge()
  : createWebSocketBridge(`ws://${window.location.host}/`)

const el = document.getElementById('root')
if (!el) throw new Error('缺少 #root 挂载点')

createRoot(el).render(
  <StrictMode>
    <App bridge={bridge} initialRoot={window.__folderspecRoot ?? '.'} />
  </StrictMode>,
)
```

- [ ] **Step 7: 写自定义编辑器**

`packages/vscode/src/editor.ts`：

```ts
import * as vscode from 'vscode'
import * as nodePath from 'node:path'
import { randomBytes } from 'node:crypto'
import { Session } from '@folderspec/core'
import type { ApiMethod } from '@folderspec/core'
import { buildWebviewHtml } from './webview-html.js'

export const VIEW_TYPE = 'folderspec.editor'

export class FolderSpecEditorProvider implements vscode.CustomTextEditorProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const root = workspaceRootFor(document.uri)
    let session = new Session(root)

    const uiRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'ui')
    panel.webview.options = { enableScripts: true, localResourceRoots: [uiRoot] }

    const indexHtml = new TextDecoder().decode(
      await vscode.workspace.fs.readFile(vscode.Uri.joinPath(uiRoot, 'index.html')),
    )
    panel.webview.html = buildWebviewHtml({
      indexHtml,
      assetBase: panel.webview.asWebviewUri(uiRoot).toString(),
      cspSource: panel.webview.cspSource,
      nonce: randomBytes(16).toString('base64'),
    })

    // 我们自己发起的编辑不应该被当成外部变更
    let applyingOwnEdit = false

    const changeSub = vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.uri.toString() !== document.uri.toString()) return
      if (applyingOwnEdit) return
      void panel.webview.postMessage({ event: 'external-change', payload: {} })
    })

    const messageSub = panel.webview.onDidReceiveMessage(async (msg: { id: number; method: ApiMethod; params: unknown }) => {
      try {
        // 切换工作区 = 换一个 Session（VSCode 端一般只会重开同一个根）
        if (msg.method === 'workspace/open') {
          const wanted = (msg.params as { root?: string }).root
          if (wanted && nodePath.resolve(wanted) !== session.root) {
            session = new Session(nodePath.resolve(wanted))
          }
        }
        let result: unknown
        if (msg.method === 'spec/save') {
          // 不直接写盘：走 WorkspaceEdit，让 VSCode 的脏标记、Ctrl+S 与撤销栈正常工作
          applyingOwnEdit = true
          try {
            const edit = new vscode.WorkspaceEdit()
            const whole = new vscode.Range(
              document.positionAt(0),
              document.positionAt(document.getText().length),
            )
            edit.replace(document.uri, whole, session.raw())
            await vscode.workspace.applyEdit(edit)
            await document.save()
          } finally {
            applyingOwnEdit = false
          }
          result = { written: true }
        } else {
          result = await session.handle(msg.method, msg.params as never)
        }
        void panel.webview.postMessage({ id: msg.id, ok: true, result })
      } catch (e) {
        void panel.webview.postMessage({
          id: msg.id,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    })

    panel.onDidDispose(() => {
      changeSub.dispose()
      messageSub.dispose()
    })
  }
}

function workspaceRootFor(uri: vscode.Uri): string {
  const folder = vscode.workspace.getWorkspaceFolder(uri)
  return folder ? folder.uri.fsPath : nodePath.dirname(uri.fsPath)
}
```

- [ ] **Step 8: 写扩展入口**

`packages/vscode/src/extension.ts`：

```ts
import * as vscode from 'vscode'
import { emptySpec, serializeSpec, SPEC_FILENAME } from '@folderspec/core'
import { FolderSpecEditorProvider, VIEW_TYPE } from './editor.js'

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      VIEW_TYPE,
      new FolderSpecEditorProvider(context),
      { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false },
    ),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('folderspec.open', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0]
      if (!folder) {
        void vscode.window.showErrorMessage('FolderSpec：请先打开一个工作区文件夹。')
        return
      }
      const uri = vscode.Uri.joinPath(folder.uri, SPEC_FILENAME)

      let exists = true
      try {
        await vscode.workspace.fs.stat(uri)
      } catch {
        exists = false
      }

      if (!exists) {
        const choice = await vscode.window.showInformationMessage(
          `本工作区还没有 ${SPEC_FILENAME}，是否创建？`,
          { modal: true },
          '创建',
        )
        if (choice !== '创建') return
        await vscode.workspace.fs.writeFile(
          uri,
          new TextEncoder().encode(serializeSpec(emptySpec())),
        )
      }

      await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE)
    }),
  )
}

export function deactivate(): void {
  // 无需清理：全部资源都挂在 context.subscriptions 上
}
```

- [ ] **Step 9: 运行测试与构建**

```bash
pnpm -C packages/ui build
pnpm -C packages/ui test
pnpm -C packages/vscode test
pnpm -C packages/vscode build
```

预期：webview-html 4 个测试 PASS；ui 全部测试仍 PASS（main.tsx 替换后）；`packages/vscode/dist/extension.js` 与 `packages/vscode/media/ui/` 生成成功。

- [ ] **Step 10: 提交**

```bash
git add packages/vscode packages/ui/src/vscode-bridge.ts packages/ui/src/main.tsx
git commit -m "feat(vscode): CustomTextEditorProvider 宿主，保存走 WorkspaceEdit"
```

---

### Task 17: 端到端冒烟测试

**Files:**
- Create: `packages/vscode/src/test/runTest.ts`
- Create: `packages/vscode/src/test/suite/index.ts`
- Create: `packages/vscode/src/test/suite/smoke.test.ts`
- Modify: `packages/vscode/package.json`（加 `@vscode/test-electron`、`mocha`、`glob` 与 `test:e2e` 脚本）
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: 已构建的扩展（Task 16）
- Produces: `pnpm -C packages/vscode test:e2e` 可跑通；CI 在 Linux 上跑全部单测 + E2E

- [ ] **Step 1: 加依赖与脚本**

```bash
pnpm -C packages/vscode add -D @vscode/test-electron@^2.4.1 mocha@^10.8.2 @types/mocha@^10.0.10 glob@^11.0.0
```

在 `packages/vscode/package.json` 的 `scripts` 中加一行：

```json
"test:e2e": "tsc -p tsconfig.test.json && node dist-test/test/runTest.js"
```

新建 `packages/vscode/tsconfig.test.json`：

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "outDir": "dist-test", "rootDir": "src" },
  "include": ["src"]
}
```

- [ ] **Step 2: 写测试运行器**

`packages/vscode/src/test/runTest.ts`：

```ts
import * as nodePath from 'node:path'
import { runTests } from '@vscode/test-electron'

async function main(): Promise<void> {
  const extensionDevelopmentPath = nodePath.resolve(__dirname, '../../')
  const extensionTestsPath = nodePath.resolve(__dirname, './suite/index')
  await runTests({ extensionDevelopmentPath, extensionTestsPath })
}

void main().catch((e: unknown) => {
  console.error('E2E 测试运行失败', e)
  process.exit(1)
})
```

`packages/vscode/src/test/suite/index.ts`：

```ts
import * as nodePath from 'node:path'
import Mocha from 'mocha'
import { glob } from 'glob'

export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 60_000 })
  const testsRoot = __dirname
  for (const f of await glob('**/*.test.js', { cwd: testsRoot })) {
    mocha.addFile(nodePath.resolve(testsRoot, f))
  }
  await new Promise<void>((resolve, reject) => {
    mocha.run(failures => (failures > 0 ? reject(new Error(`${failures} 个测试失败`)) : resolve()))
  })
}
```

- [ ] **Step 3: 写冒烟测试**

`packages/vscode/src/test/suite/smoke.test.ts`：

```ts
import * as assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import * as vscode from 'vscode'

suite('FolderSpec 冒烟测试', () => {
  test('打开 .folderspec.md 时使用自定义编辑器，且写注释后能存回磁盘', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0]
    assert.ok(folder, '测试需要一个已打开的工作区')

    const specUri = vscode.Uri.joinPath(folder.uri, '.folderspec.md')
    const initial = [
      '---', 'folderspec: 1', 'root: .', 'ownership: human', '---',
      '', '# 仓库结构契约', '', '## 结构', '', '- `src/` — 初始注释', '',
    ].join('\n')
    await vscode.workspace.fs.writeFile(specUri, new TextEncoder().encode(initial))

    // 以自定义编辑器打开
    await vscode.commands.executeCommand('vscode.openWith', specUri, 'folderspec.editor')
    await new Promise(r => setTimeout(r, 3000))

    // 文档仍可被正常读取，内容未被破坏
    const doc = await vscode.workspace.openTextDocument(specUri)
    assert.ok(doc.getText().includes('- `src/` — 初始注释'))

    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  })

  test('folderspec.open 命令已注册', async () => {
    const all = await vscode.commands.getCommands(true)
    assert.ok(all.includes('folderspec.open'))
  })
})

// 供 runTest 指定工作区用；实际路径在 CI 中由 runTest 的 launchArgs 提供
export const TMP_HINT = nodePath.join(os.tmpdir(), 'folderspec-e2e')
void fs
```

在 `packages/vscode/src/test/runTest.ts` 的 `runTests` 调用中补上工作区参数：

```ts
import * as fs from 'node:fs'
import * as os from 'node:os'

const workspace = nodePath.join(os.tmpdir(), 'folderspec-e2e')
fs.mkdirSync(nodePath.join(workspace, 'src'), { recursive: true })

await runTests({
  extensionDevelopmentPath,
  extensionTestsPath,
  launchArgs: [workspace, '--disable-extensions'],
})
```

- [ ] **Step 4: 运行 E2E**

```bash
pnpm -C packages/ui build && pnpm -C packages/vscode build
pnpm -C packages/vscode test:e2e
```

预期：下载一次 VSCode 后，2 个测试 PASS。

> **Linux 无头环境**：需要 `xvfb`。命令改为 `xvfb-run -a pnpm -C packages/vscode test:e2e`。

- [ ] **Step 5: 写 CI**

`.github/workflows/ci.yml`：

```yaml
name: CI

on:
  push: { branches: [main] }
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm -C packages/core test
      - run: pnpm -C packages/ui test
      - run: pnpm -C packages/ui build
      - run: pnpm -C packages/cli test
      - run: pnpm -C packages/vscode test
      - run: pnpm -C packages/vscode build
      - run: xvfb-run -a pnpm -C packages/vscode test:e2e
```

- [ ] **Step 6: 跑一遍完整验证**

```bash
pnpm install
pnpm typecheck
pnpm -r test
pnpm -r build
```

预期：全绿。

- [ ] **Step 7: 提交**

```bash
git add packages/vscode .github/workflows/ci.yml
git commit -m "test: VSCode 端到端冒烟测试与 CI 流水线"
```

**MVP 完成。**

---

## MVP 已知限制（写进 README，不要假装不存在）

1. **嵌套 `.gitignore` 的覆盖范围**：扫描时逐目录组合 ignore 规则，但只覆盖到当前已扫描的深度。更深处的 `.gitignore` 会在该目录被展开时才生效。绝大多数场景无感，但不等价于 git 的完整语义。
2. **位置差异不可跨会话检测**：重新加载后无法知道 spec 中的 `src/cases/foo` 与磁盘上的 `examples/foo` 是同一个东西（spec §6.1）。这是遵循声明式原则的代价，二期功能 12 用 basename 启发式缓解。
3. **模板与规则只能手写 YAML**：MVP 不提供可视化编辑器（二期功能 13、14）。
4. **没有确定性校验**：MVP 只产出契约，不检查仓库是否符合契约（二期功能 15）。
5. **不编译到 AGENTS.md / .cursor/rules**：MVP 靠在 `CLAUDE.md` / `AGENTS.md` 里写 `@.folderspec.md` 引用（二期功能 16）。
6. **不做增量刷新**：外部改动需手动重新载入（二期功能 17）。
