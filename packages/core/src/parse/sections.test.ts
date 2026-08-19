import { describe, it, expect } from 'vitest'
import { splitSections } from './sections.js'
import { parseStructure } from './structure.js'

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

  it('区块外的游离文本报行号', () => {
    const doc = '---\nfolderspec: 1\n---\n\n# T\n\n> pre\n\nsome stray text\n\n## 结构\n\n- `a/`\n'
    const r = splitSections(doc)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].line).toBe(9)
    expect(r.errors[0].message).toContain('区块外的游离内容')
  })

  it('yaml 代码块之后的游离文本同样报错', () => {
    const doc = DOC + 'stray text after rules\n'
    const r = splitSections(doc)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors.some(e => e.message.includes('区块外的游离内容'))).toBe(true)
  })

  it('front-matter 里的空行不报错', () => {
    const doc = ['---', 'folderspec: 1', '', 'root: .', '---', '', '# 标题', '## 结构', '', '- `a/`', ''].join('\n')
    const r = splitSections(doc)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.frontMatter).toEqual({ folderspec: '1', root: '.' })
  })

  it('区块之间的空行仍然被容忍', () => {
    // The original DOC already has blank lines between sections and passes
    const r = splitSections(DOC)
    expect(r.ok).toBe(true)
  })

  it('CRLF 文档与 LF 文档解析结果完全相同', () => {
    const lfResult = splitSections(DOC)
    const crlfDoc = DOC.replace(/\n/g, '\r\n')
    const crlfResult = splitSections(crlfDoc)
    expect(lfResult).toEqual(crlfResult)
  })

  it('CRLF 下 front-matter 的值不带残留 \\r', () => {
    const crlfDoc = DOC.replace(/\n/g, '\r\n')
    const r = splitSections(crlfDoc)
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    expect(r.value.frontMatter.folderspec).toBe('1')
  })

  it('CRLF 结构行通过 splitSections 和 parseStructure 组合解析', () => {
    const crlfDoc = DOC.replace(/\n/g, '\r\n')
    const sr = splitSections(crlfDoc)
    if (!sr.ok) throw new Error(JSON.stringify(sr.errors))
    const pr = parseStructure(sr.value.structure)
    if (!pr.ok) throw new Error(JSON.stringify(pr.errors))
    expect(pr.value[0]).toEqual({ name: 'src', isDir: true, annotation: '核心源码', children: [] })
  })

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
})
