# FolderSpec v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 FolderSpec 的界面改成 VSCode 风格的三栏（树 / 只读文件预览 / 注释区），支持多选并对一批节点写一条「整体」注释，该注释以新的 `## 分组` 区落进 `.folderspec.md`。

**Architecture:** 沿用既有分层：`@folderspec/core` 承担格式与纯逻辑，`@folderspec/ui` 只通过 `Bridge` 说话、不认识宿主。分组是 `Spec` 上的一等公民（`groups: Group[]`），成员关系存在分组一侧而非节点上；`ViewNode.groups` 由 `merge` 派生、不落盘。新增的 `file/read` 让工具首次读取任意文件内容，因此工作区边界校验从「延期项」升级为本计划的必做项。

**Tech Stack:** TypeScript strict · ESM · pnpm workspaces · Vitest + fast-check · React 18 + react-arborist · Prism（核心 + 约 12 种语言）· yaml · Node ≥ 20

**Spec:** [`docs/superpowers/specs/2026-08-20-folderspec-v2-design.md`](../specs/2026-08-20-folderspec-v2-design.md)

## Global Constraints

隐含属于每一个任务的验收条件。

- **只读铁律**：整个程序只允许写 `.folderspec.md` 一个文件。`file/read` 只读不写。测试夹具在 `os.tmpdir()` 下是唯一例外。
- **包边界**：`core` 不得 import 任何 DOM / `vscode` / `react`；`ui` 不得 import 任何 Node 内置模块，且只能以 `import type` 从 `@folderspec/core/api` 取类型。检查 import 用**说明符**而非裸字符串（`grep "node:"` 会误命中 `node: ViewNode` 这类参数注解）。
- **UI 不得知道自己跑在哪个宿主**：不出现 `--vscode-*`、`acquireVsCodeApi`、`WebSocket`（`vscode-bridge.ts` / `ws-bridge.ts` 两个传输层除外，它们由 `main.tsx` 自识别选用）。
- **路径规范**：跨边界的路径一律是相对工作区根的 posix 路径，根节点为空字符串 `''`。
- **不可重算的区分一律不存**：新增字段前先自问「重新加载后仅凭 契约文件 + 磁盘 能否算出它」。`ViewNode.groups` 是派生值，正因如此才允许存在于 `ViewNode` 上。
- **注释不可丢**：解析失败绝不用空 spec 覆盖用户文件；写盘前必须 `serialize → parse` 自校验（该闸门在 `Session.raw()` 内，`save()` 调用它）。
- 三个 YAML 区（模板 / 规则 / 分组）保持**同样的严格度**：未知字段一律拒绝并报行号。
- 规范章节标题是中文，解析器额外接受英文别名，序列化器只输出中文。
- TypeScript `strict: true`、ESM、`verbatimModuleSyntax: true` —— 类型导入必须 `import type`。

## 工具链

Node 不在默认 PATH 上。**所有 node/npm/pnpm 命令必须前置**：

```bash
source ~/miniconda3/etc/profile.d/conda.sh && conda activate folderspec && <命令>
```

验证：`node -v` → `v26.6.0`，`pnpm -v` → `9.15.9`。不要自行安装 node/nvm/pnpm，不要用 `apt` 或 `sudo`。
`@folderspec/core` 必须先构建，其他包才能 typecheck（根 `typecheck` 脚本已串好这一步）。

## 起点

分支 `design/v2-ui`，基于 `main`。当前 **292 个测试**全绿：core 159 · ui 79 · cli 40 · vscode 14。

## File Structure

```
packages/core/src/
  types.ts                      修改：新增 Group；Spec 加 groups；RawSections 加 groupsYaml；ViewNode 加 groups
  parse/sections.ts             修改：SECTION_ALIASES 加 分组/Groups；yaml 围栏分支纳入 groups
  parse/groups.ts               新建：parseGroups
  parse/index.ts                修改：parseSpec 串联分组区
  serialize.ts                  修改：输出 ## 分组 区
  spec-edit.ts                  修改：deriveGroupId / setGroup / deleteGroup
  merge.ts                      修改：由 Spec.groups 派生 ViewNode.groups
  workspace-path.ts             新建：工作区边界校验，scan 与 file/read 共用
  scan.ts                       修改：subPath 走边界校验
  file-read.ts                  新建：readWorkspaceFile
  api.ts                        修改：Api 新增三个方法
  session.ts                    修改：setGroup / deleteGroup / readFile 与 handle 分发

packages/ui/src/
  layout.css                    新建：三栏骨架与 VSCode 观感的样式（styles.css 只加变量，不改既有规则）
  useElementSize.ts             新建：ResizeObserver 测量 + jsdom 回退
  FileIcon.tsx                  新建：精选内联 SVG 图标 + 扩展名映射
  selection.ts                  新建：多选纯函数（区间 / 跳选 / 与既有分组的对应）
  GroupPanel.tsx                新建：分组面板
  ContentPane.tsx               新建：只读文件预览 + Prism 高亮
  NodeRow.tsx                   修改：图标、缩进引导线、分组色点、多选态
  Tree.tsx                      修改：多选接线、行高与缩进
  AnnotationPanel.tsx           修改：底部只读列出所属分组
  App.tsx                       修改：三栏组装、selectedPaths、内容栏联动
  styles.css                    修改：仅新增表面色 token
```

---

## Phase A — core：格式与纯逻辑（Task 1–5）

---

### Task 1: `## 分组` 区的类型与解析

**Files:**
- Modify: `packages/core/src/types.ts`（追加 `Group`，`Spec` 加 `groups`，`RawSections` 加 `groupsYaml`）
- Modify: `packages/core/src/parse/sections.ts`（别名表与围栏分支）
- Create: `packages/core/src/parse/groups.ts`
- Modify: `packages/core/src/parse/index.ts`
- Test: `packages/core/src/parse/groups.test.ts`
- Test: `packages/core/src/parse/sections.test.ts`（追加）
- Test: `packages/core/src/parse/index.test.ts`（追加）

**Interfaces:**
- Consumes: `YamlBlock`、`ParseError`、`Result<T>`、`isSeverity`（`types.ts`）；`lineAtOffset`、`topLevelItemOffsets`、`isPlainObject`（`parse/yaml-util.ts`）
- Produces:
  - `interface Group { id: string; members: string[]; text: string; severity?: Severity }`
  - `Spec` 增加 `groups: Group[]`
  - `RawSections` 增加 `groupsYaml: YamlBlock | null`
  - `function parseGroups(block: YamlBlock | null): Result<Group[]>`

- [ ] **Step 1: 追加类型**

`packages/core/src/types.ts`，在 `Rule` 之后追加：

```ts
export interface Group {
  id: string
  /** 工作区相对 posix 路径 */
  members: string[]
  text: string
  severity?: Severity
}
```

在 `Spec` 接口内 `rules: Rule[]` 之后追加一行 `groups: Group[]`。
在 `RawSections` 接口内 `rulesYaml: YamlBlock | null` 之后追加一行 `groupsYaml: YamlBlock | null`。

- [ ] **Step 2: 写失败的测试**

`packages/core/src/parse/groups.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { parseGroups } from './groups.js'

const block = (text: string) => ({ text, startLine: 30 })

describe('parseGroups', () => {
  it('null 区块返回空数组', () => {
    const r = parseGroups(null)
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    expect(r.value).toEqual([])
  })

  it('解析完整分组', () => {
    const r = parseGroups(block([
      '- id: parse-layer',
      '  members:',
      '    - src/parse/sections.ts',
      '    - src/parse/structure.ts',
      '  text: 这两个共同构成解析层',
      '  severity: warning',
    ].join('\n')))
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    expect(r.value).toEqual([{
      id: 'parse-layer',
      members: ['src/parse/sections.ts', 'src/parse/structure.ts'],
      text: '这两个共同构成解析层',
      severity: 'warning',
    }])
  })

  it('severity 可省略', () => {
    const r = parseGroups(block('- { id: g, members: [a.ts], text: t }'))
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    expect(r.value[0].severity).toBeUndefined()
  })

  it('顶层不是序列时报错', () => {
    const r = parseGroups(block('id: x'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].message).toContain('分组区顶层必须是序列')
  })

  it('id 重复时报第二次出现的行号', () => {
    const r = parseGroups(block([
      '- { id: dup, members: [a.ts], text: a }',
      '- { id: dup, members: [b.ts], text: b }',
    ].join('\n')))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].message).toContain('分组 id "dup" 重复')
    expect(r.errors[0].line).toBe(31)
  })

  it('members 为空数组时报错', () => {
    const r = parseGroups(block('- { id: g, members: [], text: t }'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].message).toContain('members 必须是非空的字符串数组')
  })

  it('members 含 .. 时报错', () => {
    const r = parseGroups(block('- { id: g, members: ["../x.ts"], text: t }'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].message).toContain('不得包含 ".." 路径段')
  })

  it('缺少必填字段时逐条报错', () => {
    const r = parseGroups(block('- { id: g }'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    const msgs = r.errors.map(e => e.message).join(' | ')
    expect(msgs).toContain('members')
    expect(msgs).toContain('text')
  })

  it('未知字段被拒绝', () => {
    const r = parseGroups(block('- { id: g, members: [a.ts], text: t, colour: red }'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].message).toContain('有未知字段 "colour"')
  })

  it('非法 severity 被拒绝', () => {
    const r = parseGroups(block('- { id: g, members: [a.ts], text: t, severity: fatal }'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].message).toContain('severity 只能是 error/warning/advisory')
  })

  it('多行块式分组的错误行号指向该分组起始行', () => {
    const r = parseGroups(block([
      '- id: a',        // 30
      '  members: [x]', // 31
      '  text: ok',     // 32
      '- id: b',        // 33
      '  members: [y]', // 34
    ].join('\n')))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].line).toBe(33)
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

```bash
pnpm -C packages/core test src/parse/groups.test.ts
```

预期：FAIL，`Failed to resolve import "./groups.js"`。

- [ ] **Step 4: 写 `parse/groups.ts`**

```ts
import { parseDocument } from 'yaml'
import { isSeverity } from '../types.js'
import { isPlainObject, lineAtOffset, topLevelItemOffsets } from './yaml-util.js'
import type { Group, ParseError, Result, YamlBlock } from '../types.js'

const ALLOWED = new Set(['id', 'members', 'text', 'severity'])

export function parseGroups(block: YamlBlock | null): Result<Group[]> {
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
    return { ok: false, errors: [{ line: block.startLine, message: '分组区顶层必须是序列（每个分组一个 - 项）' }] }
  }

  const offsets = topLevelItemOffsets(doc)
  const errors: ParseError[] = []
  const groups: Group[] = []
  const seen = new Set<string>()

  raw.forEach((item, idx) => {
    const at = { line: lineAtOffset(block, offsets[idx]) }
    if (!isPlainObject(item)) {
      errors.push({ ...at, message: `第 ${idx + 1} 个分组必须是映射` })
      return
    }

    const id = item.id
    if (typeof id !== 'string' || id === '') {
      errors.push({ ...at, message: `第 ${idx + 1} 个分组缺少非空的 id` })
      return
    }
    if (seen.has(id)) {
      errors.push({ ...at, message: `分组 id "${id}" 重复` })
      return
    }
    seen.add(id)

    for (const key of Object.keys(item)) {
      if (!ALLOWED.has(key)) {
        errors.push({ ...at, message: `分组 "${id}" 有未知字段 "${key}"，只允许 id/members/text/severity` })
      }
    }

    let bad = false
    const members = item.members
    if (!Array.isArray(members) || members.length === 0 || members.some(m => typeof m !== 'string' || m === '')) {
      errors.push({ ...at, message: `分组 "${id}" 的 members 必须是非空的字符串数组` })
      bad = true
    } else if ((members as string[]).some(m => m.split('/').includes('..'))) {
      errors.push({ ...at, message: `分组 "${id}" 的 members 不得包含 ".." 路径段` })
      bad = true
    }

    if (typeof item.text !== 'string' || item.text === '') {
      errors.push({ ...at, message: `分组 "${id}" 缺少非空的 text` })
      bad = true
    }

    if (item.severity !== undefined && !isSeverity(item.severity)) {
      errors.push({ ...at, message: `分组 "${id}" 的 severity 只能是 error/warning/advisory` })
      bad = true
    }

    if (bad || errors.length) return

    const g: Group = { id, members: members as string[], text: item.text as string }
    if (item.severity !== undefined) g.severity = item.severity as Group['severity']
    groups.push(g)
  })

  if (errors.length) return { ok: false, errors }
  return { ok: true, value: groups }
}
```

- [ ] **Step 5: 让 `sections.ts` 认识分组区**

`packages/core/src/parse/sections.ts`：

1. `SECTION_ALIASES` 的类型与内容改为：

```ts
const SECTION_ALIASES: Record<string, 'structure' | 'templates' | 'rules' | 'groups'> = {
  '结构': 'structure',
  'Structure': 'structure',
  '模板': 'templates',
  'Templates': 'templates',
  '规则': 'rules',
  'Rules': 'rules',
  '分组': 'groups',
  'Groups': 'groups',
}
```

2. `current` 变量的类型加上 `| 'groups'`，并在其旁声明 `let groupsYaml: YamlBlock | null = null`。
3. 未知标题的错误文案改成 `` `未知区块标题 "## ${h[1]}"，只允许 结构/模板/规则/分组` ``。
4. yaml 围栏分支的条件从 `current === 'templates' || current === 'rules'` 改为把 `'groups'` 也纳入；该分支内的两条错误文案里「模板区与规则区」改成「模板区、规则区与分组区」，「## 结构 / ## 模板 / ## 规则」改成「## 结构 / ## 模板 / ## 规则 / ## 分组」。
5. 围栏解析成功后的赋值改为三分支：`templates` → `templatesYaml`，`rules` → `rulesYaml`，否则 → `groupsYaml`。
6. 末尾 `return` 的 value 里追加 `groupsYaml`。

**注意**：`sections.test.ts` 里已有一条断言未知区块标题错误文案的测试，改文案后它会失败——这是预期的，把该测试的期望同步更新，不要改文案去迁就测试。

- [ ] **Step 6: 给 `sections.test.ts` 追加测试**

```ts
  it('切出分组区', () => {
    const doc = DOC.replace('## 规则', '## 分组')
    const r = splitSections(doc)
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    expect(r.value.groupsYaml).not.toBeNull()
    expect(r.value.rulesYaml).toBeNull()
  })

  it('接受英文别名 ## Groups', () => {
    const doc = DOC.replace('## 规则', '## Groups')
    const r = splitSections(doc)
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    expect(r.value.groupsYaml).not.toBeNull()
  })

  it('分组区缺失时为 null 而非报错', () => {
    const r = splitSections(DOC)
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    expect(r.value.groupsYaml).toBeNull()
  })
```

- [ ] **Step 7: 让 `parseSpec` 串联分组区**

`packages/core/src/parse/index.ts`：

1. 顶部追加 `import { parseGroups } from './groups.js'` 与 `export { parseGroups } from './groups.js'`。
2. 在 `const rules = parseRules(s.rulesYaml)` 之后追加：

```ts
  const groups = parseGroups(s.groupsYaml)
  if (!groups.ok) errors.push(...groups.errors)
```

3. 返回值的 `value` 里追加：

```ts
      groups: (groups as { ok: true; value: Spec['groups'] }).value,
```

- [ ] **Step 8: 给 `parse/index.test.ts` 追加测试**

```ts
  it('串联分组区', () => {
    const doc = DOC.replace('## 规则', '## 分组').replace(
      '- { id: r1, severity: error, scope: "**", text: 规则一 }',
      '- { id: g1, members: [src/a.ts], text: 分组一 }',
    )
    const r = parseSpec(doc)
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    expect(r.value.groups).toEqual([{ id: 'g1', members: ['src/a.ts'], text: '分组一' }])
    expect(r.value.rules).toEqual([])
  })

  it('没有分组区时 groups 为空数组', () => {
    const r = parseSpec(DOC)
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    expect(r.value.groups).toEqual([])
  })
```

- [ ] **Step 9: 运行全部测试与类型检查**

```bash
pnpm -C packages/core test
pnpm -C packages/core typecheck
```

预期：全绿。此时 `serialize.ts` 尚未输出分组区，`spec-edit.ts` 也未处理 `groups`，但 `Spec` 多一个字段不会让既有测试失败——若失败，说明某处用了穷举字段的构造，按报错修正。

- [ ] **Step 10: 提交**

```bash
git add packages/core/src/types.ts packages/core/src/parse
git commit -m "feat(core): .folderspec.md 新增 ## 分组 区的解析"
```

---

### Task 2: 分组的序列化与 round-trip

**这是本计划最关键的一个任务。** round-trip property test 保护的是「人工写的东西永不丢失」这个不变量——分组注释同样是人写的东西，必须纳入同一张网。

**Files:**
- Modify: `packages/core/src/serialize.ts`
- Test: `packages/core/src/serialize.test.ts`（追加）
- Test: `packages/core/src/roundtrip.test.ts`（扩展生成器）

**Interfaces:**
- Consumes: `Group`、`Spec`（Task 1）
- Produces: `serializeSpec` 输出 `## 分组` 区；round-trip 属性覆盖 `groups`

- [ ] **Step 1: 写失败的单元测试**

追加到 `packages/core/src/serialize.test.ts`（`base` 常量需同步加上 `groups: []`，否则类型不完整）：

```ts
  it('groups 为空时不输出分组区', () => {
    expect(serializeSpec(base)).not.toContain('## 分组')
  })

  it('输出分组区', () => {
    const out = serializeSpec({
      ...base,
      groups: [{
        id: 'parse-layer',
        members: ['src/parse/sections.ts', 'src/parse/structure.ts'],
        text: '这两个共同构成解析层',
        severity: 'warning',
      }],
    })
    expect(out).toContain('## 分组')
    expect(out).toContain('id: parse-layer')
    expect(out).toContain('src/parse/sections.ts')
    expect(out).toContain('severity: warning')
  })

  it('severity 缺省时不输出该键', () => {
    const out = serializeSpec({
      ...base,
      groups: [{ id: 'g', members: ['a.ts'], text: 't' }],
    })
    expect(out).not.toContain('severity')
  })
```

同时把该文件里所有 `Spec` 字面量补上 `groups: []`。

- [ ] **Step 2: 扩展 round-trip 生成器**

`packages/core/src/roundtrip.test.ts`：

在 `ruleArb` 之后追加：

```ts
/** 成员路径：多段 posix 路径，不含 '..' 段（解析器会拒绝它） */
const memberArb = fc
  .array(chars('abz09-', 1, 6), { minLength: 1, maxLength: 3 })
  .map(segs => segs.join('/'))

/**
 * 分组 id 用比 identArb 宽得多的字符池：它是**用户在面板里手打的组名**，
 * 会出现中文、空格，以及 : # - " 这些对 YAML 有特殊含义的字符。
 * 模板名与规则 id 目前没有编辑入口，所以沿用窄的 identArb；分组名不能照抄。
 */
const groupIdArb = chars('ab中文 -:#"', 1, 12).map(s => s.trim()).filter(s => s !== '')

const groupArb: fc.Arbitrary<Group> = fc.record({
  id: groupIdArb,
  members: fc.uniqueArray(memberArb, { minLength: 1, maxLength: 4 }),
  text: textArb,
  severity: fc.option(fc.constantFrom('error' as const, 'warning' as const, 'advisory' as const), { nil: undefined }),
})
```

在 `specArb` 的 `fc.record({...})` 里追加一行 `groups: fc.array(groupArb, { maxLength: 3 }),`，并在其 `.map(...)` 里追加去重：

```ts
  groups: s.groups.filter((g, i, all) => all.findIndex(o => o.id === g.id) === i),
```

顶部 import 追加 `Group` 类型。

**不要**给 `memberArb` 加过滤去回避失败——如果 property 报出反例，那是它在做它该做的事：把反例加成固定的回归单测，然后修实现。

- [ ] **Step 3: 运行确认失败**

```bash
pnpm -C packages/core test src/serialize.test.ts src/roundtrip.test.ts
```

预期：单元测试因 `## 分组` 未输出而 FAIL；property 测试因 `groups` 往返丢失而 FAIL。

- [ ] **Step 4: 实现序列化**

`packages/core/src/serialize.ts`：

1. 顶部 import 追加 `Group`。
2. 在 `## 规则` 区块之后追加：

```ts
  if (spec.groups.length > 0) {
    out.push('## 分组')
    out.push('')
    out.push('```yaml')
    out.push(groupsToYaml(spec.groups))
    out.push('```')
    out.push('')
  }
```

3. 文件末尾追加：

```ts
function groupsToYaml(groups: Group[]): string {
  return stringify(groups.map(g => {
    const o: Record<string, unknown> = { id: g.id, members: g.members, text: g.text }
    if (g.severity) o.severity = g.severity
    return o
  })).replace(/\n+$/, '')
}
```

- [ ] **Step 5: 运行确认通过**

```bash
pnpm -C packages/core test
pnpm -C packages/core typecheck
```

预期：全绿，含 500 次随机 round-trip。**若 property 报出反例，fast-check 会打印最小反例——把它加成固定回归单测，再修实现，然后在报告里写明反例是什么。**

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/serialize.ts packages/core/src/serialize.test.ts packages/core/src/roundtrip.test.ts
git commit -m "feat(core): 分组区的序列化，并纳入 round-trip property test"
```

---

### Task 3: 分组的纯函数编辑

**Files:**
- Modify: `packages/core/src/spec-edit.ts`
- Test: `packages/core/src/spec-edit.test.ts`（追加）

**Interfaces:**
- Consumes: `Group`、`Spec`、`Severity`
- Produces:
  - `function deriveGroupId(members: readonly string[], taken: ReadonlySet<string>): string`
  - `interface GroupPatch { name?: string | null; text?: string | null; severity?: Severity | null }`
  - `function setGroup(spec: Spec, id: string | null, members: readonly string[], patch: GroupPatch): { spec: Spec; id: string }`
  - `function deleteGroup(spec: Spec, id: string): Spec`
  - `moveNode` 额外重写受影响的分组成员路径

**两条本任务确定的语义，spec 未写明，在此定死：**

1. **成员列表按字典序存储。** 分组是「整体」，选中顺序不携带意义；排序让成员变动时的 diff 稳定。
2. **`text` 清空即删除该分组。** 与 `setAnnotation` 清空即回收节点的语义一致。对尚不存在的分组传空 `text` 是空操作。

**以及一个 spec 的缺口，本任务一并补上：** `moveNode` 移动节点后，指向被移动子树的分组成员路径会失效。`moveNode` 必须同步重写这些路径，否则拖一下就让分组悄悄指向不存在的位置。

- [ ] **Step 1: 写失败的测试**

追加到 `packages/core/src/spec-edit.test.ts`（`emptySpec()` 已含 `groups: []`，Task 1 已保证）：

```ts
import { deriveGroupId, setGroup, deleteGroup } from './spec-edit.js'

describe('deriveGroupId', () => {
  it('取最长公共父目录的 basename', () => {
    expect(deriveGroupId(['src/parse/a.ts', 'src/parse/b.ts'], new Set())).toBe('parse')
  })

  it('公共父目录较浅时取较浅的那个', () => {
    expect(deriveGroupId(['src/parse/a.ts', 'src/ui/b.ts'], new Set())).toBe('src')
  })

  it('成员都在根下时回退为 group', () => {
    expect(deriveGroupId(['a.ts', 'b.ts'], new Set())).toBe('group')
  })

  it('单个成员取其父目录名', () => {
    expect(deriveGroupId(['src/parse/a.ts'], new Set())).toBe('parse')
  })

  it('冲突时递增后缀', () => {
    expect(deriveGroupId(['src/parse/a.ts'], new Set(['parse']))).toBe('parse-2')
    expect(deriveGroupId(['src/parse/a.ts'], new Set(['parse', 'parse-2']))).toBe('parse-3')
  })

  it('中文目录名可直接作为 id', () => {
    expect(deriveGroupId(['文档/设计/a.md', '文档/设计/b.md'], new Set())).toBe('设计')
  })
})

describe('setGroup', () => {
  it('新建分组并自动取名，成员按字典序存储', () => {
    const r = setGroup(emptySpec(), null, ['src/parse/z.ts', 'src/parse/a.ts'], { text: '解析层' })
    expect(r.id).toBe('parse')
    expect(r.spec.groups).toEqual([{ id: 'parse', members: ['src/parse/a.ts', 'src/parse/z.ts'], text: '解析层' }])
  })

  it('不修改传入的 spec', () => {
    const before = emptySpec()
    setGroup(before, null, ['a/b.ts'], { text: 'x' })
    expect(before.groups).toEqual([])
  })

  it('按 id 更新既有分组', () => {
    let s = setGroup(emptySpec(), null, ['src/parse/a.ts'], { text: '旧' }).spec
    s = setGroup(s, 'parse', ['src/parse/a.ts', 'src/parse/b.ts'], { text: '新' }).spec
    expect(s.groups).toHaveLength(1)
    expect(s.groups[0].text).toBe('新')
    expect(s.groups[0].members).toEqual(['src/parse/a.ts', 'src/parse/b.ts'])
  })

  it('设置与清除 severity', () => {
    let s = setGroup(emptySpec(), null, ['a/b.ts'], { text: 't', severity: 'error' }).spec
    expect(s.groups[0].severity).toBe('error')
    s = setGroup(s, s.groups[0].id, ['a/b.ts'], { severity: null }).spec
    expect(s.groups[0].severity).toBeUndefined()
  })

  it('清空 text 即删除该分组', () => {
    let s = setGroup(emptySpec(), null, ['a/b.ts'], { text: 't' }).spec
    s = setGroup(s, s.groups[0].id, ['a/b.ts'], { text: '   ' }).spec
    expect(s.groups).toEqual([])
  })

  it('对不存在的分组传空 text 是空操作', () => {
    const s = setGroup(emptySpec(), null, ['a/b.ts'], { text: '' }).spec
    expect(s.groups).toEqual([])
  })

  it('成员去重', () => {
    const r = setGroup(emptySpec(), null, ['a/b.ts', 'a/b.ts'], { text: 't' })
    expect(r.spec.groups[0].members).toEqual(['a/b.ts'])
  })
})

describe('setGroup 改名', () => {
  it('patch.name 把既有分组改成用户指定的名字', () => {
    let s = setAnnotation(emptySpec(), 'src/a.ts', false, { annotation: 'x' })
    const { spec, id } = setGroup(s, null, ['src/a.ts', 'src/b.ts'], { text: '一体' })
    expect(id).toBe('src')
    const r = setGroup(spec, id, ['src/a.ts', 'src/b.ts'], { name: '解析层' })
    expect(r.id).toBe('解析层')
    expect(r.spec.groups.map(g => g.id)).toEqual(['解析层'])
    expect(r.spec.groups[0].text).toBe('一体')
  })

  it('新建时 name 优先于自动取名', () => {
    const r = setGroup(emptySpec(), null, ['src/a.ts'], { name: '我起的名', text: 't' })
    expect(r.id).toBe('我起的名')
  })

  it('改成已被占用的名字时按同样的规则加后缀', () => {
    let { spec } = setGroup(emptySpec(), null, ['src/a.ts'], { name: 'core', text: 't1' })
    const mk = setGroup(spec, null, ['docs/b.md'], { text: 't2' })
    const r = setGroup(mk.spec, mk.id, ['docs/b.md'], { name: 'core' })
    expect(r.id).toBe('core-2')
    expect(r.spec.groups.map(g => g.id).sort()).toEqual(['core', 'core-2'])
  })

  it('改成自己当前的名字不加后缀', () => {
    const { spec, id } = setGroup(emptySpec(), null, ['src/a.ts'], { name: 'core', text: 't' })
    const r = setGroup(spec, id, ['src/a.ts'], { name: 'core' })
    expect(r.id).toBe('core')
    expect(r.spec.groups).toHaveLength(1)
  })

  it('name 为空白串时视为未改名', () => {
    const { spec, id } = setGroup(emptySpec(), null, ['src/a.ts'], { text: 't' })
    const r = setGroup(spec, id, ['src/a.ts'], { name: '   ' })
    expect(r.id).toBe(id)
  })
})

describe('deleteGroup', () => {
  it('按 id 删除', () => {
    const s = setGroup(emptySpec(), null, ['a/b.ts'], { text: 't' }).spec
    expect(deleteGroup(s, s.groups[0].id).groups).toEqual([])
  })

  it('删除不存在的 id 是空操作', () => {
    const s = setGroup(emptySpec(), null, ['a/b.ts'], { text: 't' }).spec
    expect(deleteGroup(s, 'nope').groups).toHaveLength(1)
  })
})

describe('moveNode 与分组成员', () => {
  it('移动节点时同步重写分组成员路径', () => {
    let s = setAnnotation(emptySpec(), 'examples/foo', true, { annotation: 'x' })
    s = setGroup(s, null, ['examples/foo'], { text: '案例' }).spec
    s = moveNode(s, 'examples/foo', 'src/cases', true)
    expect(s.groups[0].members).toEqual(['src/cases/foo'])
  })

  it('重写子树内部的成员路径', () => {
    let s = setAnnotation(emptySpec(), 'examples/foo/input.json', false, { annotation: 'x' })
    s = setGroup(s, null, ['examples/foo/input.json'], { text: '输入' }).spec
    s = moveNode(s, 'examples/foo', 'src/cases', true)
    expect(s.groups[0].members).toEqual(['src/cases/foo/input.json'])
  })

  it('不动与被移动子树无关的成员', () => {
    let s = setAnnotation(emptySpec(), 'other/keep.ts', false, { annotation: 'x' })
    s = setGroup(s, null, ['other/keep.ts'], { text: '保持' }).spec
    s = moveNode(s, 'examples/foo', 'src/cases', true)
    expect(s.groups[0].members).toEqual(['other/keep.ts'])
  })
})
```

- [ ] **Step 2: 运行确认失败**

```bash
pnpm -C packages/core test src/spec-edit.test.ts
```

预期：FAIL，`deriveGroupId` / `setGroup` / `deleteGroup` 未导出。

- [ ] **Step 3: 实现**

`packages/core/src/spec-edit.ts` 末尾追加，并把 `Group` 加进类型 import：

```ts
export interface GroupPatch {
  /** 用户手填的组名。省略或全为空白＝不改名；改名后 id 随之变化，返回的 id 是最终生效的那个。 */
  name?: string | null
  text?: string | null
  severity?: Severity | null
}

/** 取所有成员的最长公共父目录的 basename；无公共父目录时回退为 group。冲突时递增后缀。 */
export function deriveGroupId(members: readonly string[], taken: ReadonlySet<string>): string {
  return uniqueId(commonParentBasename(members), taken)
}

/** 冲突时追加 -2、-3。自动取名与用户改名共用这一条规则，两条路径的去重行为必须一致。 */
function uniqueId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`
    if (!taken.has(candidate)) return candidate
  }
}

function commonParentBasename(members: readonly string[]): string {
  if (members.length === 0) return 'group'
  const parents = members.map(m => m.split('/').filter(s => s !== '').slice(0, -1))
  let common = parents[0]
  for (const p of parents.slice(1)) {
    let i = 0
    while (i < common.length && i < p.length && common[i] === p[i]) i++
    common = common.slice(0, i)
  }
  const last = common[common.length - 1]
  return last && last !== '..' ? last : 'group'
}

export function setGroup(
  spec: Spec,
  id: string | null,
  members: readonly string[],
  patch: GroupPatch,
): { spec: Spec; id: string } {
  const next = structuredClone(spec)
  const sorted = [...new Set(members)].sort((a, b) => a.localeCompare(b, 'en'))
  const taken = new Set(next.groups.map(g => g.id))
  const current = id === null ? undefined : next.groups.find(g => g.id === id)

  // 改名时自身的旧 id 不算冲突，否则每改一次名字就多一个 -2 后缀
  const wanted = patch.name?.trim()
  const others = new Set(taken)
  if (current) others.delete(current.id)

  const targetId = wanted ? uniqueId(wanted, others) : (id ?? deriveGroupId(sorted, taken))
  const existing = current ?? next.groups.find(g => g.id === targetId)

  const text = patch.text === undefined ? existing?.text : (patch.text ?? '').trim()

  // 清空 text 即删除该分组；对尚不存在的分组是空操作
  if (text === undefined || text === '') {
    if (existing) next.groups = next.groups.filter(g => g !== existing)
    return { spec: next, id: targetId }
  }

  if (existing) {
    existing.id = targetId
    existing.members = sorted
    existing.text = text
    if (patch.severity !== undefined) {
      if (patch.severity === null) delete existing.severity
      else existing.severity = patch.severity
    }
  } else {
    const g: Group = { id: targetId, members: sorted, text }
    if (patch.severity) g.severity = patch.severity
    next.groups.push(g)
  }
  return { spec: next, id: targetId }
}

export function deleteGroup(spec: Spec, id: string): Spec {
  const next = structuredClone(spec)
  next.groups = next.groups.filter(g => g.id !== id)
  return next
}

/** 节点被移动后，指向该子树的分组成员路径必须同步重写，否则分组会悄悄指向不存在的位置。 */
function rewriteGroupMembers(groups: Group[], from: string, to: string): void {
  const prefix = `${from}/`
  for (const g of groups) {
    g.members = g.members.map(m => (m === from ? to : m.startsWith(prefix) ? to + m.slice(from.length) : m))
  }
}
```

在 `moveNode` 内部，紧接在 `else list.push(detached)` 之后、`return next` 之前插入：

```ts
  const movedName = fromSegs[fromSegs.length - 1]
  const movedTo = toSegs.length === 0 ? movedName : `${toSegs.join('/')}/${movedName}`
  rewriteGroupMembers(next.groups, fromSegs.join('/'), movedTo)
```

- [ ] **Step 4: 运行确认通过**

```bash
pnpm -C packages/core test
pnpm -C packages/core typecheck
```

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/spec-edit.ts packages/core/src/spec-edit.test.ts
git commit -m "feat(core): 分组的纯函数编辑，移动节点时同步重写成员路径"
```

---

### Task 4: `merge` 派生 `ViewNode.groups`

**Files:**
- Modify: `packages/core/src/types.ts`（`ViewNode` 加 `groups?`）
- Modify: `packages/core/src/merge.ts`
- Test: `packages/core/src/merge.test.ts`（追加）

**Interfaces:**
- Consumes: `Group`、`Spec`、`ViewNode`
- Produces: `ViewNode` 增加 `groups?: string[]`，由 `merge` 从 `Spec.groups` 反查得到

**这是派生值，不是存储值。** 它不落盘，重新加载时由 `Spec.groups` 重算，因此不违反「不可重算的区分一律不存」这条原则。

- [ ] **Step 1: 追加类型**

`packages/core/src/types.ts` 的 `ViewNode` 接口内，`severity?: Severity` 之后追加：

```ts
  /** 该节点所属的分组 id（由 merge 从 Spec.groups 反查，不落盘） */
  groups?: string[]
```

- [ ] **Step 2: 写失败的测试**

追加到 `packages/core/src/merge.test.ts`。注意该文件里的 `spec()` 辅助函数需同步补上 `groups: []`，并新增一个可传分组的重载：

```ts
const specG = (nodes: SpecNode[], groups: Spec['groups']): Spec => ({
  version: 1, root: '.', ownership: 'human', title: '', preamble: [],
  nodes, templates: [], rules: [], groups,
})

describe('merge 的分组派生', () => {
  it('磁盘上存在的成员会带上 groups', () => {
    const actual = dir('r', '', [file('a.ts', 'a.ts'), file('b.ts', 'b.ts')])
    const v = merge(actual, NO_GIT, specG([], [
      { id: 'g1', members: ['a.ts'], text: 't' },
    ]))
    expect(find(v, 'a.ts').groups).toEqual(['g1'])
    expect(find(v, 'b.ts').groups).toBeUndefined()
  })

  it('一个节点可属于多个分组，顺序与文件中一致', () => {
    const actual = dir('r', '', [file('a.ts', 'a.ts')])
    const v = merge(actual, NO_GIT, specG([], [
      { id: 'g1', members: ['a.ts'], text: 't1' },
      { id: 'g2', members: ['a.ts'], text: 't2' },
    ]))
    expect(find(v, 'a.ts').groups).toEqual(['g1', 'g2'])
  })

  it('成员在磁盘上不存在时仍作为 spec-only 节点出现并带 groups', () => {
    const actual = dir('r', '', [])
    const v = merge(actual, NO_GIT, specG(
      [sdir('docs', [{ name: 'plan.md', isDir: false, children: [] }])],
      [{ id: 'g1', members: ['docs/plan.md'], text: 't' }],
    ))
    expect(find(v, 'docs/plan.md').origin).toBe('spec-only')
    expect(find(v, 'docs/plan.md').groups).toEqual(['g1'])
  })

  it('分组成员指向根节点时不会崩', () => {
    const v = merge(dir('r', '', []), NO_GIT, specG([], [
      { id: 'g1', members: [''], text: 't' },
    ]))
    expect(v.groups).toEqual(['g1'])
  })

  it('merge 仍然不修改入参', () => {
    const groups = [{ id: 'g1', members: ['a.ts'], text: 't' }]
    const s = specG([], groups)
    merge(dir('r', '', [file('a.ts', 'a.ts')]), NO_GIT, s)
    expect(s.groups).toBe(groups)
    expect(groups[0].members).toEqual(['a.ts'])
  })
})
```

- [ ] **Step 3: 运行确认失败**

```bash
pnpm -C packages/core test src/merge.test.ts
```

- [ ] **Step 4: 实现**

`packages/core/src/merge.ts`：

1. 顶部类型 import 追加 `Group`。
2. 在 `merge()` 内、构造 `root` 之前，建立一次索引并向下传递：

```ts
export function merge(
  actual: ActualNode,
  git: GitStates,
  spec: Spec,
  hidden: ReadonlySet<string> = NO_HIDDEN,
): ViewNode {
  const groupsByPath = indexGroups(spec.groups)
  const root: ViewNode = { name: actual.name, path: actual.path, isDir: true, origin: 'both' }
  applyGroups(root, groupsByPath)
  if (actual.truncated) root.truncated = true
  if (actual.unreadable) root.unreadable = true
  const children = mergeChildren(actual.path, actual.children, spec.nodes, git, hidden, groupsByPath)
  if (children) root.children = children
  return root
}

/** path → 所属分组 id 列表，顺序与 Spec.groups 中的出现顺序一致 */
function indexGroups(groups: readonly Group[]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const g of groups) {
    for (const m of g.members) {
      const list = map.get(m)
      if (list) list.push(g.id)
      else map.set(m, [g.id])
    }
  }
  return map
}

function applyGroups(v: ViewNode, groupsByPath: Map<string, string[]>): void {
  const ids = groupsByPath.get(v.path)
  if (ids && ids.length > 0) v.groups = [...ids]
}
```

3. 给 `mergeChildren`、`fromActual`、`fromSpec` 各加一个末位参数 `groupsByPath: Map<string, string[]>` 并逐层传下去；在 `fromActual` 与 `fromSpec` 构造出 `v` 之后各调用一次 `applyGroups(v, groupsByPath)`。

**注意**：`applyGroups` 里的 `[...ids]` 是必要的——直接赋值会让多个 `ViewNode` 共享同一个数组，而 `ViewNode` 会被序列化送到前端，共享可变数组是隐患。最后一条测试就在钉这一点。

- [ ] **Step 5: 运行确认通过并提交**

```bash
pnpm -C packages/core test
pnpm -C packages/core typecheck
git add packages/core/src/types.ts packages/core/src/merge.ts packages/core/src/merge.test.ts
git commit -m "feat(core): merge 从 Spec.groups 派生 ViewNode.groups"
```

---

### Task 5: 工作区边界校验、`file/read`、Session 与 Api 增量

**这个任务里最重要的不是新功能，是那道边界校验。** `file/read` 让工具首次按前端传来的路径读取任意文件内容并回传。在此之前 `scan()` 的 `subPath` 接受 `..`（实测可枚举到 `/`），当时判定「不可从用户输入触达」所以延期——**加了 `file/read` 之后那个前提就不成立了**。

**Files:**
- Create: `packages/core/src/workspace-path.ts`
- Create: `packages/core/src/file-read.ts`
- Modify: `packages/core/src/scan.ts`
- Modify: `packages/core/src/api.ts`
- Modify: `packages/core/src/session.ts`
- Modify: `packages/core/src/index.ts`（导出新符号）
- Test: `packages/core/src/workspace-path.test.ts`
- Test: `packages/core/src/file-read.test.ts`
- Test: `packages/core/src/scan.test.ts`（追加）
- Test: `packages/core/src/session.test.ts`（追加）

**Interfaces:**
- Consumes: `Session`、`setGroup`、`deleteGroup`（Task 3）
- Produces:
  - `function normalizeWorkspacePath(input: string): string`（越界即抛错）
  - `const MAX_READ_BYTES = 1_048_576`
  - `type FileReadResult = { kind: 'text'; text: string } | { kind: 'binary' } | { kind: 'too-large'; size: number } | { kind: 'unreadable'; reason: string }`
  - `function readWorkspaceFile(root: string, subPath: string): Promise<FileReadResult>`
  - `Api` 新增 `spec/setGroup`、`spec/deleteGroup`、`file/read`
  - `Session` 新增 `setGroup`、`deleteGroup`、`readFile`

- [ ] **Step 1: 写失败的测试**

`packages/core/src/workspace-path.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { normalizeWorkspacePath } from './workspace-path.js'

describe('normalizeWorkspacePath', () => {
  it('空串归一化为空串（工作区根）', () => {
    expect(normalizeWorkspacePath('')).toBe('')
  })

  it('去掉多余的分隔符与 . 段', () => {
    expect(normalizeWorkspacePath('./src//parse/')).toBe('src/parse')
  })

  it('把反斜杠当作分隔符', () => {
    expect(normalizeWorkspacePath('src\\parse')).toBe('src/parse')
  })

  it('拒绝 .. 段', () => {
    expect(() => normalizeWorkspacePath('../etc')).toThrow(/不得包含 "\.\." 段/)
    expect(() => normalizeWorkspacePath('src/../../etc')).toThrow(/不得包含 "\.\." 段/)
    expect(() => normalizeWorkspacePath('src/..')).toThrow(/不得包含 "\.\." 段/)
  })

  it('不把 ..foo 当成越界', () => {
    expect(normalizeWorkspacePath('src/..foo')).toBe('src/..foo')
  })

  it('拒绝绝对路径', () => {
    expect(() => normalizeWorkspacePath('/etc/passwd')).toThrow(/必须是工作区相对路径/)
    expect(() => normalizeWorkspacePath('C:\\Windows')).toThrow(/必须是工作区相对路径/)
  })
})
```

`packages/core/src/file-read.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { readWorkspaceFile, MAX_READ_BYTES } from './file-read.js'

let root: string

beforeAll(async () => {
  root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'fileread-'))
  await fs.mkdir(nodePath.join(root, 'sub'), { recursive: true })
  await fs.writeFile(nodePath.join(root, 'sub/a.txt'), '第一行\n第二行\n')
  await fs.writeFile(nodePath.join(root, 'bin.dat'), Buffer.from([0x41, 0x00, 0x42]))
  await fs.writeFile(nodePath.join(root, 'big.txt'), Buffer.alloc(MAX_READ_BYTES + 1, 0x61))
})

afterAll(async () => { await fs.rm(root, { recursive: true, force: true }) })

describe('readWorkspaceFile', () => {
  it('读取文本文件', async () => {
    const r = await readWorkspaceFile(root, 'sub/a.txt')
    expect(r).toEqual({ kind: 'text', text: '第一行\n第二行\n' })
  })

  it('含 NUL 字节的文件判为二进制', async () => {
    expect(await readWorkspaceFile(root, 'bin.dat')).toEqual({ kind: 'binary' })
  })

  it('超过上限的文件不读内容', async () => {
    const r = await readWorkspaceFile(root, 'big.txt')
    expect(r.kind).toBe('too-large')
    if (r.kind === 'too-large') expect(r.size).toBe(MAX_READ_BYTES + 1)
  })

  it('目录返回 unreadable', async () => {
    const r = await readWorkspaceFile(root, 'sub')
    expect(r.kind).toBe('unreadable')
  })

  it('不存在的路径返回 unreadable 而非抛错', async () => {
    const r = await readWorkspaceFile(root, 'nope.txt')
    expect(r.kind).toBe('unreadable')
  })

  it('拒绝越界路径且不读到工作区外的内容', async () => {
    await expect(readWorkspaceFile(root, '../../../etc/passwd')).rejects.toThrow(/不得包含 "\.\." 段/)
  })
})
```

追加到 `packages/core/src/scan.test.ts`：

```ts
  it('拒绝越界的 subPath', async () => {
    await expect(scan(root, { subPath: '../../..' })).rejects.toThrow(/不得包含 "\.\." 段/)
  })
```

- [ ] **Step 2: 运行确认失败**

```bash
pnpm -C packages/core test src/workspace-path.test.ts src/file-read.test.ts src/scan.test.ts
```

- [ ] **Step 3: 写 `workspace-path.ts`**

```ts
/**
 * 把跨边界传入的相对路径归一化为工作区相对的 posix 路径，并拒绝任何逃出工作区的写法。
 *
 * 这道校验是 file/read 引入后才变成必需的：在此之前 scan 的 subPath 虽然也接受 ".."，
 * 但结果会被 findActual 丢弃、不产生可观测的越界读取。file/read 会把内容直接回传前端，
 * 于是同一个缺口变成了真实可达的路径。两个入口共用这一处实现，不在两边各写一遍。
 */
export function normalizeWorkspacePath(input: string): string {
  const posix = input.split('\\').join('/')
  if (posix.startsWith('/') || /^[A-Za-z]:/.test(posix)) {
    throw new Error(`路径必须是工作区相对路径，实际是 ${JSON.stringify(input)}`)
  }
  const segs = posix.split('/').filter(s => s !== '' && s !== '.')
  if (segs.includes('..')) {
    throw new Error(`路径不得包含 ".." 段，实际是 ${JSON.stringify(input)}`)
  }
  return segs.join('/')
}
```

- [ ] **Step 4: 让 `scan.ts` 使用它**

`packages/core/src/scan.ts`：顶部 import `normalizeWorkspacePath`，把 `scan()` 里的 `const subPath = toPosix(opts.subPath ?? '')` 改为 `const subPath = normalizeWorkspacePath(opts.subPath ?? '')`。原有的 `toPosix` 若再无调用者则删掉；若仍被 `buildAncestorLayers` 之类使用则保留。

- [ ] **Step 5: 写 `file-read.ts`**

```ts
import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'
import { normalizeWorkspacePath } from './workspace-path.js'

export const MAX_READ_BYTES = 1_048_576
const SNIFF_BYTES = 8192

export type FileReadResult =
  | { kind: 'text'; text: string }
  | { kind: 'binary' }
  | { kind: 'too-large'; size: number }
  | { kind: 'unreadable'; reason: string }

/** 只读。本工具只写 .folderspec.md 一个文件，这里不会有任何写操作。 */
export async function readWorkspaceFile(root: string, subPath: string): Promise<FileReadResult> {
  const rel = normalizeWorkspacePath(subPath)
  const abs = nodePath.join(root, rel)

  let stat
  try {
    stat = await fs.stat(abs)
  } catch (e) {
    return { kind: 'unreadable', reason: e instanceof Error ? e.message : String(e) }
  }
  if (stat.isDirectory()) return { kind: 'unreadable', reason: '这是一个目录' }
  if (!stat.isFile()) return { kind: 'unreadable', reason: '不是普通文件' }
  if (stat.size > MAX_READ_BYTES) return { kind: 'too-large', size: stat.size }

  let buf: Buffer
  try {
    buf = await fs.readFile(abs)
  } catch (e) {
    return { kind: 'unreadable', reason: e instanceof Error ? e.message : String(e) }
  }
  if (buf.subarray(0, SNIFF_BYTES).includes(0)) return { kind: 'binary' }
  return { kind: 'text', text: buf.toString('utf8') }
}
```

- [ ] **Step 6: 扩展 `api.ts`**

在 `Api` 接口内追加三行：

```ts
  'spec/setGroup': { params: SetGroupParams; result: EditResult & { id: string } }
  'spec/deleteGroup': { params: { id: string }; result: EditResult }
  'file/read': { params: { path: string }; result: FileReadResult }
```

并在文件内追加：

```ts
export interface SetGroupParams {
  /** null 表示新建并自动取名，实际 id 由 result 返回 */
  id: string | null
  members: string[]
  /** 用户手填的组名；省略或全为空白则沿用 id 或自动取名 */
  name?: string | null
  text?: string | null
  severity?: Severity | null
}
```

以及在既有的类型再导出行里补上 `Group`、`FileReadResult`：

```ts
export type { FileReadResult } from './file-read.js'
```

**注意**：`api.ts` 必须保持零 node 依赖。`file-read.ts` 里 import 了 `node:fs`，所以**只能 `export type`**，不能 `export`。Task 完成后必须跑一次校验（见 Step 9）。

- [ ] **Step 7: 扩展 `session.ts`**

import 追加 `setGroup`、`deleteGroup`（来自 `./spec-edit.js`）与 `readWorkspaceFile`（来自 `./file-read.js`），类型追加 `GroupPatch`（`./spec-edit.js`）、`SetGroupParams`、`FileReadResult`。

新增三个方法：

```ts
  setGroup(params: SetGroupParams): EditResult & { id: string } {
    this.assertWritable()
    for (const m of params.members) assertRepresentablePath(m)
    const patch: GroupPatch = {}
    if (params.name !== undefined) patch.name = params.name === null ? null : normalizeAnnotation(params.name)
    if (params.text !== undefined) patch.text = params.text === null ? null : normalizeAnnotation(params.text)
    if (params.severity !== undefined) patch.severity = params.severity
    const r = setGroup(this.spec, params.id, params.members, patch)
    this.spec = r.spec
    this.dirty = true
    return { tree: this.tree(), dirty: true, id: r.id }
  }

  deleteGroup(id: string): EditResult {
    this.assertWritable()
    this.spec = deleteGroup(this.spec, id)
    this.dirty = true
    return { tree: this.tree(), dirty: true }
  }

  async readFile(path: string): Promise<FileReadResult> {
    this.assertOpened()
    return readWorkspaceFile(this.root, path)
  }
```

`handle()` 的 switch 追加三个分支：

```ts
      case 'spec/setGroup':
        return this.setGroup(params as SetGroupParams) as Api[K]['result']
      case 'spec/deleteGroup':
        return this.deleteGroup((params as { id: string }).id) as Api[K]['result']
      case 'file/read':
        return (await this.readFile((params as { path: string }).path)) as Api[K]['result']
```

`readFile` 用 `assertOpened()` 而非 `assertWritable()`——只读模式下仍应能浏览文件内容，正如 `expand()` 一样。

- [ ] **Step 8: 追加 Session 测试**

```ts
describe('Session 的分组与文件读取', () => {
  it('setGroup 新建分组并返回自动 id', async () => {
    const s = new Session(root); await s.open()
    const r = s.setGroup({ id: null, members: ['src/core', 'src/deep'], text: '两个子目录' })
    expect(r.id).toBe('src')
    expect(r.dirty).toBe(true)
  })

  it('setGroup 透传 name，改名后返回新 id', async () => {
    const s = new Session(root); await s.open()
    const { id } = s.setGroup({ id: null, members: ['src'], text: 't' })
    const r = s.setGroup({ id, members: ['src'], name: '解析层' })
    expect(r.id).toBe('解析层')
  })

  it('setGroup 会把注释里的换行归一化为空格', async () => {
    const s = new Session(root); await s.open()
    s.setGroup({ id: null, members: ['src'], text: '一行\n二行' })
    expect(s.raw()).toContain('一行 二行')
  })

  it('deleteGroup 删除分组', async () => {
    const s = new Session(root); await s.open()
    const { id } = s.setGroup({ id: null, members: ['src'], text: 't' })
    s.deleteGroup(id)
    expect(s.raw()).not.toContain('## 分组')
  })

  it('只读模式下 setGroup 抛错', async () => {
    await fs.writeFile(nodePath.join(root, SPEC_FILENAME), '不是合法的契约文件\n')
    const s = new Session(root); await s.open()
    expect(() => s.setGroup({ id: null, members: ['src'], text: 't' })).toThrow('只读模式')
  })

  it('只读模式下仍可读取文件内容', async () => {
    await fs.writeFile(nodePath.join(root, SPEC_FILENAME), '不是合法的契约文件\n')
    await fs.writeFile(nodePath.join(root, 'README.md'), 'hello')
    const s = new Session(root); await s.open()
    expect(await s.readFile('README.md')).toEqual({ kind: 'text', text: 'hello' })
  })

  it('未 open 时 readFile 抛错', async () => {
    await expect(new Session(root).readFile('README.md')).rejects.toThrow('会话尚未打开')
  })

  it('readFile 拒绝越界路径', async () => {
    const s = new Session(root); await s.open()
    await expect(s.readFile('../../../etc/passwd')).rejects.toThrow(/不得包含 "\.\." 段/)
  })

  it('handle 能分发全部三个新方法', async () => {
    const s = new Session(root); await s.open()
    // members 是单个顶层路径（无公共父目录），deriveGroupId 按 spec §3.4 回退为 'group'。
    // 这里只关心 handle() 的分发，取名规则由 spec-edit.test.ts 覆盖。
    const g = await s.handle('spec/setGroup', { id: null, members: ['src'], text: 't' })
    expect((g as { id: string }).id).toBe('group')
    await s.handle('spec/deleteGroup', { id: 'group' })
    const f = await s.handle('file/read', { path: 'README.md' })
    expect((f as { kind: string }).kind).toBeDefined()
  })
})
```

（`root` 夹具需含 `README.md`——既有 `beforeEach` 已创建，确认后再用。）

- [ ] **Step 9: 校验、导出、提交**

```bash
pnpm -C packages/core test
pnpm -C packages/core typecheck
# api.ts / types.ts 必须零 node 依赖，否则 ui 的浏览器打包会被污染
git grep -nE "from ['\"]node:" -- packages/core/src/api.ts packages/core/src/types.ts && echo "!! 有 node 依赖" || echo "零 node 依赖 ✓"
```

`packages/core/src/index.ts` 追加导出：

```ts
export { normalizeWorkspacePath } from './workspace-path.js'
export { readWorkspaceFile, MAX_READ_BYTES } from './file-read.js'
export { setGroup, deleteGroup, deriveGroupId } from './spec-edit.js'
export type { GroupPatch } from './spec-edit.js'
```

```bash
git add packages/core/src
git commit -m "feat(core): 工作区边界校验、file/read、Session 的分组与读文件方法"
```

**Phase A 完成。** `@folderspec/core` 已能完整表达分组、安全地读取工作区内文件，且 round-trip 属性覆盖了新格式。

## Phase B — UI（Task 6–11）

全部测试用 `FakeBridge`，不碰文件系统、不 import 任何 Node 内置模块。

---

### Task 6: 三栏骨架与容器实测

**Files:**
- Create: `packages/ui/src/useElementSize.ts`
- Create: `packages/ui/src/splitter.ts`
- Create: `packages/ui/src/layout.css`
- Modify: `packages/ui/src/styles.css`（**仅新增** token，不改既有规则）
- Modify: `packages/ui/src/main.tsx`（import layout.css）
- Test: `packages/ui/src/useElementSize.test.ts`
- Test: `packages/ui/src/splitter.test.ts`

**Interfaces:**
- Produces:
  - `function useElementSize<T extends HTMLElement>(fallback: { width: number; height: number }): [React.RefObject<T>, { width: number; height: number }]`
  - `function nextWidth(startWidth: number, delta: number, side: 'left' | 'right', min: number, max: number): number`
  - `function useSplitter(opts: { initial: number; min: number; max: number; side: 'left' | 'right' }): { width: number; onPointerDown: (e: React.PointerEvent<HTMLElement>) => void }`

**为什么必须实测而不是算：** 现在的 `App.tsx` 用 `window.innerWidth - PANEL_WIDTH` 和 `innerHeight - headerHeight` 推树的尺寸。已修复的高亮溢出缺陷的成因就在这里——推算值可能超过容器真实宽度。改成实测后，那一类缺陷在构造上不可能再发生。

**jsdom 没有 `ResizeObserver`。** App 测试依赖树真实渲染出行，尺寸为 0 会让它们全部失效。所以必须有回退路径，且回退值非零。

- [ ] **Step 1: 写失败的测试**

`packages/ui/src/useElementSize.test.ts`：

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useElementSize } from './useElementSize.js'

const FALLBACK = { width: 800, height: 600 }
const original = globalThis.ResizeObserver

afterEach(() => { globalThis.ResizeObserver = original })

describe('useElementSize', () => {
  it('没有 ResizeObserver 时回退到给定值，且非零', () => {
    // @ts-expect-error 故意移除
    delete globalThis.ResizeObserver
    const { result } = renderHook(() => useElementSize<HTMLDivElement>(FALLBACK))
    expect(result.current[1]).toEqual(FALLBACK)
    expect(result.current[1].width).toBeGreaterThan(0)
    expect(result.current[1].height).toBeGreaterThan(0)
  })

  it('有 ResizeObserver 时用观察到的尺寸', () => {
    let cb: ResizeObserverCallback | null = null
    globalThis.ResizeObserver = class {
      constructor(c: ResizeObserverCallback) { cb = c }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver

    const { result, rerender } = renderHook(() => useElementSize<HTMLDivElement>(FALLBACK))
    expect(cb).not.toBeNull()
    cb!([{ contentRect: { width: 321, height: 654 } } as ResizeObserverEntry], {} as ResizeObserver)
    rerender()
    expect(result.current[1]).toEqual({ width: 321, height: 654 })
  })

  it('观察到 0 尺寸时保留回退值', () => {
    let cb: ResizeObserverCallback | null = null
    globalThis.ResizeObserver = class {
      constructor(c: ResizeObserverCallback) { cb = c }
      observe() {}; unobserve() {}; disconnect() {}
    } as unknown as typeof ResizeObserver
    const { result, rerender } = renderHook(() => useElementSize<HTMLDivElement>(FALLBACK))
    cb!([{ contentRect: { width: 0, height: 0 } } as ResizeObserverEntry], {} as ResizeObserver)
    rerender()
    expect(result.current[1]).toEqual(FALLBACK)
  })
})
```

- [ ] **Step 2: 运行确认失败，然后实现**

```ts
import { useEffect, useRef, useState } from 'react'

export interface Size { width: number; height: number }

/**
 * 用 ResizeObserver 实测容器尺寸。
 * jsdom 没有实现 ResizeObserver，此时回退到传入值——测试环境依赖树能真实渲染出行，
 * 尺寸为 0 会让依赖真实渲染的 App 测试全部失效。观察到 0 尺寸时同样保留回退值。
 */
export function useElementSize<T extends HTMLElement>(fallback: Size): [React.RefObject<T | null>, Size] {
  const ref = useRef<T | null>(null)
  const [size, setSize] = useState<Size>(fallback)

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    // ResizeObserver 必须无条件创建：单测里 renderHook 不渲染任何 JSX，ref 永远不会
    // 挂到真实 DOM 节点上，如果在此处按 `!ref.current` 提前 return，观察者对象根本不会
    // 被构造，测试里用来断言「回调已注册」的钩子就永远拿不到实例。真实场景下 ref 已经在
    // commit 阶段（早于这个被动 effect）绑定好了，所以 observe() 依然会按预期生效。
    const ro = new ResizeObserver(entries => {
      const r = entries[0]?.contentRect
      if (!r) return
      if (r.width > 0 && r.height > 0) setSize({ width: r.width, height: r.height })
    })
    if (ref.current) ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])

  return [ref, size]
}
```

- [ ] **Step 3: 新增表面色 token**

`packages/ui/src/styles.css` 的 `:root` 块内**追加**（不改任何既有行）：

```css
  --fs-sidebar-bg: #f3f3f3;
  --fs-editor-bg: #ffffff;
  --fs-panel-border: #e0e0e0;
  --fs-row-hover-bg: #e8e8e8;
  --fs-indent-guide: #d0d0d0;
  --fs-group-dot: #b180d7;
  --fs-line-number: #9a9a9a;
```

- [ ] **Step 4: 写 `layout.css`**

```css
/* 三栏骨架。每栏独立 flex 子项，各自 min-width:0 + overflow:hidden，
   任一栏的内容都不可能画到相邻栏上——这从构造上排除了已修复的高亮溢出缺陷。 */
.fs-shell { display: flex; flex-direction: column; height: 100vh; background: var(--fs-bg); }
.fs-header { flex: 0 0 auto; }
.fs-body { display: flex; flex: 1 1 auto; min-height: 0; }

.fs-pane-tree {
  flex: 0 0 260px; min-width: 160px; max-width: 60%;
  display: flex; flex-direction: column; min-height: 0; overflow: hidden;
  background: var(--fs-sidebar-bg); border-right: 1px solid var(--fs-panel-border);
}
.fs-pane-content {
  flex: 1 1 auto; min-width: 0; min-height: 0; overflow: auto;
  background: var(--fs-editor-bg);
}
.fs-pane-panel {
  flex: 0 0 320px; min-width: 220px;
  min-height: 0; overflow: auto; padding: 12px;
  border-left: 1px solid var(--fs-panel-border);
}
.fs-splitter { flex: 0 0 4px; cursor: col-resize; background: transparent; }
.fs-splitter:hover { background: var(--fs-panel-border); }
```

- [ ] **Step 5: 写分栏拖拽的失败测试**

spec §5.1 明确要求左右两栏**可拖**。`.fs-splitter` 只给了 `cursor: col-resize` 是不够的——没有拖拽逻辑它就只是个装饰。宽度计算提成纯函数单测，指针事件只测一条主路径。

`packages/ui/src/splitter.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { nextWidth, useSplitter } from './splitter.js'

describe('nextWidth', () => {
  it('左栏：向右拖变宽', () => {
    expect(nextWidth(260, 40, 'left', 160, 600)).toBe(300)
  })

  it('右栏：向右拖变窄', () => {
    expect(nextWidth(320, 40, 'right', 220, 600)).toBe(280)
  })

  it('下界夹紧', () => {
    expect(nextWidth(260, -500, 'left', 160, 600)).toBe(160)
  })

  it('上界夹紧', () => {
    expect(nextWidth(260, 5000, 'left', 160, 600)).toBe(600)
  })

  it('零位移原地不动', () => {
    expect(nextWidth(260, 0, 'left', 160, 600)).toBe(260)
  })
})

describe('useSplitter', () => {
  it('按下并移动指针后宽度跟随，抬起后停止跟随', () => {
    const { result } = renderHook(() => useSplitter({ initial: 260, min: 160, max: 600, side: 'left' }))
    expect(result.current.width).toBe(260)

    const el = document.createElement('div')
    document.body.appendChild(el)

    act(() => {
      result.current.onPointerDown({
        clientX: 100, pointerId: 1, currentTarget: el, preventDefault: () => {},
      } as unknown as React.PointerEvent<HTMLElement>)
    })

    // jsdom 没有 PointerEvent 构造器，但 addEventListener 按事件名匹配，
    // 用 MouseEvent 发一个名为 pointermove 的事件即可命中监听器。
    act(() => { el.dispatchEvent(new MouseEvent('pointermove', { clientX: 150 })) })
    expect(result.current.width).toBe(310)

    act(() => { el.dispatchEvent(new MouseEvent('pointerup', {})) })
    act(() => { el.dispatchEvent(new MouseEvent('pointermove', { clientX: 400 })) })
    expect(result.current.width).toBe(310)
  })
})
```

- [ ] **Step 6: 实现 `splitter.ts`**

```ts
import { useCallback, useState } from 'react'

export function nextWidth(
  startWidth: number, delta: number, side: 'left' | 'right', min: number, max: number,
): number {
  const raw = side === 'left' ? startWidth + delta : startWidth - delta
  return Math.min(max, Math.max(min, raw))
}

export interface SplitterOptions {
  initial: number
  min: number
  max: number
  /** 分隔条在被调节的那一栏的哪一侧：'left' 表示这一栏在分隔条左边（右拖变宽） */
  side: 'left' | 'right'
}

export function useSplitter({ initial, min, max, side }: SplitterOptions) {
  const [width, setWidth] = useState(initial)

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = width
    const el = e.currentTarget
    // jsdom 没有 setPointerCapture；可选链让测试环境不必打桩
    el.setPointerCapture?.(e.pointerId)

    const move = (ev: Event) => {
      setWidth(nextWidth(startWidth, (ev as MouseEvent).clientX - startX, side, min, max))
    }
    const up = () => {
      el.releasePointerCapture?.(e.pointerId)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }, [width, min, max, side])

  return { width, onPointerDown }
}
```

宽度存在 hook 里而不是 App 里，是因为它是纯粹的界面状态：不进 `Spec`、不落盘、刷新即回到默认值。与 `hidden` 集合同一类东西。

- [ ] **Step 7: 在 `main.tsx` 里 import `./layout.css`，运行测试与 typecheck，提交**

```bash
pnpm -C packages/ui test && pnpm -C packages/core build && pnpm -C packages/ui typecheck
git add packages/ui/src/useElementSize.ts packages/ui/src/useElementSize.test.ts packages/ui/src/splitter.ts packages/ui/src/splitter.test.ts packages/ui/src/layout.css packages/ui/src/styles.css packages/ui/src/main.tsx
git commit -m "feat(ui): 三栏骨架、容器实测 hook、分栏拖拽与表面色 token"
```

---

### Task 7: 文件图标与树行重构

**Files:**
- Create: `packages/ui/src/FileIcon.tsx`
- Modify: `packages/ui/src/NodeRow.tsx`
- Modify: `packages/ui/src/Tree.tsx`（`indent`/`rowHeight` 改值、透传 `onGroupClick`）
- Modify: `packages/ui/src/layout.css`
- Test: `packages/ui/src/FileIcon.test.tsx`
- Test: `packages/ui/src/NodeRow.test.tsx`（追加）

**Interfaces:**
- Produces:
  - `function iconKindFor(name: string, isDir: boolean, isOpen: boolean): IconKind`
  - `function FileIcon(props: { kind: IconKind }): JSX.Element`
  - `NodeRow` 渲染图标、缩进引导线、可点击的分组色点；新增可选 prop `onGroupClick?: (id: string) => void`
  - `SpecTree` 新增可选 prop `onGroupClick?: (id: string) => void`，`indent` 改 8、`rowHeight` 改 22

**spec §5.2 的行高与缩进是 CSS 与 react-arborist 两处必须同时改的值。** `rowHeight` 决定虚拟化为每行预留的像素；只改 CSS 的 `.fs-row { height }` 会让行与预留槽位错位、行间露出缝隙。所以 `.fs-row` **不设固定 height**（沿用 `styles.css` 里的 `height: 100%` 填满槽位），22px 由 `rowHeight={22}` 决定。`indent` 同理改成 8，与缩进引导线的每级宽度保持一致。

**一条必须写进 README 的平台限制：** VSCode 不把用户当前生效的 file icon theme 暴露给 webview，所以本扩展只能自带图标，与用户原生资源管理器里看到的**可能不一致**。这不是实现瑕疵。

- [ ] **Step 1: 写失败的测试**

`packages/ui/src/FileIcon.test.tsx`：

```tsx
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { FileIcon, iconKindFor } from './FileIcon.js'

describe('iconKindFor', () => {
  it('目录按开合状态区分', () => {
    expect(iconKindFor('src', true, false)).toBe('folder')
    expect(iconKindFor('src', true, true)).toBe('folder-open')
  })

  it('按扩展名归类，忽略大小写', () => {
    expect(iconKindFor('a.TS', false, false)).toBe('ts')
    expect(iconKindFor('a.tsx', false, false)).toBe('ts')
    expect(iconKindFor('a.js', false, false)).toBe('js')
    expect(iconKindFor('a.json', false, false)).toBe('json')
    expect(iconKindFor('a.md', false, false)).toBe('md')
    expect(iconKindFor('a.yaml', false, false)).toBe('yaml')
    expect(iconKindFor('a.yml', false, false)).toBe('yaml')
    expect(iconKindFor('a.png', false, false)).toBe('image')
  })

  it('按整名归类的特例', () => {
    expect(iconKindFor('.gitignore', false, false)).toBe('git')
    expect(iconKindFor('pnpm-lock.yaml', false, false)).toBe('lock')
  })

  it('未知扩展名回退到通用文件', () => {
    expect(iconKindFor('a.zzz', false, false)).toBe('file')
    expect(iconKindFor('LICENSE', false, false)).toBe('file')
  })
})

describe('FileIcon', () => {
  it('渲染出一个带 aria-hidden 的 svg', () => {
    const { container } = render(<FileIcon kind="ts" />)
    const svg = container.querySelector('svg')
    expect(svg).toBeTruthy()
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
  })

  it('每一种 kind 都能渲染，不落空', () => {
    for (const k of ['folder','folder-open','ts','js','json','md','yaml','css','html','py','rs','go','sh','toml','lock','image','git','file'] as const) {
      const { container } = render(<FileIcon kind={k} />)
      expect(container.querySelector('svg'), `kind=${k} 没渲染出 svg`).toBeTruthy()
    }
  })
})
```

追加到 `packages/ui/src/NodeRow.test.tsx`：

```tsx
  it('渲染文件图标', () => {
    const { container } = renderRow(make({ name: 'a.ts', path: 'a.ts' }))
    expect(container.querySelector('.fs-icon svg')).toBeTruthy()
  })

  it('属于分组时渲染分组色点，数量与分组数一致', () => {
    const { container } = renderRow(make({ groups: ['g1', 'g2'] }))
    expect(container.querySelectorAll('.fs-group-dot')).toHaveLength(2)
  })

  it('不属于任何分组时没有色点', () => {
    const { container } = renderRow(make())
    expect(container.querySelectorAll('.fs-group-dot')).toHaveLength(0)
  })

  it('点击色点上报该分组 id，且不触发整行的展开', () => {
    const onGroupClick = vi.fn()
    const toggle = vi.fn()
    // 夹具必须是**目录**：node.toggle() 只在 d.isDir 时才调用，用默认的文件节点
    // 会让 `expect(toggle).not.toHaveBeenCalled()` 恒真——删掉 stopPropagation()
    // 这条测试照样绿，也就侦测不到它要防的那个回归。
    const { container } = renderRow(
      make({ name: 'src', path: 'src', isDir: true, groups: ['g1'] }),
      { onGroupClick, toggle },
    )
    fireEvent.click(container.querySelector('.fs-group-dot')!)
    expect(onGroupClick).toHaveBeenCalledWith('g1')
    expect(toggle).not.toHaveBeenCalled()
  })

  it('缩进引导线的条数等于层级', () => {
    const { container } = renderRow(make(), { level: 3 })
    expect(container.querySelectorAll('.fs-indent-guide')).toHaveLength(3)
  })

  it('根层级没有引导线', () => {
    const { container } = renderRow(make(), { level: 0 })
    expect(container.querySelectorAll('.fs-indent-guide')).toHaveLength(0)
  })
```

`renderRow` 是 `NodeRow.test.tsx` 里已有的辅助函数，它构造一个假的 `NodeRendererProps`。**本任务需要给它加三个可选入参**：`level`（默认 0，写进假 node 的 `level`）、`toggle`（默认 `vi.fn()`，写进假 node 的 `toggle`）、`onGroupClick`（默认 `undefined`，作为额外 prop 传给 `NodeRow`）。改造时不要动它已有的默认行为，否则既有用例会连带失败。文件顶部的 import 需要补 `fireEvent`（现在只 import 了 `render`、`screen`）。

- [ ] **Step 2: 运行确认失败，然后实现 `FileIcon.tsx`**

```tsx
export type IconKind =
  | 'folder' | 'folder-open'
  | 'ts' | 'js' | 'json' | 'md' | 'yaml' | 'css' | 'html'
  | 'py' | 'rs' | 'go' | 'sh' | 'toml' | 'lock' | 'image' | 'git' | 'file'

const BY_NAME: Record<string, IconKind> = {
  '.gitignore': 'git', '.gitattributes': 'git', '.gitmodules': 'git',
  'pnpm-lock.yaml': 'lock', 'package-lock.json': 'lock', 'cargo.lock': 'lock',
}

const BY_EXT: Record<string, IconKind> = {
  ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts',
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  json: 'json', jsonc: 'json',
  md: 'md', markdown: 'md',
  yaml: 'yaml', yml: 'yaml',
  css: 'css', scss: 'css', less: 'css',
  html: 'html', htm: 'html',
  py: 'py', rs: 'rs', go: 'go',
  sh: 'sh', bash: 'sh', zsh: 'sh',
  toml: 'toml',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', svg: 'image', webp: 'image', ico: 'image',
}

export function iconKindFor(name: string, isDir: boolean, isOpen: boolean): IconKind {
  if (isDir) return isOpen ? 'folder-open' : 'folder'
  const lower = name.toLowerCase()
  const byName = BY_NAME[lower]
  if (byName) return byName
  const dot = lower.lastIndexOf('.')
  if (dot <= 0) return 'file'
  return BY_EXT[lower.slice(dot + 1)] ?? 'file'
}

/** 每个 kind 一段 path 数据，全部在 16x16 视口内。颜色由 CSS 的 currentColor 决定，
 *  因此跟着 --fs-* 主题走，深色浅色都不用额外处理。 */
const PATHS: Record<IconKind, string> = {
  'folder': 'M1.5 3h4l1.5 2h7.5v8.5h-13z',
  'folder-open': 'M1.5 3h4l1.5 2h7.5v1.5h-11l-2 7h-1z M3.5 7.5h12l-2 6h-12z',
  'ts': 'M2 2h12v12H2z',
  'js': 'M2 2h12v12H2z',
  'json': 'M5 2c-2 0-2 2-2 3s0 3-1 3 1 0 1 3 0 3 2 3 M11 2c2 0 2 2 2 3s0 3 1 3-1 0-1 3 0 3-2 3',
  'md': 'M1.5 4h13v8h-13z M3.5 10.5V6l2 2 2-2v4.5 M10 6v3l-1.5-1.5 M10 6l1.5 1.5',
  'yaml': 'M4 3l2.5 4v6 M9 3l-2.5 4 M9.5 8h4 M9.5 11h4',
  'css': 'M3 2h10l-1 11-4 1-4-1z',
  'html': 'M3 2h10l-1 11-4 1-4-1z',
  'py': 'M8 1.5c-3 0-3 1.5-3 3h6v1h-6c-2 0-3 1-3 3s1 3 3 3v-2c0-1.5 1.5-1.5 1.5-1.5h4.5c2 0 3-1 3-3v-.5c0-2-1-3-3-3z',
  'rs': 'M8 1.5l6 3.5v6l-6 3.5-6-3.5v-6z',
  'go': 'M3 6h4 M2 8h5 M3 10h4 M10.5 4a4 4 0 100 8 4 4 0 000-8z',
  'sh': 'M1.5 2.5h13v11h-13z M4 6l2.5 2L4 10 M8 10.5h4',
  'toml': 'M2.5 3h11 M8 3v10 M4 13h8',
  'lock': 'M4.5 7V5a3.5 3.5 0 017 0v2 M3 7h10v7H3z',
  'image': 'M1.5 3h13v10h-13z M4 10l3-3 2 2 2.5-2.5L14 9.5 M5 6a1 1 0 100 .01z',
  'git': 'M8 1.5l6.5 6.5L8 14.5 1.5 8z M6 8h4 M8 6v4',
  'file': 'M3.5 1.5h6l3 3v10h-9z M9.5 1.5v3h3',
}

export function FileIcon({ kind }: { kind: IconKind }) {
  return (
    <svg className="fs-icon-svg" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"
         fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round">
      <path d={PATHS[kind]} />
    </svg>
  )
}
```

- [ ] **Step 3: 重构 `NodeRow.tsx`**

在既有结构基础上：图标插在折叠箭头之后、名称之前；分组色点插在注释之前；整行不再依赖外部宽度。

签名改为 `NodeRow(props: NodeRendererProps<ViewNode> & { onGroupClick?: (id: string) => void })`。

**缩进引导线必须自己画，不能靠 react-arborist 的 `paddingLeft`。** 它给节点渲染器的 `style` 里只有 `paddingLeft: level * indent`，那是一段空白，画不出竖线。所以把 `paddingLeft` 从 `style` 里摘掉，改成按层级渲染等宽的引导线元素——层级关系一目了然，条数还能直接单测。

```tsx
export function NodeRow(
  { node, style, dragHandle, onGroupClick }: NodeRendererProps<ViewNode> & { onGroupClick?: (id: string) => void },
) {
  const d = node.data
  const color = nodeColorVar(d)
  const annotated = isAnnotated(d)
  // paddingLeft 是 react-arborist 表达层级的方式；这里换成可见的引导线，所以要摘掉它
  const { paddingLeft: _drop, ...rest } = (style ?? {}) as { paddingLeft?: unknown }

  return (
    <div
      ref={dragHandle}
      style={rest as React.CSSProperties}
      className="fs-row"
      data-selected={node.isSelected}
      data-origin={d.origin}
      data-annotated={annotated}
      onClick={() => { if (d.isDir) node.toggle() }}
    >
      {Array.from({ length: node.level }, (_, i) => (
        <span key={i} className="fs-indent-guide" aria-hidden="true" />
      ))}
      <span className="fs-caret" aria-hidden="true">
        {d.isDir ? (node.isOpen ? '▾' : '▸') : ''}
      </span>
      <span className="fs-icon"><FileIcon kind={iconKindFor(d.name, d.isDir, node.isOpen)} /></span>
      {d.severity ? <span className="fs-badge">{SEVERITY_BADGE[d.severity]}</span> : null}
      <span className="fs-name" style={color ? { color } : undefined}>
        {d.name}{d.isDir ? '/' : ''}
      </span>
      {d.truncated ? <span title={`子项过多，已截断显示`}>⋯</span> : null}
      {d.unreadable ? <span title={`无法读取该目录（通常是权限不足）`}>🚫</span> : null}
      {d.annotation ? <span className="fs-annotation">{d.annotation}</span> : null}
      {(d.groups ?? []).map(g => (
        <button
          key={g} type="button" className="fs-group-dot"
          title={`属于分组 ${g}`} aria-label={`选中分组 ${g} 的全部成员`}
          onClick={e => { e.stopPropagation(); onGroupClick?.(g) }}
        />
      ))}
    </div>
  )
}
```

**`e.stopPropagation()` 不能省**：整行的 `onClick` 会展开目录，色点落在行内，不拦住就会「点色点顺带把目录展开/收起」。spec §5.5 要求色点可点击并选中该分组全部成员，这是它唯一的入口。

- [ ] **Step 4: 追加样式到 `layout.css`**

```css
/* 行高由 Tree 的 rowHeight={22} 决定；这里不设 height，避免与虚拟化预留的槽位错位 */
.fs-row { font-size: 13px; gap: 4px; }
.fs-row:hover { background: var(--fs-row-hover-bg); }
.fs-caret { display: inline-flex; justify-content: center; width: 16px; flex-shrink: 0; }
.fs-icon { display: inline-flex; align-items: center; width: 16px; flex-shrink: 0; opacity: .85; }
/* 每级一根竖线，宽度必须与 Tree 的 indent={8} 一致 */
.fs-indent-guide {
  flex: 0 0 8px; align-self: stretch;
  border-left: 1px solid var(--fs-indent-guide);
}
.fs-group-dot {
  width: 6px; height: 6px; border-radius: 50%; padding: 0; border: none;
  background: var(--fs-group-dot); flex-shrink: 0; margin-left: 2px; cursor: pointer;
}
```

- [ ] **Step 4b: 改 `Tree.tsx` 的两个数值并透传 `onGroupClick`**

`TreeProps` 追加 `onGroupClick?: (id: string) => void`，`indent={16}` 改 `indent={8}`，`rowHeight={24}` 改 `rowHeight={22}`，并把子节点渲染器换成携带回调的包装：

```tsx
  const renderNode = useCallback(
    (p: NodeRendererProps<ViewNode>) => <NodeRow {...p} onGroupClick={onGroupClick} />,
    [onGroupClick],
  )
```

把 `{NodeRow}` 换成 `{renderNode}`。**`useCallback` 不能省**：react-arborist 把子渲染器的引用当作组件类型，引用一变，每一个可见行都会卸载重挂——代价是每次渲染都 churn 掉全部行的 DOM 与 drag-ref 身份，以及实打实的渲染开销。

（注：**不是**「选中态与展开态会丢失」。本计划早先的措辞是错的，已核对 `react-arborist@3.16.0` 源码更正：选中/展开态存在它自己的 Redux store 里（`TreeProvider` 的 `useRef` + `useSyncExternalStore`），与渲染器身份完全解耦，换引用只让单行组件重挂，store 不受影响。写进代码注释时请用真实理由，别沿用旧说法。）

**本步不加 `Tree.test.tsx` 用例。** 那个文件从建立起就只测抽出来的纯函数（`makeMoveHandler` / `matchesSearch` / `makeDisableDrop`），从不渲染虚拟列表——沿用这条既有约定。透传本身在两处已被覆盖：色点点击由 `NodeRow.test.tsx` 验证，端到端由 Task 11 的 App 测试验证（App 测试里树是真渲染出行的）。

- [ ] **Step 5: 运行测试、typecheck，提交**

```bash
pnpm -C packages/ui test
git add packages/ui/src/FileIcon.tsx packages/ui/src/FileIcon.test.tsx packages/ui/src/NodeRow.tsx packages/ui/src/NodeRow.test.tsx packages/ui/src/Tree.tsx packages/ui/src/layout.css
git commit -m "feat(ui): 文件类型图标与树行重构（图标、缩进引导线、可点击分组色点、22px 行高）"
```

---

### Task 8: 多选

**Files:**
- Create: `packages/ui/src/selection.ts`
- Modify: `packages/ui/src/Tree.tsx`
- Test: `packages/ui/src/selection.test.ts`
- Test: `packages/ui/src/Tree.test.tsx`（追加）

**Interfaces:**
- Consumes: `ViewNode`、`Group`（`@folderspec/core/api`）
- Produces:
  - `interface ClickMods { shift: boolean; ctrl: boolean }`
  - `interface SelectionState { selected: string[]; anchor: string | null }`
  - `function applyClick(state: SelectionState, clicked: string, visibleOrder: readonly string[], mods: ClickMods): SelectionState`
  - `function matchingGroups(selected: readonly string[], groups: readonly Group[]): Group[]`
  - `function visibleOrderOf(nodes: readonly ViewNode[], isOpen: (path: string) => boolean): string[]`

**沿用本项目已确立的模式**（`makeMoveHandler`、`matchesSearch`、`makeDisableDrop`、`isEntryModule`、`parseArgs`）：把决策逻辑提成导出的纯函数直接单测，不去渲染虚拟列表。

**Shift 区间按「当前可见的展开顺序」取**，不是磁盘顺序——所见即所选。

- [ ] **Step 1: 写失败的测试**

`packages/ui/src/selection.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { applyClick, matchingGroups, visibleOrderOf } from './selection.js'
import type { Group, ViewNode } from '@folderspec/core/api'

const ORDER = ['a', 'b', 'c', 'd', 'e']
const S = (selected: string[], anchor: string | null = null) => ({ selected, anchor })

describe('applyClick', () => {
  it('普通单击只选中一个并设为锚点', () => {
    expect(applyClick(S(['a', 'b']), 'd', ORDER, { shift: false, ctrl: false }))
      .toEqual({ selected: ['d'], anchor: 'd' })
  })

  it('ctrl 单击切换加入', () => {
    expect(applyClick(S(['a']), 'c', ORDER, { shift: false, ctrl: true }))
      .toEqual({ selected: ['a', 'c'], anchor: 'c' })
  })

  it('ctrl 单击已选中的项则移除', () => {
    expect(applyClick(S(['a', 'c'], 'a'), 'c', ORDER, { shift: false, ctrl: true }))
      .toEqual({ selected: ['a'], anchor: 'c' })
  })

  it('shift 单击选中锚点到目标之间的全部项', () => {
    expect(applyClick(S(['b'], 'b'), 'd', ORDER, { shift: true, ctrl: false }))
      .toEqual({ selected: ['b', 'c', 'd'], anchor: 'b' })
  })

  it('shift 反向同样成立', () => {
    expect(applyClick(S(['d'], 'd'), 'b', ORDER, { shift: true, ctrl: false }))
      .toEqual({ selected: ['b', 'c', 'd'], anchor: 'd' })
  })

  it('没有锚点时 shift 退化为普通单击', () => {
    expect(applyClick(S([], null), 'c', ORDER, { shift: true, ctrl: false }))
      .toEqual({ selected: ['c'], anchor: 'c' })
  })

  it('目标不在可见顺序里时退化为普通单击', () => {
    expect(applyClick(S(['a'], 'a'), 'zz', ORDER, { shift: true, ctrl: false }))
      .toEqual({ selected: ['zz'], anchor: 'zz' })
  })

  it('区间结果按可见顺序排列，不按点击先后', () => {
    const r = applyClick(S(['e'], 'e'), 'a', ORDER, { shift: true, ctrl: false })
    expect(r.selected).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})

describe('matchingGroups', () => {
  const groups: Group[] = [
    { id: 'g1', members: ['a', 'b'], text: 't1' },
    { id: 'g2', members: ['b', 'a'], text: 't2' },
    { id: 'g3', members: ['a'], text: 't3' },
  ]

  it('按集合相等匹配，与顺序无关', () => {
    expect(matchingGroups(['b', 'a'], groups).map(g => g.id)).toEqual(['g1', 'g2'])
  })

  it('成员多一个就不匹配', () => {
    expect(matchingGroups(['a', 'b', 'c'], groups)).toEqual([])
  })

  it('单个成员也能匹配', () => {
    expect(matchingGroups(['a'], groups).map(g => g.id)).toEqual(['g3'])
  })

  it('空选中集不匹配任何分组', () => {
    expect(matchingGroups([], groups)).toEqual([])
  })
})

describe('visibleOrderOf', () => {
  const tree: ViewNode[] = [
    { name: 'a', path: 'a', isDir: true, origin: 'both', children: [
      { name: 'a1', path: 'a/a1', isDir: false, origin: 'both' },
    ] },
    { name: 'b', path: 'b', isDir: false, origin: 'both' },
  ]

  it('展开的目录其子项计入顺序', () => {
    expect(visibleOrderOf(tree, p => p === 'a')).toEqual(['a', 'a/a1', 'b'])
  })

  it('未展开的目录其子项不计入', () => {
    expect(visibleOrderOf(tree, () => false)).toEqual(['a', 'b'])
  })
})
```

- [ ] **Step 2: 运行确认失败**

```bash
pnpm -C packages/ui test src/selection.test.ts
```

预期：FAIL，`Failed to resolve import "./selection.js"`。

- [ ] **Step 3: 实现 `selection.ts`**

```ts
import type { Group, ViewNode } from '@folderspec/core/api'

export interface ClickMods { shift: boolean; ctrl: boolean }
export interface SelectionState { selected: string[]; anchor: string | null }

/** 当前可见的展开顺序。Shift 区间以此为准，所见即所选，而非磁盘顺序。 */
export function visibleOrderOf(nodes: readonly ViewNode[], isOpen: (path: string) => boolean): string[] {
  const out: string[] = []
  const visit = (list: readonly ViewNode[]) => {
    for (const n of list) {
      out.push(n.path)
      if (n.isDir && isOpen(n.path) && n.children) visit(n.children)
    }
  }
  visit(nodes)
  return out
}

export function applyClick(
  state: SelectionState,
  clicked: string,
  visibleOrder: readonly string[],
  mods: ClickMods,
): SelectionState {
  if (mods.ctrl) {
    const has = state.selected.includes(clicked)
    return {
      selected: has ? state.selected.filter(p => p !== clicked) : [...state.selected, clicked],
      anchor: clicked,
    }
  }

  if (mods.shift && state.anchor !== null) {
    const from = visibleOrder.indexOf(state.anchor)
    const to = visibleOrder.indexOf(clicked)
    if (from !== -1 && to !== -1) {
      const lo = from <= to ? from : to
      const hi = from <= to ? to : from
      return { selected: visibleOrder.slice(lo, hi + 1), anchor: state.anchor }
    }
  }

  return { selected: [clicked], anchor: clicked }
}

/**
 * 选中集与某个分组的成员集完全相等时，面板应编辑该分组而非新建。
 * 判定用集合相等，与顺序无关（成员在文件里按字典序存储，界面里按点击顺序产生）。
 */
export function matchingGroups(selected: readonly string[], groups: readonly Group[]): Group[] {
  if (selected.length === 0) return []
  const want = new Set(selected)
  return groups.filter(g => g.members.length === want.size && g.members.every(m => want.has(m)))
}
```

- [ ] **Step 4: 接进 `Tree.tsx`**

改动三处：

1. `TreeProps` 的 `selectedPath: string | null` 改为 `selectedPaths: string[]`；`onSelect(path: string, node: ViewNode)` 改为 `onSelect(path: string, mods: ClickMods)`。
2. react-arborist 的 `onSelect` 不携带修饰键，因此**改由 `NodeRow` 的 `onClick` 读取 `e.shiftKey` 与 `e.ctrlKey || e.metaKey` 并上报**。`SpecTree` 把回调与 `selectedPaths` 通过 props 传给行渲染器（沿用现有传参风格，不引入状态库）。
3. `<Tree>` 的 `selection` prop 只接受单个 id，多选态不再依赖它：`NodeRow` 自行按 `selectedPaths.includes(d.path)` 决定 `data-selected`。

追加到 `Tree.test.tsx`：

```tsx
  it('多选时每个被选中的行都带 data-selected', () => {
    // 通过直接渲染 NodeRow 断言，避免依赖虚拟列表
    const { container } = renderRowWithSelection(
      { name: 'b', path: 'b', isDir: false, origin: 'actual-only' },
      ['a', 'b'],
    )
    expect(container.querySelector('.fs-row')?.getAttribute('data-selected')).toBe('true')
  })

  it('未被选中的行 data-selected 为 false', () => {
    const { container } = renderRowWithSelection(
      { name: 'c', path: 'c', isDir: false, origin: 'actual-only' },
      ['a', 'b'],
    )
    expect(container.querySelector('.fs-row')?.getAttribute('data-selected')).toBe('false')
  })
```

`renderRowWithSelection` 是本文件内的小辅助，构造 `NodeRendererProps` 并注入 `selectedPaths`，与已有的 `renderRow` 同风格。

- [ ] **Step 5: 运行测试、typecheck，提交**

```bash
pnpm -C packages/ui test
pnpm -C packages/core build && pnpm -C packages/ui typecheck
git add packages/ui/src/selection.ts packages/ui/src/selection.test.ts packages/ui/src/Tree.tsx packages/ui/src/Tree.test.tsx packages/ui/src/NodeRow.tsx
git commit -m "feat(ui): 多选（Shift 区间 / Ctrl 跳选）与选中集到分组的匹配"
```

---

### Task 9: 分组面板与归属入口

**Files:**
- Create: `packages/ui/src/GroupPanel.tsx`
- Modify: `packages/ui/src/AnnotationPanel.tsx`
- Test: `packages/ui/src/GroupPanel.test.tsx`
- Test: `packages/ui/src/AnnotationPanel.test.tsx`（追加）

**Interfaces:**
- Consumes: `matchingGroups`（Task 8）、`Group`、`Severity`
- Produces:
  - `interface GroupSubmit { id: string | null; name: string; text: string; severity: Severity | null }`
  - `interface GroupPanelProps { members: string[]; groups: Group[]; disabled: boolean; onSubmit(p: GroupSubmit): void; onRemoveMember(path: string): void }`
  - `function GroupPanel(props: GroupPanelProps): JSX.Element`
  - `AnnotationPanel` 新增两个 prop：`groupsOfNode: Group[]`、`onPickGroup(id: string): void`

**行为规则（spec 5.4.1 与 5.4.2）：**

- 选中集与某个既有分组的成员集完全相等，面板编辑该分组，名字与注释回填
- 否则新建，`id` 传 `null` 让 core 自动推导名字
- 多个分组成员集相同时，面板顶部提示并列出，默认取第一个
- 单选时面板底部只读列出该节点所属的全部分组，点击即上报其 id

- [ ] **Step 1: 写失败的测试**

`packages/ui/src/GroupPanel.test.tsx`：

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { GroupPanel } from './GroupPanel.js'
import type { Group } from '@folderspec/core/api'

const G: Group[] = [{ id: 'parse', members: ['src/a.ts', 'src/b.ts'], text: '解析层', severity: 'warning' }]
const noop = { onSubmit: vi.fn(), onRemoveMember: vi.fn() }

describe('GroupPanel', () => {
  it('显示成员数量与成员列表', () => {
    render(<GroupPanel members={['src/a.ts', 'src/b.ts']} groups={[]} disabled={false} {...noop} />)
    expect(screen.getByText(/已选中 2 项/)).toBeTruthy()
    expect(screen.getByText('src/a.ts')).toBeTruthy()
  })

  it('选中集等于既有分组时回填名字与注释', () => {
    render(<GroupPanel members={['src/b.ts', 'src/a.ts']} groups={G} disabled={false} {...noop} />)
    expect((screen.getByLabelText('分组名') as HTMLInputElement).value).toBe('parse')
    expect((screen.getByLabelText('分组注释') as HTMLTextAreaElement).value).toBe('解析层')
    expect((screen.getByLabelText('约束强度') as HTMLSelectElement).value).toBe('warning')
  })

  it('选中集不等于任何分组时是新建形态，注释为空', () => {
    render(<GroupPanel members={['src/a.ts', 'src/c.ts']} groups={G} disabled={false} {...noop} />)
    expect((screen.getByLabelText('分组注释') as HTMLTextAreaElement).value).toBe('')
  })

  it('注释失焦时提交，新建时 id 为 null', () => {
    const onSubmit = vi.fn()
    render(<GroupPanel members={['src/a.ts', 'src/c.ts']} groups={G} disabled={false}
      onSubmit={onSubmit} onRemoveMember={vi.fn()} />)
    const ta = screen.getByLabelText('分组注释')
    fireEvent.change(ta, { target: { value: '新分组' } })
    fireEvent.blur(ta)
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ id: null, text: '新分组' }))
  })

  it('编辑既有分组时提交带上其 id', () => {
    const onSubmit = vi.fn()
    render(<GroupPanel members={['src/a.ts', 'src/b.ts']} groups={G} disabled={false}
      onSubmit={onSubmit} onRemoveMember={vi.fn()} />)
    const ta = screen.getByLabelText('分组注释')
    fireEvent.change(ta, { target: { value: '改过的' } })
    fireEvent.blur(ta)
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ id: 'parse', text: '改过的' }))
  })

  it('内容未变时不提交', () => {
    const onSubmit = vi.fn()
    render(<GroupPanel members={['src/a.ts', 'src/b.ts']} groups={G} disabled={false}
      onSubmit={onSubmit} onRemoveMember={vi.fn()} />)
    fireEvent.blur(screen.getByLabelText('分组注释'))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('点击成员上的移除按钮上报该成员路径', () => {
    const onRemoveMember = vi.fn()
    render(<GroupPanel members={['src/a.ts', 'src/b.ts']} groups={[]} disabled={false}
      onSubmit={vi.fn()} onRemoveMember={onRemoveMember} />)
    fireEvent.click(screen.getByLabelText('从选中集移除 src/a.ts'))
    expect(onRemoveMember).toHaveBeenCalledWith('src/a.ts')
  })

  it('多个分组成员集相同时给出提示', () => {
    const two: Group[] = [
      { id: 'g1', members: ['x'], text: 'a' },
      { id: 'g2', members: ['x'], text: 'b' },
    ]
    render(<GroupPanel members={['x']} groups={two} disabled={false} {...noop} />)
    expect(screen.getByText(/有 2 个分组的成员完全相同/)).toBeTruthy()
  })

  it('只读模式下全部控件禁用', () => {
    render(<GroupPanel members={['x']} groups={[]} disabled={true} {...noop} />)
    expect((screen.getByLabelText('分组注释') as HTMLTextAreaElement).disabled).toBe(true)
    expect((screen.getByLabelText('分组名') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText('约束强度') as HTMLSelectElement).disabled).toBe(true)
  })

  it('切换选中集时重置为新集合的内容', () => {
    const { rerender } = render(
      <GroupPanel members={['src/a.ts', 'src/b.ts']} groups={G} disabled={false} {...noop} />)
    rerender(<GroupPanel members={['src/a.ts', 'src/c.ts']} groups={G} disabled={false} {...noop} />)
    expect((screen.getByLabelText('分组注释') as HTMLTextAreaElement).value).toBe('')
  })
})
```

追加到 `packages/ui/src/AnnotationPanel.test.tsx`（既有用例需补上两个新 prop）：

```tsx
  it('底部列出该节点所属的分组', () => {
    const g: Group[] = [{ id: 'parse', members: ['src/core'], text: '解析层' }]
    render(<AnnotationPanel node={node()} disabled={false} onChange={vi.fn()}
      groupsOfNode={g} onPickGroup={vi.fn()} />)
    expect(screen.getByText('parse')).toBeTruthy()
    expect(screen.getByText(/解析层/)).toBeTruthy()
  })

  it('点击所属分组时上报其 id', () => {
    const onPickGroup = vi.fn()
    const g: Group[] = [{ id: 'parse', members: ['src/core'], text: '解析层' }]
    render(<AnnotationPanel node={node()} disabled={false} onChange={vi.fn()}
      groupsOfNode={g} onPickGroup={onPickGroup} />)
    fireEvent.click(screen.getByText('parse'))
    expect(onPickGroup).toHaveBeenCalledWith('parse')
  })

  it('不属于任何分组时不显示该区块', () => {
    render(<AnnotationPanel node={node()} disabled={false} onChange={vi.fn()}
      groupsOfNode={[]} onPickGroup={vi.fn()} />)
    expect(screen.queryByText('所属分组')).toBeNull()
  })
```

- [ ] **Step 2: 运行确认失败**

```bash
pnpm -C packages/ui test src/GroupPanel.test.tsx src/AnnotationPanel.test.tsx
```

- [ ] **Step 3: 实现 `GroupPanel.tsx`**

```tsx
import { useEffect, useState } from 'react'
import type { Group, Severity } from '@folderspec/core/api'
import { SEVERITY_BADGE } from './colors.js'
import { matchingGroups } from './selection.js'

export interface GroupSubmit {
  id: string | null
  name: string
  text: string
  severity: Severity | null
}

export interface GroupPanelProps {
  members: string[]
  groups: Group[]
  disabled: boolean
  onSubmit(p: GroupSubmit): void
  onRemoveMember(path: string): void
}

/** 选中集的稳定键：排序后拼接。用它作为重置依赖，而不是 text/name —— 理由同
 *  AnnotationPanel：把 text 放进依赖，自己那次提交的回声会冲掉用户失焦后继续输入的内容。 */
const keyOf = (members: readonly string[]) => [...members].sort().join(' ')

export function GroupPanel({ members, groups, disabled, onSubmit, onRemoveMember }: GroupPanelProps) {
  const matches = matchingGroups(members, groups)
  const current = matches[0] ?? null

  const [name, setName] = useState('')
  const [text, setText] = useState('')

  useEffect(() => {
    setName(current?.id ?? '')
    setText(current?.text ?? '')
  }, [keyOf(members)])

  const submit = (over: Partial<GroupSubmit>) => {
    onSubmit({
      id: current?.id ?? null,
      name: name.trim(),
      text: text.trim(),
      severity: current?.severity ?? null,
      ...over,
    })
  }

  return (
    <div className="fs-panel">
      <h2 className="fs-panel-path">已选中 {members.length} 项</h2>

      {matches.length > 1 && (
        <p className="fs-panel-note">
          有 {matches.length} 个分组的成员完全相同，当前编辑的是 {current?.id}
        </p>
      )}

      <label className="fs-field">
        <span>分组名</span>
        <input
          aria-label="分组名" type="text" value={name} disabled={disabled}
          placeholder="留空则自动取名"
          onChange={e => setName(e.target.value)}
          onBlur={() => { if (name.trim() !== (current?.id ?? '')) submit({ name: name.trim() }) }}
        />
      </label>

      <label className="fs-field">
        <span>分组注释</span>
        <textarea
          aria-label="分组注释" rows={6} value={text} disabled={disabled}
          onChange={e => setText(e.target.value)}
          onBlur={() => { if (text.trim() !== (current?.text ?? '')) submit({ text: text.trim() }) }}
        />
      </label>

      <label className="fs-field">
        <span>约束强度</span>
        <select
          aria-label="约束强度" value={current?.severity ?? ''} disabled={disabled}
          onChange={e => submit({ severity: e.target.value === '' ? null : (e.target.value as Severity) })}
        >
          <option value="">（仅注释，不强制）</option>
          <option value="advisory">{SEVERITY_BADGE.advisory} advisory</option>
          <option value="warning">{SEVERITY_BADGE.warning} warning</option>
          <option value="error">{SEVERITY_BADGE.error} error</option>
        </select>
      </label>

      <ul className="fs-member-list">
        {members.map(m => (
          <li key={m}>
            <span className="fs-member-path">{m}</span>
            <button type="button" aria-label={`从选中集移除 ${m}`} disabled={disabled}
              onClick={() => onRemoveMember(m)}>×</button>
          </li>
        ))}
      </ul>
    </div>
  )
}
```

- [ ] **Step 4: 扩展 `AnnotationPanel.tsx`**

props 追加 `groupsOfNode: Group[]` 与 `onPickGroup(id: string): void`；在 severity 字段之后追加：

```tsx
      {groupsOfNode.length > 0 && (
        <div className="fs-owning-groups">
          <span className="fs-field-label">所属分组</span>
          <ul>
            {groupsOfNode.map(g => (
              <li key={g.id}>
                <button type="button" className="fs-group-link" onClick={() => onPickGroup(g.id)}>{g.id}</button>
                <span className="fs-group-text">{g.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
```

既有行为一律不动，特别是那条只依赖 `node?.path` 的重置 effect。

- [ ] **Step 5: 运行测试、typecheck，提交**

```bash
pnpm -C packages/ui test
git add packages/ui/src/GroupPanel.tsx packages/ui/src/GroupPanel.test.tsx packages/ui/src/AnnotationPanel.tsx packages/ui/src/AnnotationPanel.test.tsx packages/ui/src/layout.css
git commit -m "feat(ui): 分组面板与单选时的归属入口"
```

---

### Task 10: 中间栏只读文件预览

**Files:**
- Create: `packages/ui/src/ContentPane.tsx`
- Create: `packages/ui/src/highlight.ts`
- Modify: `packages/ui/package.json`（加 `prismjs` 与 `@types/prismjs`）
- Modify: `packages/ui/src/layout.css`
- Test: `packages/ui/src/highlight.test.ts`
- Test: `packages/ui/src/ContentPane.test.tsx`

**Interfaces:**
- Consumes: `FileReadResult`、`ViewNode`（`@folderspec/core/api`）
- Produces:
  - `function languageFor(fileName: string): string | null`
  - `function highlightToHtml(code: string, lang: string | null): string`
  - `interface ContentPaneProps { node: ViewNode | null; content: FileReadResult | null; loading: boolean }`
  - `function ContentPane(props: ContentPaneProps): JSX.Element`

**只读。** 本工具只写 `.folderspec.md` 一个文件；中间栏不会成为编辑器。

- [ ] **Step 1: 装依赖**

```bash
pnpm -C packages/ui add prismjs@^1.29.0
pnpm -C packages/ui add -D @types/prismjs@^1.26.5
```

- [ ] **Step 2: 写失败的测试**

`packages/ui/src/highlight.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { languageFor, highlightToHtml } from './highlight.js'

describe('languageFor', () => {
  it('按扩展名映射到 Prism 语言名', () => {
    expect(languageFor('a.ts')).toBe('typescript')
    expect(languageFor('a.tsx')).toBe('tsx')
    expect(languageFor('a.js')).toBe('javascript')
    expect(languageFor('a.json')).toBe('json')
    expect(languageFor('a.md')).toBe('markdown')
    expect(languageFor('a.yaml')).toBe('yaml')
    expect(languageFor('a.yml')).toBe('yaml')
    expect(languageFor('a.py')).toBe('python')
    expect(languageFor('a.rs')).toBe('rust')
    expect(languageFor('a.go')).toBe('go')
    expect(languageFor('a.sh')).toBe('bash')
    expect(languageFor('a.css')).toBe('css')
    expect(languageFor('a.html')).toBe('markup')
    expect(languageFor('a.toml')).toBe('toml')
  })

  it('忽略大小写', () => {
    expect(languageFor('A.TS')).toBe('typescript')
  })

  it('未知扩展名返回 null', () => {
    expect(languageFor('a.zzz')).toBeNull()
    expect(languageFor('LICENSE')).toBeNull()
  })
})

describe('highlightToHtml', () => {
  it('已知语言产出带 token 标记的 HTML', () => {
    const html = highlightToHtml('const a = 1', 'typescript')
    expect(html).toContain('token')
  })

  it('lang 为 null 时做 HTML 转义而不是原样输出', () => {
    const html = highlightToHtml('<script>alert(1)</script>', null)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('未注册的语言也走转义分支，不抛错', () => {
    const html = highlightToHtml('<b>x</b>', 'not-a-language')
    expect(html).toContain('&lt;b&gt;')
  })
})
```

`packages/ui/src/ContentPane.test.tsx`：

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ContentPane } from './ContentPane.js'
import type { ViewNode } from '@folderspec/core/api'

const file = (name = 'a.ts', path = 'src/a.ts'): ViewNode =>
  ({ name, path, isDir: false, origin: 'both' })
const dir = (): ViewNode =>
  ({ name: 'src', path: 'src', isDir: true, origin: 'both', children: [file(), file('b.ts', 'src/b.ts')] })

describe('ContentPane', () => {
  it('未选中任何节点时给出提示', () => {
    render(<ContentPane node={null} content={null} loading={false} />)
    expect(screen.getByText('在左侧选中一个文件查看内容')).toBeTruthy()
  })

  it('加载中显示加载态', () => {
    render(<ContentPane node={file()} content={null} loading={true} />)
    expect(screen.getByText('读取中…')).toBeTruthy()
  })

  it('文本文件渲染行号与内容', () => {
    render(<ContentPane node={file()} content={{ kind: 'text', text: 'a\nb\nc' }} loading={false} />)
    expect(screen.getByText('src/a.ts')).toBeTruthy()
    const lines = document.querySelectorAll('.fs-code-line')
    expect(lines).toHaveLength(3)
    expect(document.querySelectorAll('.fs-line-no')[2].textContent).toBe('3')
  })

  it('二进制文件不渲染内容，给出说明', () => {
    render(<ContentPane node={file('x.png', 'x.png')} content={{ kind: 'binary' }} loading={false} />)
    expect(screen.getByText(/二进制文件/)).toBeTruthy()
    expect(document.querySelectorAll('.fs-code-line')).toHaveLength(0)
  })

  it('超大文件显示体积且不渲染内容', () => {
    render(<ContentPane node={file()} content={{ kind: 'too-large', size: 2_000_000 }} loading={false} />)
    expect(screen.getByText(/超过预览上限/)).toBeTruthy()
    expect(document.querySelectorAll('.fs-code-line')).toHaveLength(0)
  })

  it('读取失败时显示原因', () => {
    render(<ContentPane node={file()} content={{ kind: 'unreadable', reason: 'EACCES' }} loading={false} />)
    expect(screen.getByText(/EACCES/)).toBeTruthy()
  })

  it('目录显示子项统计而非内容', () => {
    render(<ContentPane node={dir()} content={null} loading={false} />)
    expect(screen.getByText(/共 2 项/)).toBeTruthy()
  })

  it('尚未展开的目录不谎报为空', () => {
    const unscanned: ViewNode = { name: 'src', path: 'src', isDir: true, origin: 'both' }
    render(<ContentPane node={unscanned} content={null} loading={false} />)
    expect(screen.getByText(/尚未展开/)).toBeTruthy()
  })
})
```

- [ ] **Step 3: 运行确认失败**

```bash
pnpm -C packages/ui test src/highlight.test.ts src/ContentPane.test.tsx
```

- [ ] **Step 4: 实现 `highlight.ts`**

```ts
import Prism from 'prismjs'
import 'prismjs/components/prism-typescript.js'
import 'prismjs/components/prism-jsx.js'
import 'prismjs/components/prism-tsx.js'
import 'prismjs/components/prism-json.js'
import 'prismjs/components/prism-markdown.js'
import 'prismjs/components/prism-yaml.js'
import 'prismjs/components/prism-python.js'
import 'prismjs/components/prism-rust.js'
import 'prismjs/components/prism-go.js'
import 'prismjs/components/prism-bash.js'
import 'prismjs/components/prism-css.js'
import 'prismjs/components/prism-toml.js'

const BY_EXT: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  tsx: 'tsx', jsx: 'jsx',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json',
  md: 'markdown', markdown: 'markdown',
  yaml: 'yaml', yml: 'yaml',
  py: 'python', rs: 'rust', go: 'go',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  css: 'css', scss: 'css', less: 'css',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup',
  toml: 'toml',
}

export function languageFor(fileName: string): string | null {
  const lower = fileName.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot <= 0) return null
  return BY_EXT[lower.slice(dot + 1)] ?? null
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * 语言未知或 Prism 未注册该语法时一律走 HTML 转义分支。
 * 这里的输出会经 dangerouslySetInnerHTML 注入，转义是唯一的防线，不能省。
 */
export function highlightToHtml(code: string, lang: string | null): string {
  if (!lang) return escapeHtml(code)
  const grammar = Prism.languages[lang]
  if (!grammar) return escapeHtml(code)
  return Prism.highlight(code, grammar, lang)
}
```

- [ ] **Step 5: 实现 `ContentPane.tsx`**

```tsx
import type { FileReadResult, ViewNode } from '@folderspec/core/api'
import { highlightToHtml, languageFor } from './highlight.js'

export interface ContentPaneProps {
  node: ViewNode | null
  content: FileReadResult | null
  loading: boolean
}

export function ContentPane({ node, content, loading }: ContentPaneProps) {
  if (!node) return <div className="fs-content-empty">在左侧选中一个文件查看内容</div>

  if (node.isDir) {
    return (
      <div className="fs-content">
        <div className="fs-content-path">{node.path}</div>
        <p className="fs-content-note">
          {node.children === undefined
            ? '这是一个目录，尚未展开——点击左侧的箭头展开后可看到子项。'
            : `这是一个目录，共 ${node.children.length} 项。`}
        </p>
      </div>
    )
  }

  if (loading) return <div className="fs-content-empty">读取中…</div>
  if (!content) return <div className="fs-content-empty">在左侧选中一个文件查看内容</div>

  return (
    <div className="fs-content">
      <div className="fs-content-path">{node.path}</div>
      {content.kind === 'binary' && <p className="fs-content-note">二进制文件，不预览内容。</p>}
      {content.kind === 'too-large' && (
        <p className="fs-content-note">
          文件 {(content.size / 1024 / 1024).toFixed(2)} MB，超过预览上限，不读取内容。
        </p>
      )}
      {content.kind === 'unreadable' && (
        <p className="fs-content-note">无法读取：{content.reason}</p>
      )}
      {content.kind === 'text' && <CodeView text={content.text} fileName={node.name} />}
    </div>
  )
}

function CodeView({ text, fileName }: { text: string; fileName: string }) {
  const lang = languageFor(fileName)
  const lines = text.split('\n')
  return (
    <pre className="fs-code">
      {lines.map((line, i) => (
        <div className="fs-code-line" key={i}>
          <span className="fs-line-no">{i + 1}</span>
          <code
            className="fs-code-text"
            dangerouslySetInnerHTML={{ __html: highlightToHtml(line, lang) }}
          />
        </div>
      ))}
    </pre>
  )
}
```

**逐行高亮而非整段高亮**是有意的：行号与内容需要严格对齐，整段高亮产出的 HTML 会跨行嵌套 token，拆行时标签会断。代价是跨行的字符串或块注释着色不完美——对「瞥一眼想起这文件是干嘛的」这个用途足够，且换来行号绝对可靠。

- [ ] **Step 6: 追加样式**

```css
.fs-content { padding: 8px 12px; font-size: 13px; }
.fs-content-empty { padding: 24px; opacity: .6; }
.fs-content-path { font-weight: 600; margin-bottom: 8px; }
.fs-content-note { opacity: .75; }
.fs-code { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 18px; }
.fs-code-line { display: flex; white-space: pre; }
.fs-line-no { flex: 0 0 44px; text-align: right; padding-right: 12px; color: var(--fs-line-number); user-select: none; }
.fs-code-text { flex: 1 1 auto; }
```

- [ ] **Step 7: 运行测试、typecheck、构建，提交**

```bash
pnpm -C packages/ui test
pnpm -C packages/core build && pnpm -C packages/ui typecheck
pnpm -C packages/ui build
```

构建后确认产物增量在预期内（基线 282KB，Prism 加 12 种语法预期增加 30–40KB）。**若增量显著超出，在报告里写明实际数字**——这是当初选 Prism 而非 Shiki 的理由，值得核对。

```bash
git add packages/ui/src/ContentPane.tsx packages/ui/src/ContentPane.test.tsx packages/ui/src/highlight.ts packages/ui/src/highlight.test.ts packages/ui/src/layout.css packages/ui/package.json pnpm-lock.yaml
git commit -m "feat(ui): 中间栏只读文件预览与轻量语法高亮"
```

---

### Task 11: App 组装

Phase B 的收口。

**Files:**
- Modify: `packages/ui/src/App.tsx`
- Modify: `packages/ui/src/test-bridge.ts`（新增 `setHandler`）
- Test: `packages/ui/src/App.test.tsx`（重写受影响的用例并追加新用例）
- Test: `packages/ui/src/test-bridge.test.ts`（追加 `setHandler` 用例）

**Interfaces:**
- Consumes: 前面全部组件与纯函数
- Produces: 三栏 App，`selectedPaths` 驱动右栏形态，内容栏跟随最后点击的文件

- [ ] **Step 1: 写失败的测试**

在 `App.test.tsx` 的 `bridgeWith` 里补上新方法的桩：

```tsx
  'spec/setGroup': () => ({ tree: tree([SRC]), dirty: true, id: 'src' }),
  'spec/deleteGroup': () => ({ tree: tree([SRC]), dirty: true }),
  'file/read': () => ({ kind: 'text', text: 'hello\nworld' }),
```

追加用例：

```tsx
  it('单击文件后中间栏请求并显示其内容', async () => {
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))
    const row = container.querySelector('.fs-row')
    expect(row).toBeTruthy()
    fireEvent.click(row!)
    await waitFor(() => expect(bridge.lastCall('file/read')).toEqual({ path: 'src' }))
  })

  it('ctrl 多选后右栏切换为分组面板', async () => {
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))
    const rows = container.querySelectorAll('.fs-row')
    fireEvent.click(rows[0])
    fireEvent.click(rows[1], { ctrlKey: true })
    await waitFor(() => expect(screen.getByText(/已选中 2 项/)).toBeTruthy())
  })

  it('分组面板提交后发出 spec/setGroup', async () => {
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))
    const rows = container.querySelectorAll('.fs-row')
    fireEvent.click(rows[0])
    fireEvent.click(rows[1], { ctrlKey: true })
    const ta = await screen.findByLabelText('分组注释')
    fireEvent.change(ta, { target: { value: '这两个是一体的' } })
    fireEvent.blur(ta)
    await waitFor(() => expect(bridge.lastCall('spec/setGroup')).toMatchObject({
      id: null, text: '这两个是一体的',
    }))
  })

  it('点击行尾的分组色点，选中该分组的全部成员并进入分组面板', async () => {
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))
    const dot = container.querySelector('.fs-group-dot')
    expect(dot, '固定树夹具里至少要有一个节点带 groups').toBeTruthy()
    fireEvent.click(dot!)
    await waitFor(() => expect(screen.getByText(/已选中 2 项/)).toBeTruthy())
  })

  it('拖动左侧分隔条改变树栏宽度', async () => {
    const { container } = render(<App bridge={bridgeWith()} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))
    const pane = container.querySelector('.fs-pane-tree') as HTMLElement
    const before = pane.style.flexBasis
    const splitter = container.querySelectorAll('.fs-splitter')[0] as HTMLElement
    fireEvent.pointerDown(splitter, { clientX: 260, pointerId: 1 })
    fireEvent(splitter, new MouseEvent('pointermove', { clientX: 320 }))
    fireEvent(splitter, new MouseEvent('pointerup', {}))
    expect(pane.style.flexBasis).not.toBe(before)
  })

  it('file/read 失败时显示错误横幅', async () => {
    const bridge = bridgeWith()
    bridge.setHandler('file/read', () => { throw new Error('读取炸了') })
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))
    fireEvent.click(container.querySelector('.fs-row')!)
    await waitFor(() => expect(screen.getByText(/读取炸了/)).toBeTruthy())
  })
```

`FakeBridge` 需要一个 `setHandler(method, fn)` 以支持第四条；一并加上并在 `test-bridge.test.ts` 里补一条它的测试。

- [ ] **Step 2: 运行确认失败，然后改写 `App.tsx`**

关键改动：

1. 状态：`selectedPath: string | null` → `selection: SelectionState`；新增 `contentPath: string | null`、`content: FileReadResult | null`、`contentLoading: boolean`、`openPaths: Set<string>`。
2. 布局改为 `.fs-shell` / `.fs-header` / `.fs-body` 三栏，树栏用 `useElementSize` 实测尺寸传给 `SpecTree`。
3. `onSelect(path, mods)`：用 `applyClick` 更新选中集；若该节点是文件则同时设 `contentPath` 并发 `file/read`。
4. 右栏：`selection.selected.length >= 2` 渲染 `GroupPanel`，否则渲染 `AnnotationPanel`（并传入 `groupsOfNode` 与 `onPickGroup`）。
5. `onPickGroup(id)`：把 `selection.selected` 设为该分组的成员。
6. 全部 bridge 调用一律 `try/catch` 并落到错误横幅——包括新增的三个。
7. `SpecTree` 传 `onGroupClick={onPickGroup}`——spec §5.5 的色点入口与 §5.4.2 的面板入口走同一个处理函数，两条路径落到同一个结果，不要写成两份逻辑。
8. 两条分隔条各用一个 `useSplitter`：左 `{ initial: 260, min: 160, max: 600, side: 'left' }`，右 `{ initial: 320, min: 220, max: 720, side: 'right' }`。宽度写进对应栏的内联 `style={{ flexBasis: `${width}px` }}`，分隔条 `<div className="fs-splitter" onPointerDown={...} role="separator" aria-orientation="vertical" />`。树栏宽度变化由 `useElementSize` 自动被 `ResizeObserver` 捕获，不需要额外接线。

三个新增处理函数的实现：

沿用 `handlePatch` 已经确立的写法：`bridge.request(...)` 取回 `EditResult`，`setTree(r.tree)` + `setDirty(r.dirty)`，`catch` 落到 `setError`。节点查找用 `App.tsx` 里已经在用的 `flatten(tree.children ?? []).get(path)`（来自 `./Tree.js`），不要新写一个查找函数。

```tsx
  const loadContent = useCallback(async (path: string) => {
    setContentLoading(true)
    try {
      setContent(await bridge.request('file/read', { path }))
    } catch (e) {
      setContent(null)
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setContentLoading(false)
    }
  }, [bridge])

  const handleSelect = useCallback((path: string, mods: ClickMods) => {
    if (tree === null) return
    const order = visibleOrderOf(tree.children ?? [], p => openPaths.has(p))
    setSelection(prev => applyClick(prev, path, order, mods))
    const node = flatten(tree.children ?? []).get(path)
    if (node && !node.isDir) {
      setContentPath(path)
      void loadContent(path)
    }
  }, [tree, openPaths, loadContent])

  const handleGroupSubmit = useCallback(async (p: GroupSubmit) => {
    try {
      const r = await bridge.request('spec/setGroup', {
        id: p.id,
        members: selection.selected,
        name: p.name,
        text: p.text,
        severity: p.severity,
      })
      setTree(r.tree)
      setDirty(r.dirty)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [bridge, selection.selected])
```

`GroupSubmit.name` 必须一路透传到 `spec/setGroup`——它是用户改名的唯一通道。`name` 为空串时 core 视为「未改名」，所以新建分组时面板留空即走自动取名，UI 侧不需要特判。

**保留全部既有行为**：只读横幅、外部变更提示、`requestReload` 的未保存确认、头部高度实测、保存按钮的脏标记。

- [ ] **Step 3: 运行测试、typecheck、构建，提交**

```bash
pnpm -C packages/ui test
pnpm -C packages/core build && pnpm -C packages/ui typecheck
pnpm -C packages/ui build
git add packages/ui/src/App.tsx packages/ui/src/App.test.tsx packages/ui/src/test-bridge.ts packages/ui/src/test-bridge.test.ts
git commit -m "feat(ui): 三栏 App 组装，多选驱动分组面板，内容栏联动"
```

**App 测试的固定树夹具需要带 `groups`。** 上面的色点用例要求夹具里存在一个 `groups: ['g1']` 且成员为两个节点的场景——改 `bridgeWith` 的 `tree(...)` 夹具时，让两个节点都带 `groups: ['g1']`，这样点击色点后选中集为 2、右栏切到分组面板。

**Phase B 完成。**

---

## Phase C — 宿主与文档（Task 12）

---

### Task 12: 宿主主题映射与文档

**Files:**
- Modify: `packages/vscode/src/webview-html.ts`（新增 token 的 `--vscode-*` 映射）
- Modify: `README.md`
- Test: `packages/vscode/src/webview-html.test.ts`（追加）

- [ ] **Step 1: 写失败的测试**

追加到 `packages/vscode/src/webview-html.test.ts`：

```ts
  it('新增的表面色 token 也映射到 VSCode 主题变量', () => {
    const html = build()
    expect(html).toContain('--fs-sidebar-bg: var(--vscode-sideBar-background')
    expect(html).toContain('--fs-editor-bg: var(--vscode-editor-background')
    expect(html).toContain('--fs-panel-border: var(--vscode-panel-border')
    expect(html).toContain('--fs-row-hover-bg: var(--vscode-list-hoverBackground')
    expect(html).toContain('--fs-indent-guide: var(--vscode-tree-indentGuidesStroke')
    expect(html).toContain('--fs-line-number: var(--vscode-editorLineNumber-foreground')
  })
```

- [ ] **Step 2: 在 `THEME_BRIDGE` 里补齐映射**

每一条都带上与 `styles.css` 相同的回退值，缺一条那一侧就会得到透明背景：

```css
  --fs-sidebar-bg: var(--vscode-sideBar-background, #f3f3f3);
  --fs-editor-bg: var(--vscode-editor-background, #ffffff);
  --fs-panel-border: var(--vscode-panel-border, #e0e0e0);
  --fs-row-hover-bg: var(--vscode-list-hoverBackground, #e8e8e8);
  --fs-indent-guide: var(--vscode-tree-indentGuidesStroke, #d0d0d0);
  --fs-group-dot: var(--vscode-charts-purple, #b180d7);
  --fs-line-number: var(--vscode-editorLineNumber-foreground, #9a9a9a);
```

- [ ] **Step 3: 更新 README**

新增或修改四处：

1. **`## 分组` 区的完整说明**，含字段表与一个可直接抄用的完整示例——模板区与规则区已有同样待遇，分组区不能只在设计文档里存在。
2. **界面说明**：三栏布局、Shift/Ctrl 多选、批量注释与单节点注释互不覆盖。
3. **已知限制里追加三条**：
   - VSCode 不把用户当前生效的 file icon theme 暴露给 webview，因此本扩展自带图标，与原生资源管理器里看到的可能不一致 —— **这一条 Task 7 已写入 README，核对存在即可，不要重复添加**
   - 中间栏的语法高亮是逐行进行的，跨行的字符串与块注释着色不完美；这是为了让行号严格对齐所做的取舍
   - **分组成员若既不在结构区、又不在磁盘上，树上不会出现对应的行**（因此看不到它的分组色点）。这种情况只在「一个从未被单独注释过的文件被加进分组、随后从磁盘删除」时出现。**该成员不会丢失**——它仍在 `.folderspec.md` 的分组区里，也仍会列在分组面板的成员列表中；只是树上没有可挂载的节点。树只渲染结构区声明过的节点与磁盘上真实存在的节点，为分组成员额外合成节点会破坏「稀疏覆盖层」这条不变量
4. **`.folderspec.md` 示例**同步加上一个分组区。

- [ ] **Step 4: 全量验证**

```bash
pnpm -C packages/core test && pnpm -C packages/ui test && pnpm -C packages/cli test && pnpm -C packages/vscode test
pnpm typecheck
pnpm -r build
```

再做一次真实的端到端确认：起 CLI、用 Playwright 截图，确认三栏布局、图标、多选与分组面板在真实浏览器里成立。Playwright 与无头 Chromium 装在 `browseruse` conda 环境，CJK 字体已装。

```bash
source ~/miniconda3/etc/profile.d/conda.sh && conda activate folderspec
node packages/cli/dist/main.js --no-open --port 7940 >/tmp/srv.log 2>&1 &
# 等待就绪后
conda activate browseruse && python /tmp/你的脚本.py http://127.0.0.1:7940/
```

脚本里用 `playwright.async_api`，`chromium.launch(args=["--no-sandbox"])`，视口 1500x900，展开目录、单击文件看中间栏、Ctrl 多选看右栏切换，各截一张图。**程序化断言也要有**：例如选中行的 `getBoundingClientRect().right` 不得超过 `.fs-pane-content` 的左边缘。跑完杀掉服务。

- [ ] **Step 5: 提交**

```bash
git add packages/vscode/src/webview-html.ts packages/vscode/src/webview-html.test.ts README.md
git commit -m "feat: 宿主主题映射补齐新增 token，README 补充分组格式与已知限制"
```

---

## 实现期的两条硬性纪律

这两条不是建议，是本项目 MVP 期间用代价换来的：

1. **凡是要求补回归测试，必须做 RED/GREEN 实证** ——回退被测代码、跑测试、贴出真实的失败输出、恢复、再贴通过输出。MVP 期间**十次**出现「测试无法侦测它要防的缺陷」，包括为了修复而新写的测试本身。口头断言一律不接受。
2. **报告只能写 `git log` 真实打印出来的 SHA。** 曾有实现者报告了一个不存在的提交与编造的测试记录，代价是一整轮。提交没落地就报 BLOCKED——如实的 BLOCKED 是好结果。
