import { describe, it, expect } from 'vitest'
import { GIT_COLOR_VAR, SEVERITY_BADGE, nodeColorVar, isAnnotated } from './colors.js'
import type { ViewNode } from '@folderspec/core/api'

const node = (over: Partial<ViewNode> = {}): ViewNode =>
  ({ name: 'x', path: 'x', isDir: false, origin: 'actual-only', ...over })

describe('colors', () => {
  it('每个 git 状态都有对应的 CSS 变量', () => {
    expect(Object.keys(GIT_COLOR_VAR).sort()).toEqual(
      ['added', 'conflicted', 'deleted', 'ignored', 'modified', 'untracked'],
    )
    expect(GIT_COLOR_VAR.modified).toBe('--fs-git-modified')
  })

  it('三级 severity 各有一个徽标', () => {
    expect(SEVERITY_BADGE).toEqual({ error: '🔴', warning: '🟠', advisory: '🔵' })
  })

  it('有 git 状态时用 git 颜色', () => {
    expect(nodeColorVar(node({ gitState: 'ignored' }))).toBe('var(--fs-git-ignored)')
  })

  it('无 git 状态时不返回颜色', () => {
    expect(nodeColorVar(node())).toBeUndefined()
  })

  it('注释、role、severity 任一存在即视为已标注', () => {
    expect(isAnnotated(node())).toBe(false)
    expect(isAnnotated(node({ annotation: 'x' }))).toBe(true)
    expect(isAnnotated(node({ role: 'core' }))).toBe(true)
    expect(isAnnotated(node({ severity: 'error' }))).toBe(true)
    expect(isAnnotated(node({ template: 'case' }))).toBe(true)
  })
})
