import type { ActualNode, GitStates, Group, NodeOrigin, Spec, SpecNode, ViewMode, ViewNode } from './types.js'

const NO_HIDDEN: ReadonlySet<string> = new Set()

export function merge(
  actual: ActualNode,
  git: GitStates,
  spec: Spec,
  hidden: ReadonlySet<string> = NO_HIDDEN,
  mode: ViewMode = 'spec',
): ViewNode {
  const groupsByPath = indexGroups(spec.groups)
  const root: ViewNode = { name: actual.name, path: actual.path, isDir: true, origin: 'both' }
  applyGroups(root, groupsByPath)
  if (actual.truncated) root.truncated = true
  if (actual.unreadable) root.unreadable = true
  const children = mergeChildren(actual.path, actual.children, spec.nodes, git, hidden, groupsByPath, mode)
  if (children) root.children = children
  return root
}

/** path → 所属分组 id 列表，顺序与 Spec.groups 中的出现顺序一致 */
function indexGroups(groups: readonly Group[]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const g of groups) {
    for (const m of g.members) {
      const list = map.get(m)
      if (list) list.push(g.id)
      else map.set(m, [g.id])
    }
  }
  return map
}

// [...ids] 是**为将来留的余量，不是在防一个当前存在的缺陷**——别把它读成后者。
// 当前调用里不可能共享：groupsByPath 的 key 就是 path，而 merge 对每条路径只物化一个
// ViewNode（fromActual / fromSpec 各生成一次），于是每个 list 至多被读一次。去掉这层拷贝
// 今天一条用例都判不到（已实测：全量 core 245 条照样绿），因为构造不出"两个 ViewNode 同 path"。
// 它守的是将来那一步：一旦有人把 groupsByPath 提到 merge 之外跨调用缓存，直接赋值就会让
// 多次 merge 产出的节点共享同一个数组，下游（UI）就地改一处便串到另一处。
// 结论：留着，但别为它写一条"证明它有用"的用例——那条用例只能是假的。
function applyGroups(v: ViewNode, groupsByPath: Map<string, string[]>): void {
  const ids = groupsByPath.get(v.path)
  if (ids && ids.length > 0) v.groups = [...ids]
}

function mergeChildren(
  parentPath: string,
  actualKids: ActualNode[] | undefined,
  specKids: SpecNode[],
  git: GitStates,
  hidden: ReadonlySet<string>,
  groupsByPath: Map<string, string[]>,
  mode: ViewMode,
): ViewNode[] | undefined {
  // 该目录尚未扫描。spec 模式下把 spec 子节点原样物化为 unscanned，等展开后重新合成；
  // disk 模式不做任何 spec 驱动的合成（下面同一函数里"补上 spec-only 遗留项"那段
  // 也是同一类合成），未扫描就是"还不知道"，不能拿契约声明的结构去猜。
  if (actualKids === undefined) {
    if (mode === 'disk' || specKids.length === 0) return undefined
    return sortView(specKids
      .map(s => fromSpec(parentPath, s, 'unscanned', git, hidden, groupsByPath))
      .filter((v): v is ViewNode => v !== null))
  }

  const bySpecName = new Map(specKids.map(s => [s.name, s]))
  const out: ViewNode[] = []

  for (const a of actualKids) {
    // hidden 记的是「本次会话里被拖走节点的旧位置」，是 spec 模式专属的临时 UI 状态
    // （spec §6.1：拖拽绝不记录"从哪儿来"）。disk 视图存在的全部理由就是诚实地显示
    // 磁盘上真实的样子——如果它也听 hidden 的，刚被拖走的节点在"原始结构"里的旧位置
    // 照样不显示，这个视图就是在撒谎，等于自己废掉自己存在的理由。
    if (mode === 'spec' && hidden.has(a.path)) {
      bySpecName.delete(a.name)
      continue
    }
    const s = bySpecName.get(a.name)
    if (s) bySpecName.delete(a.name)
    out.push(fromActual(a, s, git, hidden, groupsByPath, mode))
  }

  // disk 模式不产出 spec-only 节点：这些节点在磁盘上并不存在，"原始结构"视图只认磁盘。
  if (mode === 'spec') {
    for (const s of bySpecName.values()) {
      const v = fromSpec(parentPath, s, 'spec-only', git, hidden, groupsByPath)
      if (v) out.push(v)
    }
  }

  return sortView(out)
}

function fromActual(
  a: ActualNode,
  s: SpecNode | undefined,
  git: GitStates,
  hidden: ReadonlySet<string>,
  groupsByPath: Map<string, string[]>,
  mode: ViewMode,
): ViewNode {
  const v: ViewNode = {
    name: a.name,
    path: a.path,
    isDir: a.kind === 'dir',
    origin: s ? 'both' : 'actual-only',
  }
  // 目录也查同一张表，且查得到——gitStatus() 已经把文件状态滚到祖先目录上了
  // （见 git.ts 的 rollupDirStates）。这里刻意仍然是**一次精确查表**：聚合绝不能在
  // merge 里算，一来 merge 每次 tree() 都重跑，二来首屏只扫两层，深处的文件根本不在
  // 这棵树上，遍历子树永远聚合不到它们。
  const g = git.get(a.path)
  if (g) v.gitState = g
  if (a.truncated) v.truncated = true
  if (a.unreadable) v.unreadable = true
  // s 是按同一路径逐层匹配到的 spec 节点（bySpecName 在每一级都按 name 对齐，
  // 等价于按完整路径查找）——这就是规则 3「标注按路径挂」：节点被移动后，
  // 它在磁盘上的旧路径与契约里的新路径不再对应同一条 s，自然显示为无标注。
  applySpecFields(v, s)
  applyGroups(v, groupsByPath)

  if (a.kind === 'dir') {
    const children = mergeChildren(a.path, a.children, s?.children ?? [], git, hidden, groupsByPath, mode)
    if (children) v.children = children
  }
  return v
}

function fromSpec(
  parentPath: string,
  s: SpecNode,
  origin: NodeOrigin,
  git: GitStates,
  hidden: ReadonlySet<string>,
  groupsByPath: Map<string, string[]>,
): ViewNode | null {
  const path = parentPath === '' ? s.name : `${parentPath}/${s.name}`
  if (hidden.has(path)) return null

  const v: ViewNode = { name: s.name, path, isDir: s.isDir, origin }
  const g = git.get(path)
  if (g) v.gitState = g
  applySpecFields(v, s)
  applyGroups(v, groupsByPath)

  if (s.isDir) {
    if (s.children.length > 0) {
      const kids = s.children
        .map(c => fromSpec(path, c, origin, git, hidden, groupsByPath))
        .filter((c): c is ViewNode => c !== null)
      v.children = sortView(kids)
    } else if (origin === 'spec-only') {
      // spec-only 目录在磁盘上根本不存在——它能被物化出来，本身就是因为父目录已经
      // 扫描过磁盘、扫描结果里没有这个名字（mergeChildren 的"补上 spec-only 遗留项"
      // 那段）。它的子结构完全由 spec 决定，没有更高权威的磁盘可去问；s.children 为空
      // 就是"确知这里没有子节点"，不是"还没来得及看"。必须给一个真实的空数组 []，
      // 否则 react-arborist（childrenAccessor="children"，见 Tree.tsx）会把 undefined
      // 一律当叶子——叶子既不能展开也不能接收拖入的节点，用户右键新建的空契约目录
      // 建完之后就什么都放不进去（真实复现：2026-08-20 empty-dir-drop 报告，右键
      // 「新建目录（仅契约）」建出 src/cases 后拖 examples/case-alpha 进去，落点被判成
      // src 的同级而不是 cases 的子级）。磁盘上真实存在的空目录在 fromActual 里早就是
      // children: []（[] 在 JS 里是真值，`if (children) v.children = children` 会命中）
      // ——这里补齐的正是让 spec-only 空目录跟它拿到同一种"可放入"的行为，两类空目录
      // 不该有可观测的差别（这也是 merge.test.ts 里专门验证"行为一致"那条用例的由来）。
      v.children = []
    }
    // 剩下唯一会走到这里的分支是 origin === 'unscanned'：children 必须留 undefined，
    // 绝不能套用上面 spec-only 的逻辑改成 []。unscanned 节点是父目录**还没**被磁盘
    // 扫描到时、由 mergeChildren 提前把 spec 结构物化出来的（见上面"该目录尚未扫描"
    // 分支），我们并不知道它在磁盘上是否真的存在、更不知道它下面有没有磁盘独有的
    // 子节点——跟 spec-only 那种"父目录已扫描、明确查无此名"完全是两回事。undefined
    // 必须保留"还没问过磁盘，展开时再去问"这层含义：Tree.tsx 的 onToggle 正是靠
    // `n.children === undefined` 判断要不要调用 onExpand 触发真实扫描；一旦这里也
    // 给了 []，UI 会误以为已经问过磁盘、答案就是空，从而永远失去继续往下问的机会——
    // 展开后重新 merge 时它才会按磁盘结果被重判为 both 或 spec-only，那时才谈得上
    // "确知"（见 merge.test.ts 里把这条链路串起来的幂等用例）。
  }
  return v
}

function applySpecFields(v: ViewNode, s: SpecNode | undefined): void {
  if (!s) return
  if (s.annotation) v.annotation = s.annotation
  if (s.role) v.role = s.role
  if (s.template) v.template = s.template
  if (s.severity) v.severity = s.severity
}

function sortView(nodes: ViewNode[]): ViewNode[] {
  return nodes.sort((a, b) => {
    const ad = a.isDir ? 0 : 1
    const bd = b.isDir ? 0 : 1
    if (ad !== bd) return ad - bd
    return a.name.localeCompare(b.name, 'en')
  })
}
