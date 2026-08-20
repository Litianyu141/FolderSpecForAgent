import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'
import { parseSpec } from './parse/index.js'
import { serializeSpec } from './serialize.js'
import { scan, DEFAULT_DEPTH } from './scan.js'
import { gitStatus } from './git.js'
import { merge } from './merge.js'
import { copyNode, createNode, emptySpec, findSpecNode, isSelfOrDescendant, moveNode, removeNode, renameNode, setAnnotation, setGroup, deleteGroup, setLang } from './spec-edit.js'
import type { AnnotationPatch, GroupPatch } from './spec-edit.js'
import { readWorkspaceFile } from './file-read.js'
import type { FileReadResult } from './file-read.js'
import type { Api, ApiMethod, AnnotateParams, CopyNodeParams, CreateNodeParams, EditResult, MoveParams, OpenResult, RenameParams, SaveResult, SetGroupParams, SetLangParams, SetViewModeParams, ViewModeResult } from './api.js'
import type { ActualNode, GitStates, Group, Lang, ParseError, Spec, SpecNode, ViewMode, ViewNode } from './types.js'

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
      // 平台事实，不是从 root 的字面量里猜出来的——完整推导见 api.ts 的 OpenResult.sep
      sep: nodePath.sep,
      hasSpec,
      specPath: this.specPath,
      parseErrors: this.parseErrors,
      tree: this.tree(),
      groups: this.groupsSnapshot(),
      // 直接读 this.spec.lang：上面三个分支已经把 this.spec 定成了"这次 open() 该
      // 采用的那份 Spec"（解析成功是 parsed.value；没有文件/读失败/解析失败都是
      // emptySpec() 默认的 'zh'），不需要在这里重新分支——完整推导见 OpenResult.lang
      // 的字段注释（api.ts）。
      lang: this.spec.lang,
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
    // annotate 是第三条会往契约里写下一条路径的写路径（另两条是 createNode 与 move），
    // 此前完全没接这道闸门：往一个被拖走的旧位置（或它的子路径）上写注释会"写成功"，
    // raw() 里确实多出那一行，而 merge 在 spec 视图下把整条路径跳过——用户既看不见
    // 也点不到，本次会话里再也够不着自己刚写的字。"文件里还在、界面上够不着"与真的
    // 丢了在用户那边是同一件事，所以三条写路径必须用同一道闸门。
    this.assertNotHidden(path)
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
    // 与 createNode 共用同一道闸门：toParent 是不是"能安全新增一条声明的地方"，
    // 对 createNode 和 move 而言是同一个问题（都是往 toParent/parentPath 下面挂一条
    // 新的 spec 声明），两条写路径此前给出相反答案——createNode 会拒绝把节点声明
    // 挂到磁盘上的文件下面，move 却一直放行，是同一条不变量的两个不同实现，界面
    // 因此在说谎。见 assertCreatableParent 上方注释里对 hidden / 懒加载边界两条
    // 旁路检查的完整推导。
    this.assertCreatableParent(params.toParent)

    // to 必须在动手之前算出来：它既是下面 hidden 记账的键，也是"这次移动会在契约里
    // 写下哪一条路径"这个问题的答案，闸门要审的正是它。按段拼接（而不是字符串直接
    // 相连）是为了与 moveNode 内部的 toSegments 归一化保持一致——两边对同一次调用
    // 必须算出同一条路径，否则闸门审的是 A、写下去的是 B。
    const name = params.from.split('/').filter(Boolean).pop() ?? ''
    const to = [...params.toParent.split('/').filter(Boolean), name].join('/')

    // 结果路径闸门。allowHidden 这里必须是 true，是本函数与 createNode 之间**唯一**
    // 一处刻意的不对称：结果路径落在 hidden 上，对 move 而言恰恰是"把节点拖回它原来
    // 的位置"这个完全合法的动作，下面的 this.hidden.delete(to) 正是为它准备的；而对
    // createNode 而言没有任何合法解释，只能拒绝。
    this.assertDeclarableResult(to, this.movedIsDir(params.from, to, params.isDir), true)

    // 快照必须盖住下面对 hidden 的两处改动，不能只盖 spec——见 Snapshot 的注释
    const before = this.captureState()
    this.spec = moveNode(this.spec, params.from, params.toParent, params.isDir)

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
   * 在契约里给一个节点改名——"我声明这东西应该叫 X"，不是"去把磁盘上的文件改名"
   * （真正改名的是随后读契约的 Agent，见 CLAUDE.md 铁律 1）。除 `.folderspec.md`
   * 之外一个字节都不写。
   *
   * 与 move() 结构完全同构，七条配套动作一一对应、逐条照做——其中三条是 move 用真实
   * 缺陷换来的（改成同名照样隐藏 → 节点凭空消失；改回原名不解除隐藏 → 第二次凭空
   * 消失；快照只盖 spec → 节点被 hidden 永久挡住），改名会一模一样地踩到。
   *
   * 三道闸门全部接进 createNode / move / annotate 已经共用的那一套，不新写一份：
   * 同一条不变量有两个实现，两条写路径迟早给出相反的答案，界面就在说谎（e7a723f、
   * 06c7167 两次为这条原则付过代价）。
   *
   * **isDir 不进参数**（与 MoveParams / CreateNodeParams 唯一一处刻意的不同）：那两个
   * 方法在决定"新位置该是个什么东西"，调用方的声明带着信息；改名不改变一个节点是
   * 文件还是目录，这个值调用方只可能传错。所以在这里自己解析——契约里有这个节点就
   * 听契约的（与 movedIsDir 同一条优先级：现有数据高于调用方的声明），没有才问磁盘；
   * 两边都没有就报错，而不是随便猜一个：那条路径在树上根本没有对应的行。
   */
  rename(params: RenameParams): EditResult & { path: string } {
    this.assertWritable()
    const { path, newName } = params
    assertRepresentablePath(path)
    // 与 createNode 共用同一条名字规则：两处分叉就会出现"新建允许、改名拒绝"这种
    // 界面在说谎的情形（见 assertValidNodeName 上方对每一条禁令的推导）。
    assertValidNodeName(newName)

    const segs = path.split('/').filter(Boolean)
    if (segs.length === 0) throw new Error('不能重命名根节点')
    const parentSegs = segs.slice(0, -1)
    const parentPath = parentSegs.join('/')
    // 按段拼接（而不是字符串直接相连）：与 renameNode 内部的 toSegments 归一化保持
    // 一致，两边对同一次调用必须算出同一条路径，否则闸门审的是 A、写下去的是 B。
    const to = [...parentSegs, newName].join('/')

    // 源节点自己落在 hidden 上时拒绝。ancestorChain 逐级走完，所以这一句同时覆盖
    // "祖先被拖走"：那条路径连同它下面的一切在树上都不显示，给一个树上根本不存在的
    // 节点改名，写下去的是一条用户既看不见也删不掉的声明（与 annotate 同源）。
    this.assertNotHidden(path)
    // 结果路径 `parentPath/newName` 是一条**新增的声明**，"这个父级下面能不能安全地
    // 挂一条新声明"对 createNode、move、rename 是同一个问题，共用同一套判据。
    this.assertCreatableParent(parentPath)

    // 契约里有这个节点就听契约的，没有才问磁盘（见方法头部关于 isDir 的推导）。
    const inSpec = findSpecNode(this.spec.nodes, path)
    let diskIsDir = false
    if (!inSpec) {
      const { node: onDisk, unscanned } = lookupActual(this.actual, path)
      if (unscanned) {
        throw new Error(`\`${path}\` 尚未扫描到，无法确认它是文件还是目录；请先展开它所在的目录再重试`)
      }
      if (!onDisk) throw new Error(`契约里和磁盘上都没有 \`${path}\`，没有可以重命名的节点`)
      diskIsDir = onDisk.kind === 'dir'
    }

    // 撞名一律拒绝，绝不静默合并：把两个不同东西的注释揉到一起是不可逆的丢失，而
    // role/template/severity 三个字段根本没有"并"这个操作（完整推导见 spec-edit.ts
    // 的 assertNoMergeConflict）。契约侧那一半的判重在 renameNode() 里，与 createNode
    // 的同层重名共用同一条判据；这里补磁盘侧的另一半——磁盘上已经有一个叫这个名字的
    // 东西时，这条声明会让契约把两个不同的东西说成同一个。
    //
    // 两个例外必须放行，否则最普通的操作会被挡在门外：
    //   - `to === path`：用户在预填当前名字的输入框里直接回车，那不是撞名；
    //   - `to` 落在 hidden 上：那正是"把名字改回去"——磁盘上那一行此刻被藏着，
    //     下面的 this.hidden.delete(to) 就是为它准备的（与 assertDeclarableResult
    //     的 allowHidden 是同一条理由，也继承了它同一处已知的不精确：hidden 不记
    //     去向，工具分不出这条 hidden 是不是同一个节点留下的）。
    if (to !== path && !this.hidden.has(to)) {
      const { node: occupied, unscanned } = lookupActual(this.actual, to)
      // 这里与 assertDeclarableResult 对 unscanned 的取向刻意相反（那边放行）：那边
      // 未知时最多把 isDir 这一位写错，用户一展开就看到真相；这里未知时可能悄悄把
      // 一个节点的全部注释挂到磁盘上另一个真实存在的东西上，是不可逆的丢失。代价是
      // 用户要先展开那一层再重试，报错原文已经写明这条出路。
      if (unscanned) {
        throw new Error(`\`${to}\` 尚未扫描到，无法确认磁盘上有没有同名的东西；请先展开它所在的目录再重试`)
      }
      if (occupied) {
        throw new Error(
          `\`${to}\` 在磁盘上已经存在：改成这个名字会让契约把两个不同的东西说成同一个，` +
          '两边的注释也会被揉到一起。请换一个名字（本工具不会去动磁盘上的文件名）',
        )
      }
    }

    const candidate = renameNode(this.spec, path, newName, diskIsDir)

    // 真正的空操作：改成它现在的名字、且契约里本来就有这个节点时，什么都没变——
    // 不置脏、不吃一格撤销栈（与 removeNode / deleteGroup / setLang 同一条判据：
    // 一次什么都没改变的调用不该让界面显示"有未保存的改动"）。判据是"结果是否与
    // 当前逐字相同"而**不是**"newName 是不是原名"：对一个 actual-only 节点改成同名
    // 会真的多出一条声明，那不是空操作，下面那道 `to !== path` 的闸也正是为它准备的。
    if (specsEqual(candidate, this.spec)) return { ...this.editResult(), path: to }

    // 结果路径闸门。allowHidden 这里是 true，理由与 move 完全相同：结果路径落在
    // hidden 上正是"把名字改回原来那个"这个完全合法的动作。
    this.assertDeclarableResult(to, this.movedIsDir(path, to, diskIsDir), true)

    // 快照必须盖住下面对 hidden 的两处改动，不能只盖 spec——见 Snapshot 的注释
    const before = this.captureState()
    this.spec = candidate

    // 改回原名时必须先解除隐藏，否则该路径会同时在 actual 侧（磁盘上真实存在）和
    // spec 侧（契约又把它声明了回去）被 merge 跳过，节点第二次凭空消失。
    this.hidden.delete(to)

    // 只有名字真的变了才隐藏旧路径。改成同名时新旧路径相同，若照样加进 hidden，
    // merge 会把磁盘侧和 spec 侧双双跳过，节点就从界面上凭空消失（文件和契约其实
    // 都还在）——与 move() 拖回原父级那个缺陷是同一个形状。
    if (to !== path) this.hidden.add(path)

    this.commitEdit(before)
    return { ...this.editResult(), path: to }
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
    // 结果路径与 createNode() 纯函数算出来的那条必须逐字相同，否则闸门审的是一条、
    // 写进契约的是另一条。
    this.assertDeclarableResult([...parentPath.split('/').filter(Boolean), name].join('/'), isDir, false)
    const before = this.captureState()
    const created = createNode(this.spec, parentPath, name, isDir)
    this.spec = created.spec
    this.commitEdit(before)
    return { ...this.editResult(), path: created.path }
  }

  /**
   * 把一个节点在契约里**再声明一份**——右键「复制」/「粘贴」的写入侧。
   * 剪贴板本身不在这里：记的是"上次复制的是哪条路径"，纯粹的会话内 UI 状态，与
   * hidden 同类（open() 时清空、永不落盘），归 UI 管；core 侧只有这一个无状态方法。
   *
   * 与 rename() 一样走"三道闸门 + 快照 + 纯函数 + commitEdit"这条既有收口，**一道
   * 都不新写**（06c7167 把判据拆成 assertNotHidden / assertCreatableParent /
   * assertDeclarableResult 正是为此）。与 rename() 有三处刻意的不同，各有出处：
   *
   * 1. **不碰 hidden。** 复制不移走源节点，没有旧位置需要隐藏——rename/move 那七条
   *    配套动作里凡是围着 hidden 打转的，这里一条都不适用。对称地，
   *    assertDeclarableResult 的 allowHidden 传 false（与 createNode 同侧）：结果
   *    路径落在 hidden 上对 move/rename 是"把节点放回原处"这个合法动作，对复制没有
   *    任何合法解释——那是一条谁也看不见的声明。
   * 2. **撞名不拒绝，自动加后缀**（用户已裁定，控制器的顾虑记在报告里：契约里会出现
   *    用户没亲自取过的名字，而 Agent 会照着它真去建目录）。副作用是好的那一侧：
   *    名字唯一 ⇒ 粘贴永远走不到 moveNode 那条"合并到同名节点"的路，也就不可能覆盖
   *    掉谁已经写下的注释。
   * 3. **isDir 自己解析**（与 rename 同一条优先级：契约里有就听契约的，没有才问磁盘），
   *    参数里不给——复制不改变一个节点是文件还是目录，这个值调用方只可能传错。
   *
   * "粘进自己的子树"这一档必须**提前**判，不能等纯函数 copyNode 去抛：下面
   * uniqueCopyName 会先一步为"目标父级的子项尚未扫描"抛错，于是把 `src` 粘进未展开
   * 的 `src/core` 时用户收到的是"请先展开该目录"，展开之后才发现真正的原因是根本
   * 不该往那儿粘。判据本身仍然只有一份（spec-edit.ts 的 isSelfOrDescendant，
   * moveNode 用的是同一个）。
   */
  copyNode(params: CopyNodeParams): EditResult & { path: string } {
    this.assertWritable()
    const { from, toParent } = params
    assertRepresentablePath(from)
    assertValidParentPath(toParent)

    const fromSegs = from.split('/').filter(Boolean)
    if (fromSegs.length === 0) throw new Error('不能复制根节点')

    // 提前判，理由见方法头部；判据与 moveNode 共用 isSelfOrDescendant
    if (isSelfOrDescendant(from, toParent)) {
      throw new Error(
        '不能把节点粘贴到它自己或它的子树下：那会让这个节点声明自己内部还有一份自己，' +
        '再粘一次又翻一倍，而契约的消费者是会照着它真去建目录的 Agent',
      )
    }

    // 源节点落在 hidden 上时拒绝（ancestorChain 逐级走完，祖先被拖走也一并覆盖）。
    // 与 annotate / rename 同源：那条路径在树上根本不显示，用户以为自己复制的是眼前
    // 那棵子树，实际契约里那个位置早已空了，粘出来会是一条莫名其妙的空声明。
    this.assertNotHidden(from)
    // 结果路径是一条**新增的声明**，"这个父级下面能不能安全地挂一条新声明"对
    // createNode / move / rename / copy 是同一个问题，共用同一套判据。
    this.assertCreatableParent(toParent)

    // 契约里有这个节点就听契约的，没有才问磁盘（见方法头部关于 isDir 的推导）。
    const inSpec = findSpecNode(this.spec.nodes, from)
    let isDir: boolean
    if (inSpec) isDir = inSpec.isDir
    else {
      const { node: onDisk, unscanned } = lookupActual(this.actual, from)
      if (unscanned) {
        throw new Error(`\`${from}\` 尚未扫描到，无法确认它是文件还是目录；请先展开它所在的目录再重试`)
      }
      if (!onDisk) throw new Error(`契约里和磁盘上都没有 \`${from}\`，没有可以复制的节点`)
      isDir = onDisk.kind === 'dir'
    }

    const name = this.uniqueCopyName(toParent, fromSegs[fromSegs.length - 1], isDir)
    // 后缀本身安全，但源名字可能已经贴边（契约里长得出叫 ".." 的节点——annotate 不做
    // 逐段名字校验），加完后缀的结果必须自己也过这道关，与 createNode / rename 同一套。
    assertValidNodeName(name)

    // 按段拼接（而不是字符串直接相连）：与纯函数 copyNode 内部的 toSegments 归一化
    // 保持一致，两边对同一次调用必须算出同一条路径，否则闸门审的是 A、写下去的是 B。
    const to = [...toParent.split('/').filter(Boolean), name].join('/')
    // 今天这道闸拦不下任何东西——uniqueCopyName 已经把磁盘上占着的名字和 hidden
    // 占着的名字全让开了，磁盘类型冲突与 hidden 两项都无从触发。留着不是防御性代码，
    // 是纪律：**每条写路径写下的结果路径都必须过同一道闸**，让它成立的理由不该是
    // "另一个函数会先让开"——那正是 06c7167 之前那批缺陷的形状（同一条不变量两个
    // 实现，改动其中一个，另一处悄悄失效）。
    this.assertDeclarableResult(to, isDir, false)

    const before = this.captureState()
    const created = copyNode(this.spec, from, toParent, name, isDir)
    this.spec = created.spec
    this.commitEdit(before)
    return { ...this.editResult(), path: created.path }
  }

  /**
   * 副本落到 toParent 下面时该叫什么——撞名自动加后缀，像文件管理器那样。
   *
   * **序列是确定、可预期的**：`demo` → `demo-copy` → `demo-copy-2` → `demo-copy-3`。
   * 第一档不带数字（`demo-copy` 而不是 `demo-copy-1`），从第二档起追加 `-2`、`-3`，
   * 与 spec-edit.ts 里 uniqueId 给分组 id 去重的规则逐字同构——本仓库只该有一套
   * "冲突了怎么让"的写法。不冲突时**原样保留名字**，不无条件加后缀：粘到别的父级下
   * 本来就没有撞名这回事，凭空多一截 `-copy` 只是噪音。
   *
   * **文件的后缀加在扩展名之前**（`a.ts` → `a-copy.ts`，不是 `a.ts-copy`）：契约的
   * 消费者是会照着建文件的 Agent，`a.ts-copy` 会被建成一个没有扩展名的东西。目录不
   * 切扩展名（`my.dir` → `my.dir-copy`），点文件也不切（`.gitignore` 的那个点是名字
   * 的一部分，切了会得到 `-copy.gitignore`）。
   *
   * **冲突要同时看三处**，少查一处就等于承诺了一件做不到的事：
   *   1. 契约侧兄弟——同层同名是重复声明，解析器本来也会拒绝；
   *   2. **磁盘侧兄弟**——`src/demo-copy` 完全可能已经躺在磁盘上了。漏掉这一半，
   *      副本会与一个真实存在、内容毫不相干的目录合成同一行（origin 'both'），
   *      被复制来的整套注释就此挂到了别人身上（53c3ef6 那一轮为 rename 立的纪律）；
   *   3. **hidden**——本次会话里被拖走的旧位置。这一格契约侧与磁盘侧都查不出来
   *      （契约里那个节点已经搬走、磁盘上那一行被 merge 整个跳过），而落在上面的
   *      声明在树上永远不显示。让开一格就好，不必报错。
   *
   * 目标父级的**子项尚未扫描**时宁可报错，不猜。这里与 assertDeclarableResult 对
   * unscanned 的放行取向刻意相反，站在 rename 那一侧：那边未知时最多把 isDir 这一位
   * 写错，用户一展开就看到真相；这里未知时是"自动后缀"这个承诺本身失效——挑出来的
   * 名字可能正压在一个磁盘上真实存在的东西上，而整套被复制的注释会跟着挂过去，
   * 且**静默**。代价是右键一个还没展开过的目录粘贴时要先展开一次，报错原文写明了
   * 这条出路。根治要让这条写路径能按需扫描，那是另一件事（见 assertDeclarableResult
   * 末尾对同一件事的记载）。
   */
  private uniqueCopyName(toParent: string, sourceName: string, isDir: boolean): string {
    const specSiblings = toParent === ''
      ? this.spec.nodes
      : findSpecNode(this.spec.nodes, toParent)?.children ?? []
    const taken = new Set(specSiblings.map(n => n.name))

    const { node: parentOnDisk, unscanned } = lookupActual(this.actual, toParent)
    // unscanned 这一档今天够不着（assertCreatableParent 已经先一步拒绝了未扫描的
    // 父级），但两处判据不该靠"另一处会先拦下"来成立；children === undefined 那一档
    // 则是实打实可达的——右键一个从没展开过的目录就是它。
    if (unscanned || (parentOnDisk !== null && parentOnDisk.children === undefined)) {
      throw new Error(
        `\`${toParent}\` 的子项尚未扫描，无法确认磁盘上有没有同名的东西；请先展开该目录再重试`,
      )
    }
    for (const c of parentOnDisk?.children ?? []) taken.add(c.name)

    const prefix = toParent === '' ? '' : `${toParent}/`
    const free = (n: string): boolean => !taken.has(n) && !this.hidden.has(`${prefix}${n}`)

    if (free(sourceName)) return sourceName
    const { stem, ext } = splitCopyName(sourceName, isDir)
    for (let i = 1; ; i++) {
      const candidate = `${stem}-copy${i === 1 ? '' : `-${i}`}${ext}`
      if (free(candidate)) return candidate
    }
  }

  /**
   * hidden 记的是本次会话里被拖走节点的旧位置，merge 在 spec 视图下会把这条路径
   * **连同它下面的一切**整个跳过（不看磁盘、不看契约，见 merge.ts：命中 hidden 的
   * actual 节点直接 continue、fromSpec 直接返回 null）。在这样一条路径上写下声明，
   * 写盘会成功、raw() 里确实有那一行，但树上永远看不见——与 CLAUDE.md"唯一能造成
   * 的伤害是弄丢人写的注释"是同一类失效：内容还在文件里，用户却再也找不到、够不着。
   * hidden 只记旧位置、不记去向（spec §6.1 拖拽绝不记录来源，这里对称地也不该反向
   * 猜测去向），能做的只有据实拒绝。
   *
   * **必须逐级查祖先，不能只做精确匹配**：merge 那边 hidden 是对整棵子树生效的，
   * 这边只比较相等的话，hidden 路径的任意后代都能绕过去（终审实测：拖走 `src` 之后
   * `src/sub` 照样放行，声明与被搬过去的注释一起从树上消失）。同一条不变量在两处
   * 用了宽窄不同的判据，本身就是缺陷。
   */
  private assertNotHidden(path: string): void {
    for (const p of ancestorChain(path)) {
      if (this.hidden.has(p)) {
        throw new Error(
          `\`${p}\` 是本次会话里刚被拖走的旧位置，它和它下面的一切在树上都不显示；` +
          '在这里写下的声明用户既看不见也删不掉，请改用它现在所在的位置',
        )
      }
    }
  }

  /**
   * "这个父级下面能不能安全地挂一条新声明"——createNode 与 move 的 toParent 共用
   * （e7a723f 确立的原则：同一条不变量必须只有一个实现，否则界面在说谎）。
   *
   * "目录判断只信一个真相源"这条隐含假设在这里会出错：ensure()（setAnnotation 也在
   * 用）为了让路径能穿过去，会把 spec 侧的中间节点强行升级成目录；但 merge() 对
   * "磁盘和契约都有"的节点只信磁盘（merge.ts 的 fromActual 用 a.kind==='dir'，
   * 完全不看 spec 那份 isDir）。于是 parentPath 一旦是磁盘上真实存在的文件，
   * createNode 能成功返回、raw() 的自校验也能通过——写进契约的却是一行 UI 永远
   * 选不中、用户永远看不见也删不掉的声明，因为合成出来的树坚持认为那里是文件。
   * spec 里已经声明为文件的叶子也一并拒绝：不能因为一次"新建子项"的副作用，就
   * 悄悄把用户之前"这是个文件"的声明改写成目录。
   *
   * **三项检查都要逐级走完整条祖先链**，不能只审 parentPath 落到的那一个节点：
   * ensure() 是对**每一个**中间段做 `found.isDir = true` 的，一条 parentPath 多深
   * 一层，只审末段的闸门就完全绕过去了——契约里用户明确写下的"这是个文件"会被一次
   * 毫不相干的深层新建静默翻成目录，注释文字还留着，但它现在描述的是一个与自己矛盾
   * 的结构，正踩中"悄悄改掉一个标识符比报错更糟"（见本文件顶部）。
   */
  private assertCreatableParent(parentPath: string): void {
    this.assertNotHidden(parentPath)

    for (const p of ancestorChain(parentPath)) {
      // 这一级可能落在懒加载边界（DEFAULT_DEPTH）之下——此时磁盘扫描结果里既没有
      // 它、也没有证据证明它不存在，lookupActual 用 unscanned 把这种"还不知道"与
      // "确实没有"区分开（findActual 对两者给出同一个 null，分不出来）。
      //
      // 取向：宁可让用户多点一次"展开"重试，也不要在不知道的时候放行——一旦这一级
      // 真实存在且是文件，merge 会在下次展开时把它按磁盘判定为文件，挂在它下面的
      // 声明从树上永久消失（正是上一轮复审用真实 Session 复现出来的那条链路：
      // createNode 放行 → raw() 里有 child.md → expand 之后 child.md 从树上消失）。
      //
      // 代价：合法的深层声明——这一级磁盘上其实并不存在，纯粹是要往下声明新内容——
      // 如果恰好落在这个边界之下，也会被一并挡下，需要先展开那一层再重试。这个代价
      // 小于"悄悄产生一个用户看不见的结果"，而且在真实 UI 里根本走不到：parentPath
      // 只来自树上一个已经可见的节点，可见就意味着它自己已经被扫到了。
      const { node: onDisk, unscanned } = lookupActual(this.actual, p)
      if (unscanned) {
        throw new Error(`\`${p}\` 尚未扫描到，无法确认磁盘上是文件还是目录；请先展开该节点再重试`)
      }
      if (onDisk && onDisk.kind !== 'dir') {
        throw new Error(`\`${p}\` 在磁盘上是一个文件，不能在它下面新建节点`)
      }
      const inSpec = findSpecNode(this.spec.nodes, p)
      if (inSpec && !inSpec.isDir) {
        throw new Error(`\`${p}\` 在契约里被声明为文件，不能在它下面新建节点`)
      }
    }
  }

  /**
   * 闸门的另一半：**这次操作会在契约里写下的那条路径本身**能不能安全存在。
   * 上面那个函数只审父级，于是闸门恰好错了一层——管住了父，没管住子。
   *
   * 两项检查：
   *
   * 1. 落在 hidden 上（`allowHidden` 为 false 时）。理由与 assertNotHidden 完全相同，
   *    只是对象换成了结果路径：拖走 `src` 之后在根下新建 `src`，parentPath 是 ''、
   *    怎么查都干净，而写下去的那一行在树上永远不出现。祖先侧已经由
   *    assertCreatableParent 覆盖，这里只需补上"恰好等于某条 hidden"这一格。
   *
   * 2. 与磁盘的类型冲突。merge 对 origin='both' 的节点只信磁盘（fromActual 用
   *    a.kind），所以把磁盘上的文件 README.md 声明成目录时，**界面上零异常**——树上
   *    照旧是文件、右栏照旧写"文件"，用户以为这次点击什么都没发生；而契约里留下的是
   *    `- \`README.md/\``（尾斜杠 = 目录），契约的消费者是会照着 rm 掉再 mkdir 的
   *    Agent。反方向（把磁盘上的目录声明成文件）同样成立。这条与 1 不同：1 是"用户
   *    够不着自己写的东西"，2 是"契约携带一条 Agent 会照做的谎话"。
   *
   * 未扫描到（unscanned）时**放行**，与 assertCreatableParent 对父级的做法刻意不同。
   * 差别在两件事上：(a) 危害不同——父级未知时整条声明可能挂在一个文件下面、从树上
   * 彻底消失（红线）；结果路径未知时这条声明照样在树上显示、选得中、删得掉，可能出错
   * 的只有 isDir 这一位，而且用户一展开那层，merge 立刻按磁盘显示真相。(b) 代价不同
   * ——父级不可能未扫描（它来自树上一个可见节点），拒绝它零成本；而结果路径落在未扫描
   * 区里是**最普通不过的 UI 动作**：右键一个还没展开过的目录 →「新建目录」，它的
   * children 就还是 undefined。为这种情形抛"请先展开该节点再重试"，是拿一条红线级的
   * 措辞去挡一次完全正常的操作。代价：这一格里 isDir 与磁盘不符的谎话仍写得进契约，
   * 属于已知限制（要根治得让这条写路径能按需扫描，那是另一件事）。
   */
  private assertDeclarableResult(path: string, isDir: boolean, allowHidden: boolean): void {
    // allowHidden 只对 move 为 true：结果路径正好是某条 hidden，对 move 而言就是
    // "把节点拖回它原来的位置"这个完全合法的动作，move() 里的 this.hidden.delete(to)
    // 正是为它准备的；对 createNode 而言没有任何合法解释。
    if (!allowHidden && this.hidden.has(path)) {
      throw new Error(
        `\`${path}\` 是本次会话里刚被拖走的旧位置，在这里新建的声明不会显示在树上；` +
        '请改用它现在所在的位置',
      )
    }

    const { node: onDisk, unscanned } = lookupActual(this.actual, path)
    if (unscanned || !onDisk) return
    const diskIsDir = onDisk.kind === 'dir'
    if (diskIsDir !== isDir) {
      throw new Error(
        `\`${path}\` 在磁盘上是一个${diskIsDir ? '目录' : '文件'}，不能在契约里把它声明成${isDir ? '目录' : '文件'}：` +
        '树上只会按磁盘上的真实类型显示，界面看不出任何异常，而契约里留下的是一条 Agent 会照做的假声明',
      )
    }
  }

  /**
   * 这次移动落定之后，目标路径在契约里究竟会是目录还是文件——与 moveNode/mergeInto
   * 内部的优先级严格一致：契约里已有的源节点说了算（`detach(...) ?? { isDir }`：
   * 现有数据优先于调用方的声明），源节点不存在时才用调用方传来的 isDir；两侧任一带
   * 着子项，结果必然是目录（mergeInto 末尾那一行）。
   *
   * 磁盘冲突检查必须拿这个"最终值"去比。直接拿 params.isDir 比，会在"契约里的源节点
   * 与调用方声明不一致"时判错——闸门放行的是一个值、写进契约的是另一个值，正是这一
   * 族缺陷本身的形状。
   */
  private movedIsDir(from: string, to: string, declared: boolean): boolean {
    const src = findSpecNode(this.spec.nodes, from)
    const dst = findSpecNode(this.spec.nodes, to)
    if ((src?.children.length ?? 0) > 0 || (dst?.children.length ?? 0) > 0) return true
    return src ? src.isDir : declared
  }

  /**
   * removeNode 撤掉一条声明之后，回收 hidden 里因此变成孤儿的旧位置。
   *
   * hidden 只记旧位置、不记去向，它的有效性完全依赖一个**隐含前提**：被拖走的那个
   * spec 节点还活着。removeNode 可以把那个节点删掉（连同它整棵纯脚手架子树），却
   * 一直没有对称地撤掉 hidden 里对应的条目——于是磁盘上货真价实、装着文件的目录
   * 连同整棵子树从树上凭空消失，`tree/expand` 也拉不回来，本次会话里既看不见也无法
   * 给它或它的任何后代写注释。方向上是"弄丢人写的注释"这条红线的镜像：不是契约里有
   * 而树上没有，是磁盘上有而树上没有。move() 为对称场景专门写了 this.hidden.delete(to)，
   * 这里补上另一半。
   *
   * **判据为什么是 basename。** 不变量 2 明令禁止记录"从哪儿来"，所以工具没有任何
   * 数据能把"hidden 里的这条旧位置"与"契约里的哪个节点"对应起来。唯一可依赖、且由
   * moveNode 本身保证的事实是：移动不改名（`const name = fromSegs[fromSegs.length-1]`，
   * 落点用的是同一个 name）。所以被移除的子树里出现过的每一个名字，都可能是某条
   * hidden 的那个节点。
   *
   * **第二条判据：同层。** rename() 恰好废掉了上面那个前提——它换的正是名字，按名
   * 回收在改过名的节点上必然落空（hidden 里记着 `src/core`，契约里活着的却是
   * `src/kernel`），于是"改名 → 对新名字取消声明"会把上面那条红线原样放回来：磁盘上
   * 真实存在的整棵子树在本次会话里彻底够不着。rename 不换父级，改名前的旧位置与改名
   * 后的那条声明**永远是同层兄弟**，这就是同层这一格能补上的原因。它比按名回收更宽，
   * 会顺带解除同层里与这次移除无关的 hidden——按本函数一贯的取向（宁可多解除，不可
   * 少解除；多解除只是旧位置多显示一行，难看、可撤销、用户看得见），这个代价是可接受
   * 的一侧。
   *
   * **宁可多解除，不可少解除。** 多解除的最坏后果是旧位置多显示一行（节点在新旧两处
   * 同时出现，一处带标注一处不带）——难看、可撤销、用户看得见；少解除的后果是磁盘上
   * 真实存在的整棵子树在本次会话里彻底够不着，按本项目的定义等同于丢失。两种错误的
   * 量级不对等，判据就必须往"多解除"那一侧偏。
   *
   * 必须在 this.spec 被换掉**之前**调用：要数的是即将消失的那棵子树里有哪些名字。
   * 也必须在 captureState() **之后**——快照里的 hidden 得是这次操作之前的原样，
   * 撤销才能把隐藏一并还原回去（见 Snapshot 的注释）。
   */
  private releaseHiddenFor(removedPath: string): void {
    if (this.hidden.size === 0) return
    const removed = findSpecNode(this.spec.nodes, removedPath)
    if (!removed) return

    const names = new Set<string>()
    collectNames(removed, names)
    const removedParent = parentPathOf(removedPath)
    for (const h of [...this.hidden]) {
      const base = h.split('/').filter(Boolean).pop() ?? ''
      // 两条判据任一命中就回收：按名（move 留下的）或按同层（rename 留下的）。
      if (names.has(base) || parentPathOf(h) === removedParent) this.hidden.delete(h)
    }
  }

  /**
   * 撤销一个节点的声明——只影响 spec.nodes 这一条（及其被判定为纯脚手架的子树），
   * 不碰磁盘上的任何文件/目录。走与其他写方法完全相同的收口（assertWritable →
   * 快照 → 纯函数改 spec → commitEdit），因此也天然进撤销栈、天然被「原始结构」
   * 只读视图拦下、天然会被 raw()/save() 的自校验闸门保护。
   *
   * 子树保护、分组成员是否清理、路径不存在时是空操作——完整语义推导见 spec-edit.ts
   * 的 removeNode()。
   *
   * 路径不存在时的"空操作"必须是**真正**的空操作：不置脏、不进撤销栈。旧版本在这
   * 里无条件 commitEdit，理由是"与 Session.deleteGroup 对不存在 id 的既有行为保持
   * 一致"——复审裁定这个参照对象选错了：setLang 早就为同一个毛病改过（传入相同
   * 语言时不再置脏、不再吃一格撤销栈，见 254cdaf），项目已经裁定过"一次什么都没
   * 改变的调用不该置脏"，deleteGroup 带着这个怪癖是遗留缺陷，不是该被沿用的标准
   * （见下面 deleteGroup 的同款修复）。空操作置脏 = 界面告诉用户"有未保存的改动"，
   * 而其实一个字节都没变，这与本轮另外三条旁路是同一族"界面在说谎"问题。
   *
   * 判据用"纯函数返回的结果是否深度等于调用前"，而不是"路径存不存在"：removeNode()
   * 对空路径会抛错（"不能移除根节点"），如果改成调用前先用 findSpecNode 判断路径
   * 存不存在、"找不到就当空操作提前返回"，会把这个抛错场景误判成路径不存在、悄悄
   * 把一次本该报错的非法调用吞成了成功——那正是本项目一贯反对的"静默"。深度比较
   * 不需要在这里复述 removeNode() 内部到底在哪些条件下会提前返回不变的结果，纯
   * 函数以后再加新的空操作分支也不会让这里的判据过期。成本：多一次 JSON.stringify
   * 级别的深比较，量级与 captureState() 本来就要做的 structuredClone 相同（都与
   * 已标注节点数成正比，不是仓库文件数），不算新增的开销数量级。
   */
  removeNode(path: string): EditResult {
    this.assertWritable()
    assertRepresentablePath(path)
    const candidate = removeNode(this.spec, path)
    if (specsEqual(candidate, this.spec)) return this.editResult()
    const before = this.captureState()
    // 顺序要紧：captureState() 之后（快照里的 hidden 必须是这次操作之前的原样，
    // 撤销才还得回来）、this.spec 被换掉之前（要数的是即将消失的那棵子树）。
    this.releaseHiddenFor(path)
    this.spec = candidate
    this.commitEdit(before)
    return this.editResult()
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

  /**
   * id 在当前分组里找不到时是真正的空操作：不置脏、不进撤销栈——理由与判据的完整
   * 推导见上面 removeNode() 的注释。这里改用"存在性预判"而不是 removeNode 那种
   * "算出结果再比较"：deleteGroup 的纯函数实现只是 `filter(g => g.id !== id)`，
   * 没有 removeNode 那种"参数本身非法就该抛错"的分支，"id 是否存在于 groups 里"
   * 与"结果是否会变化"完全等价，不必再算一遍结果、比较两份 Spec 的开销。这一步
   * 参照的是 Session.setLang 已有的写法（254cdaf）：先判断"这次调用改不改变
   * 任何东西"，改变才走 captureState → 纯函数 → commitEdit。
   */
  deleteGroup(id: string): EditResult {
    this.assertWritable()
    if (!this.spec.groups.some(g => g.id === id)) return this.editResult()
    const before = this.captureState()
    this.spec = deleteGroup(this.spec, id)
    this.commitEdit(before)
    return this.editResult()
  }

  /**
   * 切换样板文字（标题行、导言、四个章节标题）的语言。走与其他四个写方法基本相同的
   * 收口（assertWritable → 快照 → 纯函数改 spec → commitEdit），因此也天然进撤销栈、
   * 天然被「原始结构」只读视图拦下、天然会被 raw()/save() 的自校验闸门保护——见
   * spec-edit.ts 的 setLang() 关于"未改过才换"判据的完整推导。
   *
   * 唯一的例外：传入的 lang 与当前相同时提前返回，不调用 commitEdit。这里和其他
   * 四个写方法（annotate/move/setGroup/deleteGroup 等）故意不一致——那几个"传相同
   * 的值"本来就需要用户主动重新输入一遍，谁会误触不用管；语言开关是双态控件，当前
   * 选中项通常常驻可点，点一下自己已经在的语言是很容易被误触的操作。而且这里判断
   * 安全：lang === this.spec.lang 时 setLang() 是纯函数级别真正的恒等变换（内部
   * from/to 落到同一份 LANG_DEFAULTS 条目，title/preamble 逐字不变），提前返回不会
   * 漏做任何该做的事。
   */
  setLang(lang: Lang): EditResult {
    this.assertWritable()
    if (lang === this.spec.lang) return this.editResult()
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
      case 'spec/rename':
        return this.rename(params as RenameParams) as Api[K]['result']
      case 'spec/createNode':
        return this.createNode(params as CreateNodeParams) as Api[K]['result']
      case 'spec/copyNode':
        return this.copyNode(params as CopyNodeParams) as Api[K]['result']
      case 'spec/removeNode':
        return this.removeNode((params as { path: string }).path) as Api[K]['result']
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

/**
 * 把一条路径拆成"每一级祖先，加它自己"，根（''）给出空数组：
 * 'a/b/c' → ['a', 'a/b', 'a/b/c']。
 *
 * 丙 那四个缺口里有三个是同一句话的不同说法："判据只认整条路径落到的那一个节点，
 * 不看中间层"。ensure() 与 merge 的 hidden 都是对整条链/整棵子树生效的，闸门这边
 * 也必须逐级走一遍，否则路径多深一层就绕过去了。
 */
function ancestorChain(path: string): string[] {
  const segs = path.split('/').filter(s => s !== '')
  return segs.map((_, i) => segs.slice(0, i + 1).join('/'))
}

/** 一条路径的父级路径，根下的节点给出 ''。供 releaseHiddenFor 的"同层"判据用，
 *  推导见那里。 */
function parentPathOf(path: string): string {
  return path.split('/').filter(s => s !== '').slice(0, -1).join('/')
}

/**
 * 把一个名字拆成"加后缀的那一半"和"必须留在后面的扩展名"。供 uniqueCopyName 用，
 * 完整推导（为什么目录不切、点文件不切）见那里。
 *
 * 判据是 `lastIndexOf('.') > 0`，不是 `> -1`：下标 0 的那个点属于 `.gitignore`
 * 这种"整体就是名字"的点文件，切了会得到 `-copy.gitignore`——后缀跑到最前面，
 * 名字面目全非。多重扩展名（`a.d.ts`）只切最后一段，得到 `a.d-copy.ts`：与文件
 * 管理器一致，也不需要一份"哪些是复合扩展名"的清单（那种清单永远不全）。
 */
function splitCopyName(name: string, isDir: boolean): { stem: string; ext: string } {
  if (isDir) return { stem: name, ext: '' }
  const i = name.lastIndexOf('.')
  if (i <= 0) return { stem: name, ext: '' }
  return { stem: name.slice(0, i), ext: name.slice(i) }
}

/** 一棵 spec 子树里出现过的全部节点名（含根自己）。供 releaseHiddenFor 用，判据的
 *  推导见那里。 */
function collectNames(n: SpecNode, out: Set<string>): void {
  out.add(n.name)
  for (const c of n.children) collectNames(c, out)
}

function findActual(node: ActualNode, path: string): ActualNode | null {
  if (node.path === path) return node
  for (const c of node.children ?? []) {
    const hit = findActual(c, path)
    if (hit) return hit
  }
  return null
}

/**
 * 沿路径逐段查找磁盘节点，同时区分"这段路径磁盘上确实没有"与"还不知道，因为
 * 半路上某一级目录尚未扫描"（ActualNode.children === undefined，见 scan.ts 的
 * 懒加载边界：DEFAULT_DEPTH 决定 walk() 递归几层，超出的那层节点会作为条目
 * 出现在父级的 children 里，但它自己的 children 保持 undefined）。
 *
 * findActual() 原来的实现（上面）对这两种情况给出同一个 null，assertCreatableParent
 * 若照单全收，会把"没扫到"误判成"磁盘上真没有"——见该方法上方的讨论。
 *
 * 用逐段下潜而不是 findActual 那种全树 DFS：既更直接（路径本就是分段的），也顺带
 * 让"半路撞上未扫描目录"这件事在遍历过程中自然可见，不需要额外再跑一遍判断。
 */
function lookupActual(node: ActualNode, path: string): { node: ActualNode | null; unscanned: boolean } {
  if (path === '') return { node, unscanned: false }
  let cur = node
  for (const seg of path.split('/')) {
    if (seg === '') continue
    if (cur.children === undefined) return { node: null, unscanned: true }
    const next = cur.children.find(c => c.name === seg)
    if (!next) return { node: null, unscanned: false }
    cur = next
  }
  return { node: cur, unscanned: false }
}

/**
 * 两份 Spec 是否深度相同——供 Session.removeNode 判断一次调用是否真的改变了契约。
 * removeNode()（spec-edit.ts）统一走 structuredClone，即便什么都没删也会返回一个
 * 新对象，不能靠 "===" 判断有没有变化。
 *
 * Spec 是不含函数/Date/循环引用的普通可 JSON 化数据（见 types.ts），且这里比较的
 * 两侧都源自同一份原始对象——一侧是 structuredClone 出来的候选结果，另一侧是当前
 * this.spec 本身——序列化后逐字节比较即可，不需要为了这一处引入一整个深比较库。
 */
function specsEqual(a: Spec, b: Spec): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
