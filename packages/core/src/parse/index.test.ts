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
