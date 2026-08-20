import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'
import { parseSpec } from './parse/index.js'
import { serializeSpec } from './serialize.js'
import { scan, DEFAULT_DEPTH } from './scan.js'
import { gitStatus } from './git.js'
import { merge } from './merge.js'
import { createNode, emptySpec, findSpecNode, moveNode, setAnnotation, setGroup, deleteGroup, setLang } from './spec-edit.js'
import type { AnnotationPatch, GroupPatch } from './spec-edit.js'
import { readWorkspaceFile } from './file-read.js'
import type { FileReadResult } from './file-read.js'
import type { Api, ApiMethod, AnnotateParams, CreateNodeParams, EditResult, MoveParams, OpenResult, SaveResult, SetGroupParams, SetLangParams, SetViewModeParams, ViewModeResult } from './api.js'
import type { ActualNode, GitStates, Group, Lang, ParseError, Spec, ViewMode, ViewNode } from './types.js'

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

/**
 * createNode 的 name 是用户直接敲进输入框的单个路径段，不是像 annotate/move 那样
 * 已经存在于磁盘、已经过操作系统那道关卡的文件名——不能假定它无害。除了上面
 * assertRepresentablePath 已经挡住的反引号/换行，这里还要挡：
 *   - 空字符串——一个空文本框提交，不该在契约里留一个没有名字的节点；
 *   - 含 "/"——这个参数位约定是单个路径段，含 "/" 说明调用方把它和 parentPath
 *     弄混了，放行的话会把用户以为的一层目录悄悄拆成好几层；
 *   - "." / ".."——在文件系统里有特殊含义，允许的话 Agent 读到一个名叫 `..` 的
 *     "应该存在的目录"会分不清这是笔误还是真要在上级目录动手。
 */
function assertValidNodeName(name: string): void {
  if (name === '') throw new Error('名字不能为空')
  if (name.includes('/')) {
    throw new Error(`名字 ${JSON.stringify(name)} 不能包含 "/"：这里只接受单个路径段，不是路径`)
  }
  if (FORBIDDEN_IN_NODE_NAME.test(name)) {
    throw new Error(`名字 ${JSON.stringify(name)} 含有反引号或换行，当前契约格式无法表示`)
  }
  if (name === '.' || name === '..') {
    throw new Error(`名字不能是 "${name}"：在文件系统里有特殊含义`)
  }
}

/**
 * parentPath（createNode）/ toParent（move）是多段路径，此前只过了
 * assertRepresentablePath（只挡反引号/换行）。这道关卡挡不住 ".." 这种能把声明
 * 写到仓库之外的段：`createNode({ parentPath: '../etc', name: 'passwd', ... })`
 * 能一路通过 raw() 的 serialize→parse 自校验、成功 save()，磁盘上得到
 * `- \`../\`\n  - \`etc/\`\n    - \`passwd\``——本工具自己不 mkdir，只读铁律没破，
 * 但契约的消费者是真的会 mkdir 的 Agent，这等于亲手写了一条越出仓库的指令。
 * 逐段跑 assertValidNodeName，与 name 参数共用同一条规则（含 "." / ".." 的检查），
 * 不必另起一套；createNode 与 move() 的 toParent 共用这个函数。
 */
function assertValidParentPath(path: string): void {
  for (const seg of path.split('/')) {
    if (seg !== '') assertValidNodeName(seg)
  }
}

/**
 * 撤销栈深度上限。快照与「已标注节点数」成正比（不是仓库文件数），50 步在最坏情况下
 * 也只是几十份 Spec 的副本；到顶丢最旧的一步，防止一份超大契约把内存吃干净。
 */
const MAX_UNDO_DEPTH = 50

/**
 * 一次编辑之前的完整可撤销状态。
 *
 * **hidden 必须和 spec 一起进快照。** hidden 记的是本次会话里被拖走节点的旧位置；
 * 只还原 spec 的话，契约里节点已经回到旧位置、而旧位置又仍被 hidden 挡着，于是它
 * 在**新旧两个位置都不显示**——正是 v1 里「`.claude/command` 拖一下就整个不见了」
 * 那个缺陷的形状。
 *
 * actual（磁盘扫描结果）刻意**不**在里面：撤销的是"契约上的编辑"，不是"看过哪些
 * 目录"，把懒加载出来的子树一起还原会让一次无关的撤销顺手折叠掉用户展开过的目录。
 */
interface Snapshot {
  spec: Spec
  hidden: Set<string>
  revision: number
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

  /**
   * 撤销 / 重做栈。与 hidden 同类：纯内存、open() 时清空、永不落盘。
   *
   * 设计文档与 CLAUDE.md 里「不需要 undo 栈、dry-run、回滚」那一句说的是**另一个
   * 问题**：本工具永不改动磁盘上的文件，因此没有"操作把仓库弄坏了要回滚"这回事。
   * 这里的撤销栈解决的是手滑——拖错了位置、注释写串了行，要能一步退回来。它只作用
   * 于内存里的 Spec 与 hidden，一样一个字节都不写磁盘，只读铁律没有被动摇。
   * 看到那句话时别顺手把这一整块删掉。
   */
  private undoStack: Snapshot[] = []
  private redoStack: Snapshot[] = []

  /**
   * dirty 不是一个能随快照一起存取的布尔量，所以用「当前状态编号 vs 与磁盘一致的
   * 那个编号」两个数来表达。
   *
   * 反例：照搬"存下编辑前的 dirty、撤销时还原"，会在「编辑 → 保存 → 撤销」上答错——
   * 编辑前 dirty 是 false，可撤销回去之后磁盘上已经是编辑后的内容了，内存与磁盘明明
   * 不一致却报告为干净，用户关掉窗口就丢东西。反过来"撤销一律置脏"则永远摘不掉脏
   * 标记，撤回到打开时的状态也还在提示有未保存改动。
   *
   * 编号单调递增、从不复用，所以相等只可能是"真的是同一个状态"；栈到顶丢掉最旧一步
   * 时也不会误判（那个编号从此无法再被还原到）。
   */
  private revisionSeq = 0
  private revision = 0
  private savedRevision = 0

  private parseErrors: ParseError[] | null = null
  /** open() 是否已经完整跑完一次。区分"从未打开"与"打开成功"——两者 parseErrors 都是 null，
   *  不能只靠 parseErrors 判断，否则未 open() 就调用 save() 会用空 spec 覆盖用户已有的文件。 */
  private opened = false

  constructor(readonly root: string) {}

  get specPath(): string {
    return nodePath.join(this.root, SPEC_FILENAME)
  }

  isDirty(): boolean {
    return this.revision !== this.savedRevision
  }

  async open(): Promise<OpenResult> {
    this.hidden.clear()
    // 历史与 hidden 同类，绝不跨越一次重载：open() 之后内存里的 spec 来自磁盘，
    // 栈里那些快照描述的是上一份文件的状态，还原过去只会把别的内容写成"撤销结果"。
    this.undoStack = []
    this.redoStack = []
    this.revision = this.nextRevision()
    this.savedRevision = this.revision

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
   * 不置 dirty——正因为它不产生任何编辑，才不入 undoStack（不是"不需要 undo 栈"：
   * 这个会话里此刻就有一个真实的 undoStack，见类顶部字段注释；这里只是不往里推）。
   * 写入侧的闸门在 assertWritable() 里（见那里的注释）。
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
    // 先取快照再改。setAnnotation 抛错时 commitEdit 不会执行，栈保持原样。
    const before = this.captureState()
    this.spec = setAnnotation(this.spec, path, isDir, patch)
    this.commitEdit(before)
    return this.editResult()
  }

  move(params: MoveParams): EditResult {
    this.assertWritable()
    assertRepresentablePath(params.from)
    assertValidParentPath(params.toParent)
    // 快照必须盖住下面对 hidden 的两处改动，不能只盖 spec——见 Snapshot 的注释
    const before = this.captureState()
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

    this.commitEdit(before)
    return this.editResult()
  }

  /**
   * 在契约里声明一个尚不存在的节点。走与其他四个写方法（annotate/move/setGroup/
   * deleteGroup）完全相同的收口（assertWritable → 快照 → 纯函数改 spec →
   * commitEdit），因此也天然进撤销栈、天然被「原始结构」只读视图拦下、天然会被
   * raw()/save() 的自校验闸门保护。
   */
  createNode(params: CreateNodeParams): EditResult & { path: string } {
    this.assertWritable()
    const { parentPath, name, isDir } = params
    assertValidParentPath(parentPath)
    assertValidNodeName(name)
    this.assertCreatableParent(parentPath)
    const before = this.captureState()
    const created = createNode(this.spec, parentPath, name, isDir)
    this.spec = created.spec
    this.commitEdit(before)
    return { ...this.editResult(), path: created.path }
  }

  /**
   * "目录判断只信一个真相源"这条隐含假设在这里会出错：ensure()（setAnnotation 也在
   * 用）为了让路径能穿过去，会把 spec 侧的中间节点强行升级成目录；但 merge() 对
   * "磁盘和契约都有"的节点只信磁盘（merge.ts 的 fromActual 用 a.kind==='dir'，
   * 完全不看 spec 那份 isDir）。于是 parentPath 一旦是磁盘上真实存在的文件，
   * createNode 能成功返回、raw() 的自校验也能通过——写进契约的却是一行 UI 永远
   * 选不中、用户永远看不见也删不掉的声明，因为合成出来的树坚持认为那里是文件。
   * spec 里已经声明为文件的叶子也一并拒绝：不能因为一次"新建子项"的副作用，就
   * 悄悄把用户之前"这是个文件"的声明改写成目录。
   */
  private assertCreatableParent(parentPath: string): void {
    const onDisk = findActual(this.actual, parentPath)
    if (onDisk && onDisk.kind !== 'dir') {
      throw new Error(`\`${parentPath}\` 在磁盘上是一个文件，不能在它下面新建节点`)
    }
    const inSpec = findSpecNode(this.spec.nodes, parentPath)
    if (inSpec && !inSpec.isDir) {
      throw new Error(`\`${parentPath}\` 在契约里被声明为文件，不能在它下面新建节点`)
    }
  }

  setGroup(params: SetGroupParams): EditResult & { id: string } {
    this.assertWritable()
    for (const m of params.members) assertRepresentablePath(m)
    const patch: GroupPatch = {}
    if (params.name !== undefined) patch.name = params.name === null ? null : normalizeAnnotation(params.name)
    if (params.text !== undefined) patch.text = params.text === null ? null : normalizeAnnotation(params.text)
    if (params.severity !== undefined) patch.severity = params.severity
    const before = this.captureState()
    const r = setGroup(this.spec, params.id, params.members, patch)
    this.spec = r.spec
    this.commitEdit(before)
    return { ...this.editResult(), id: r.id }
  }

  deleteGroup(id: string): EditResult {
    this.assertWritable()
    const before = this.captureState()
    this.spec = deleteGroup(this.spec, id)
    this.commitEdit(before)
    return this.editResult()
  }

  /**
   * 切换样板文字（标题行、导言、四个章节标题）的语言。走与其他四个写方法完全相同的
   * 收口（assertWritable → 快照 → 纯函数改 spec → commitEdit），因此也天然进撤销栈、
   * 天然被「原始结构」只读视图拦下、天然会被 raw()/save() 的自校验闸门保护——见
   * spec-edit.ts 的 setLang() 关于"未改过才换"判据的完整推导。
   */
  setLang(lang: Lang): EditResult {
    this.assertWritable()
    const before = this.captureState()
    this.spec = setLang(this.spec, lang)
    this.commitEdit(before)
    return this.editResult()
  }

  /**
   * 退回一次已提交的编辑。粒度是"一次编辑"而不是一次按键：注释面板失焦才提交，
   * 所以一次注释修改就是一步；拖拽、分组增删改同理。
   *
   * 栈空时是**空操作**而不是抛错：UI 会按 canUndo 置灰按钮，但快捷键（Ctrl+Z）绕不过
   * 去，没得可退时弹一条错误横幅只是噪音——何况空操作什么都没改，不存在"静默吞掉了
   * 一次数据变更"的风险，与本项目"宁可报错也别静默改写"的取向不冲突。
   */
  undo(): EditResult {
    this.assertWritable()
    const prev = this.undoStack.pop()
    if (prev) {
      // redoStack 不需要单独限深：它只在这里增长，每长一格就从 undoStack 摘走一格，
      // 而一有新编辑 commitEdit 就把它清空——长度恒不超过 MAX_UNDO_DEPTH。
      this.redoStack.push(this.captureState())
      this.restoreState(prev)
    }
    return this.editResult()
  }

  redo(): EditResult {
    this.assertWritable()
    const next = this.redoStack.pop()
    if (next) {
      this.pushUndo(this.captureState())
      this.restoreState(next)
    }
    return this.editResult()
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

  /**
   * 供不走 save() 的宿主使用：把要落盘的文本和它对应的 revision **在同一次调用里**
   * 一起交出去，而不是让宿主自己分两步拼（先读 raw()、再另外读一次"现在的 revision"）。
   *
   * 这不是防御性代码——两个宿主的消息回调都不排队（cli/src/server.ts 的
   * `socket.on('message', async ...)`、vscode/src/editor.ts 的 `onDidReceiveMessage`），
   * 宿主自己真实落盘的那几个 await（VSCode 是 WorkspaceEdit + document.save()，
   * 后者会跑 save participants，窗口可能有几百毫秒）期间完全可能又处理一条把
   * revision 推进的新消息。如果宿主是"调 raw() 拿文本，回头再读一次 session 的
   * revision"，两次读取中间那一刻可能已经隔着一次新编辑，读到的 revision 会比
   * 文本实际对应的那个新——回头拿去 markSaved() 会把没写进磁盘的那一版误标成
   * 已保存，正是 save() 那个 bug 的翻版。绑成一次调用的返回值，宿主不可能读错。
   */
  rawForSave(): { text: string; revision: number } {
    const text = this.raw()
    return { text, revision: this.revision }
  }

  async save(): Promise<SaveResult> {
    // text 与 revision 必须来自同一次 rawForSave() 调用：下面 await fs.writeFile
    // 期间，两个宿主的消息回调都不排队，一笔新的 spec/annotate 完全可能插进来把
    // this.revision 推进。若这里落盘后才去读"此刻的 this.revision"，记下的就是
    // 那笔新编辑的版本号，而磁盘上写的其实是旧版本的文本——脏标记会被误判为已经
    // 熄灭，用户以为存好了、关窗即丢，正是本工具唯一要严防的那种伤害。
    const { text, revision } = this.rawForSave()
    await fs.writeFile(this.specPath, text, 'utf8')
    // 记下"磁盘上现在是哪一个状态"，而不是简单地把 dirty 抹掉：保存点可以落在撤销
    // 链的任意一处，之后往回退反而会重新变脏（见 revision 的注释）。
    this.savedRevision = revision
    // dirty 必须在 savedRevision 落定之后才读：如果上面 await 期间又落地了一笔新
    // 编辑（this.revision 已经比 revision 更新），isDirty() 此刻会正确地算出
    // true——调用方（UI）得如实转达这个值，不能自己假定保存一定让脏标记熄灭
    // （SaveResult.dirty 上有完整推导）。
    return { written: true, dirty: this.isDirty() }
  }

  /**
   * 供不走 save() 的宿主在**它自己**把内容写盘成功之后，补记"磁盘现在是哪个版本"。
   * 目前只有 VSCode 一家：它不调用 save()（那个方法自己 fs.writeFile），而是拿
   * rawForSave() 的文本走 WorkspaceEdit + document.save()，好让 VSCode 原生的脏
   * 标记、Ctrl+S、撤销栈正常工作（见 editor.ts 的 spec/save 分支）。这条写路径完全
   * 绕开了 save()，于是 savedRevision 永远追不上 revision——dirty 语义升级成
   * "revision 是否等于 savedRevision" 之后，这个宿主里的脏标记会在首次编辑后永远
   * 亮着，undo 回到刚保存的那一步也摘不掉。
   *
   * **必须传入调用 rawForSave() 时拿到的那个 revision，不能在这里改读"此刻的
   * this.revision"。** VSCode 的写入路径中间隔着 WorkspaceEdit + document.save()
   * 两个 await（document.save() 还会跑 save participants，窗口可能有几百毫秒），
   * 若在这里才读 this.revision，中途插进来的一笔新编辑会让这次保存把"根本没写进
   * 磁盘的那一版"标记成已保存——与 save() 曾经的那个 bug 是同一形状。参数化之后
   * 宿主必须原样传回 rawForSave() 给出的值，不能自己现拼。
   *
   * 这个方法只做记账，跟 save() 末尾那一行做的事完全一样，只是搬出来给调用方在
   * 自己完成落盘之后触发——它自己不碰文件系统，不构成新的写路径。
   *
   * 刻意不挂 assertWritable()：调用它的前提是刚用 rawForSave() 生成的内容已经真实
   * 写盘成功，而 rawForSave() 内部已经做过 assertWritable() 检查，那一刻状态确实
   * 可写。VSCode 的写入路径中间隔着那两个 await，万一期间视图切到「原始结构」，
   * 在这里重复挂一次 assertWritable() 只会把一次已经真实写盘成功的保存上报成
   * 失败、savedRevision 还是没追上去——比现在要修的 bug 更糟。只需要
   * assertOpened()：没打开就没有意义的 revision 可言。
   */
  markSaved(revision: number): void {
    this.assertOpened()
    this.savedRevision = revision
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
      case 'spec/createNode':
        return this.createNode(params as CreateNodeParams) as Api[K]['result']
      case 'spec/save':
        return (await this.save()) as Api[K]['result']
      case 'spec/raw':
        return { markdown: this.raw() } as Api[K]['result']
      case 'spec/setGroup':
        return this.setGroup(params as SetGroupParams) as Api[K]['result']
      case 'spec/deleteGroup':
        return this.deleteGroup((params as { id: string }).id) as Api[K]['result']
      case 'spec/setLang':
        return this.setLang((params as SetLangParams).lang) as Api[K]['result']
      case 'file/read':
        return (await this.readFile((params as { path: string }).path)) as Api[K]['result']
      case 'view/setMode':
        return this.setViewMode((params as SetViewModeParams).mode) as Api[K]['result']
      case 'spec/undo':
        return this.undo() as Api[K]['result']
      case 'spec/redo':
        return this.redo() as Api[K]['result']
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

  private editResult(): EditResult {
    return {
      tree: this.tree(),
      dirty: this.isDirty(),
      groups: this.groupsSnapshot(),
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
    }
  }

  private nextRevision(): number {
    return ++this.revisionSeq
  }

  /**
   * spec 这里是深拷贝，**今天纯属防御**——四个编辑函数（setAnnotation/moveNode/
   * setGroup/deleteGroup）都是纯函数，各自 structuredClone 一份新的返回，从不就地
   * 改入参，所以直接存引用今天一条用例都判不到。别为它补一条"证明它有用"的用例，
   * 那条用例只能是假的。
   *
   * 留着的理由：它守的是将来那一步——一旦有人为了省一次克隆把某个编辑函数改成就地
   * 修改，栈里的历史会跟着被悄悄改写，而本工具唯一能造成的伤害正是弄丢人写的注释。
   * 代价也确实只是"再克隆一次"：编辑函数本来就要克隆一份，这里是同一数量级的常数
   * 倍，且与已标注节点数成正比，不是仓库文件数。
   *
   * hidden 则**必须**是副本，不是防御：move() 会就地 add/delete 同一个 Set，存引用
   * 的话栈里所有快照都会跟着变。
   */
  private captureState(): Snapshot {
    return {
      spec: structuredClone(this.spec),
      hidden: new Set(this.hidden),
      revision: this.revision,
    }
  }

  /**
   * 直接接管快照自己的那两个对象，不再拷贝一次——前提是**调用方必须先把它从栈里
   * pop 出来**（undo/redo 都是这么做的）。改成 peek 而不 pop 的话，后续一次 move()
   * 就会就地改掉仍留在栈里的那份 hidden，历史被悄悄改写。
   */
  private restoreState(s: Snapshot): void {
    this.spec = s.spec
    this.hidden = s.hidden
    this.revision = s.revision
  }

  /** 一次编辑提交后的收尾：入栈、清重做栈（标准语义）、领一个新的状态编号 */
  private commitEdit(before: Snapshot): void {
    this.pushUndo(before)
    this.redoStack = []
    this.revision = this.nextRevision()
  }

  private pushUndo(s: Snapshot): void {
    this.undoStack.push(s)
    if (this.undoStack.length > MAX_UNDO_DEPTH) this.undoStack.shift()
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
