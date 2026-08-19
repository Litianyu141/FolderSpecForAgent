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

export interface Spec {
  version: number
  root: string
  ownership: string
  title: string
  preamble: string[]
  nodes: SpecNode[]
  templates: Template[]
  rules: Rule[]
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
