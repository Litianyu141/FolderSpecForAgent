import { splitSections } from './sections.js'
import { parseStructure } from './structure.js'
import { parseTemplates } from './templates.js'
import { parseRules } from './rules.js'
import { parseGroups } from './groups.js'
import type { ParseError, Result, Spec } from '../types.js'

export { splitSections } from './sections.js'
export { parseStructure, ANNOTATION_SEPARATOR } from './structure.js'
export { parseTemplates } from './templates.js'
export { parseRules } from './rules.js'
export { parseGroups } from './groups.js'

export const SUPPORTED_VERSION = 1

export function parseSpec(markdown: string): Result<Spec> {
  const sections = splitSections(markdown)
  if (!sections.ok) return sections
  const s = sections.value

  const errors: ParseError[] = []

  const version = Number(s.frontMatter.folderspec)
  if (!Number.isInteger(version) || version !== SUPPORTED_VERSION) {
    errors.push({ line: 2, message: `不支持的 folderspec 版本 "${s.frontMatter.folderspec ?? ''}"，本工具支持 ${SUPPORTED_VERSION}` })
  }

  const nodes = parseStructure(s.structure)
  if (!nodes.ok) errors.push(...nodes.errors)

  const templates = parseTemplates(s.templatesYaml)
  if (!templates.ok) errors.push(...templates.errors)

  const rules = parseRules(s.rulesYaml)
  if (!rules.ok) errors.push(...rules.errors)

  const groups = parseGroups(s.groupsYaml)
  if (!groups.ok) errors.push(...groups.errors)

  if (errors.length) {
    errors.sort((a, b) => a.line - b.line)
    return { ok: false, errors }
  }

  return {
    ok: true,
    value: {
      version,
      root: s.frontMatter.root ?? '.',
      ownership: s.frontMatter.ownership ?? 'human',
      // 缺失或无法识别的值一律按 'zh'——保证没有 lang: 字段的老文件行为不变，
      // 而不是让一个手误的值把只读模式以外的地方也搞出崩溃或报错噪音。
      lang: s.frontMatter.lang === 'en' ? 'en' : 'zh',
      title: s.title,
      preamble: s.preamble,
      nodes: (nodes as { ok: true; value: Spec['nodes'] }).value,
      templates: (templates as { ok: true; value: Spec['templates'] }).value,
      rules: (rules as { ok: true; value: Spec['rules'] }).value,
      groups: (groups as { ok: true; value: Spec['groups'] }).value,
    },
  }
}
