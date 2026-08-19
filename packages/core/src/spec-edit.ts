import type { Severity, Spec, SpecNode } from './types.js'

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
