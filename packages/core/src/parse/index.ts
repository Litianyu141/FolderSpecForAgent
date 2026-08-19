import { splitSections } from './sections.js'
import { parseStructure } from './structure.js'
import { parseTemplates } from './templates.js'
import { parseRules } from './rules.js'
import type { ParseError, Result, Spec } from '../types.js'

export { splitSections } from './sections.js'
export { parseStructure, ANNOTATION_SEPARATOR } from './structure.js'
export { parseTemplates } from './templates.js'
export { parseRules } from './rules.js'

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
      title: s.title,
      preamble: s.preamble,
      nodes: (nodes as { ok: true; value: Spec['nodes'] }).value,
      templates: (templates as { ok: true; value: Spec['templates'] }).value,
      rules: (rules as { ok: true; value: Spec['rules'] }).value,
    },
  }
}
