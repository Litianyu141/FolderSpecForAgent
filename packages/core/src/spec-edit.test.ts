import { describe, it, expect } from 'vitest'
import { createNode, deriveGroupId, deleteGroup, emptySpec, findSpecNode, moveNode, removeNode, setAnnotation, setGroup, setLang } from './spec-edit.js'
import type { Spec, SpecNode } from './types.js'
import { serializeSpec } from './serialize.js'
import { parseSpec } from './parse/index.js'

const find = findSpecNode

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

  it('传空字符串等同清除注释字段——但节点本身若是这次调用之前就有的，不会被连带删掉', () => {
    // 新语义（见 pruneAlong 的说明）：'src' 在这次调用开始前就已经存在（上一次
    // 调用创建的），不会被这次清空连带吃掉；annotation 字段确实被清空，删不删
    // 整个节点是另一回事。
    let s = setAnnotation(emptySpec(), 'src', true, { annotation: 'a' })
    s = setAnnotation(s, 'src', true, { annotation: '   ' })
    expect(find(s.nodes, 'src')).not.toBeNull()
    expect(find(s.nodes, 'src')?.annotation).toBeUndefined()
  })

  it('首次声明就传空白注释：同一次调用里由 ensure() 现造出来的整条链会被完整收回', () => {
    // annotation 全是空白，applyText 会当成"清除"；ensure() 为了够到这个全新路径
    // 顺手新建的 src/core/walk.ts 三层，全部是这次调用自己造出来的半成品——理应
    // 连本带利收回，不留下一截从未被赋予过任何意义、纯属误触的空节点。这是
    // pruneAlong 收紧之后仍然保留的那部分能力：只回收"这次编辑自己新建的"。
    const s = setAnnotation(emptySpec(), 'src/core/walk.ts', false, { annotation: '   ' })
    expect(s.nodes).toEqual([])
  })

  it('清空后不再回收祖先——它们在这次编辑之前就已经存在（新语义：跨调用不做脚手架自动回收）', () => {
    // 旧版本这里期望 s.nodes 变成 []：给 src/core/walk.ts 写注释顺带建出 src、core
    // 两级祖先，再用一次独立调用清空注释，会把整条链回收掉。这个"跨调用回收"
    // 正是 add-node-core-report.md 里 Critical 修复要关掉的那个机制的另一副面孔——
    // 工具分不清"这段是脚手架"还是"这是别的地方明确声明过的节点"，两者在 Spec
    // 里字节相同，只能一律不动"编辑前已存在"的部分。多留一截空目录，远比误删
    // 一条声明安全。
    let s = setAnnotation(emptySpec(), 'src/core/walk.ts', false, { annotation: 'x' })
    s = setAnnotation(s, 'src/core/walk.ts', false, { annotation: null })
    expect(find(s.nodes, 'src')?.isDir).toBe(true)
    expect(find(s.nodes, 'src/core')?.isDir).toBe(true)
    const leaf = find(s.nodes, 'src/core/walk.ts')
    expect(leaf).not.toBeNull()
    expect(leaf?.annotation).toBeUndefined()
  })

  it('清空时不回收仍有内容的祖先；本身空的那段（跨调用）现在也不再被自动回收', () => {
    let s = setAnnotation(emptySpec(), 'src', true, { annotation: '源码' })
    s = setAnnotation(s, 'src/core/walk.ts', false, { annotation: 'x' })
    s = setAnnotation(s, 'src/core/walk.ts', false, { annotation: null })
    expect(find(s.nodes, 'src')?.annotation).toBe('源码')
    // 'core' 是上一次调用（写 walk.ts 注释）创建的，对本次清空调用来说是
    // "编辑前已经存在"，因此不会被本次调用回收，即便它现在同样没有任何自己的内容。
    expect(find(s.nodes, 'src/core')).not.toBeNull()
    expect(find(s.nodes, 'src/core/walk.ts')).not.toBeNull()
  })
})

describe('moveNode', () => {
  it('把 spec 中已有的节点连同子树移到新父级下；被搬空的原父级不再被连带删除', () => {
    let s = setAnnotation(emptySpec(), 'examples/foo', true, { annotation: '一个案例' })
    s = setAnnotation(s, 'examples/foo/input.json', false, { annotation: '输入' })
    s = moveNode(s, 'examples/foo', 'src/cases', true)
    // 'examples' 在这次 move 之前就已经存在（上一次 setAnnotation 创建的），搬走
    // 唯一的子项 foo 之后它变空，但不再被这次移动连带吃掉——moveNode 不再对源
    // 路径做任何祖先回收，见 moveNode 内部注释。
    expect(find(s.nodes, 'examples')).not.toBeNull()
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

  it('移到根下（toParent 为空字符串）；源路径上变空的祖先不再被连带删除', () => {
    let s = setAnnotation(emptySpec(), 'src/cases/foo', true, { annotation: 'x' })
    s = moveNode(s, 'src/cases/foo', '', true)
    expect(find(s.nodes, 'foo')?.annotation).toBe('x')
    expect(find(s.nodes, 'src')).not.toBeNull()
  })

  it('目标下已有同名节点时合并，被移动方的字段优先', () => {
    let s = setAnnotation(emptySpec(), 'src/cases/foo', true, { annotation: '旧的', role: 'keep-me' })
    s = setAnnotation(s, 'examples/foo', true, { annotation: '新的' })
    s = moveNode(s, 'examples/foo', 'src/cases', true)
    expect(find(s.nodes, 'src/cases/foo')?.annotation).toBe('新的')
    expect(find(s.nodes, 'src/cases/foo')?.role).toBe('keep-me')
  })

  it('移动后不再回收源路径上的祖先——它们在这次移动之前就已经存在', () => {
    // 'a'/'b' 是上一次 setAnnotation 调用为了够到 c 顺手建的祖先，对这次 move 调用
    // 来说是"编辑前已经存在"；c 被移走后 a/b 变空，但不再被这次 move 连带吃掉——
    // 理由与 setAnnotation 那几条"新语义"用例一致：工具分不清"脚手架"和"别处
    // 明确声明"，只能一律不动编辑前已有的内容。
    let s = setAnnotation(emptySpec(), 'a/b/c', true, { annotation: 'x' })
    s = moveNode(s, 'a/b/c', 'z', true)
    expect(find(s.nodes, 'a')).not.toBeNull()
    expect(find(s.nodes, 'a/b')).not.toBeNull()
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

describe('isDir 一致性（Finding 1：isDir 与 children 同步）', () => {
  it('序列化再解析应该成功 - 路由穿过文件节点', () => {
    // 这会在修复前失败：b.txt 会有 children 但 isDir: false
    let s = setAnnotation(emptySpec(), 'a/b.txt', false, { annotation: 'x' })
    s = setAnnotation(s, 'a/b.txt/c', false, { annotation: 'y' })

    const serialized = serializeSpec(s)
    const parsed = parseSpec(serialized)
    expect(parsed.ok).toBe(true)
  })

  it('序列化再解析应该成功 - 降级目录为文件', () => {
    // 这会在修复前失败：src 既有子项又被设成 isDir: false
    let s = setAnnotation(emptySpec(), 'src', true, { annotation: 'x' })
    s = setAnnotation(s, 'src/core', false, { annotation: 'y' })
    s = setAnnotation(s, 'src', false, { annotation: 'z' })

    const serialized = serializeSpec(s)
    const parsed = parseSpec(serialized)
    expect(parsed.ok).toBe(true)
  })

  it('序列化再解析应该成功 - mergeInto 文件到目录', () => {
    // 场景 (c)：mergeInto 把文件和已有子项的目录合并
    // 这会在修复前失败：foo 既有子项又被 mergeInto 设成 isDir: false
    let s = setAnnotation(emptySpec(), 'src/cases/foo/inner.txt', false, { annotation: '内部文件' })
    s = setAnnotation(s, 'examples/foo', false, { annotation: '一个文件' })
    s = moveNode(s, 'examples/foo', 'src/cases', false)

    const serialized = serializeSpec(s)
    const parsed = parseSpec(serialized)
    expect(parsed.ok).toBe(true)
  })

  it('ensure 穿过文件节点时把它升级成目录', () => {
    let s = setAnnotation(emptySpec(), 'a/b.txt', false, { annotation: 'x' })
    s = setAnnotation(s, 'a/b.txt/c', false, { annotation: 'y' })

    const btxt = find(s.nodes, 'a/b.txt')
    expect(btxt?.isDir).toBe(true)
    expect(btxt?.annotation).toBe('x')
    expect(find(s.nodes, 'a/b.txt/c')?.annotation).toBe('y')
  })

  it('有子项的目录不会被降级成文件', () => {
    let s = setAnnotation(emptySpec(), 'src', true, { annotation: 'x' })
    s = setAnnotation(s, 'src/core', false, { annotation: 'y' })
    s = setAnnotation(s, 'src', false, { annotation: 'z' })

    const src = find(s.nodes, 'src')
    expect(src?.isDir).toBe(true)
    expect(src?.annotation).toBe('z')
    expect(src?.children.length).toBeGreaterThan(0)
  })

  it('mergeInto 落到已有子项的同名节点上时结果是目录', () => {
    // 目标：src/cases/foo 是目录，有子项 inner.txt
    let s = setAnnotation(emptySpec(), 'src/cases/foo/inner.txt', false, { annotation: '内部文件' })
    // 来源：examples/foo 是文件（不是目录）
    s = setAnnotation(s, 'examples/foo', false, { annotation: '一个文件' })
    // 移动文件到目录，mergeInto 应该保持结果是目录且保留子项
    s = moveNode(s, 'examples/foo', 'src/cases', false)

    const foo = find(s.nodes, 'src/cases/foo')
    expect(foo?.isDir).toBe(true)
    expect(foo?.annotation).toBe('一个文件')
    expect(foo?.children.length).toBeGreaterThan(0)
    expect(find(s.nodes, 'src/cases/foo/inner.txt')?.annotation).toBe('内部文件')
  })

  it('自子树判断不误伤相邻名字', () => {
    const s = setAnnotation(emptySpec(), 'a', true, { annotation: 'x' })

    // a 不在 ab 的子树下
    expect(() => moveNode(s, 'a', 'ab', true)).not.toThrow()

    // ab 不在 a 的子树下
    expect(() => moveNode(s, 'ab', 'a', true)).not.toThrow()

    // a 在 a/b 的子树下——应当抛出
    const s2 = setAnnotation(emptySpec(), 'a/b', true, { annotation: 'x' })
    expect(() => moveNode(s2, 'a', 'a/b', true)).toThrow('不能把节点移动到它自己的子树下')
  })
})

describe('拖拽声明的空节点行为（Finding 2：曾经的已知边界，已被 Critical 修复关闭）', () => {
  it('拖拽声明的空节点，即便后来给它加了子项又清空，也不会被连带回收（曾经的已知边界，现已修复）', () => {
    let s = moveNode(emptySpec(), 'examples/foo', 'src/cases', true)
    // 此刻 src/cases/foo 是一个拖拽声明出来的空节点——它没有 annotation，只有
    // "这里应该有"这句声明本身；这与 createNode() 造出来的节点在 Spec 里字节相同。

    // 为它添加子项（另一次独立的调用）
    s = setAnnotation(s, 'src/cases/foo/readme.md', false, { annotation: 'hi' })
    expect(find(s.nodes, 'src/cases/foo')).not.toBeNull()

    // 清空该子项（又一次独立的调用）
    s = setAnnotation(s, 'src/cases/foo/readme.md', false, { annotation: null })

    // 旧版本这里整条链会被清空——这曾经被本文件当作"已知边界"接受下来，实际
    // 就是 createNode 版 Critical bug 的 moveNode 版最小复现：拖拽声明出来的空
    // 节点被后续一次无关的清空连带删除。现在 'readme.md' 也在这次清空调用开始
    // 之前就已经存在（上一次"写注释"调用创建的），同样不回收——它没有变成 null，
    // 而是留下一条没有 annotation 的裸声明，一路到 'src' 都还在。
    expect(find(s.nodes, 'src/cases/foo')).not.toBeNull()
    expect(find(s.nodes, 'src/cases/foo/readme.md')).not.toBeNull()
    expect(find(s.nodes, 'src/cases/foo/readme.md')?.annotation).toBeUndefined()
  })
})

describe('deriveGroupId', () => {
  it('取最长公共父目录的 basename', () => {
    expect(deriveGroupId(['src/parse/a.ts', 'src/parse/b.ts'], new Set())).toBe('parse')
  })

  it('公共父目录较浅时取较浅的那个', () => {
    expect(deriveGroupId(['src/parse/a.ts', 'src/ui/b.ts'], new Set())).toBe('src')
  })

  it('成员都在根下时回退为 group', () => {
    expect(deriveGroupId(['a.ts', 'b.ts'], new Set())).toBe('group')
  })

  it('单个成员取其父目录名', () => {
    expect(deriveGroupId(['src/parse/a.ts'], new Set())).toBe('parse')
  })

  it('冲突时递增后缀', () => {
    expect(deriveGroupId(['src/parse/a.ts'], new Set(['parse']))).toBe('parse-2')
    expect(deriveGroupId(['src/parse/a.ts'], new Set(['parse', 'parse-2']))).toBe('parse-3')
  })

  it('中文目录名可直接作为 id', () => {
    expect(deriveGroupId(['文档/设计/a.md', '文档/设计/b.md'], new Set())).toBe('设计')
  })
})

describe('setGroup', () => {
  it('新建分组并自动取名，成员按字典序存储', () => {
    const r = setGroup(emptySpec(), null, ['src/parse/z.ts', 'src/parse/a.ts'], { text: '解析层' })
    expect(r.id).toBe('parse')
    expect(r.spec.groups).toEqual([{ id: 'parse', members: ['src/parse/a.ts', 'src/parse/z.ts'], text: '解析层' }])
  })

  it('不修改传入的 spec', () => {
    const before = emptySpec()
    setGroup(before, null, ['a/b.ts'], { text: 'x' })
    expect(before.groups).toEqual([])
  })

  it('按 id 更新既有分组', () => {
    let s = setGroup(emptySpec(), null, ['src/parse/a.ts'], { text: '旧' }).spec
    s = setGroup(s, 'parse', ['src/parse/a.ts', 'src/parse/b.ts'], { text: '新' }).spec
    expect(s.groups).toHaveLength(1)
    expect(s.groups[0].text).toBe('新')
    expect(s.groups[0].members).toEqual(['src/parse/a.ts', 'src/parse/b.ts'])
  })

  it('设置与清除 severity', () => {
    let s = setGroup(emptySpec(), null, ['a/b.ts'], { text: 't', severity: 'error' }).spec
    expect(s.groups[0].severity).toBe('error')
    s = setGroup(s, s.groups[0].id, ['a/b.ts'], { severity: null }).spec
    expect(s.groups[0].severity).toBeUndefined()
  })

  it('清空 text 即删除该分组', () => {
    let s = setGroup(emptySpec(), null, ['a/b.ts'], { text: 't' }).spec
    s = setGroup(s, s.groups[0].id, ['a/b.ts'], { text: '   ' }).spec
    expect(s.groups).toEqual([])
  })

  it('对不存在的分组传空 text 是空操作', () => {
    const s = setGroup(emptySpec(), null, ['a/b.ts'], { text: '' }).spec
    expect(s.groups).toEqual([])
  })

  it('成员去重', () => {
    const r = setGroup(emptySpec(), null, ['a/b.ts', 'a/b.ts'], { text: 't' })
    expect(r.spec.groups[0].members).toEqual(['a/b.ts'])
  })
})

describe('setGroup 改名', () => {
  it('patch.name 把既有分组改成用户指定的名字', () => {
    let s = setAnnotation(emptySpec(), 'src/a.ts', false, { annotation: 'x' })
    const { spec, id } = setGroup(s, null, ['src/a.ts', 'src/b.ts'], { text: '一体' })
    expect(id).toBe('src')
    const r = setGroup(spec, id, ['src/a.ts', 'src/b.ts'], { name: '解析层' })
    expect(r.id).toBe('解析层')
    expect(r.spec.groups.map(g => g.id)).toEqual(['解析层'])
    expect(r.spec.groups[0].text).toBe('一体')
  })

  it('新建时 name 优先于自动取名', () => {
    const r = setGroup(emptySpec(), null, ['src/a.ts'], { name: '我起的名', text: 't' })
    expect(r.id).toBe('我起的名')
  })

  it('改成已被占用的名字时按同样的规则加后缀', () => {
    let { spec } = setGroup(emptySpec(), null, ['src/a.ts'], { name: 'core', text: 't1' })
    const mk = setGroup(spec, null, ['docs/b.md'], { text: 't2' })
    const r = setGroup(mk.spec, mk.id, ['docs/b.md'], { name: 'core' })
    expect(r.id).toBe('core-2')
    expect(r.spec.groups.map(g => g.id).sort()).toEqual(['core', 'core-2'])
  })

  it('改成自己当前的名字不加后缀', () => {
    const { spec, id } = setGroup(emptySpec(), null, ['src/a.ts'], { name: 'core', text: 't' })
    const r = setGroup(spec, id, ['src/a.ts'], { name: 'core' })
    expect(r.id).toBe('core')
    expect(r.spec.groups).toHaveLength(1)
  })

  it('name 为空白串时视为未改名', () => {
    const { spec, id } = setGroup(emptySpec(), null, ['src/a.ts'], { text: 't' })
    const r = setGroup(spec, id, ['src/a.ts'], { name: '   ' })
    expect(r.id).toBe(id)
  })
})

describe('deleteGroup', () => {
  it('按 id 删除', () => {
    const s = setGroup(emptySpec(), null, ['a/b.ts'], { text: 't' }).spec
    expect(deleteGroup(s, s.groups[0].id).groups).toEqual([])
  })

  it('删除不存在的 id 是空操作', () => {
    const s = setGroup(emptySpec(), null, ['a/b.ts'], { text: 't' }).spec
    expect(deleteGroup(s, 'nope').groups).toHaveLength(1)
  })
})

/**
 * removeNode：从契约里撤销一个节点的声明——"不再声明这里应该有它"，不是删除磁盘上
 * 的文件/目录（真正动磁盘的是随后读契约的 Agent，见 CLAUDE.md 铁律 1）。完整语义
 * 推导见 spec-edit.ts 里 removeNode() 上方的注释；这里只钉住具体行为。
 */
describe('removeNode（撤销节点声明，不碰磁盘）', () => {
  it('移除一个没有子节点的叶子声明', () => {
    const s = setAnnotation(emptySpec(), 'README.md', false, { annotation: '说明文档' })
    const after = removeNode(s, 'README.md')
    expect(find(after.nodes, 'README.md')).toBeNull()
  })

  it('不修改传入的 spec（返回新对象）', () => {
    const before = setAnnotation(emptySpec(), 'README.md', false, { annotation: 'x' })
    const after = removeNode(before, 'README.md')
    expect(find(before.nodes, 'README.md')).not.toBeNull()
    expect(find(after.nodes, 'README.md')).toBeNull()
  })

  it('目标节点自己带 annotation/role/severity 不影响移除——移除的正是它自己的声明', () => {
    const s = setAnnotation(emptySpec(), 'src', true, { annotation: '核心源码', role: 'source-root', severity: 'error' })
    const after = removeNode(s, 'src')
    expect(after.nodes).toEqual([])
  })

  it('不能移除根节点', () => {
    expect(() => removeNode(emptySpec(), '')).toThrow('根节点')
  })

  it('路径不存在时是空操作，不报错——与 deleteGroup 对不存在 id 的既有行为一致', () => {
    const s = setAnnotation(emptySpec(), 'src', true, { annotation: 'x' })
    const after = removeNode(s, 'does/not/exist')
    expect(after.nodes).toEqual(s.nodes)
  })

  it('移除一棵纯脚手架子树（子孙都没有任何内容）——整棵子树一并收走', () => {
    let s = emptySpec()
    ;({ spec: s } = createNode(s, '', 'src', true))
    ;({ spec: s } = createNode(s, 'src', 'cases', true))
    ;({ spec: s } = createNode(s, 'src/cases', 'foo', true))
    ;({ spec: s } = createNode(s, 'src/cases/foo', 'bar.ts', false))

    const after = removeNode(s, 'src/cases')
    expect(find(after.nodes, 'src/cases')).toBeNull()
    expect(find(after.nodes, 'src/cases/foo/bar.ts')).toBeNull()
    // 'src' 本身不在被移除的子树里，留作空脚手架——这是可接受的代价（见
    // pruneAlong 的说明：多留一截没人管的空目录，远比错删内容安全），不是本函数
    // 要顺手清理的东西。
    expect(find(after.nodes, 'src')).not.toBeNull()
  })

  it('移除节点后，分组里的成员路径原样保留（悬空成员，不自动清理）', () => {
    const s0 = setAnnotation(emptySpec(), 'src/a.ts', false, { annotation: 'x' })
    const { spec: s } = setGroup(s0, null, ['src/a.ts', 'src/b.ts'], { text: '一起看' })
    const after = removeNode(s, 'src/a.ts')
    expect(after.groups).toHaveLength(1)
    expect(after.groups[0].members).toEqual(['src/a.ts', 'src/b.ts'])
  })
})

/**
 * 红线：removeNode 绝不能无条件级联删除子树。结构区是嵌套列表，移除一个目录节点
 * 必然带走它在 spec.nodes 里嵌套的全部子节点——如果子孙里有任何一个携带用户内容
 * （annotation/role/template/severity），无条件级联就是一次点击丢掉多条用户或
 * Agent 已经写下的声明，正是本工具"唯一能造成的伤害"那条铁律要防的事。这里没有
 * "强制级联"的旁路：想清空整棵子树，必须自底向上对每个带内容的子节点分别调用一次
 * ——每一步都是一次独立、可撤销、用户明确按下的操作（"显式优于隐式"）。
 */
describe('removeNode 红线：子树里有用户内容时拒绝级联删除', () => {
  it('目标节点自身无内容，但直接子节点带注释——拒绝，原 spec 一个字节都不变', () => {
    let s = emptySpec()
    ;({ spec: s } = createNode(s, '', 'src', true))
    s = setAnnotation(s, 'src/cases', true, { annotation: '用户手写的关键说明' })

    expect(() => removeNode(s, 'src')).toThrow()
    // 抛错意味着调用方拿到的还是原来那个 s——重新断言它没被动过，
    // 而不是只看"抛没抛错"这一件事本身。
    expect(find(s.nodes, 'src/cases')?.annotation).toBe('用户手写的关键说明')
  })

  it('隔两层的子孙带内容也会被发现——不能只查直接子节点', () => {
    let s = emptySpec()
    ;({ spec: s } = createNode(s, '', 'src', true))
    ;({ spec: s } = createNode(s, 'src', 'cases', true))
    s = setAnnotation(s, 'src/cases/foo', true, { role: 'fixture' })

    expect(() => removeNode(s, 'src')).toThrow()
    expect(find(s.nodes, 'src/cases/foo')?.role).toBe('fixture')
  })

  it('只有 template/severity（没有 annotation/role）的子孙同样能拦下', () => {
    let s = emptySpec()
    ;({ spec: s } = createNode(s, '', 'src', true))
    s = setAnnotation(s, 'src/cases', false, { severity: 'warning' })

    expect(() => removeNode(s, 'src')).toThrow()
  })

  it('自底向上先移除带内容的子节点，父节点才能被移除——显式级联，不是隐式的', () => {
    let s = emptySpec()
    ;({ spec: s } = createNode(s, '', 'src', true))
    s = setAnnotation(s, 'src/cases', true, { annotation: '说明' })

    expect(() => removeNode(s, 'src')).toThrow()
    s = removeNode(s, 'src/cases')
    const after = removeNode(s, 'src')
    expect(after.nodes).toEqual([])
  })
})

describe('createNode', () => {
  it('在指定父级下声明一个尚不存在的节点，父级链条按需创建', () => {
    const { spec: s, path } = createNode(emptySpec(), 'src/cases', 'input.json', false)
    expect(path).toBe('src/cases/input.json')
    expect(find(s.nodes, 'src')?.isDir).toBe(true)
    expect(find(s.nodes, 'src/cases')?.isDir).toBe(true)
    const leaf = find(s.nodes, 'src/cases/input.json')
    expect(leaf?.isDir).toBe(false)
    expect(leaf?.children).toEqual([])
    // 刚声明的节点不带任何注释——这正是"待创建"的空白状态，不是注释被漏写
    expect(leaf?.annotation).toBeUndefined()
  })

  it('parentPath 为空字符串时在根下新增节点', () => {
    const { spec: s, path } = createNode(emptySpec(), '', 'docs', true)
    expect(path).toBe('docs')
    expect(find(s.nodes, 'docs')?.isDir).toBe(true)
  })

  it('不修改传入的 spec（返回新对象）', () => {
    const before = emptySpec()
    const { spec: after } = createNode(before, '', 'docs', true)
    expect(before.nodes).toEqual([])
    expect(after.nodes).toHaveLength(1)
  })

  it('拒绝同层重名：先声明的节点已占用这个名字', () => {
    const { spec: s } = createNode(emptySpec(), '', 'src', true)
    expect(() => createNode(s, '', 'src', true)).toThrow('src')
  })

  it('判重只看 name、不看 isDir——与解析器的判重键保持一致', () => {
    // parse/structure.ts 对同层重名的判定不看 isDir：merge 用 name 做 key（后一个覆盖
    // 前一个），spec-edit 用 list.find(name) 找第一个——如果 createNode 只在 isDir 也
    // 相同时才报错，会放行一个 `foo` 文件与 `foo/` 目录做兄弟，round-trip 时被解析器拒绝，
    // 用户此后再也存不了盘。
    const { spec: s } = createNode(emptySpec(), '', 'foo', true)
    expect(() => createNode(s, '', 'foo', false)).toThrow()
  })

  it('父级路径穿过已有的文件叶子节点时，把它升级成目录', () => {
    const s = setAnnotation(emptySpec(), 'src', false, { annotation: '曾经是个文件' })
    expect(find(s.nodes, 'src')?.isDir).toBe(false)
    const { spec: after } = createNode(s, 'src', 'inner.ts', false)
    expect(find(after.nodes, 'src')?.isDir).toBe(true)
    expect(find(after.nodes, 'src/inner.ts')?.isDir).toBe(false)
  })

  it('新节点在已有同名兄弟旁边正常追加，不影响其他兄弟', () => {
    let s = setAnnotation(emptySpec(), 'src/core', true, { annotation: '核心' })
    const { spec: after } = createNode(s, 'src', 'utils', true)
    expect(find(after.nodes, 'src/core')?.annotation).toBe('核心')
    expect(find(after.nodes, 'src/utils')?.isDir).toBe(true)
  })
})

/**
 * Critical 修复回归：createNode 声明出来的节点，不能因为后续一次独立的编辑把
 * 别处内容清空／搬走而被连带回收。三条序列对应评审报告 add-node-core-report.md
 * 里真实复现过的 A/B/C（D 需要真实文件系统 + 跨 Session，见 session.test.ts）。
 * 这条红线出在 pruneAlong：它曾经沿路径无条件回收"当前为空"的节点，而
 * createNode 声明出来的节点天生没有 annotation，与 setAnnotation 顺手搭的脚手架
 * 在 Spec 里字节相同——工具分不清"这是声明"还是"这是脚手架"，只能收紧到只回收
 * "这一次调用自己新建的部分"（见 pruneAlong 的说明）。
 */
describe('Critical 修复：createNode 声明的节点不会被后续独立的编辑连带回收', () => {
  it('序列 A：声明 src/cases → 写注释 → 清空注释，声明本身与补出来的父级都必须还在', () => {
    const created = createNode(emptySpec(), 'src', 'cases', true)
    let s = setAnnotation(created.spec, created.path, true, { annotation: '存放测试用例' })
    s = setAnnotation(s, created.path, true, { annotation: null })
    expect(find(s.nodes, 'src')).not.toBeNull()
    expect(find(s.nodes, 'src/cases')).not.toBeNull()
  })

  it('序列 B：声明 docs → 声明 docs/readme.md → 写注释 → 清空，两条声明都必须还在', () => {
    const c1 = createNode(emptySpec(), '', 'docs', true)
    const c2 = createNode(c1.spec, 'docs', 'readme.md', false)
    let s = setAnnotation(c2.spec, c2.path, false, { annotation: '说明文档' })
    s = setAnnotation(s, c2.path, false, { annotation: null })
    expect(find(s.nodes, 'docs')).not.toBeNull()
    expect(find(s.nodes, 'docs/readme.md')).not.toBeNull()
  })

  it('序列 C：声明 docs → 声明 docs/api → 把 api 拖到别处，父级声明 docs 不会被连带删除', () => {
    const c1 = createNode(emptySpec(), '', 'docs', true)
    const c2 = createNode(c1.spec, 'docs', 'api', true)
    const s = moveNode(c2.spec, c2.path, 'elsewhere', true)
    expect(find(s.nodes, 'docs')).not.toBeNull()
    expect(find(s.nodes, 'elsewhere/api')).not.toBeNull()
  })
})

describe('moveNode 与分组成员', () => {
  it('移动节点时同步重写分组成员路径', () => {
    let s = setAnnotation(emptySpec(), 'examples/foo', true, { annotation: 'x' })
    s = setGroup(s, null, ['examples/foo'], { text: '案例' }).spec
    s = moveNode(s, 'examples/foo', 'src/cases', true)
    expect(s.groups[0].members).toEqual(['src/cases/foo'])
  })

  it('重写子树内部的成员路径', () => {
    let s = setAnnotation(emptySpec(), 'examples/foo/input.json', false, { annotation: 'x' })
    s = setGroup(s, null, ['examples/foo/input.json'], { text: '输入' }).spec
    s = moveNode(s, 'examples/foo', 'src/cases', true)
    expect(s.groups[0].members).toEqual(['src/cases/foo/input.json'])
  })

  it('不动与被移动子树无关的成员', () => {
    let s = setAnnotation(emptySpec(), 'other/keep.ts', false, { annotation: 'x' })
    s = setGroup(s, null, ['other/keep.ts'], { text: '保持' }).spec
    s = moveNode(s, 'examples/foo', 'src/cases', true)
    expect(s.groups[0].members).toEqual(['other/keep.ts'])
  })

  it('不动与 from 共享字符串前缀、但不在其子树内的成员（src/core-utils 不是 src/core 的子节点）', () => {
    let s = setAnnotation(emptySpec(), 'src/core', true, { annotation: 'x' })
    s = setGroup(s, null, ['src/core-utils/a.ts'], { text: '工具' }).spec
    s = moveNode(s, 'src/core', 'lib', true)
    expect(s.groups[0].members).toEqual(['src/core-utils/a.ts'])
  })
})

describe('emptySpec 的语言默认值', () => {
  it('不传参数时默认为 zh，标题与导言是中文默认文案', () => {
    const s = emptySpec()
    expect(s.lang).toBe('zh')
    expect(s.title).toBe('仓库结构契约')
    expect(s.preamble).toHaveLength(3)
  })

  it("传 'en' 时标题与导言换成英文默认文案", () => {
    const s = emptySpec('en')
    expect(s.lang).toBe('en')
    expect(s.title).toBe('Repository Structure Contract')
    expect(s.preamble[0]).toContain('structural intent')
  })
})

describe('setLang（切换展示语言：样板文字未改过才跟着换，用户内容一字不动）', () => {
  it('标题与导言仍是切换前语言的默认值时，跟着换成新语言的默认值', () => {
    const s = setLang(emptySpec('zh'), 'en')
    expect(s.lang).toBe('en')
    expect(s.title).toBe('Repository Structure Contract')
    expect(s.preamble[0]).toContain('structural intent')
    expect(s.preamble).toHaveLength(3)
  })

  it('标题被用户改过（哪怕只改了一个字）时，切换语言原样保留——不是恰好等于任一语言默认值的字符串', () => {
    const custom = { ...emptySpec('zh'), title: '仓库结构契约！' }
    // 这个标题必须真的与两种语言的默认值都不相等，断言才有区分力
    expect(custom.title).not.toBe('仓库结构契约')
    expect(custom.title).not.toBe('Repository Structure Contract')
    const after = setLang(custom, 'en')
    expect(after.title).toBe('仓库结构契约！')
    expect(after.lang).toBe('en') // lang 字段本身仍然要换
  })

  it('导言里哪怕只有一句被改过，整段导言原样保留（判据是整段逐字相等，不是逐句）', () => {
    const base = emptySpec('zh')
    const custom: Spec = { ...base, preamble: [...base.preamble] }
    custom.preamble[0] = '本文件声明本仓库的结构意图（这句话被用户改过一个字）。'
    const after = setLang(custom, 'en')
    expect(after.preamble).toEqual(custom.preamble)
  })

  it('反向切换（en → zh）同样遵守未改过才换的规则', () => {
    const s = setLang(emptySpec('en'), 'zh')
    expect(s.title).toBe('仓库结构契约')
    expect(s.preamble).toHaveLength(3)
  })

  it('反向切换时用户改过的英文标题同样原样保留', () => {
    const custom = { ...emptySpec('en'), title: 'My Own Title' }
    const after = setLang(custom, 'zh')
    expect(after.title).toBe('My Own Title')
  })

  it('不修改传入的 spec（返回新对象）', () => {
    const before = emptySpec('zh')
    const after = setLang(before, 'en')
    expect(before.lang).toBe('zh')
    expect(before.title).toBe('仓库结构契约')
    expect(after.lang).toBe('en')
  })

  it('切换到同一种语言是安全的空操作——标题与导言不受影响', () => {
    const s = emptySpec('zh')
    const after = setLang(s, 'zh')
    expect(after.title).toBe(s.title)
    expect(after.preamble).toEqual(s.preamble)
  })
})
