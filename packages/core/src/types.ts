export type Severity = 'error' | 'warning' | 'advisory'

export interface SpecNode {
  name: string
  isDir: boolean
  role?: string
  template?: string
  severity?: Severity
  annotation?: string
  children: SpecNode[]
}

export interface TemplateChild {
  name: string
  isDir: boolean
  role?: string
  required: boolean
}

export interface Template {
  name: string
  description?: string
  rootVariable?: string
  rootNaming?: string
  children: TemplateChild[]
  exemplar: string[]
}

export interface Rule {
  id: string
  severity: Severity
  scope: string
  text: string
}

export interface Group {
  id: string
  /** 工作区相对 posix 路径 */
  members: string[]
  text: string
  severity?: Severity
}

export interface Spec {
  version: number
  root: string
  ownership: string
  title: string
  preamble: string[]
  nodes: SpecNode[]
  templates: Template[]
  rules: Rule[]
  groups: Group[]
}

export interface ParseError {
  line: number
  message: string
}

export type Result<T> = { ok: true; value: T } | { ok: false; errors: ParseError[] }

export interface Line {
  line: number
  text: string
}

export interface YamlBlock {
  text: string
  startLine: number
}

export interface RawSections {
  frontMatter: Record<string, string>
  title: string
  preamble: string[]
  structure: Line[]
  templatesYaml: YamlBlock | null
  rulesYaml: YamlBlock | null
  groupsYaml: YamlBlock | null
}

export const SEVERITIES: readonly Severity[] = ['error', 'warning', 'advisory']

export function isSeverity(v: unknown): v is Severity {
  return typeof v === 'string' && (SEVERITIES as readonly string[]).includes(v)
}

export type FileKind = 'file' | 'dir' | 'symlink'

export interface ActualNode {
  name: string
  /** 相对工作区根的 posix 路径；根节点为 '' */
  path: string
  kind: FileKind
  /** undefined = 该目录尚未扫描（懒加载边界）；[] = 已扫描且为空 */
  children?: ActualNode[]
  /** 直接子项超过 MAX_CHILDREN，已截断 */
  truncated?: boolean
  /** readdir 失败（通常是权限） */
  unreadable?: boolean
}

export interface ScanOpts {
  /** 相对根的子路径，扫描从这里开始；默认 '' 即根本身 */
  subPath?: string
  /** 从起点往下扫几层；默认 2 */
  depth?: number
  /** 单目录最多保留多少子项，超出则截断；默认 MAX_CHILDREN。主要用于测试和对扫描量有更紧预算的调用方 */
  maxChildren?: number
}

export type GitState = 'ignored' | 'untracked' | 'modified' | 'added' | 'deleted' | 'conflicted'

/** 键是相对工作区根的 posix 路径 */
export type GitStates = Map<string, GitState>

export type NodeOrigin = 'both' | 'spec-only' | 'actual-only' | 'unscanned'

/**
 * 'spec'：三源合成（默认，现有行为）——磁盘扫描 + git 状态 + 契约，契约里声明的结构生效。
 * 'disk'：只按磁盘扫描结果建树，忽略契约里的结构性重排——用于「原始结构」对比视图，
 * 让用户看清拖拽到底改了什么（拖拽本身不记录"从哪儿来"，是设计文档 §6.1 记录在案、
 * 刻意接受的限制；这个模式是四个候选方案里用户选中的补偿手段）。
 * 纯显示模式，不落盘、不进 Spec——与 hidden 同类的派生状态。
 */
export type ViewMode = 'spec' | 'disk'

export interface ViewNode {
  name: string
  path: string
  isDir: boolean
  origin: NodeOrigin
  gitState?: GitState
  annotation?: string
  role?: string
  template?: string
  severity?: Severity
  /** 该节点所属的分组 id（由 merge 从 Spec.groups 反查，不落盘） */
  groups?: string[]
  children?: ViewNode[]
  truncated?: boolean
  unreadable?: boolean
}
