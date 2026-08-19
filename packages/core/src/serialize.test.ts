import { describe, it, expect } from 'vitest'
import { serializeSpec } from './serialize.js'
import type { Spec } from './types.js'

const base: Spec = {
  version: 1, root: '.', ownership: 'human',
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
