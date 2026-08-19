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
    expect(r.errors[0].message).toContain('规则区顶层必须是序列')
  })

  it('id 重复时报错', () => {
    const r = parseRules(block([
      '- { id: dup, severity: error, scope: "**", text: a }',
      '- { id: dup, severity: error, scope: "**", text: b }',
    ].join('\n')))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].message).toContain('规则 id "dup" 重复')
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
    expect(r.errors[0].message).toContain('severity 只能是 error/warning/advisory')
  })
})
