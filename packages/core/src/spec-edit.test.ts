import { describe, it, expect } from 'vitest'
import { createNode, deriveGroupId, deleteGroup, emptySpec, findSpecNode, moveNode, setAnnotation, setGroup, setLang } from './spec-edit.js'
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

describe('拖拽声明的空节点行为（Finding 2：边界情况）', () => {
  it('拖拽声明的空节点在其自身子树被清空时也会被回收（已知边界）', () => {
    let s = moveNode(emptySpec(), 'examples/foo', 'src/cases', true)
    // 现在 src/cases/foo 是空的拖拽声明

    // 为它添加子项
    s = setAnnotation(s, 'src/cases/foo/readme.md', false, { annotation: 'hi' })
    expect(find(s.nodes, 'src/cases/foo')).not.toBeNull()

    // 清空该子项
    s = setAnnotation(s, 'src/cases/foo/readme.md', false, { annotation: null })

    // 结果：整条链都被清掉，因为没有任何实质内容
    expect(s.nodes).toEqual([])
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
