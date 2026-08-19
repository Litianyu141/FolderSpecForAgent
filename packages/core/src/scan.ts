import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'
import ignore from 'ignore'
import type { Ignore } from 'ignore'
import type { Dirent } from 'node:fs'
import { normalizeWorkspacePath } from './workspace-path.js'
import type { ActualNode, FileKind, ScanOpts } from './types.js'

export const MAX_CHILDREN = 10_000
export const DEFAULT_DEPTH = 2

/** 无论 ignore 文件怎么写都必须排除的目录名，硬编码判断，不参与 ignore 规则的优先级竞争 */
const ALWAYS_IGNORED_NAMES = new Set(['.git'])

/** 一层 ignore 规则；base 是它生效的目录（相对根的 posix 路径，根为 ''） */
interface IgnoreLayer {
  base: string
  ig: Ignore
}

export async function scan(root: string, opts: ScanOpts = {}): Promise<ActualNode> {
  const subPath = normalizeWorkspacePath(opts.subPath ?? '')
  const depth = opts.depth ?? DEFAULT_DEPTH
  const maxChildren = opts.maxChildren ?? MAX_CHILDREN

  const layers = await buildAncestorLayers(root, subPath)
  const node: ActualNode = {
    name: subPath === '' ? nodePath.basename(nodePath.resolve(root)) : basename(subPath),
    path: subPath,
    kind: 'dir',
  }
  await walk(root, node, layers, depth, maxChildren)
  return node
}

async function walk(
  root: string,
  dir: ActualNode,
  inherited: IgnoreLayer[],
  depth: number,
  maxChildren: number,
): Promise<void> {
  if (depth <= 0) return

  const abs = nodePath.join(root, dir.path)
  let entries: Dirent[]
  try {
    entries = await fs.readdir(abs, { withFileTypes: true })
  } catch {
    dir.unreadable = true
    dir.children = []
    return
  }

  const own = await readLayer(abs, dir.path)
  const layers = own ? [...inherited, own] : inherited

  const children: ActualNode[] = []
  for (const e of entries) {
    const rel = dir.path === '' ? e.name : `${dir.path}/${e.name}`
    const isSymlink = e.isSymbolicLink()
    const isDir = !isSymlink && e.isDirectory()
    if (ALWAYS_IGNORED_NAMES.has(e.name)) continue
    if (isIgnored(layers, rel, isDir)) continue
    if (children.length >= maxChildren) {
      dir.truncated = true
      break
    }
    const kind: FileKind = isSymlink ? 'symlink' : isDir ? 'dir' : 'file'
    children.push({ name: e.name, path: rel, kind })
  }

  children.sort(compareNodes)
  dir.children = children

  // 只递归真实目录；符号链接一律不进入，避免成环
  for (const c of children) {
    if (c.kind === 'dir') await walk(root, c, layers, depth - 1, maxChildren)
  }
}

export function compareNodes(a: ActualNode, b: ActualNode): number {
  const ad = a.kind === 'dir' ? 0 : 1
  const bd = b.kind === 'dir' ? 0 : 1
  if (ad !== bd) return ad - bd
  return a.name.localeCompare(b.name, 'en')
}

/**
 * 为 subPath 的每一级祖先建立 ignore 层：根目录本身（若 subPath 非空）
 * 到 subPath 的父级为止。subPath 自身的层由 walk() 首次调用时补上，
 * 避免和这里重复读取、重复编译。
 *
 * subPath === '' 时根本身就是 walk() 的起点，根层完全交给 walk() 读取，
 * 这里直接返回空数组，省掉一次多余的磁盘读取与 ignore 编译。
 */
async function buildAncestorLayers(root: string, subPath: string): Promise<IgnoreLayer[]> {
  if (subPath === '') return []

  const layers: IgnoreLayer[] = []
  const rootLayer = await readLayer(root, '')
  if (rootLayer) layers.push(rootLayer)

  const parts = subPath.split('/')
  let acc = ''
  for (let i = 0; i < parts.length - 1; i++) {
    acc = acc === '' ? parts[i] : `${acc}/${parts[i]}`
    const layer = await readLayer(nodePath.join(root, acc), acc)
    if (layer) layers.push(layer)
  }
  return layers
}

async function readLayer(absDir: string, base: string): Promise<IgnoreLayer | null> {
  const patterns: string[] = []
  for (const file of ['.gitignore', '.ignore']) {
    try {
      patterns.push(await fs.readFile(nodePath.join(absDir, file), 'utf8'))
    } catch {
      // 该目录没有这个 ignore 文件，正常情况
    }
  }
  if (patterns.length === 0) return null
  // `ignore().add()` only splits a *string* argument into per-line patterns;
  // an array argument treats each element as one atomic pattern. Since our
  // elements are raw multi-line file contents, join them into a single
  // string first so every line becomes its own rule.
  return { base, ig: ignore().add(patterns.join('\n')) }
}

function isIgnored(layers: IgnoreLayer[], relPath: string, isDir: boolean): boolean {
  const target = isDir ? `${relPath}/` : relPath
  for (const { base, ig } of layers) {
    if (base !== '' && !target.startsWith(`${base}/`)) continue
    const sub = base === '' ? target : target.slice(base.length + 1)
    if (sub === '' || sub === '/') continue
    if (ig.ignores(sub)) return true
  }
  return false
}

function basename(posixPath: string): string {
  const i = posixPath.lastIndexOf('/')
  return i === -1 ? posixPath : posixPath.slice(i + 1)
}
