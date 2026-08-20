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
    expect(r.errors[0].code).toBe('parse.rulesTopLevel')
  })

  it('id 重复时报错', () => {
    const r = parseRules(block([
      '- { id: dup, severity: error, scope: "**", text: a }',
      '- { id: dup, severity: error, scope: "**", text: b }',
    ].join('\n')))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatchObject({ code: 'parse.ruleIdDuplicate', params: { id: 'dup' } })
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
    expect(r.errors[0]).toMatchObject({ code: 'parse.ruleSeverityInvalid', params: { id: 'x' } })
  })

  it('规则未知字段报错', () => {
    const r = parseRules(block('- { id: x, sevrity: error, scope: "**", text: t }'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors.some(e => e.code === 'parse.ruleUnknownField' && e.params?.field === 'sevrity')).toBe(true)
  })

  it('多行块式规则的错误行号指向该规则起始行', () => {
    const text = [
      '- id: rule1',
      '  severity: error',
      '  scope: "**"',
      '  text: 规则一',
      '- id: rule2',
      '  severity: error',
      '  scope: "**"',
    ].join('\n')
    const r = parseRules({ text, startLine: 20 })
    expect(r.ok).toBe(false)
    if (r.ok) return
    // rule2 starts at line 20 + 4 = 24 (0-based: lines 0-3 for rule1, line 4 starts rule2)
    const rule2Error = r.errors.find(e => e.message.includes('rule2'))
    expect(rule2Error?.line).toBe(24)
  })
})
