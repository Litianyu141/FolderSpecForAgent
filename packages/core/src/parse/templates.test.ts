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
    expect(r.errors[0].code).toBe('parse.templatesTopLevel')
  })

  it('required 不是布尔时报错', () => {
    const r = parseTemplates(block('case:\n  children:\n    a.txt: { required: yes-please }'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatchObject({ code: 'parse.templateChildRequiredType', params: { name: 'case', child: 'a.txt' } })
  })

  it('exemplar 不是字符串数组时报错', () => {
    const r = parseTemplates(block('case:\n  children: {}\n  exemplar: 42'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatchObject({ code: 'parse.templateExemplarType', params: { name: 'case' } })
  })

  it('root.variable 不是字符串时报错', () => {
    const r = parseTemplates(block('case:\n  root: { variable: 123 }\n  children: {}'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatchObject({ code: 'parse.templateRootVariableType', params: { name: 'case' } })
  })

  it('root.naming 不是字符串时报错', () => {
    const r = parseTemplates(block('case:\n  root: { naming: 123 }\n  children: {}'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatchObject({ code: 'parse.templateRootNamingType', params: { name: 'case' } })
  })

  it('模板顶层未知字段报错', () => {
    const r = parseTemplates(block('case:\n  descriptin: typo\n  children: {}'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatchObject({ code: 'parse.templateUnknownField', params: { name: 'case', field: 'descriptin' } })
  })

  it('children 条目的未知字段报错', () => {
    const r = parseTemplates(block('case:\n  children:\n    a.txt: { requird: true }'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatchObject({
      code: 'parse.templateChildUnknownField',
      params: { name: 'case', child: 'a.txt', field: 'requird' },
    })
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

  // 回归：round-trip property test 发现的反例（详见 roundtrip.test.ts）。
  // 形如整数的键（如 "0"）在被转换成普通 JS 对象后，会被 ECMAScript 的
  // 整数键排序规则重排到最前面，与它在 YAML 文档里的原始顺序无关。
  it('顶层模板名形如整数时仍按文档中的原始顺序返回', () => {
    const r = parseTemplates(block('b:\n  children: {}\n"0":\n  children: {}'))
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    expect(r.value.map(t => t.name)).toEqual(['b', '0'])
  })

  it('children 子项名形如整数时仍按文档中的原始顺序返回', () => {
    const r = parseTemplates(block([
      'case:',
      '  children:',
      '    a: { required: false }',
      '    "0": { required: false }',
    ].join('\n')))
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    expect(r.value[0]?.children.map(c => c.name)).toEqual(['a', '0'])
  })
})
