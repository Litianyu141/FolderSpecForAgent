import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'
import { parseSpec } from './parse/index.js'
import { serializeSpec } from './serialize.js'
import { scan, DEFAULT_DEPTH } from './scan.js'
import { gitStatus } from './git.js'
import { merge } from './merge.js'
import { emptySpec, moveNode, setAnnotation } from './spec-edit.js'
import type { AnnotationPatch } from './spec-edit.js'
import type { Api, ApiMethod, AnnotateParams, EditResult, MoveParams, OpenResult } from './api.js'
import type { ActualNode, GitStates, ParseError, Spec, ViewNode } from './types.js'

export const SPEC_FILENAME = '.folderspec.md'

const FORBIDDEN_IN_IDENTIFIER = /[`\]\s]/

/**
 * role/template 是短标识符，必须能在序列化后的 `[role:x]` 标签里原样往返。放行任意字符
 * 就等于允许写出解析器读不回来的标签——save() 的自校验虽然会兜底拦下写入，但用户看不到
 * 诊断，体验上等同于会话被永久卡死。因此在用户输入进入系统的这个边界直接拒绝，而不是
 * 静默改写一个标识符（那样会让用户以为自己写的值被保存了，实际却是别的东西）。
 */
function assertValidIdentifier(field: string, v: string | null | undefined): void {
  if (v === undefined || v === null) return
  if (FORBIDDEN_IN_IDENTIFIER.test(v)) {
    throw new Error(`${field} 不能包含反引号、"]" 或空白字符（会破坏 \`[${field}:...]\` 标签语法）：${JSON.stringify(v)}`)
  }
}

/**
 * 结构区里一个节点必须是一行；annotation 中出现的换行会在序列化后把一行拆成两行，
 * 写盘后无法被解析器读回来（自校验会拦下写入，且没有清晰的诊断指向具体是哪个节点）。
 * 换行在注释里没有"正确"语义（一条注释本就该是一行），把它替换成空格是用户敲下 Enter
 * 时最不吃惊的结果，而不是拒绝或静默丢弃。
 */
function normalizeAnnotation(v: string | null | undefined): string | null | undefined {
  if (v === undefined || v === null) return v
  return v.replace(/\r\n|\r|\n/g, ' ')
}

export class Session {
  private actual: ActualNode = { name: '', path: '', kind: 'dir', children: [] }
  private git: GitStates = new Map()
  private spec: Spec = emptySpec()
  /** 当次会话内被拖走的旧位置；临时状态，永不落盘（spec §6.1） */
  private hidden = new Set<string>()
  private dirty = false
  private parseErrors: ParseError[] | null = null
  /** open() 是否已经完整跑完一次。区分"从未打开"与"打开成功"——两者 parseErrors 都是 null，
   *  不能只靠 parseErrors 判断，否则未 open() 就调用 save() 会用空 spec 覆盖用户已有的文件。 */
  private opened = false

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

    // 扫描、git 查询、契约读取与解析都已经完整跑完；标记为已打开。
    // 必须在下面的 this.tree() 之前设置——open() 自己也要调用 tree()，
    // 并且一次半途失败的 open()（上面任何一步抛出）绝不能被算作"已打开"。
    this.opened = true

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
    this.assertOpened()
    return merge(this.actual, this.git, this.spec, this.hidden)
  }

  async expand(path: string): Promise<ViewNode> {
    this.assertOpened()
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
    const { path, isDir, annotation, role, template, severity } = params
    assertValidIdentifier('role', role)
    assertValidIdentifier('template', template)
    const patch: AnnotationPatch = {
      annotation: normalizeAnnotation(annotation),
      role,
      template,
      severity,
    }
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
    this.assertWritable()
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

  private assertOpened(): void {
    if (!this.opened) {
      throw new Error('会话尚未打开：必须先调用 open()，否则会用空 spec 覆盖用户已有的契约文件')
    }
  }

  private assertWritable(): void {
    this.assertOpened()
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
