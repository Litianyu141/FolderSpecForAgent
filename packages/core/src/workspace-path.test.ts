import { describe, it, expect } from 'vitest'
import { normalizeWorkspacePath } from './workspace-path.js'

describe('normalizeWorkspacePath', () => {
  it('空串归一化为空串（工作区根）', () => {
    expect(normalizeWorkspacePath('')).toBe('')
  })

  it('去掉多余的分隔符与 . 段', () => {
    expect(normalizeWorkspacePath('./src//parse/')).toBe('src/parse')
  })

  it('把反斜杠当作分隔符', () => {
    expect(normalizeWorkspacePath('src\\parse')).toBe('src/parse')
  })

  it('拒绝 .. 段', () => {
    expect(() => normalizeWorkspacePath('../etc')).toThrow(/不得包含 "\.\." 段/)
    expect(() => normalizeWorkspacePath('src/../../etc')).toThrow(/不得包含 "\.\." 段/)
    expect(() => normalizeWorkspacePath('src/..')).toThrow(/不得包含 "\.\." 段/)
  })

  it('不把 ..foo 当成越界', () => {
    expect(normalizeWorkspacePath('src/..foo')).toBe('src/..foo')
  })

  it('拒绝绝对路径', () => {
    expect(() => normalizeWorkspacePath('/etc/passwd')).toThrow(/必须是工作区相对路径/)
    expect(() => normalizeWorkspacePath('C:\\Windows')).toThrow(/必须是工作区相对路径/)
  })
})
