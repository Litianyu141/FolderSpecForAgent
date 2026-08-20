import type { Group, Lang, ParseError, Severity, ViewMode, ViewNode } from './types.js'
import type { FileReadResult } from './file-read.js'

export type { GitState, Group, Lang, NodeOrigin, ParseError, Severity, Spec, SpecNode, ViewMode, ViewNode } from './types.js'
export type { FileReadResult } from './file-read.js'

/**
 * 没有 canUndo / canRedo：open() 会清空撤销栈（见 Session.open），两者此处恒为
 * false，不携带信息；加上必填字段还会打红 ui 的 typecheck。接 workspace/open 的
 * UI 请自行把撤销/重做按钮按 false 复位——理由见 EditResult.canUndo 的字段注释。
 */
export interface OpenResult {
  root: string
  rootName: string
  hasSpec: boolean
  specPath: string
  /** 非 null 表示契约文件解析失败，当前处于只读模式 */
  parseErrors: ParseError[] | null
  tree: ViewNode
  /** 当前契约里的全部分组。UI 需要完整的 text/severity，ViewNode.groups 只有 id */
  groups: Group[]
  /**
   * 刚载入的契约的展示语言，取自 Session.spec.lang——不是猜出来的，是这次 open()
   * 实际采用的那份 Spec 真实携带的值。没有它，UI 的语言开关拿不到正确初态：载入一份
   * `lang: en` 的契约后，开关会停在与文件内容不符的语言上，用户第一次点它其实是在
   * "切回" 而不是"切到"，体验上等于开关一直显示错的那一侧。
   *
   * 三种载入结局，值分别来自：
   * - 解析成功：`parsed.value.lang`——契约文件 front-matter 里写的那个（缺省时
   *   parser 按 'zh' 补齐，见 parse/index.ts）。
   * - `hasSpec === false`（仓库里还没有 `.folderspec.md`）：`emptySpec()` 的默认值
   *   `'zh'`。这里没有"文件内容"可言，'zh' 只是本工具一贯的默认语言，不是猜测。
   * - 解析失败（只读模式，`parseErrors !== null`）：同样是 `emptySpec()` 的默认值
   *   `'zh'`，**不是**试图从读不懂的原始字节里嗅探这份契约"看起来"是哪种语言。
   *   这里特意不做嗅探：一份解析失败的文件很可能只是格式坏了，其余内容仍是完整的
   *   某种语言，嗅探错了会让 UI 显示一个"看似有依据、实则读错"的语言，比老老实实给
   *   一个双方都心知肚明的默认值更容易误导人（只读模式下语言开关本就不可编辑，
   *   这个值目前只用于显示，给错比给默认更糟）。
   *
   * 三种情形对应的 Session 内部状态都是同一件事——`this.spec` 就是上面选中的那份
   * Spec，所以实现上直接读 `this.spec.lang`，不需要在 open() 里分支处理。
   */
  lang: Lang
}

export interface AnnotateParams {
  path: string
  isDir: boolean
  annotation?: string | null
  role?: string | null
  template?: string | null
  severity?: Severity | null
}

export interface MoveParams {
  from: string
  toParent: string
  isDir: boolean
}

export interface CreateNodeParams {
  /** 挂在哪个父目录下；'' 表示挂在根下。父级链条在契约里若还不存在会按需补齐（同 spec/annotate）。 */
  parentPath: string
  /** 单个路径段，不是路径——不能含 "/" */
  name: string
  isDir: boolean
}

export interface EditResult {
  tree: ViewNode
  dirty: boolean
  /** 当前契约里的全部分组。UI 需要完整的 text/severity，ViewNode.groups 只有 id */
  groups: Group[]
  /**
   * 撤销 / 重做栈当前是否非空，供 UI 置灰按钮。
   *
   * 语义**只是"栈里有没有东西"**，不含"现在允许不允许写"。只读态（契约解析失败、
   * 「原始结构」视图）是另一件事，已经分别由 OpenResult.parseErrors 与 ViewModeResult.mode
   * 告诉 UI，且 UI 在那两种状态下本来就要禁掉全部编辑入口。把只读判断也揉进这两个
   * 布尔量，等于把同一条规则实现两遍，两处一旦分叉界面就在说谎。
   *
   * 注意 OpenResult 里没有这两个字段：workspace/open 会清空历史（见 Session.open），
   * 之后两者恒为 false，UI 收到 open 结果时直接按 false 复位即可。
   */
  canUndo: boolean
  canRedo: boolean
}

/**
 * dirty 是保存落地那一刻的真值，不是调用方的假定。两个宿主的消息回调都不排队
 * （cli/src/server.ts 的 `socket.on('message', async ...)`、vscode/src/editor.ts 的
 * `onDidReceiveMessage`）：spec/save 横跨落盘的那个 await（CLI 是 fs.writeFile；
 * VSCode 是 WorkspaceEdit + document.save()）期间完全可能又落地一笔 spec/annotate
 * / move / setGroup / deleteGroup。core 侧用捕获时的 revision 记账
 * （Session.rawForSave/markSaved）已经能正确识别这种情况——此刻的 dirty 完全可能
 * 仍是 true，因为那笔新编辑从未被这次保存写进磁盘。调用方必须回填这个值，而不是
 * 在 spec/save 成功后无条件把界面上的脏标记抹掉，否则用户会以为存好了、关窗即丢。
 *
 * 没有 canUndo / canRedo：save() 自己不碰撤销/重做栈，那两个值在保存前后不变——
 * 若保存期间恰好插入了一笔新编辑，那笔编辑自己的 EditResult 早已把它们更新到位，
 * 这里再重复携带一遍只是在复述别处已经正确的值，不带来新信息。
 */
export interface SaveResult {
  written: boolean
  dirty: boolean
}

export interface SetGroupParams {
  /** null 表示新建并自动取名，实际 id 由 result 返回 */
  id: string | null
  members: string[]
  /** 用户手填的组名；省略或全为空白则沿用 id 或自动取名 */
  name?: string | null
  text?: string | null
  severity?: Severity | null
}

export interface SetViewModeParams {
  mode: ViewMode
}

export interface SetLangParams {
  lang: Lang
}

export interface ViewModeResult {
  tree: ViewNode
  mode: ViewMode
}

export interface Api {
  'workspace/open': { params: { root: string }; result: OpenResult }
  'tree/get': { params: Record<string, never>; result: { tree: ViewNode } }
  'tree/expand': { params: { path: string }; result: { tree: ViewNode } }
  'spec/annotate': { params: AnnotateParams; result: EditResult }
  'spec/move': { params: MoveParams; result: EditResult }
  /**
   * 在契约里声明一个尚不存在的目录/文件——"这里应该有"，不是"去创建它"（真正建它的是
   * 读契约的 Agent，见 CLAUDE.md 铁律 1）。不产生任何文件系统写入，新节点在 merge 里
   * 自然呈现为 spec-only（虚线），与拖拽间接产生的空节点走的是同一条呈现路径。
   *
   * 结果里的 path 是新节点的完整路径，供 UI 选中它 / 直接进入重命名态——新建之后
   * 用户几乎总是紧接着要么改名、要么补一句注释，没有这个字段 UI 得自己拼 parentPath
   * 和 name，一旦两边拼接规则（'' 表示根）不一致就会选中错误的节点。
   */
  'spec/createNode': { params: CreateNodeParams; result: EditResult & { path: string } }
  /**
   * 从契约里撤销一个节点的声明——"不再声明这里应该有它"，不是删除磁盘上的文件/目录
   * （真正动磁盘的是随后读契约的 Agent，见 CLAUDE.md 铁律 1）。对磁盘上真实存在的
   * 节点而言，它依旧会出现在树上（只是不再带任何标注）；只有对 spec-only 节点（磁盘
   * 上不存在），移除才等于这一行彻底从树上消失。
   *
   * 若目标节点的子树里有任何后代带着用户内容（annotation/role/template/severity），
   * 会抛错拒绝——移除一个目录节点必然连带移除它嵌套的全部子节点，无条件级联等于
   * 一次点击丢掉多条用户或 Agent 已经写下的声明。想清空整棵子树，请自底向上对每个
   * 带内容的子节点分别调用一次；完整推导见 spec-edit.ts 的 removeNode()。
   *
   * 路径不存在时是空操作，不报错（与 spec/deleteGroup 对不存在 id 的既有行为一致）。
   * 分组成员不会被一并清理，见 removeNode() 上方"分组成员留作悬空"一节。
   */
  'spec/removeNode': { params: { path: string }; result: EditResult }
  'spec/save': { params: Record<string, never>; result: SaveResult }
  'spec/raw': { params: Record<string, never>; result: { markdown: string } }
  'spec/setGroup': { params: SetGroupParams; result: EditResult & { id: string } }
  'spec/deleteGroup': { params: { id: string }; result: EditResult }
  /**
   * 切换我们生成的样板文字（标题行、导言、四个章节标题）的语言。用户写的内容——节点
   * 注释、分组说明、规则文字、模板描述与名字、语义角色、节点名、路径——一个字都不动，
   * 只有逐字等于切换前那个语言默认值的标题/导言才会跟着换（见 spec-edit.ts 的 setLang）。
   *
   * 归在 `spec/` 而不是 `view/`：它改的是 Spec 本身（lang 字段与可能被替换的
   * title/preamble），要落盘、要经过 assertWritable()、要进撤销栈——与 view/setMode
   * 那种纯显示、不碰 Spec 的操作是两类不同的东西（对比 view/setMode 上的注释）。
   *
   * 传入的 lang 与当前相同时是真正的空操作：不置脏、不进撤销栈，`result.dirty`/
   * `canUndo` 原样反映调用前的状态（见 Session.setLang）。语言开关多半是双态控件，
   * 当前选中项常驻可点，UI 侧不需要在调用前自己判断"是不是已经是这个语言了"。
   */
  'spec/setLang': { params: SetLangParams; result: EditResult }
  'file/read': { params: { path: string }; result: FileReadResult }
  /** 切换「原始结构 / 我的结构」显示模式。纯显示状态，不写盘、不置 dirty（见 Session.setViewMode）。 */
  'view/setMode': { params: SetViewModeParams; result: ViewModeResult }
  /**
   * 退回 / 重做**一次已提交的编辑**（annotate、move、setGroup、deleteGroup、removeNode
   * 各算一步）。
   * 只动内存里的 Spec 与 hidden，不产生任何文件写入；栈空时是空操作而非报错
   * （见 Session.undo）。
   */
  'spec/undo': { params: Record<string, never>; result: EditResult }
  'spec/redo': { params: Record<string, never>; result: EditResult }
}

export type ApiMethod = keyof Api

export type BridgeEvent = 'spec-changed' | 'scan-progress' | 'external-change'

export interface Bridge {
  request<K extends ApiMethod>(method: K, params: Api[K]['params']): Promise<Api[K]['result']>
  on(event: BridgeEvent, cb: (payload: unknown) => void): () => void
}
