import type { ParseError, Severity, ViewNode } from './types.js'
import type { FileReadResult } from './file-read.js'

export type { GitState, Group, NodeOrigin, ParseError, Severity, Spec, SpecNode, ViewNode } from './types.js'
export type { FileReadResult } from './file-read.js'

export interface OpenResult {
  root: string
  rootName: string
  hasSpec: boolean
  specPath: string
  /** 非 null 表示契约文件解析失败，当前处于只读模式 */
  parseErrors: ParseError[] | null
  tree: ViewNode
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
}

export type ApiMethod = keyof Api

export type BridgeEvent = 'spec-changed' | 'scan-progress' | 'external-change'

export interface Bridge {
  request<K extends ApiMethod>(method: K, params: Api[K]['params']): Promise<Api[K]['result']>
  on(event: BridgeEvent, cb: (payload: unknown) => void): () => void
}
