import { describe, it, expect } from 'vitest'
import { applyClick, matchingGroups, visibleOrderOf } from './selection.js'
import type { Group, ViewNode } from '@folderspec/core/api'

const ORDER = ['a', 'b', 'c', 'd', 'e']
const S = (selected: string[], anchor: string | null = null) => ({ selected, anchor })

describe('applyClick', () => {
  it('普通单击只选中一个并设为锚点', () => {
    expect(applyClick(S(['a', 'b']), 'd', ORDER, { shift: false, ctrl: false }))
      .toEqual({ selected: ['d'], anchor: 'd' })
  })

  it('ctrl 单击切换加入', () => {
    expect(applyClick(S(['a']), 'c', ORDER, { shift: false, ctrl: true }))
      .toEqual({ selected: ['a', 'c'], anchor: 'c' })
  })

  it('ctrl 单击已选中的项则移除', () => {
    expect(applyClick(S(['a', 'c'], 'a'), 'c', ORDER, { shift: false, ctrl: true }))
      .toEqual({ selected: ['a'], anchor: 'c' })
  })

  it('shift 单击选中锚点到目标之间的全部项', () => {
    expect(applyClick(S(['b'], 'b'), 'd', ORDER, { shift: true, ctrl: false }))
      .toEqual({ selected: ['b', 'c', 'd'], anchor: 'b' })
  })

  it('shift 反向同样成立', () => {
    expect(applyClick(S(['d'], 'd'), 'b', ORDER, { shift: true, ctrl: false }))
      .toEqual({ selected: ['b', 'c', 'd'], anchor: 'd' })
  })

  it('没有锚点时 shift 退化为普通单击', () => {
    expect(applyClick(S([], null), 'c', ORDER, { shift: true, ctrl: false }))
      .toEqual({ selected: ['c'], anchor: 'c' })
  })

  it('目标不在可见顺序里时退化为普通单击', () => {
    expect(applyClick(S(['a'], 'a'), 'zz', ORDER, { shift: true, ctrl: false }))
      .toEqual({ selected: ['zz'], anchor: 'zz' })
  })

  it('区间结果按可见顺序排列，不按点击先后', () => {
    const r = applyClick(S(['e'], 'e'), 'a', ORDER, { shift: true, ctrl: false })
    expect(r.selected).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})

describe('matchingGroups', () => {
  const groups: Group[] = [
    { id: 'g1', members: ['a', 'b'], text: 't1' },
    { id: 'g2', members: ['b', 'a'], text: 't2' },
    { id: 'g3', members: ['a'], text: 't3' },
  ]

  it('按集合相等匹配，与顺序无关', () => {
    expect(matchingGroups(['b', 'a'], groups).map(g => g.id)).toEqual(['g1', 'g2'])
  })

  it('成员多一个就不匹配', () => {
    expect(matchingGroups(['a', 'b', 'c'], groups)).toEqual([])
  })

  it('单个成员也能匹配', () => {
    expect(matchingGroups(['a'], groups).map(g => g.id)).toEqual(['g3'])
  })

  it('空选中集不匹配任何分组', () => {
    expect(matchingGroups([], groups)).toEqual([])
  })
})

describe('visibleOrderOf', () => {
  const tree: ViewNode[] = [
    { name: 'a', path: 'a', isDir: true, origin: 'both', children: [
      { name: 'a1', path: 'a/a1', isDir: false, origin: 'both' },
    ] },
    { name: 'b', path: 'b', isDir: false, origin: 'both' },
  ]

  it('展开的目录其子项计入顺序', () => {
    expect(visibleOrderOf(tree, p => p === 'a')).toEqual(['a', 'a/a1', 'b'])
  })

  it('未展开的目录其子项不计入', () => {
    expect(visibleOrderOf(tree, () => false)).toEqual(['a', 'b'])
  })
})
