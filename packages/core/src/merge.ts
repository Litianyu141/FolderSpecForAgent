import type { ActualNode, GitStates, Group, NodeOrigin, Spec, SpecNode, ViewNode } from './types.js'

const NO_HIDDEN: ReadonlySet<string> = new Set()

export function merge(
  actual: ActualNode,
  git: GitStates,
  spec: Spec,
  hidden: ReadonlySet<string> = NO_HIDDEN,
): ViewNode {
  const groupsByPath = indexGroups(spec.groups)
  const root: ViewNode = { name: actual.name, path: actual.path, isDir: true, origin: 'both' }
  applyGroups(root, groupsByPath)
  if (actual.truncated) root.truncated = true
  if (actual.unreadable) root.unreadable = true
  const children = mergeChildren(actual.path, actual.children, spec.nodes, git, hidden, groupsByPath)
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

// [...ids] 是必要的：直接赋值会让多个 ViewNode 共享同一个数组引用，
// 该数组来自本次 merge() 内部的 groupsByPath 索引；一旦下游（UI）就地修改
// 某个节点的 groups，就可能连带影响其他持有同一引用的节点。
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
): ViewNode[] | undefined {
  // 该目录尚未扫描：spec 子节点原样物化为 unscanned，等展开后重新合成
  if (actualKids === undefined) {
    if (specKids.length === 0) return undefined
    return sortView(specKids
      .map(s => fromSpec(parentPath, s, 'unscanned', git, hidden, groupsByPath))
      .filter((v): v is ViewNode => v !== null))
  }

  const bySpecName = new Map(specKids.map(s => [s.name, s]))
  const out: ViewNode[] = []

  for (const a of actualKids) {
    if (hidden.has(a.path)) {
      bySpecName.delete(a.name)
      continue
    }
    const s = bySpecName.get(a.name)
    if (s) bySpecName.delete(a.name)
    out.push(fromActual(a, s, git, hidden, groupsByPath))
  }

  for (const s of bySpecName.values()) {
    const v = fromSpec(parentPath, s, 'spec-only', git, hidden, groupsByPath)
    if (v) out.push(v)
  }

  return sortView(out)
}

function fromActual(
  a: ActualNode,
  s: SpecNode | undefined,
  git: GitStates,
  hidden: ReadonlySet<string>,
  groupsByPath: Map<string, string[]>,
): ViewNode {
  const v: ViewNode = {
    name: a.name,
    path: a.path,
    isDir: a.kind === 'dir',
    origin: s ? 'both' : 'actual-only',
  }
  const g = git.get(a.path)
  if (g) v.gitState = g
  if (a.truncated) v.truncated = true
  if (a.unreadable) v.unreadable = true
  applySpecFields(v, s)
  applyGroups(v, groupsByPath)

  if (a.kind === 'dir') {
    const children = mergeChildren(a.path, a.children, s?.children ?? [], git, hidden, groupsByPath)
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

  if (s.isDir && s.children.length > 0) {
    const kids = s.children
      .map(c => fromSpec(path, c, origin, git, hidden, groupsByPath))
      .filter((c): c is ViewNode => c !== null)
    v.children = sortView(kids)
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
