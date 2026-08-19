import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { makeDisableDrop, makeMoveHandler, matchesSearch } from './Tree.js'
import { NodeRow } from './NodeRow.js'
import type { ViewNode } from '@folderspec/core/api'

// 通过直接渲染 NodeRow 断言多选态的接线，避免依赖虚拟列表——
// 与本文件其余用例（makeMoveHandler/matchesSearch/makeDisableDrop）同样只测抽出的逻辑，
// 不渲染 SpecTree/react-arborist 的虚拟化列表。
const renderRowWithSelection = (data: ViewNode, selectedPaths: string[]) => {
  const node = {
    data,
    isSelected: false,
    isOpen: false,
    isLeaf: !data.isDir,
    level: 0,
    toggle: vi.fn(),
  }
  return render(
    <NodeRow
      node={node as never}
      style={{}}
      dragHandle={undefined}
      tree={{} as never}
      preview={false}
      selectedPaths={selectedPaths}
    />,
  )
}

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

  it('多选拖拽的每次调用参数与 id 顺序一一对应', () => {
    const onMove = vi.fn()
    makeMoveHandler(tree, onMove)({ dragIds: ['src/core', 'README.md'], parentId: 'examples' })
    expect(onMove).toHaveBeenNthCalledWith(1, 'src/core', 'examples', true)
    expect(onMove).toHaveBeenNthCalledWith(2, 'README.md', 'examples', false)
  })

  it('忽略树里找不到的 id', () => {
    const onMove = vi.fn()
    makeMoveHandler(tree, onMove)({ dragIds: ['ghost'], parentId: 'src' })
    expect(onMove).not.toHaveBeenCalled()
  })
})

describe('makeDisableDrop', () => {
  it('允许放到合成的根节点上（react-arborist 顶层拖放目标没有 isDir 字段）', () => {
    // 复刻 react-arborist create-root.js 里合成根节点的 data 形状：只有 id，没有 isDir。
    const rootLike: { data: { id: string; isDir?: boolean } } = { data: { id: '__REACT_ARBORIST_INTERNAL_ROOT__' } }
    expect(makeDisableDrop(false)({ parentNode: rootLike })).toBe(false)
  })

  it('禁止放到文件上', () => {
    expect(makeDisableDrop(false)({ parentNode: { data: { isDir: false } } })).toBe(true)
  })

  it('允许放到目录上', () => {
    expect(makeDisableDrop(false)({ parentNode: { data: { isDir: true } } })).toBe(false)
  })

  it('disabled 为 true 时一律禁止', () => {
    const rootLike: { data: { id: string; isDir?: boolean } } = { data: { id: '__REACT_ARBORIST_INTERNAL_ROOT__' } }
    expect(makeDisableDrop(true)({ parentNode: rootLike })).toBe(true)
    expect(makeDisableDrop(true)({ parentNode: { data: { isDir: false } } })).toBe(true)
    expect(makeDisableDrop(true)({ parentNode: { data: { isDir: true } } })).toBe(true)
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

describe('多选态接线（经 NodeRow 断言，不渲染虚拟列表）', () => {
  it('多选时每个被选中的行都带 data-selected', () => {
    const { container } = renderRowWithSelection(
      { name: 'b', path: 'b', isDir: false, origin: 'actual-only' },
      ['a', 'b'],
    )
    expect(container.querySelector('.fs-row')?.getAttribute('data-selected')).toBe('true')
  })

  it('未被选中的行 data-selected 为 false', () => {
    const { container } = renderRowWithSelection(
      { name: 'c', path: 'c', isDir: false, origin: 'actual-only' },
      ['a', 'b'],
    )
    expect(container.querySelector('.fs-row')?.getAttribute('data-selected')).toBe('false')
  })
})
