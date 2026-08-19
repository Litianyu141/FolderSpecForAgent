import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'
import { parseSpec } from './parse/index.js'
import { serializeSpec } from './serialize.js'
import { scan, DEFAULT_DEPTH } from './scan.js'
import { gitStatus } from './git.js'
import { merge } from './merge.js'
import { emptySpec, moveNode, setAnnotation } from './spec-edit.js'
import type { Api, ApiMethod, AnnotateParams, EditResult, MoveParams, OpenResult } from './api.js'
import type { ActualNode, GitStates, ParseError, Spec, ViewNode } from './types.js'

export const SPEC_FILENAME = '.folderspec.md'

export class Session {
  private actual: ActualNode = { name: '', path: '', kind: 'dir', children: [] }
  private git: GitStates = new Map()
  private spec: Spec = emptySpec()
  /** 当次会话内被拖走的旧位置；临时状态，永不落盘（spec §6.1） */
  private hidden = new Set<string>()
  private dirty = false
  private parseErrors: ParseError[] | null = null

  constructor(readonly root: string) {}

  get specPath(): string {
    return nodePath.join(this.root, SPEC_FILENAME)
  }

  isDirty(): boolean {
    return this.dirty
  }

  async open(): Promise<OpenResult> {
    this.hidden.clear()
    this.dirty = false

    const [actual, git] = await Promise.all([
      scan(this.root, { depth: DEFAULT_DEPTH }),
      gitStatus(this.root),
    ])
    this.actual = actual
    this.git = git

    let hasSpec = false
    let raw: string | null = null
    try {
      raw = await fs.readFile(this.specPath, 'utf8')
      hasSpec = true
    } catch {
      // 没有契约文件是完全正常的起始状态
    }

    if (raw === null) {
      this.spec = emptySpec()
      this.parseErrors = null
    } else {
      const parsed = parseSpec(raw)
      if (parsed.ok) {
        this.spec = parsed.value
        this.parseErrors = null
      } else {
        // 解析失败：保留空 spec 仅供显示，绝不写回覆盖用户文件（spec §8）
        this.spec = emptySpec()
        this.parseErrors = parsed.errors
      }
    }

    return {
      root: this.root,
      rootName: this.actual.name,
      hasSpec,
      specPath: this.specPath,
      parseErrors: this.parseErrors,
      tree: this.tree(),
    }
  }

  async reload(): Promise<OpenResult> {
    return this.open()
  }

  tree(): ViewNode {
    return merge(this.actual, this.git, this.spec, this.hidden)
  }

  async expand(path: string): Promise<ViewNode> {
    const sub = await scan(this.root, { subPath: path, depth: DEFAULT_DEPTH })
    const target = findActual(this.actual, path)
    if (target) {
      target.children = sub.children
      if (sub.truncated) target.truncated = true
      if (sub.unreadable) target.unreadable = true
    }
    return this.tree()
  }

  annotate(params: AnnotateParams): EditResult {
    this.assertWritable()
    const { path, isDir, ...patch } = params
    this.spec = setAnnotation(this.spec, path, isDir, patch)
    this.dirty = true
    return { tree: this.tree(), dirty: true }
  }

  move(params: MoveParams): EditResult {
    this.assertWritable()
    this.spec = moveNode(this.spec, params.from, params.toParent, params.isDir)
    // 旧位置在当次会话中隐藏；重新 open 后自然消失（不落盘）
    this.hidden.add(params.from)
    this.dirty = true
    return { tree: this.tree(), dirty: true }
  }

  raw(): string {
    return serializeSpec(this.spec)
  }

  async save(): Promise<{ written: boolean }> {
    this.assertWritable()
    const text = serializeSpec(this.spec)

    // 写盘前自校验：序列化的结果必须能被自己解析回来（spec §8）
    const verify = parseSpec(text)
    if (!verify.ok) {
      throw new Error(
        `序列化自校验失败，已中止写入以免损坏契约文件：${verify.errors.map(e => `第 ${e.line} 行 ${e.message}`).join('；')}`,
      )
    }

    await fs.writeFile(this.specPath, text, 'utf8')
    this.dirty = false
    return { written: true }
  }

  /**
   * 注意：'workspace/open' 只重新扫描 **本 Session 自己的 root**，忽略 params.root。
   * 切换工作区意味着换一个 Session——由宿主负责（见 CLI 的 server.ts 与 VSCode 的 editor.ts）。
   */
  async handle<K extends ApiMethod>(method: K, params: Api[K]['params']): Promise<Api[K]['result']> {
    switch (method) {
      case 'workspace/open':
        return (await this.open()) as Api[K]['result']
      case 'tree/get':
        return { tree: this.tree() } as Api[K]['result']
      case 'tree/expand':
        return { tree: await this.expand((params as Api['tree/expand']['params']).path) } as Api[K]['result']
      case 'spec/annotate':
        return this.annotate(params as AnnotateParams) as Api[K]['result']
      case 'spec/move':
        return this.move(params as MoveParams) as Api[K]['result']
      case 'spec/save':
        return (await this.save()) as Api[K]['result']
      case 'spec/raw':
        return { markdown: this.raw() } as Api[K]['result']
      default:
        throw new Error(`未知方法 "${String(method)}"`)
    }
  }

  private assertWritable(): void {
    if (this.parseErrors !== null) {
      throw new Error('契约文件解析失败，当前为只读模式，请先修复文件')
    }
  }
}

function findActual(node: ActualNode, path: string): ActualNode | null {
  if (node.path === path) return node
  for (const c of node.children ?? []) {
    const hit = findActual(c, path)
    if (hit) return hit
  }
  return null
}
