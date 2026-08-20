import { describe, it, expect } from 'vitest'
import { merge } from './merge.js'
import { rollupDirStates } from './git.js'
import type { ActualNode, GitState, GitStates, Spec, SpecNode, ViewNode } from './types.js'

const dir = (name: string, path: string, children?: ActualNode[]): ActualNode =>
  children === undefined ? { name, path, kind: 'dir' } : { name, path, kind: 'dir', children }
const file = (name: string, path: string): ActualNode => ({ name, path, kind: 'file' })

const sdir = (name: string, children: SpecNode[] = [], extra: Partial<SpecNode> = {}): SpecNode =>
  ({ name, isDir: true, children, ...extra })

const spec = (nodes: SpecNode[]): Spec => ({
  version: 1, root: '.', ownership: 'human', lang: 'zh', title: '', preamble: [],
  nodes, templates: [], rules: [], groups: [],
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

  // 复现 2026-08-20 的真 bug：用户右键新建的空契约目录（spec-only、没有声明任何子节点）
  // 曾经拿到 children === undefined，而 react-arborist（Tree.tsx 的 childrenAccessor）
  // 把 undefined 一律当叶子——叶子不能接收拖入的节点，于是"新建目录"这个功能建完之后
  // 什么都放不进去。spec-only 目录在磁盘上根本不存在，它的子结构完全由 spec 决定，
  // 没有声明子节点就是"确知为空"，不是"还没问过磁盘"——必须给一个真实的空数组。
  it('spec-only 空目录 children 为 []（可被拖入），而不是 undefined', () => {
    const actual = dir('r', '', [dir('src', 'src', [])])
    const s = spec([sdir('src', [sdir('cases', [])])]) // src/cases 是 spec-only 空目录
    const v = merge(actual, NO_GIT, s)
    const cases = find(v, 'src/cases')
    expect(cases.origin).toBe('spec-only')
    expect(cases.children).toEqual([])
  })

  // 磁盘上真实存在的空目录早就是 children: []（fromActual 里 [] 在 JS 是真值，
  // `if (children) v.children = children` 会命中）。这条用例钉住"两类空目录行为一致"
  // 这个验收标准本身：spec-only 空目录与磁盘空目录必须拿到同样形状的 children。
  it('spec-only 空目录与磁盘上真实存在的空目录，children 形状一致（都是 []）', () => {
    const actual = dir('r', '', [dir('real-empty', 'real-empty', [])])
    const s = spec([sdir('spec-only-empty', [])])
    const v = merge(actual, NO_GIT, s)
    expect(find(v, 'real-empty').children).toEqual([])
    expect(find(v, 'spec-only-empty').children).toEqual([])
  })

  // 护栏用例，防止把上面的修复做过头。unscanned 与 spec-only 都可能出现
  // "s.children.length === 0"，但语义完全不同：spec-only 的父目录**已经**扫描过磁盘，
  // 这个节点在磁盘上确实不存在，children 因此是"确知空"；unscanned 恰恰相反——它是
  // 父目录**还没**扫描到的地方提前物化出来的 spec 结构，我们根本不知道它在磁盘上是否
  // 真的存在、更不知道它下面有什么。undefined 在这里必须保留"还没问过磁盘，点开再问"
  // 这层含义（Tree.tsx 的 onToggle 正是靠 children === undefined 触发 onExpand 去真扫描）。
  // 如果这条用例也被"修"成 []，UI 会误以为已经问过磁盘、答案是空，从而失去继续往下
  // 问的机会——这正是本条要防的"修过头"。
  it('unscanned 目录（父目录尚未扫描）的 children 仍是 undefined，不会被误判为"确知空"', () => {
    const actual = dir('r', '', [dir('src', 'src')]) // src.children undefined —— 尚未扫描
    const s = spec([sdir('src', [sdir('core', [])])]) // src/core 声明为空目录，但父目录未扫描
    const v = merge(actual, NO_GIT, s)
    const core = find(v, 'src/core')
    expect(core.origin).toBe('unscanned')
    expect(core.children).toBeUndefined()
  })

  // 把上面两条串成一条幂等链路：同一个节点，扫描前是 unscanned + undefined
  // （不确知），扫描后磁盘证实它不存在 → 落地为 spec-only + []（确知空）。
  // 这正是 merge 对"actual 侧缺失分支"必须幂等的具体体现：只作用于已加载的那部分树，
  // 展开后用新的 actual 重新合成即可得到确定结果，不依赖任何遗留状态。
  it('展开后重新合成：原本 unscanned 的空声明目录，磁盘扫描证实不存在后落地为 spec-only 且 children 变为 []', () => {
    const s = spec([sdir('src', [sdir('core', [])])])
    const before = merge(dir('r', '', [dir('src', 'src')]), NO_GIT, s) // src 尚未扫描
    expect(find(before, 'src/core').origin).toBe('unscanned')
    expect(find(before, 'src/core').children).toBeUndefined()

    // 用户展开 src 触发真实扫描：磁盘上 src 存在但是空的（core 目录并不存在）
    const after = merge(dir('r', '', [dir('src', 'src', [])]), NO_GIT, s)
    expect(find(after, 'src/core').origin).toBe('spec-only')
    expect(find(after, 'src/core').children).toEqual([])
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

const specG = (nodes: SpecNode[], groups: Spec['groups']): Spec => ({
  version: 1, root: '.', ownership: 'human', lang: 'zh', title: '', preamble: [],
  nodes, templates: [], rules: [], groups,
})

describe('merge 的分组派生', () => {
  it('磁盘上存在的成员会带上 groups', () => {
    const actual = dir('r', '', [file('a.ts', 'a.ts'), file('b.ts', 'b.ts')])
    const v = merge(actual, NO_GIT, specG([], [
      { id: 'g1', members: ['a.ts'], text: 't' },
    ]))
    expect(find(v, 'a.ts').groups).toEqual(['g1'])
    expect(find(v, 'b.ts').groups).toBeUndefined()
  })

  it('一个节点可属于多个分组，顺序与文件中一致', () => {
    const actual = dir('r', '', [file('a.ts', 'a.ts')])
    const v = merge(actual, NO_GIT, specG([], [
      { id: 'g1', members: ['a.ts'], text: 't1' },
      { id: 'g2', members: ['a.ts'], text: 't2' },
    ]))
    expect(find(v, 'a.ts').groups).toEqual(['g1', 'g2'])
  })

  it('成员在磁盘上不存在时仍作为 spec-only 节点出现并带 groups', () => {
    const actual = dir('r', '', [])
    const v = merge(actual, NO_GIT, specG(
      [sdir('docs', [{ name: 'plan.md', isDir: false, children: [] }])],
      [{ id: 'g1', members: ['docs/plan.md'], text: 't' }],
    ))
    expect(find(v, 'docs/plan.md').origin).toBe('spec-only')
    expect(find(v, 'docs/plan.md').groups).toEqual(['g1'])
  })

  it('分组成员指向根节点时不会崩', () => {
    const v = merge(dir('r', '', []), NO_GIT, specG([], [
      { id: 'g1', members: [''], text: 't' },
    ]))
    expect(v.groups).toEqual(['g1'])
  })

  it('merge 仍然不修改入参', () => {
    const groups = [{ id: 'g1', members: ['a.ts'], text: 't' }]
    const s = specG([], groups)
    merge(dir('r', '', [file('a.ts', 'a.ts')]), NO_GIT, s)
    expect(s.groups).toBe(groups)
    expect(groups[0].members).toEqual(['a.ts'])
  })

  // 这条钉的是 merge **输出契约**的一面：ViewNode.groups 归该节点私有，下游（UI）可以就地改。
  //
  // 它的前身叫"不同节点的 groups 数组互不共享引用"，夹具里 a.ts 属 g1、b.ts 属 g2 ——
  // 两条 path、两份互不相干的内容，indexGroups 本来就各建一个新数组，那条用例因此**空转**：
  // 删掉 applyGroups 里的 [...ids]，core 全量 245 条照样全绿（已实测）。名字听着在替那层
  // 拷贝担保，实则什么也没证明，是本项目第 7 次同类问题。
  //
  // 现在两条 path 归属同一个分组，内容相同——这才踩到真正的危险区：把"内容相同的 id 列表
  // 折叠成同一个引用"是 indexGroups 上一个看着无害的优化，一旦它和"去掉 [...ids]"同时发生，
  // 这条就红。诚实说明它的边界：**单点变异仍判不红**（两处各自留一处拷贝就够安全），
  // 它守的是这一对改动的组合，以及 merge 交出去的那条契约本身。
  it('内容相同的两条路径各自持有独立的 groups 数组，改一处不会串到另一处', () => {
    const actual = dir('r', '', [file('a.ts', 'a.ts'), file('b.ts', 'b.ts')])
    const v = merge(actual, NO_GIT, specG([], [
      { id: 'g1', members: ['a.ts', 'b.ts'], text: 't1' },
    ]))
    const a = find(v, 'a.ts')
    const b = find(v, 'b.ts')
    a.groups!.push('intruder')
    expect(b.groups).toEqual(['g1'])
  })
})

describe('merge 的 disk 视图模式（原始结构，忽略契约里的结构性重排）', () => {
  it('disk 模式下只按磁盘扫描结果建树：契约声明但磁盘没有的节点（spec-only）不出现', () => {
    const actual = dir('r', '', [dir('src', 'src', [])])
    const s = spec([
      sdir('src', [], { annotation: '核心源码' }),
      sdir('docs', [sdir('specs', [], { annotation: '设计文档' })]), // 磁盘上不存在
    ])
    const v = merge(actual, NO_GIT, s, undefined, 'disk')
    expect(() => find(v, 'docs')).toThrow()
    expect(find(v, 'src').origin).toBe('both')
    expect(find(v, 'src').annotation).toBe('核心源码')
  })

  it('disk 模式下磁盘有、契约无 → actual-only 且无注释', () => {
    const actual = dir('r', '', [file('README.md', 'README.md')])
    const v = merge(actual, NO_GIT, spec([]), undefined, 'disk')
    const n = find(v, 'README.md')
    expect(n.origin).toBe('actual-only')
    expect(n.annotation).toBeUndefined()
  })

  // 规则 3：节点被"移动"后，契约里的路径变了，但磁盘上的文件从未真的移动（本工具
  // 绝不 mv 文件）。disk 视图必须显示出这个错位：旧路径上文件仍在、但契约里已经没有
  // 同路径的节点了，所以必须显示为"无标注"——这本身就是"它被移动过"的诚实信号，
  // 不应该试图把注释跟过去（那样反而会掩盖移动发生过的事实）。
  it('节点被移动后，旧路径在 disk 视图里显示为无标注，新路径完全不出现（磁盘上没有）', () => {
    // 模拟 Session.move 之后的 spec 形态：examples/foo 已从 spec 里摘掉、改挂到
    // src/cases/foo 下；但磁盘扫描（actual）仍然在旧路径 examples/foo 看到这个目录。
    const actual = dir('r', '', [dir('examples', 'examples', [dir('foo', 'examples/foo', [])])])
    const s = spec([sdir('src', [sdir('cases', [sdir('foo', [], { annotation: '案例' })])])])
    const v = merge(actual, NO_GIT, s, undefined, 'disk')
    const foo = find(v, 'examples/foo')
    expect(foo.origin).toBe('actual-only')
    expect(foo.annotation).toBeUndefined()
    expect(() => find(v, 'src/cases/foo')).toThrow()
  })

  // 规则 2 的核心测试。夹具必须真的有一个被拖走的节点、且它的旧位置真的在 hidden
  // 集合里——否则"忽略不忽略 hidden"在断言上没有任何区分力（本项目记录过多次这种
  // 空转的假绿用例）。这里先用 spec 模式的既有行为确认这份 hidden 夹具确实生效
  // （examples/foo 被吞掉），再验证 disk 模式下同一份 hidden 必须被完全无视。
  it('disk 模式必须忽略 hidden 集合：被拖走的旧位置在磁盘视图里仍然可见', () => {
    const actual = dir('r', '', [dir('examples', 'examples', [dir('foo', 'examples/foo', [])])])
    const s = spec([sdir('src', [sdir('cases', [sdir('foo', [], { annotation: '案例' })])])])
    const hidden = new Set(['examples/foo'])

    const specView = merge(actual, NO_GIT, s, hidden, 'spec')
    expect(() => find(specView, 'examples/foo')).toThrow() // 对照：spec 模式下确实被吞掉

    const diskView = merge(actual, NO_GIT, s, hidden, 'disk')
    expect(find(diskView, 'examples/foo').origin).toBe('actual-only')
  })

  it('disk 模式下分组仍按路径匹配（与 spec 模式共用同一套按路径索引，天然满足规则 3）', () => {
    const actual = dir('r', '', [file('a.ts', 'a.ts')])
    const v = merge(actual, NO_GIT, specG([], [{ id: 'g1', members: ['a.ts'], text: 't' }]), undefined, 'disk')
    expect(find(v, 'a.ts').groups).toEqual(['g1'])
  })

  it('disk 模式对"actual 侧缺失分支"幂等：未扫描目录不产出任何 spec 合成节点', () => {
    const s = spec([sdir('src', [sdir('core', [], { annotation: '内核' })])])
    const before = merge(dir('r', '', [dir('src', 'src')]), NO_GIT, s, undefined, 'disk') // src.children undefined
    expect(find(before, 'src').children).toBeUndefined()

    const after = merge(dir('r', '', [dir('src', 'src', [dir('core', 'src/core', [])])]), NO_GIT, s, undefined, 'disk')
    expect(find(after, 'src/core').origin).toBe('both')
    expect(find(after, 'src/core').annotation).toBe('内核')
  })

  it('disk 模式下 git 状态、truncated、unreadable 仍然透传', () => {
    const actual: ActualNode = {
      name: 'r', path: '', kind: 'dir',
      children: [
        { name: 'big', path: 'big', kind: 'dir', children: [], truncated: true },
        { name: 'a.txt', path: 'a.txt', kind: 'file' },
      ],
    }
    const git: GitStates = new Map([['a.txt', 'modified']])
    const v = merge(actual, git, spec([]), undefined, 'disk')
    expect(find(v, 'big').truncated).toBe(true)
    expect(find(v, 'a.txt').gitState).toBe('modified')
  })

  it('mode 默认值仍是 spec：不传第五个参数时行为与改动前完全一致（向后兼容）', () => {
    const actual = dir('r', '', [])
    const s = spec([sdir('docs', [], { annotation: '文档' })])
    const v = merge(actual, NO_GIT, s) // 只传 3 个参数
    expect(find(v, 'docs').origin).toBe('spec-only')
  })
})

describe('merge —— 目录跟着子树的 git 状态着色', () => {
  const rolled = (entries: [string, GitState][]): GitStates => rollupDirStates(new Map(entries))

  it('git 状态落在尚未扫描到的深层文件上时，浅层祖先目录仍然着色', () => {
    // 首屏只扫 DEFAULT_DEPTH=2 层：src/deep 已经在树上，但它的 children 是 undefined，
    // src/deep/very/nested/file.ts 根本不存在于这棵树里。所以聚合绝不能靠遍历已扫描的
    // 子树来算——只能从 gitStatus() 那张覆盖整个仓库的 Map 上滚祖先链。
    const actual = dir('r', '', [dir('src', 'src', [dir('deep', 'src/deep')])])
    const git = rolled([['src/deep/very/nested/file.ts', 'modified']])
    const v = merge(actual, git, spec([]))

    // 夹具自检：确认扫描边界确实在 src/deep，深层文件确实不在树上
    expect(find(v, 'src/deep').children).toBeUndefined()
    expect(() => find(v, 'src/deep/very')).toThrow()

    expect(find(v, 'src').gitState).toBe('modified')
    expect(find(v, 'src/deep').gitState).toBe('modified')
  })

  it('对未扫描分支仍然幂等：展开一层后重新合成，已着色的祖先不变、新露出的层级跟着着色', () => {
    const git = rolled([['src/deep/very/nested/file.ts', 'modified']])

    const before = merge(dir('r', '', [dir('src', 'src', [dir('deep', 'src/deep')])]), git, spec([]))
    expect(find(before, 'src').gitState).toBe('modified')
    expect(find(before, 'src/deep').gitState).toBe('modified')

    const after = merge(
      dir('r', '', [dir('src', 'src', [dir('deep', 'src/deep', [dir('very', 'src/deep/very')])])]),
      git, spec([]),
    )
    expect(find(after, 'src').gitState).toBe('modified')
    expect(find(after, 'src/deep').gitState).toBe('modified')
    expect(find(after, 'src/deep/very').gitState).toBe('modified')
  })
})
