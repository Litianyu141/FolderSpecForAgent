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
