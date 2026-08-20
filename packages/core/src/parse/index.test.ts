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

describe('parseSpec 分组区', () => {
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
})

describe('parseSpec 的 lang 字段', () => {
  it('front-matter 没有 lang 时默认为 zh——保证既有文件行为不变', () => {
    const r = parseSpec(DOC)
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    expect(r.value.lang).toBe('zh')
  })

  it('front-matter 里 lang: en 时解析为 en', () => {
    const doc = DOC.replace('ownership: human', 'ownership: human\nlang: en')
    const r = parseSpec(doc)
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    expect(r.value.lang).toBe('en')
  })

  it('lang 是无法识别的值时按 zh 处理，不崩溃、不报错', () => {
    const doc = DOC.replace('ownership: human', 'ownership: human\nlang: fr')
    const r = parseSpec(doc)
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    expect(r.value.lang).toBe('zh')
  })
})

describe('parseSpec 拒绝同名兄弟节点', () => {
  // 行号一目了然地对齐：1..5 是 front-matter，6 空行，7 是 "## 结构"，8 空行，
  // 9/10/11 是三个结构行。
  const doc = (...structure: string[]) => [
    '---', 'folderspec: 1', 'root: .', 'ownership: human', '---',
    '',
    '## 结构',
    '',
    ...structure,
    '',
  ].join('\n')

  it('两个同名兄弟被拒绝，行号指向后出现的那一条', () => {
    const r = parseSpec(doc(
      '- `src/` — 第一次声明',
      '- `docs/` — 无关节点',
      '- `src/` — 第二次声明',
    ))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0].line).toBe(11)
    expect(r.errors[0].message).toContain('重名')
  })

  it('同名的"文件 + 目录"也算重复声明', () => {
    // 下游两条路径的键都只有 name（merge 用 Map、spec-edit 用 list.find），
    // `src` 与 `src/` 作为兄弟一样会互相覆盖，所以不能因为 isDir 不同就放行。
    const r = parseSpec(doc(
      '- `src/` — 当成目录声明',
      '- `src` — 又当成文件声明',
    ))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].line).toBe(10)
    expect(r.errors[0].message).toContain('重名')
  })

  it('嵌套层里的同名兄弟同样被拒绝，而不是只查根层', () => {
    const r = parseSpec(doc(
      '- `src/` — 源码',
      '  - `core/` — 内核',
      '  - `core/` — 又一个内核',
    ))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].line).toBe(11)
    expect(r.errors[0].message).toContain('重名')
  })

  it('不同父节点下的同名节点是合法的，不能误伤', () => {
    const r = parseSpec(doc(
      '- `src/` — 源码',
      '  - `utils/` — 一份',
      '- `tests/` — 测试',
      '  - `utils/` — 另一份，和上面那个无关',
    ))
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    expect(r.value.nodes[0].children[0].name).toBe('utils')
    expect(r.value.nodes[1].children[0].name).toBe('utils')
  })
})
