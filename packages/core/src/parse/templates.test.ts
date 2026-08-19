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

  it('root.variable 不是字符串时报错', () => {
    const r = parseTemplates(block('case:\n  root: { variable: 123 }\n  children: {}'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].message).toContain('root.variable 必须是字符串')
  })

  it('root.naming 不是字符串时报错', () => {
    const r = parseTemplates(block('case:\n  root: { naming: 123 }\n  children: {}'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].message).toContain('root.naming 必须是字符串')
  })

  it('模板顶层未知字段报错', () => {
    const r = parseTemplates(block('case:\n  descriptin: typo\n  children: {}'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].message).toContain('有未知字段 "descriptin"')
  })

  it('children 条目的未知字段报错', () => {
    const r = parseTemplates(block('case:\n  children:\n    a.txt: { requird: true }'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].message).toContain('有未知字段 "requird"')
    expect(r.errors[0].message).toContain('a.txt')
  })

  it('多行模板的错误指向该模板的名字行', () => {
    const text = [
      'template1:',
      '  children: {}',
      'template2:',
      '  description: 123',
      '  children: {}',
    ].join('\n')
    const r = parseTemplates({ text, startLine: 10 })
    expect(r.ok).toBe(false)
    if (r.ok) return
    // template2 starts at line 10 + 2 = 12
    const template2Error = r.errors.find(e => e.message.includes('template2'))
    expect(template2Error?.line).toBe(12)
  })
})
