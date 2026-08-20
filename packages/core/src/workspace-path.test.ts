import { describe, it, expect } from 'vitest'
import { normalizeWorkspacePath, resolveWithinWorkspace } from './workspace-path.js'
import { specError } from './errors.test-support.js'

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
    // 连 params.path 一起断：只对 code，报错指着另一条路径也照样绿
    expect(() => normalizeWorkspacePath('../etc')).toThrow(specError('path.parentSegment', { path: '"../etc"' }))
    expect(() => normalizeWorkspacePath('src/../../etc')).toThrow(specError('path.parentSegment', { path: '"src/../../etc"' }))
    expect(() => normalizeWorkspacePath('src/..')).toThrow(specError('path.parentSegment', { path: '"src/.."' }))
  })

  it('不把 ..foo 当成越界', () => {
    expect(normalizeWorkspacePath('src/..foo')).toBe('src/..foo')
  })

  it('拒绝绝对路径', () => {
    expect(() => normalizeWorkspacePath('/etc/passwd')).toThrow(specError('path.notRelative', { path: '"/etc/passwd"' }))
    expect(() => normalizeWorkspacePath('C:\\Windows')).toThrow(specError('path.notRelative', { path: '"C:\\\\Windows"' }))
  })
})

describe('resolveWithinWorkspace', () => {
  // 回归用例：工作区根恰好是文件系统根 '/' 时，`realRoot + sep` 曾经算出 '//'，
  // 导致任何子路径都比不出前缀、被误判成越界。folderspec 的 CLI 接受任意目录参数，
  // `folderspec /` 打得出来，根树也能正常渲染（因为 real !== realRoot 那个短路
  // 覆盖了 subPath === '' 的情形），但底下每一次展开/读取都会被这个 bug 挡住。
  // 直接单测 resolveWithinWorkspace('/', ...)，不依赖真的把 '/' 当工作区跑起 CLI。
  it('工作区根是文件系统根 "/" 时，其下的真实路径不会被误判越界', async () => {
    await expect(resolveWithinWorkspace('/', 'etc/hostname')).resolves.toBe('/etc/hostname')
  })
})
