import { stringify } from 'yaml'
import { ANNOTATION_SEPARATOR } from './parse/structure.js'
import type { Rule, Spec, SpecNode, Template } from './types.js'

export function serializeSpec(spec: Spec): string {
  const out: string[] = []

  out.push('---')
  out.push(`folderspec: ${spec.version}`)
  out.push(`root: ${spec.root}`)
  out.push(`ownership: ${spec.ownership}`)
  out.push('---')
  out.push('')

  if (spec.title !== '') {
    out.push(`# ${spec.title}`)
    out.push('')
  }

  if (spec.preamble.length > 0) {
    for (const p of spec.preamble) out.push(p === '' ? '>' : `> ${p}`)
    out.push('')
  }

  out.push('## 结构')
  out.push('')
  for (const n of spec.nodes) emitNode(out, n, 0)
  out.push('')

  if (spec.templates.length > 0) {
    out.push('## 模板')
    out.push('')
    out.push('```yaml')
    out.push(templatesToYaml(spec.templates))
    out.push('```')
    out.push('')
  }

  if (spec.rules.length > 0) {
    out.push('## 规则')
    out.push('')
    out.push('```yaml')
    out.push(rulesToYaml(spec.rules))
    out.push('```')
    out.push('')
  }

  return out.join('\n')
}

function emitNode(out: string[], n: SpecNode, depth: number): void {
  let line = `${' '.repeat(depth * 2)}- \`${n.name}${n.isDir ? '/' : ''}\``
  if (n.role) line += ` \`[role:${n.role}]\``
  if (n.template) line += ` \`[template:${n.template}]\``
  if (n.severity) line += ` \`[severity:${n.severity}]\``
  const annotation = n.annotation?.trim()
  if (annotation) line += `${ANNOTATION_SEPARATOR}${annotation}`
  out.push(line)
  for (const c of n.children) emitNode(out, c, depth + 1)
}

function templatesToYaml(templates: Template[]): string {
  // 模板名、子项名都是用户数据，可能形如整数（例如名为 "0" 的子项）。
  // 普通 JS 对象在枚举键时会把这类键排到最前面（ECMAScript 的整数键排序规则），
  // 从而打乱原始顺序；用 Map 承载可以保证 yaml.stringify 按插入顺序输出。
  const obj = new Map<string, unknown>()
  for (const t of templates) {
    const def: Record<string, unknown> = {}
    if (t.description) def.description = t.description
    if (t.rootVariable || t.rootNaming) {
      const root: Record<string, string> = {}
      if (t.rootVariable) root.variable = t.rootVariable
      if (t.rootNaming) root.naming = t.rootNaming
      def.root = root
    }
    if (t.children.length > 0) {
      const children = new Map<string, unknown>()
      for (const c of t.children) {
        const entry: Record<string, unknown> = {}
        if (c.role) entry.role = c.role
        entry.required = c.required
        children.set(`${c.name}${c.isDir ? '/' : ''}`, entry)
      }
      def.children = children
    }
    if (t.exemplar.length > 0) def.exemplar = t.exemplar
    obj.set(t.name, def)
  }
  return stringify(obj).replace(/\n+$/, '')
}

function rulesToYaml(rules: Rule[]): string {
  return stringify(rules.map(r => ({
    id: r.id, severity: r.severity, scope: r.scope, text: r.text,
  }))).replace(/\n+$/, '')
}
