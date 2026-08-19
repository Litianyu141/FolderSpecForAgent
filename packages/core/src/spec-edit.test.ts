import { describe, it, expect } from 'vitest'
import { emptySpec, moveNode, setAnnotation } from './spec-edit.js'
import type { Spec, SpecNode } from './types.js'

const find = (nodes: SpecNode[], path: string): SpecNode | null => {
  const segs = path.split('/')
  let list = nodes
  let node: SpecNode | null = null
  for (const seg of segs) {
    node = list.find(n => n.name === seg) ?? null
    if (!node) return null
    list = node.children
  }
  return node
}

describe('setAnnotation', () => {
  it('为深层路径写注释时自动创建祖先目录节点', () => {
    const s = setAnnotation(emptySpec(), 'src/core/walk.ts', false, { annotation: '遍历入口' })
    expect(find(s.nodes, 'src')?.isDir).toBe(true)
    expect(find(s.nodes, 'src/core')?.isDir).toBe(true)
    const leaf = find(s.nodes, 'src/core/walk.ts')
    expect(leaf?.isDir).toBe(false)
    expect(leaf?.annotation).toBe('遍历入口')
  })

  it('不修改传入的 spec（返回新对象）', () => {
    const before = emptySpec()
    const after = setAnnotation(before, 'src', true, { annotation: 'x' })
    expect(before.nodes).toEqual([])
    expect(after.nodes).toHaveLength(1)
  })

  it('去除注释首尾空白', () => {
    const s = setAnnotation(emptySpec(), 'src', true, { annotation: '  有空白  ' })
    expect(find(s.nodes, 'src')?.annotation).toBe('有空白')
  })

  it('设置 role 与 severity', () => {
    const s = setAnnotation(emptySpec(), 'src', true, { role: 'source-root', severity: 'error' })
    expect(find(s.nodes, 'src')?.role).toBe('source-root')
    expect(find(s.nodes, 'src')?.severity).toBe('error')
  })

  it('未提供的字段保持不变', () => {
    let s = setAnnotation(emptySpec(), 'src', true, { annotation: 'a', role: 'r' })
    s = setAnnotation(s, 'src', true, { annotation: 'b' })
    expect(find(s.nodes, 'src')?.role).toBe('r')
    expect(find(s.nodes, 'src')?.annotation).toBe('b')
  })

  it('传 null 清除字段', () => {
    let s = setAnnotation(emptySpec(), 'src', true, { annotation: 'a', role: 'r' })
    s = setAnnotation(s, 'src', true, { role: null })
    expect(find(s.nodes, 'src')?.role).toBeUndefined()
    expect(find(s.nodes, 'src')?.annotation).toBe('a')
  })

  it('传空字符串等同清除', () => {
    let s = setAnnotation(emptySpec(), 'src', true, { annotation: 'a' })
    s = setAnnotation(s, 'src', true, { annotation: '   ' })
    expect(find(s.nodes, 'src')).toBeNull()
  })

  it('清空后沿路径回收变空的祖先', () => {
    let s = setAnnotation(emptySpec(), 'src/core/walk.ts', false, { annotation: 'x' })
    s = setAnnotation(s, 'src/core/walk.ts', false, { annotation: null })
    expect(s.nodes).toEqual([])
  })

  it('清空时不回收仍有内容的祖先', () => {
    let s = setAnnotation(emptySpec(), 'src', true, { annotation: '源码' })
    s = setAnnotation(s, 'src/core/walk.ts', false, { annotation: 'x' })
    s = setAnnotation(s, 'src/core/walk.ts', false, { annotation: null })
    expect(find(s.nodes, 'src')?.annotation).toBe('源码')
    expect(find(s.nodes, 'src/core')).toBeNull()
  })
})

describe('moveNode', () => {
  it('把 spec 中已有的节点连同子树移到新父级下', () => {
    let s = setAnnotation(emptySpec(), 'examples/foo', true, { annotation: '一个案例' })
    s = setAnnotation(s, 'examples/foo/input.json', false, { annotation: '输入' })
    s = moveNode(s, 'examples/foo', 'src/cases', true)
    expect(find(s.nodes, 'examples')).toBeNull()
    expect(find(s.nodes, 'src/cases/foo')?.annotation).toBe('一个案例')
    expect(find(s.nodes, 'src/cases/foo/input.json')?.annotation).toBe('输入')
  })

  it('移动 spec 中尚不存在的节点时，在目标位置声明它', () => {
    const s = moveNode(emptySpec(), 'examples/foo', 'src/cases', true)
    const moved = find(s.nodes, 'src/cases/foo')
    expect(moved).not.toBeNull()
    expect(moved?.isDir).toBe(true)
  })

  it('移动产生的空节点不被回收', () => {
    let s = moveNode(emptySpec(), 'examples/foo', 'src/cases', true)
    // 对无关路径做一次编辑，确认移动结果仍在
    s = setAnnotation(s, 'docs', true, { annotation: '文档' })
    expect(find(s.nodes, 'src/cases/foo')).not.toBeNull()
  })

  it('移到根下（toParent 为空字符串）', () => {
    let s = setAnnotation(emptySpec(), 'src/cases/foo', true, { annotation: 'x' })
    s = moveNode(s, 'src/cases/foo', '', true)
    expect(find(s.nodes, 'foo')?.annotation).toBe('x')
    expect(find(s.nodes, 'src')).toBeNull()
  })

  it('目标下已有同名节点时合并，被移动方的字段优先', () => {
    let s = setAnnotation(emptySpec(), 'src/cases/foo', true, { annotation: '旧的', role: 'keep-me' })
    s = setAnnotation(s, 'examples/foo', true, { annotation: '新的' })
    s = moveNode(s, 'examples/foo', 'src/cases', true)
    expect(find(s.nodes, 'src/cases/foo')?.annotation).toBe('新的')
    expect(find(s.nodes, 'src/cases/foo')?.role).toBe('keep-me')
  })

  it('移动后回收源路径上变空的祖先', () => {
    let s = setAnnotation(emptySpec(), 'a/b/c', true, { annotation: 'x' })
    s = moveNode(s, 'a/b/c', 'z', true)
    expect(find(s.nodes, 'a')).toBeNull()
    expect(find(s.nodes, 'z/c')?.annotation).toBe('x')
  })

  it('拒绝把节点移进它自己的子树', () => {
    const s = setAnnotation(emptySpec(), 'a/b', true, { annotation: 'x' })
    expect(() => moveNode(s, 'a', 'a/b', true)).toThrow('不能把节点移动到它自己的子树下')
  })
})

describe('emptySpec', () => {
  it('带上给 Agent 的声明式引言', () => {
    const s: Spec = emptySpec()
    expect(s.version).toBe(1)
    expect(s.ownership).toBe('human')
    expect(s.preamble.join('\n')).toContain('Agent 不应自行修改本文件')
    expect(s.nodes).toEqual([])
  })
})
