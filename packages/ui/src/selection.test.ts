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

  // 锚点自身所在的目录被折叠后，锚点会从 visibleOrder 里消失（目标仍可见）——
  // 这是这个特性存在的理由本身：折叠意味着"看不见"，看不见就不该参与区间计算，
  // 必须退化为普通单击。用一个不含 'a' 的 visibleOrder 直接构造这个状态，
  // 不依赖 applyClick 自己会不会把锚点从 selected 里带出可见序列。
  it('锚点已不在可见序列里（如所在目录被折叠）时退化为普通单击', () => {
    expect(applyClick(S(['a'], 'a'), 'c', ['b', 'c', 'd'], { shift: true, ctrl: false }))
      .toEqual({ selected: ['c'], anchor: 'c' })
  })

  it('shift 单击锚点自身时区间只有该项', () => {
    expect(applyClick(S(['b'], 'b'), 'b', ORDER, { shift: true, ctrl: false }))
      .toEqual({ selected: ['b'], anchor: 'b' })
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

  it('传了 matches 时，未命中的节点不算可见', () => {
    expect(visibleOrderOf(tree, p => p === 'a', n => n.name === 'a1')).toEqual(['a', 'a/a1'])
  })

  it('自己不命中但子孙命中的目录仍然可见——与 react-arborist 的 markMatch 一致', () => {
    // 'a' 自己不叫 a1，但它是命中项的祖先，屏幕上还在，区间必须把它算进去
    expect(visibleOrderOf(tree, p => p === 'a', n => n.name === 'a1')).toContain('a')
  })

  it('目录命中不会顺带把不命中的子项拉进来', () => {
    // 与 markMatch 的方向对齐：标记只往祖先方向传播，不往子孙方向传播
    expect(visibleOrderOf(tree, p => p === 'a', n => n.name === 'a')).toEqual(['a'])
  })
})
