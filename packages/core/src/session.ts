import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'
import { parseSpec } from './parse/index.js'
import { serializeSpec } from './serialize.js'
import { scan, DEFAULT_DEPTH } from './scan.js'
import { gitStatus } from './git.js'
import { merge } from './merge.js'
import { emptySpec, moveNode, setAnnotation, setGroup, deleteGroup } from './spec-edit.js'
import type { AnnotationPatch, GroupPatch } from './spec-edit.js'
import { readWorkspaceFile } from './file-read.js'
import type { FileReadResult } from './file-read.js'
import type { Api, ApiMethod, AnnotateParams, EditResult, MoveParams, OpenResult, SetGroupParams, SetViewModeParams, ViewModeResult } from './api.js'
import type { ActualNode, GitStates, Group, ParseError, Spec, ViewMode, ViewNode } from './types.js'

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

/**
 * 结构区把节点名写成 `` `名字` ``，且一个节点必须完整占据一行。反引号会提前闭合名称、
 * 换行会把一行劈成两行——两者当前的格式都无法表示，序列化出来的文本解析器读不回来。
 *
 * 这类名字来自真实文件名（``we`ird`` 在 Linux/macOS 上是合法目录名），不是用户手输的
 * 标识符，所以必须在它进入 spec 的这个边界就拒绝，而不是等到写盘前的自校验才拦下：
 * 到那一步用户已经标了一整轮，报错也只能指向"某一行解析不了"，说不清是哪个节点。
 * 完整转义是二期的事（见 README 的已知限制）。
 */
const FORBIDDEN_IN_NODE_NAME = /[`\r\n]/

function assertRepresentablePath(path: string): void {
  if (FORBIDDEN_IN_NODE_NAME.test(path)) {
    throw new Error(`路径 ${JSON.stringify(path)} 含有反引号或换行，当前契约格式无法表示；请重命名该文件或目录`)
  }
}

export class Session {
  private actual: ActualNode = { name: '', path: '', kind: 'dir', children: [] }
  private git: GitStates = new Map()
  private spec: Spec = emptySpec()
  /** 当次会话内被拖走的旧位置；临时状态，永不落盘（spec §6.1） */
  private hidden = new Set<string>()
  /** 「原始结构 / 我的结构」显示模式。与 hidden 同类的派生状态：只影响 tree() 怎么合成，
   *  永不落盘、不参与 dirty。不在 open()/reload() 时重置——它是用户的显示偏好，不是
   *  某次编辑的残留状态，外部触发的重载不该把用户正看着的视图悄悄切走。 */
  private viewMode: ViewMode = 'spec'
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
    let readErrors: ParseError[] | null = null
    try {
      raw = await fs.readFile(this.specPath, 'utf8')
      hasSpec = true
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        // 没有契约文件是完全正常的起始状态
      } else {
        // 文件在那儿，只是这一刻读不出来——EACCES/EPERM（权限）、EIO（介质）、EISDIR，
        // 以及 Windows 上最要命的 EBUSY：另一个进程正握着这个文件，而"另一个进程正在
        // 改写契约"恰恰是本工具的主场景（Agent 在写）。
        //
        // 把这些一律当成"没有文件"，会让会话保持可写、并在下一次 save() 用一份空契约
        // 盖掉用户攒了几个月的标注。所以退化到与解析失败完全相同的只读状态：
        // assertWritable() 拦住所有写入，横幅告诉用户到底是哪个文件、什么 errno。
        hasSpec = true
        readErrors = [{
          line: 0,
          message: `无法读取契约文件 ${this.specPath}（${code ?? 'UNKNOWN'}）：${e instanceof Error ? e.message : String(e)}。为避免覆盖已有内容，当前为只读模式`,
        }]
      }
    }

    if (readErrors !== null) {
      // 与解析失败同款处理：空 spec 仅供显示，绝不写回覆盖用户文件（spec §8）
      this.spec = emptySpec()
      this.parseErrors = readErrors
    } else if (raw === null) {
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
      groups: this.groupsSnapshot(),
    }
  }

  async reload(): Promise<OpenResult> {
    return this.open()
  }

  tree(): ViewNode {
    this.assertOpened()
    return merge(this.actual, this.git, this.spec, this.hidden, this.viewMode)
  }

  /**
   * 切换「原始结构 / 我的结构」视图。纯显示操作：只改 this.viewMode，不碰 this.spec，
   * 不置 dirty——正因为它不产生任何编辑，才不需要 undo 栈（与项目裁定「不需要 undo 栈」
   * 相容）。写入侧的闸门在 assertWritable() 里（见那里的注释）。
   */
  setViewMode(mode: ViewMode): ViewModeResult {
    this.assertOpened()
    this.viewMode = mode
    return { tree: this.tree(), mode: this.viewMode }
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
    assertRepresentablePath(path)
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
    return { tree: this.tree(), dirty: true, groups: this.groupsSnapshot() }
  }

  move(params: MoveParams): EditResult {
    this.assertWritable()
    assertRepresentablePath(params.from)
    assertRepresentablePath(params.toParent)
    this.spec = moveNode(this.spec, params.from, params.toParent, params.isDir)

    const name = params.from.split('/').filter(Boolean).pop() ?? ''
    const to = params.toParent === '' ? name : `${params.toParent}/${name}`

    // 目标路径如果正好是此前某次拖拽留下的隐藏旧位置，这次移动等于把节点还回去；
    // 必须先解除隐藏，否则该路径会同时在 actual 侧（磁盘上真实存在）和 spec 侧
    // （契约又把它声明了回去）被 merge 跳过，节点第二次凭空消失。典型触发方式：
    // 把节点拖到别处、再从新位置拖回原父级——第二次 move() 的 from 是当前视图
    // 路径（新位置），不是磁盘上的原路径，所以不能指望下面对 from 的处理顺带清掉它。
    this.hidden.delete(to)

    // 只有当节点真的换了位置时才隐藏旧路径。拖回原父级时新旧路径相同，
    // 若照样加进 hidden，merge 会把磁盘侧和 spec 侧双双跳过，
    // 节点就从界面上凭空消失（文件和契约其实都还在）。
    if (to !== params.from) this.hidden.add(params.from)

    this.dirty = true
    return { tree: this.tree(), dirty: true, groups: this.groupsSnapshot() }
  }

  setGroup(params: SetGroupParams): EditResult & { id: string } {
    this.assertWritable()
    for (const m of params.members) assertRepresentablePath(m)
    const patch: GroupPatch = {}
    if (params.name !== undefined) patch.name = params.name === null ? null : normalizeAnnotation(params.name)
    if (params.text !== undefined) patch.text = params.text === null ? null : normalizeAnnotation(params.text)
    if (params.severity !== undefined) patch.severity = params.severity
    const r = setGroup(this.spec, params.id, params.members, patch)
    this.spec = r.spec
    this.dirty = true
    return { tree: this.tree(), dirty: true, groups: this.groupsSnapshot(), id: r.id }
  }

  deleteGroup(id: string): EditResult {
    this.assertWritable()
    this.spec = deleteGroup(this.spec, id)
    this.dirty = true
    return { tree: this.tree(), dirty: true, groups: this.groupsSnapshot() }
  }

  async readFile(path: string): Promise<FileReadResult> {
    this.assertOpened()
    return readWorkspaceFile(this.root, path)
  }

  /**
   * 自校验（serialize → parse）必须长在 raw() 上，而不是 save() 上。
   *
   * 两个宿主的写路径不一样：CLI 走 save() 直接落盘，VSCode 走 session.raw() + WorkspaceEdit
   * （为了让脏标记、Ctrl+S、撤销栈正常工作）。校验若只放在 save() 里，VSCode 那一半的写入
   * 就完全没有校验——真实文件名里的一个反引号足以写出解析不回来的契约文件，用户下次打开
   * 就被锁在一个坏文件后面，整份标注取不回来。把闸门放在 raw() 上，两个宿主自动都受保护。
   */
  raw(): string {
    this.assertWritable()
    const text = serializeSpec(this.spec)

    // 落盘（或交给宿主落盘）前自校验：序列化的结果必须能被自己解析回来（spec §8）
    const verify = parseSpec(text)
    if (!verify.ok) {
      throw new Error(
        `序列化自校验失败，已中止以免损坏契约文件：${verify.errors.map(e => `第 ${e.line} 行 ${e.message}`).join('；')}`,
      )
    }

    return text
  }

  async save(): Promise<{ written: boolean }> {
    const text = this.raw() // raw() 已完成 assertWritable 与自校验
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
      case 'spec/setGroup':
        return this.setGroup(params as SetGroupParams) as Api[K]['result']
      case 'spec/deleteGroup':
        return this.deleteGroup((params as { id: string }).id) as Api[K]['result']
      case 'file/read':
        return (await this.readFile((params as { path: string }).path)) as Api[K]['result']
      case 'view/setMode':
        return this.setViewMode((params as SetViewModeParams).mode) as Api[K]['result']
      default:
        throw new Error(`未知方法 "${String(method)}"`)
    }
  }

  /**
   * 分组随每次读写一起过桥（UI 需要 ViewNode.groups 里没有的 text/severity）。
   * 必须是深拷贝：直接交出内部数组，宿主或 UI 侧任何一次就地改动都会改到这份
   * 即将被序列化写进用户文件的 Spec —— 本工具唯一能造成的伤害正是弄丢人写的注释。
   */
  private groupsSnapshot(): Group[] {
    return structuredClone(this.spec.groups)
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
    // disk 视图只按磁盘扫描结果建树，节点路径与契约里的路径可能对不上（节点被移动过
    // 时尤其如此）。如果在这个视图上放行编辑，改动会挂到用户当前视图里看到的路径上，
    // 那条路径未必是契约打算表达的那条——标注会悄悄挂错地方，而用户全程看不出来。
    // 闸放在这里而不是 UI 层：两个宿主的写操作都经过 assertWritable()，UI 不可能绕过去。
    if (this.viewMode === 'disk') {
      throw new Error('当前处于「原始结构」视图，为只读模式；切回「我的结构」视图后即可编辑')
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
