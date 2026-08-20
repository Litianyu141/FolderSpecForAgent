import type { Group, ParseError, Severity, ViewMode, ViewNode } from './types.js'
import type { FileReadResult } from './file-read.js'

export type { GitState, Group, NodeOrigin, ParseError, Severity, Spec, SpecNode, ViewMode, ViewNode } from './types.js'
export type { FileReadResult } from './file-read.js'

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
  'spec/save': { params: Record<string, never>; result: { written: boolean } }
  'spec/raw': { params: Record<string, never>; result: { markdown: string } }
  'spec/setGroup': { params: SetGroupParams; result: EditResult & { id: string } }
  'spec/deleteGroup': { params: { id: string }; result: EditResult }
  'file/read': { params: { path: string }; result: FileReadResult }
  /** 切换「原始结构 / 我的结构」显示模式。纯显示状态，不写盘、不置 dirty（见 Session.setViewMode）。 */
  'view/setMode': { params: SetViewModeParams; result: ViewModeResult }
  /**
   * 退回 / 重做**一次已提交的编辑**（annotate、move、setGroup、deleteGroup 各算一步）。
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
