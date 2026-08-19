import { describe, it, expect, vi } from 'vitest'
import { makeMoveHandler, matchesSearch } from './Tree.js'
import type { ViewNode } from '@folderspec/core/api'

const tree: ViewNode[] = [
  { name: 'src', path: 'src', isDir: true, origin: 'both', children: [
    { name: 'core', path: 'src/core', isDir: true, origin: 'both', children: [] },
  ] },
  { name: 'examples', path: 'examples', isDir: true, origin: 'actual-only', children: [
    { name: 'foo', path: 'examples/foo', isDir: true, origin: 'actual-only', children: [] },
  ] },
  { name: 'README.md', path: 'README.md', isDir: false, origin: 'actual-only' },
]

describe('makeMoveHandler', () => {
  it('把 react-arborist 的 dragIds/parentId 翻译成 move 调用', () => {
    const onMove = vi.fn()
    makeMoveHandler(tree, onMove)({ dragIds: ['examples/foo'], parentId: 'src' })
    expect(onMove).toHaveBeenCalledWith('examples/foo', 'src', true)
  })

  it('parentId 为 null 表示移到根下，toParent 为空字符串', () => {
    const onMove = vi.fn()
    makeMoveHandler(tree, onMove)({ dragIds: ['src/core'], parentId: null })
    expect(onMove).toHaveBeenCalledWith('src/core', '', true)
  })

  it('传递 isDir=false 给文件节点', () => {
    const onMove = vi.fn()
    makeMoveHandler(tree, onMove)({ dragIds: ['README.md'], parentId: 'src' })
    expect(onMove).toHaveBeenCalledWith('README.md', 'src', false)
  })

  it('多选拖拽逐个上报', () => {
    const onMove = vi.fn()
    makeMoveHandler(tree, onMove)({ dragIds: ['src/core', 'README.md'], parentId: 'examples' })
    expect(onMove).toHaveBeenCalledTimes(2)
  })

  it('忽略树里找不到的 id', () => {
    const onMove = vi.fn()
    makeMoveHandler(tree, onMove)({ dragIds: ['ghost'], parentId: 'src' })
    expect(onMove).not.toHaveBeenCalled()
  })
})

describe('matchesSearch', () => {
  const n = (name: string, annotation?: string): ViewNode =>
    ({ name, path: name, isDir: false, origin: 'actual-only', ...(annotation ? { annotation } : {}) })

  it('匹配名称，忽略大小写', () => {
    expect(matchesSearch(n('README.md'), 'readme')).toBe(true)
  })

  it('也匹配注释内容', () => {
    expect(matchesSearch(n('a.ts', '并行遍历入口'), '遍历')).toBe(true)
  })

  it('不匹配时返回 false', () => {
    expect(matchesSearch(n('a.ts'), 'zzz')).toBe(false)
  })

  it('空搜索词一律匹配', () => {
    expect(matchesSearch(n('a.ts'), '')).toBe(true)
  })
})
