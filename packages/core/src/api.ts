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
  /**
   * 本平台的路径分隔符（`nodePath.sep`）：POSIX 是 `'/'`，Windows 是 `'\'`。
   *
   * 存在的唯一理由是 UI 要把 `root`（平台原生的绝对路径）和 `ViewNode.path`
   * （**恒用 `'/'`**，不随平台变）拼成一条能粘进终端的绝对路径——右键菜单的
   * 「复制路径」。直接拼会在 Windows 上得到 `C:\repo/src/a.ts` 这种混合物。
   *
   * 由 core 如实告知，而不是让 UI 从 root 里"含不含 `\` "反推：那是个启发式，
   * 而 POSIX 完全允许目录名里带反斜杠（`mkdir 'we\ird'`），这种目录一旦出现在
   * root 里，反推就会把整条路径的分隔符判错。判错的代价是**静默**的——复制出去
   * 的是一条看着像模像样、实际不存在的路径，用户粘到终端里才发现，而那时他早已
   * 认定"复制成功了"。一个平台事实只有 node 侧知道，就由 node 侧说出来。
   *
   * 只描述"绝对路径怎么拼"。契约里的相对路径**永远是 `'/'` 分隔**，与这个字段无关——
   * 那是 .folderspec.md 自己的书写规范，不是操作系统的事。
   */
  sep: string
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

/**
 * 没有 isDir——这是与 MoveParams / CreateNodeParams 唯一一处刻意的不同。那两处是在
 * 决定"新位置该是个什么东西"，调用方的声明带着信息；改名不改变一个节点是文件还是
 * 目录，这个值调用方只可能传错，于是由 Session 自己解析（契约里有就听契约的，没有
 * 才问磁盘）——少一个能传错的参数，就少一格"闸门审的是 A、写下去的是 B"。
 */
export interface RenameParams {
  /** 被改名节点当前的完整路径 */
  path: string
  /** 新名字，单个路径段，不是路径——不能含 "/"（校验与 CreateNodeParams.name 完全一致） */
  newName: string
}

/**
 * 没有 isDir——与 RenameParams 同一条理由：复制不改变一个节点是文件还是目录，这个值
 * 调用方只可能传错，于是由 Session 自己解析（契约里有就听契约的，没有才问磁盘）。
 * 也没有 newName：落点名字由 core 算（撞名自动加后缀），UI 不该自己拼一个再让 core
 * 校验——两边一旦分叉，闸门审的是 A、写下去的是 B。
 */
export interface CopyNodeParams {
  /** 被复制节点当前的完整路径（"剪贴板"里记的那一条） */
  from: string
  /** 粘到哪个父目录下；'' 表示工作区根。语义与 CreateNodeParams.parentPath 完全一致 */
  toParent: string
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
  /**
   * toParent 与 spec/createNode 的 parentPath 走同一道"能不能在这里新增声明"的检查
   * （Session.assertCreatableParent）：拒绝磁盘上是文件、本次会话刚被拖走（hidden）、
   * 或落在懒加载边界之下尚未扫描这三种情形——否则 move 会成功、落盘也确实写进这条
   * 声明，但树上永远看不见，等于用户拖完之后连自己刚拖过去的节点都找不到。
   */
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
   * 在契约里给一个节点改名——"我声明这东西应该叫 X"，不是"去把磁盘上的文件改名"
   * （真正改名的是随后读契约的 Agent，见 CLAUDE.md 铁律 1）。磁盘上的文件名一个字
   * 都不会变；旧名字那一行在本次会话里被藏起来（hidden，临时 UI 状态、永不落盘），
   * 新名字以 spec-only（虚线）出现。契约里**不记录"原来叫什么"**：那是一次性操作
   * 记录，一被执行就过期（铁律 2）。
   *
   * 对任何节点都可用，不限于已声明过的：对 actual-only 节点改名等于"我声明这东西
   * 应该叫 X"，与 spec/move 对未声明节点的既有行为一致。
   *
   * 撞名一律拒绝、不静默合并——无论同名的那个是在契约里还是在磁盘上。静默合并会把
   * 两个不同东西的注释揉到一起，那是不可逆的丢失；名字校验（空名、含 "/"、反引号、
   * 换行、"." / ".."）与 spec/createNode 共用同一套判据。父级链条、结果路径两道闸门
   * 也与 spec/createNode、spec/move 共用（Session.assertCreatableParent /
   * assertDeclarableResult）。
   *
   * 结果里的 path 是改名后的完整路径，供 UI 重新选中它——与 spec/createNode 同理，
   * 自己拼 parentPath + name 会踩"根路径是 ''"的不一致。
   */
  'spec/rename': { params: RenameParams; result: EditResult & { path: string } }
  /**
   * 把一个节点在契约里**再声明一份**——右键「复制」/「粘贴」。"我声明那儿也该有一个
   * 这样的东西"，不是"去把文件拷过去"（真正动磁盘的是随后读契约的 Agent，见
   * CLAUDE.md 铁律 1）。磁盘上不会多出任何目录或文件，副本以 spec-only（虚线）出现。
   *
   * **复制的是契约子树，不是磁盘子树。** 源节点在契约里没有条目时（右键一个磁盘上
   * 真实存在、却从没被标注过的目录），粘出来的是一条不带任何内容的空声明——绝不去
   * 遍历磁盘把它的真实子结构灌进契约，那会直接破掉"稀疏覆盖层"（CLAUDE.md 不变量 3：
   * 契约只含被人工标注过的节点及其父级链条，不是仓库镜像）。完整推导见 spec-edit.ts
   * 的 copyNode()。
   *
   * **撞名自动加后缀**，不拒绝、也不合并：`demo` → `demo-copy` → `demo-copy-2`，
   * 文件的后缀加在扩展名之前（`a.ts` → `a-copy.ts`）。冲突同时看契约侧兄弟、磁盘侧
   * 兄弟与本次会话的 hidden 三处（见 Session.uniqueCopyName）。因为名字保证唯一，
   * 粘贴永远不会走 move 那条"合并到同名节点"的路，也就不可能覆盖掉谁已经写下的内容。
   *
   * **副本不继承分组归属**：分组是"这几条具体路径共享一条约束"的断言，复制一下就把
   * 范围静默扩一圈是调用方没要求过的副作用（用户已裁定）。
   *
   * **不碰 hidden**：复制不移走源节点，没有旧位置需要隐藏——这是与 spec/move 的关键
   * 区别。契约里同样**不记录"这份是从哪儿复制来的"**：那是一次性操作记录，一被执行
   * 就过期（铁律 2）。
   *
   * 结果里的 path 是副本**实际**落到的完整路径（可能带了自动后缀），供 UI 选中它——
   * 与 spec/createNode、spec/rename 同理，自己拼 toParent + 名字既踩"根路径是 ''"的
   * 不一致，也根本猜不到后缀。
   */
  'spec/copyNode': { params: CopyNodeParams; result: EditResult & { path: string } }
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
   * 路径不存在时是空操作：不报错，也不置脏、不进撤销栈——真正什么都没改变的调用
   * 不该让界面显示"有未保存的改动"，与 spec/deleteGroup 对不存在 id 的行为、
   * spec/setLang 传入相同语言时的行为都是同一条判据（见 Session.removeNode /
   * Session.deleteGroup 的实现注释）。
   * 分组成员不会被一并清理，见 removeNode() 上方"分组成员留作悬空"一节。
   */
  'spec/removeNode': { params: { path: string }; result: EditResult }
  'spec/save': { params: Record<string, never>; result: SaveResult }
  'spec/raw': { params: Record<string, never>; result: { markdown: string } }
  'spec/setGroup': { params: SetGroupParams; result: EditResult & { id: string } }
  /** id 不存在时是空操作：不置脏、不进撤销栈——见 spec/removeNode 上方关于这条判据的说明。 */
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

/**
 * params 里一个值的取值。`string | number` 是数据（路径、名字、行号、用户原文），
 * 两种语言下原样显示；`readonly WireError[]` 是**一串还没被渲染成任何语言的明细**
 * ——我们自己写的话，渲染必须推迟到显示那一刻。
 *
 * **一条明细就是嵌在别人 params 里的一条 WireError**，所以这里自引用，不另起一个
 * 结构等价的 `WireErrorDetail`：三个字段的语义、"message 是永远有一句能显示的话"
 * 这条地板、"有 code 就可翻译"这条约定，在任何一层都逐字成立。多造一个同构类型只会
 * 让线上契约出现两套等价的递归定义，而且没有任何测试能把它们绑在一起。
 */
export type WireErrorParamValue = string | number | readonly WireError[]

/**
 * 错误在**线上**的形状。
 *
 * 今天错误跨 bridge 只是一个裸字符串（`msg.error`，UI 侧 `new Error(msg.error)` 还原，
 * 见 ui/src/ws-bridge.ts 与 vscode/src/editor.ts），于是界面横幅上永远只能显示 core
 * 当初写死的那句话——语言开关管不到它。这个类型是那条线的**目标形状**：core 抛出的
 * SpecError（见 core/src/errors.ts）带着 code 与 params 过桥，UI 按 code 查中文字典，
 * 查不到就退回 `message`。
 *
 * 字段取向：
 *
 * - **`message` 必填，`code` / `params` 可选。** 不是所有错误都是 SpecError——宿主
 *   自己的失败（端口占用、WorkspaceEdit 被拒）、以及 core 里那些"只有调用方违约才
 *   触达"的普通 Error，都只有一句 message。收端因此**永远**先有一句能显示的话，
 *   带不带码只影响它能不能被翻译，不影响它能不能被显示。
 * - **`code` 是 `string`，不是 `SpecErrorCode`。** 这是从进程外收来的数据，不可信；
 *   收端要做的是"字典里查得到就用中文，查不到就用 message"，那本来就是一次运行期
 *   查表，不需要（也不该假装）编译期的枚举保证。
 *
 * 本轮**只定义形状，不改宿主与 UI 的实现**——接线是第二轮的事。放在 api.ts 是因为
 * 这里是唯一一处 core 与 ui 共同认识的类型契约，且本文件零 node 依赖，UI 直接 import
 * 得到（`@folderspec/core/api`）。
 */
export interface WireError {
  /** 人能读的一句话。core 的 SpecError 给的是英文渲染结果，宿主自己的错就是它自己的文案 */
  message: string
  /** 点分命名空间的错误码，存在即表示这是一条 core 定义过的、可翻译的错误 */
  code?: string
  /** 渲染 message 用过的那组值（路径、名字、以及可能的一串明细）。翻译时按同名占位符 `{xxx}` 代回去 */
  params?: { readonly [key: string]: WireErrorParamValue }
  /**
   * 只有**解析层的明细**带行号（一条 ParseError 嵌进 params 时就长这样），顶层错误
   * 用不到它。行号绝不进文案，由显示端自己拼成 "line N: " / "第 N 行："——两种语言
   * 下必须是同一个数字，那是"解析失败 → 只读 + 报行号"里"能定位"的那一半。
   */
  line?: number
}

export type BridgeEvent = 'spec-changed' | 'scan-progress' | 'external-change'

export interface Bridge {
  request<K extends ApiMethod>(method: K, params: Api[K]['params']): Promise<Api[K]['result']>
  on(event: BridgeEvent, cb: (payload: unknown) => void): () => void
}
