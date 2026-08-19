import { describe, it, expect } from 'vitest'
import { merge } from './merge.js'
import type { ActualNode, GitStates, Spec, SpecNode, ViewNode } from './types.js'

const dir = (name: string, path: string, children?: ActualNode[]): ActualNode =>
  children === undefined ? { name, path, kind: 'dir' } : { name, path, kind: 'dir', children }
const file = (name: string, path: string): ActualNode => ({ name, path, kind: 'file' })

const sdir = (name: string, children: SpecNode[] = [], extra: Partial<SpecNode> = {}): SpecNode =>
  ({ name, isDir: true, children, ...extra })

const spec = (nodes: SpecNode[]): Spec => ({
  version: 1, root: '.', ownership: 'human', title: '', preamble: [],
  nodes, templates: [], rules: [],
})

const find = (n: ViewNode, path: string): ViewNode => {
  if (n.path === path) return n
  for (const c of n.children ?? []) {
    try { return find(c, path) } catch { /* 继续找 */ }
  }
  throw new Error(`未找到 ${path}`)
}

const NO_GIT: GitStates = new Map()

describe('merge', () => {
  it('spec 有 + 磁盘有 → both，并带上注释', () => {
    const actual = dir('r', '', [dir('src', 'src', [])])
    const s = spec([sdir('src', [], { annotation: '核心源码', role: 'source-root' })])
    const v = merge(actual, NO_GIT, s)
    const src = find(v, 'src')
    expect(src.origin).toBe('both')
    expect(src.annotation).toBe('核心源码')
    expect(src.role).toBe('source-root')
  })

  it('spec 有 + 磁盘无 → spec-only', () => {
    const actual = dir('r', '', [])
    const s = spec([sdir('docs', [sdir('specs', [], { annotation: '设计文档' })])])
    const v = merge(actual, NO_GIT, s)
    expect(find(v, 'docs').origin).toBe('spec-only')
    expect(find(v, 'docs/specs').origin).toBe('spec-only')
    expect(find(v, 'docs/specs').annotation).toBe('设计文档')
  })

  it('spec 无 + 磁盘有 → actual-only', () => {
    const actual = dir('r', '', [file('README.md', 'README.md')])
    const v = merge(actual, NO_GIT, spec([]))
    expect(find(v, 'README.md').origin).toBe('actual-only')
  })

  it('目录尚未扫描时 spec 子节点为 unscanned', () => {
    const actual = dir('r', '', [dir('src', 'src')]) // children undefined
    const s = spec([sdir('src', [sdir('core', [], { annotation: '内核' })])])
    const v = merge(actual, NO_GIT, s)
    expect(find(v, 'src').origin).toBe('both')
    expect(find(v, 'src/core').origin).toBe('unscanned')
    expect(find(v, 'src/core').annotation).toBe('内核')
  })

  it('对未扫描分支是幂等的：扫描后重新合成得到确定结果', () => {
    const s = spec([sdir('src', [
      sdir('core', [], { annotation: '内核' }),
      sdir('gone', [], { annotation: '不存在' }),
    ])])
    const before = merge(dir('r', '', [dir('src', 'src')]), NO_GIT, s)
    expect(find(before, 'src/core').origin).toBe('unscanned')
    expect(find(before, 'src/gone').origin).toBe('unscanned')

    const after = merge(dir('r', '', [dir('src', 'src', [dir('core', 'src/core', [])])]), NO_GIT, s)
    expect(find(after, 'src/core').origin).toBe('both')
    expect(find(after, 'src/gone').origin).toBe('spec-only')
  })

  it('附上 git 状态', () => {
    const actual = dir('r', '', [file('a.txt', 'a.txt'), file('b.txt', 'b.txt')])
    const git: GitStates = new Map([['a.txt', 'modified'], ['b.txt', 'ignored']])
    const v = merge(actual, git, spec([]))
    expect(find(v, 'a.txt').gitState).toBe('modified')
    expect(find(v, 'b.txt').gitState).toBe('ignored')
  })

  it('透传 truncated 与 unreadable', () => {
    const actual: ActualNode = {
      name: 'r', path: '', kind: 'dir',
      children: [
        { name: 'big', path: 'big', kind: 'dir', children: [], truncated: true },
        { name: 'secret', path: 'secret', kind: 'dir', children: [], unreadable: true },
      ],
    }
    const v = merge(actual, NO_GIT, spec([]))
    expect(find(v, 'big').truncated).toBe(true)
    expect(find(v, 'secret').unreadable).toBe(true)
  })

  it('子项排序：目录在前，同类按名称，与来源无关', () => {
    const actual = dir('r', '', [file('z.txt', 'z.txt'), dir('m', 'm', [])])
    const s = spec([sdir('a'), { name: 'b.txt', isDir: false, children: [] }])
    const v = merge(actual, NO_GIT, s)
    expect(v.children!.map(c => c.name)).toEqual(['a', 'm', 'b.txt', 'z.txt'])
  })

  it('hidden 集合里的路径不出现在结果中（拖走后的旧位置）', () => {
    const actual = dir('r', '', [dir('examples', 'examples', [dir('foo', 'examples/foo', [])])])
    const s = spec([sdir('src', [sdir('cases', [sdir('foo', [], { annotation: '案例' })])])])
    const v = merge(actual, NO_GIT, s, new Set(['examples/foo']))
    expect(() => find(v, 'examples/foo')).toThrow()
    expect(find(v, 'src/cases/foo').origin).toBe('spec-only')
  })

  it('根节点 path 为空字符串', () => {
    const v = merge(dir('myrepo', '', []), NO_GIT, spec([]))
    expect(v.path).toBe('')
    expect(v.name).toBe('myrepo')
    expect(v.origin).toBe('both')
  })
})
