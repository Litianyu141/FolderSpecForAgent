import { describe, it, expect } from 'vitest'
import { serializeSpec } from './serialize.js'
import type { Spec } from './types.js'

const base: Spec = {
  version: 1, root: '.', ownership: 'human', lang: 'zh',
  title: '仓库结构契约', preamble: ['Agent 不应自行修改本文件。'],
  nodes: [], templates: [], rules: [], groups: [],
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
})

describe('serializeSpec 的双语支持', () => {
  it('lang 为 zh 时不输出 lang 字段——今天的输出格式必须原样保留', () => {
    const out = serializeSpec({
      ...base,
      nodes: [{ name: 'src', isDir: true, annotation: '核心源码', children: [] }],
    })
    expect(out).not.toContain('lang:')
    expect(out).toContain('## 结构')
  })

  it('lang 为 en 时 front-matter 带上 lang: en，四个章节标题换成英文', () => {
    const out = serializeSpec({
      ...base,
      lang: 'en',
      nodes: [{ name: 'src', isDir: true, children: [] }],
      templates: [{ name: 't', children: [], exemplar: [] }],
      rules: [{ id: 'r', severity: 'error', scope: '**', text: 'x' }],
      groups: [{ id: 'g', members: ['a'], text: 'y' }],
    })
    expect(out).toContain('lang: en')
    expect(out).toContain('## Structure')
    expect(out).toContain('## Templates')
    expect(out).toContain('## Rules')
    expect(out).toContain('## Groups')
    expect(out).not.toContain('## 结构')
    expect(out).not.toContain('## 模板')
    expect(out).not.toContain('## 规则')
    expect(out).not.toContain('## 分组')
  })

  it('节点注释、分组说明、规则文字这些用户内容不受 lang 影响，原样输出', () => {
    const out = serializeSpec({
      ...base,
      lang: 'en',
      nodes: [{ name: 'src', isDir: true, annotation: '核心源码，别动它', children: [] }],
      rules: [{ id: 'r1', severity: 'error', scope: '**', text: '这是用户写的规则文字' }],
      groups: [{ id: 'g1', members: ['src'], text: '用户写的分组说明' }],
    })
    expect(out).toContain('核心源码，别动它')
    expect(out).toContain('这是用户写的规则文字')
    expect(out).toContain('用户写的分组说明')
  })
})
