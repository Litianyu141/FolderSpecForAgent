import { describe, it, expect } from 'vitest'
import { parseGroups } from './groups.js'

const block = (text: string) => ({ text, startLine: 30 })

describe('parseGroups', () => {
  it('null 区块返回空数组', () => {
    const r = parseGroups(null)
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    expect(r.value).toEqual([])
  })

  it('解析完整分组', () => {
    const r = parseGroups(block([
      '- id: parse-layer',
      '  members:',
      '    - src/parse/sections.ts',
      '    - src/parse/structure.ts',
      '  text: 这两个共同构成解析层',
      '  severity: warning',
    ].join('\n')))
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    expect(r.value).toEqual([{
      id: 'parse-layer',
      members: ['src/parse/sections.ts', 'src/parse/structure.ts'],
      text: '这两个共同构成解析层',
      severity: 'warning',
    }])
  })

  it('severity 可省略', () => {
    const r = parseGroups(block('- { id: g, members: [a.ts], text: t }'))
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    expect(r.value[0].severity).toBeUndefined()
  })

  it('顶层不是序列时报错', () => {
    const r = parseGroups(block('id: x'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].code).toBe('parse.groupsTopLevel')
  })

  it('id 重复时报第二次出现的行号', () => {
    const r = parseGroups(block([
      '- { id: dup, members: [a.ts], text: a }',
      '- { id: dup, members: [b.ts], text: b }',
    ].join('\n')))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatchObject({ code: 'parse.groupIdDuplicate', params: { id: 'dup' } })
    expect(r.errors[0].line).toBe(31)
  })

  it('members 为空数组时报错', () => {
    const r = parseGroups(block('- { id: g, members: [], text: t }'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatchObject({ code: 'parse.groupMembersType', params: { id: 'g' } })
  })

  it('members 含 .. 时报错', () => {
    const r = parseGroups(block('- { id: g, members: ["../x.ts"], text: t }'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].code).toBe('parse.groupMembersParentSegment')
  })

  it('members 是以 / 开头的绝对路径时报错', () => {
    const r = parseGroups(block('- { id: g, members: ["/etc/passwd"], text: t }'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].code).toBe('parse.groupMembersAbsolute')
    expect(r.errors[0].line).toBe(30)
  })

  it('members 是 Windows 盘符形式的绝对路径时报错', () => {
    const r = parseGroups(block("- { id: g, members: ['C:\\Users\\x'], text: t }"))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].code).toBe('parse.groupMembersAbsolute')
    expect(r.errors[0].line).toBe(30)
  })

  it('members 含反斜杠分隔符时报错', () => {
    const r = parseGroups(block("- { id: g, members: ['src\\core\\a.ts'], text: t }"))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].code).toBe('parse.groupMembersBackslash')
    expect(r.errors[0].line).toBe(30)
  })

  it('缺少必填字段时逐条报错', () => {
    const r = parseGroups(block('- { id: g }'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    const msgs = r.errors.map(e => e.message).join(' | ')
    expect(msgs).toContain('members')
    expect(msgs).toContain('text')
  })

  it('未知字段被拒绝', () => {
    const r = parseGroups(block('- { id: g, members: [a.ts], text: t, colour: red }'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatchObject({ code: 'parse.groupUnknownField', params: { id: 'g', field: 'colour' } })
  })

  it('非法 severity 被拒绝', () => {
    const r = parseGroups(block('- { id: g, members: [a.ts], text: t, severity: fatal }'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatchObject({ code: 'parse.groupSeverityInvalid', params: { id: 'g' } })
  })

  it('多行块式分组的错误行号指向该分组起始行', () => {
    const r = parseGroups(block([
      '- id: a',        // 30
      '  members: [x]', // 31
      '  text: ok',     // 32
      '- id: b',        // 33
      '  members: [y]', // 34
    ].join('\n')))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].line).toBe(33)
  })
})
