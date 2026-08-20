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
    expect(r.errors[0]).toMatchObject({ line: 2, code: 'parse.indentNotMultipleOfTwo', params: { indent: 3 } })
  })

  it('缩进跳级报行号', () => {
    const r = parseStructure(L('- `src/`', '    - `deep/`'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatchObject({ code: 'parse.indentSkipsLevel', params: { prev: 0, depth: 2 } })
    expect(r.errors[0].line).toBe(2)
  })

  it('未知标签报行号而非静默忽略', () => {
    const r = parseStructure(L('- `src/` `[planned]` — 源码'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatchObject({ line: 1, code: 'parse.unknownTag', params: { tag: 'planned' } })
  })

  it('非法 severity 报行号', () => {
    const r = parseStructure(L('- `src/` `[severity:fatal]`'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatchObject({ code: 'parse.severityInvalid', params: { value: 'fatal' } })
  })

  it('名称未用反引号包裹时报错', () => {
    const r = parseStructure(L('- src/ — 源码'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].code).toBe('parse.nameBackticksRequired')
  })

  it('文件节点下挂子节点时报错', () => {
    const r = parseStructure(L('- `a.txt`', '  - `b.txt`'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatchObject({ code: 'parse.parentNotDir', params: { name: 'a.txt' } })
  })

  it('分隔符不是 " — " 时报错', () => {
    const r = parseStructure(L('- `src/`: 源码'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].code).toBe('parse.annotationSeparator')
  })

  it('收集多行的多个错误', () => {
    const r = parseStructure(L('- `a/` `[bogus]`', '- `b/` `[severity:x]`'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors).toHaveLength(2)
    expect(r.errors.map(e => e.line)).toEqual([1, 2])
  })
})
