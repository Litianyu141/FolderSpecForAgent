import type { Group, Severity, Spec, SpecNode } from './types.js'

export interface AnnotationPatch {
  annotation?: string | null
  role?: string | null
  template?: string | null
  severity?: Severity | null
}

export function emptySpec(): Spec {
  return {
    version: 1,
    root: '.',
    ownership: 'human',
    title: '仓库结构契约',
    preamble: [
      '本文件声明本仓库的**结构意图**，是长期不变量，不是一次性操作指令。',
      'Agent 应读取本文件、对照实际仓库、自行决定如何变更磁盘。',
      'Agent 不应自行修改本文件；若认为规则不合理，请向人类提出修改建议。',
    ],
    nodes: [],
    templates: [],
    rules: [],
    groups: [],
  }
}

export function setAnnotation(spec: Spec, path: string, isDir: boolean, patch: AnnotationPatch): Spec {
  const segs = toSegments(path)
  if (segs.length === 0) throw new Error('路径不能为空')

  const next = structuredClone(spec)
  const node = ensure(next.nodes, segs, isDir)

  applyText(node, 'annotation', patch.annotation)
  applyText(node, 'role', patch.role)
  applyText(node, 'template', patch.template)
  if (patch.severity !== undefined) {
    if (patch.severity === null) delete node.severity
    else node.severity = patch.severity
  }

  pruneAlong(next.nodes, segs)
  return next
}

/**
 * 在契约里声明一个尚不存在的节点——"这里应该有"，不是"去创建它"（spec §3.2 声明式）。
 * 父级链条复用 setAnnotation 同一套 ensure() 逻辑按需补齐：契约是稀疏覆盖层，只含被
 * 标注节点及其祖先链，不该为了声明一个深层节点就要求调用方先手动把每一级父目录都建出来。
 *
 * 同层重名在这里就地拒绝，不是留给 save() 的自校验去发现：解析器判重的键只有 name（见
 * parse/structure.ts「同一层重名节点」的报错与其上方注释），如果放行创建，下游 merge
 * （用 name→node 的 Map，后一个覆盖前一个）与 spec-edit 的其他函数（用 list.find 命中
 * 第一个）会对"哪一个才算数"给出相反答案；serialize→parse 的自校验会在 save() 时才
 * 中止写入，那时用户已经交互过一整轮，之后再也存不了盘——必须在创建的这一刻就堵死。
 */
export function createNode(spec: Spec, parentPath: string, name: string, isDir: boolean): { spec: Spec; path: string } {
  const parentSegs = toSegments(parentPath)
  const next = structuredClone(spec)
  const siblings = parentSegs.length === 0 ? next.nodes : ensure(next.nodes, parentSegs, true).children

  if (siblings.some(n => n.name === name)) {
    throw new Error(
      `${parentSegs.length === 0 ? '根' : `\`${parentSegs.join('/')}\``} 下已经有同名节点 \`${name}\`：` +
      '同层同名兄弟是重复声明，解析器会拒绝，请换个名字',
    )
  }

  siblings.push({ name, isDir, children: [] })
  const path = parentSegs.length === 0 ? name : `${parentSegs.join('/')}/${name}`
  return { spec: next, path }
}

export function moveNode(spec: Spec, from: string, toParent: string, isDir: boolean): Spec {
  const fromSegs = toSegments(from)
  if (fromSegs.length === 0) throw new Error('不能移动根节点')
  const toSegs = toSegments(toParent)

  const fromPrefix = `${fromSegs.join('/')}/`
  if (`${toSegs.join('/')}/`.startsWith(fromPrefix)) {
    throw new Error('不能把节点移动到它自己的子树下')
  }

  const next = structuredClone(spec)
  const name = fromSegs[fromSegs.length - 1]

  // spec 里没有该节点时，新建一个空节点——它表达"我声明它应该在这里"，本身就是有效数据
  // isDir 参数只在源节点不存在时生效；现有数据优先级高于调用者的声明
  const detached = detach(next.nodes, fromSegs) ?? { name, isDir, children: [] }
  pruneAlong(next.nodes, fromSegs.slice(0, -1))

  const list = toSegs.length === 0 ? next.nodes : ensure(next.nodes, toSegs, true).children
  const existing = list.find(n => n.name === detached.name)
  if (existing) mergeInto(existing, detached)
  else list.push(detached)

  const movedName = fromSegs[fromSegs.length - 1]
  const movedTo = toSegs.length === 0 ? movedName : `${toSegs.join('/')}/${movedName}`
  rewriteGroupMembers(next.groups, fromSegs.join('/'), movedTo)

  return next
}

export function findSpecNode(nodes: SpecNode[], path: string): SpecNode | null {
  let list = nodes
  let node: SpecNode | null = null
  for (const seg of toSegments(path)) {
    node = list.find(n => n.name === seg) ?? null
    if (!node) return null
    list = node.children
  }
  return node
}

// ---------- 内部 ----------

function toSegments(path: string): string[] {
  return path.split('/').filter(s => s !== '')
}

/** 沿路径确保节点存在；缺失的祖先一律按目录创建 */
function ensure(nodes: SpecNode[], segs: string[], lastIsDir: boolean): SpecNode {
  let list = nodes
  let node!: SpecNode
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]
    const isLast = i === segs.length - 1
    let found = list.find(n => n.name === seg)
    if (!found) {
      found = { name: seg, isDir: isLast ? lastIsDir : true, children: [] }
      list.push(found)
    } else if (!isLast) {
      // 要从它下面穿过去，它必然是目录
      found.isDir = true
    } else if (found.isDir !== lastIsDir) {
      // 只有在没有子项时才允许把目录降级成文件
      if (lastIsDir || found.children.length === 0) found.isDir = lastIsDir
    }
    node = found
    list = found.children
  }
  return node
}

function detach(nodes: SpecNode[], segs: string[]): SpecNode | null {
  let list = nodes
  for (let i = 0; i < segs.length - 1; i++) {
    const found = list.find(n => n.name === segs[i])
    if (!found) return null
    list = found.children
  }
  const idx = list.findIndex(n => n.name === segs[segs.length - 1])
  if (idx === -1) return null
  return list.splice(idx, 1)[0]
}

function mergeInto(target: SpecNode, incoming: SpecNode): void {
  if (incoming.annotation) target.annotation = incoming.annotation
  if (incoming.role) target.role = incoming.role
  if (incoming.template) target.template = incoming.template
  if (incoming.severity) target.severity = incoming.severity
  for (const c of incoming.children) {
    const existing = target.children.find(t => t.name === c.name)
    if (existing) mergeInto(existing, c)
    else target.children.push(c)
  }
  target.isDir = target.children.length > 0 ? true : incoming.isDir
}

function applyText(node: SpecNode, key: 'annotation' | 'role' | 'template', v: string | null | undefined): void {
  if (v === undefined) return
  const text = v === null ? '' : v.trim()
  if (text === '') delete node[key]
  else node[key] = text
}

function isEmptyNode(n: SpecNode): boolean {
  return n.children.length === 0 && !n.annotation && !n.role && !n.template && !n.severity
}

/**
 * 只沿本次编辑触碰的那条路径自底向上回收空叶子，绝不做全树回收。
 *
 * 作用：给 src/core/ 写注释会顺带创建祖先 src，清空后应当把 src/core 一并收回。
 * 边界：这只保证**本次编辑之外的路径**不受影响——拖拽声明出来的空节点不会被一次
 * 无关路径的编辑清掉。但如果编辑的正是该空节点自己的子树，且清空后整条链都不再
 * 携带任何字段，那么它同样会被回收。这两种节点在文件里字节相同，工具无法区分，
 * 因此不做（也无法做）无条件保护。
 */
function pruneAlong(rootList: SpecNode[], segs: string[]): void {
  const chain: Array<{ parent: SpecNode[]; node: SpecNode }> = []
  let list = rootList
  for (const seg of segs) {
    const node = list.find(n => n.name === seg)
    if (!node) break
    chain.push({ parent: list, node })
    list = node.children
  }
  for (let i = chain.length - 1; i >= 0; i--) {
    const { parent, node } = chain[i]
    if (isEmptyNode(node)) {
      const idx = parent.indexOf(node)
      if (idx !== -1) parent.splice(idx, 1)
    }
  }
}

export interface GroupPatch {
  /** 用户手填的组名。省略或全为空白＝不改名；改名后 id 随之变化，返回的 id 是最终生效的那个。 */
  name?: string | null
  text?: string | null
  severity?: Severity | null
}

/** 取所有成员的最长公共父目录的 basename；无公共父目录时回退为 group。冲突时递增后缀。 */
export function deriveGroupId(members: readonly string[], taken: ReadonlySet<string>): string {
  return uniqueId(commonParentBasename(members), taken)
}

/** 冲突时追加 -2、-3。自动取名与用户改名共用这一条规则，两条路径的去重行为必须一致。 */
function uniqueId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`
    if (!taken.has(candidate)) return candidate
  }
}

function commonParentBasename(members: readonly string[]): string {
  if (members.length === 0) return 'group'
  const parents = members.map(m => m.split('/').filter(s => s !== '').slice(0, -1))
  let common = parents[0]
  for (const p of parents.slice(1)) {
    let i = 0
    while (i < common.length && i < p.length && common[i] === p[i]) i++
    common = common.slice(0, i)
  }
  const last = common[common.length - 1]
  return last && last !== '..' ? last : 'group'
}

export function setGroup(
  spec: Spec,
  id: string | null,
  members: readonly string[],
  patch: GroupPatch,
): { spec: Spec; id: string } {
  const next = structuredClone(spec)
  const sorted = [...new Set(members)].sort((a, b) => a.localeCompare(b, 'en'))
  const taken = new Set(next.groups.map(g => g.id))
  const current = id === null ? undefined : next.groups.find(g => g.id === id)

  // 改名时自身的旧 id 不算冲突，否则每改一次名字就多一个 -2 后缀
  const wanted = patch.name?.trim()
  const others = new Set(taken)
  if (current) others.delete(current.id)

  const targetId = wanted ? uniqueId(wanted, others) : (id ?? deriveGroupId(sorted, taken))
  const existing = current ?? next.groups.find(g => g.id === targetId)

  const text = patch.text === undefined ? existing?.text : (patch.text ?? '').trim()

  // 清空 text 即删除该分组；对尚不存在的分组是空操作
  if (text === undefined || text === '') {
    if (existing) next.groups = next.groups.filter(g => g !== existing)
    return { spec: next, id: targetId }
  }

  if (existing) {
    existing.id = targetId
    existing.members = sorted
    existing.text = text
    if (patch.severity !== undefined) {
      if (patch.severity === null) delete existing.severity
      else existing.severity = patch.severity
    }
  } else {
    const g: Group = { id: targetId, members: sorted, text }
    if (patch.severity) g.severity = patch.severity
    next.groups.push(g)
  }
  return { spec: next, id: targetId }
}

export function deleteGroup(spec: Spec, id: string): Spec {
  const next = structuredClone(spec)
  next.groups = next.groups.filter(g => g.id !== id)
  return next
}

/** 节点被移动后，指向该子树的分组成员路径必须同步重写，否则分组会悄悄指向不存在的位置。 */
function rewriteGroupMembers(groups: Group[], from: string, to: string): void {
  const prefix = `${from}/`
  for (const g of groups) {
    g.members = g.members.map(m => (m === from ? to : m.startsWith(prefix) ? to + m.slice(from.length) : m))
  }
}
