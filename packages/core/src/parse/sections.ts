import { parseError } from '../errors.js'
import type { Line, ParseError, RawSections, Result, YamlBlock } from '../types.js'

const SECTION_ALIASES: Record<string, 'structure' | 'templates' | 'rules' | 'groups'> = {
  '结构': 'structure',
  'Structure': 'structure',
  '模板': 'templates',
  'Templates': 'templates',
  '规则': 'rules',
  'Rules': 'rules',
  '分组': 'groups',
  'Groups': 'groups',
}

export function splitSections(md: string): Result<RawSections> {
  const errors: ParseError[] = []
  const lines = md.split(/\r?\n/)
  let i = 0

  // ---- front-matter ----
  if (lines[0]?.trim() !== '---') {
    return { ok: false, errors: [parseError(1, 'parse.frontMatterMissing')] }
  }
  const frontMatter: Record<string, string> = {}
  i = 1
  let closed = false
  for (; i < lines.length; i++) {
    const t = lines[i]
    if (t.trim() === '---') { closed = true; i++; break }
    if (t.trim() === '') continue
    const idx = t.indexOf(':')
    if (idx === -1) {
      errors.push(parseError(i + 1, 'parse.frontMatterLine', { text: t }))
      continue
    }
    frontMatter[t.slice(0, idx).trim()] = t.slice(idx + 1).trim()
  }
  if (!closed) {
    return { ok: false, errors: [parseError(1, 'parse.frontMatterUnclosed')] }
  }

  // ---- 标题 ----
  let title = ''
  for (; i < lines.length; i++) {
    const t = lines[i]
    if (t.trim() === '') continue
    if (t.startsWith('# ')) { title = t.slice(2).trim(); i++ }
    break
  }

  // ---- 引言（连续的 > 行）----
  const preamble: string[] = []
  for (; i < lines.length; i++) {
    const t = lines[i]
    if (t.trim() === '') { if (preamble.length) break; continue }
    if (!t.startsWith('>')) break
    preamble.push(t.replace(/^>\s?/, '').trimEnd())
  }

  // ---- 三个区块 ----
  const structure: Line[] = []
  let templatesYaml: YamlBlock | null = null
  let rulesYaml: YamlBlock | null = null
  let groupsYaml: YamlBlock | null = null
  let current: 'structure' | 'templates' | 'rules' | 'groups' | null = null
  let seenStructure = false

  for (; i < lines.length; i++) {
    const t = lines[i]
    const h = /^## +(.+?) *$/.exec(t)
    if (h) {
      const kind = SECTION_ALIASES[h[1]]
      if (!kind) {
        errors.push(parseError(i + 1, 'parse.unknownSection', { title: h[1] }))
        current = null
        continue
      }
      current = kind
      if (kind === 'structure') seenStructure = true
      continue
    }
    if (current === 'structure') {
      if (t.trim() !== '') structure.push({ line: i + 1, text: t })
      continue
    }
    if (current === 'templates' || current === 'rules' || current === 'groups') {
      if (t.trim() === '') continue
      if (!/^```ya?ml\s*$/.test(t.trim())) {
        if (t.trim().startsWith('```')) {
          errors.push(parseError(i + 1, 'parse.yamlFenceRequired'))
        } else {
          errors.push(parseError(i + 1, 'parse.yamlBlockOnly', { text: t.trim() }))
        }
        current = null
        continue
      }
      const startLine = i + 2
      const body: string[] = []
      i++
      let fenceClosed = false
      for (; i < lines.length; i++) {
        if (lines[i].trim() === '```') { fenceClosed = true; break }
        body.push(lines[i])
      }
      if (!fenceClosed) {
        errors.push(parseError(startLine, 'parse.yamlFenceUnclosed'))
        continue
      }
      const block: YamlBlock = { text: body.join('\n').replace(/\n+$/, ''), startLine }
      if (current === 'templates') templatesYaml = block
      else if (current === 'rules') rulesYaml = block
      else groupsYaml = block
      current = null
      continue
    }
    if (t.trim() !== '' && current === null) {
      errors.push(parseError(i + 1, 'parse.strayContent', { text: t.trim() }))
    }
  }

  if (!seenStructure) {
    errors.push(parseError(lines.length, 'parse.structureSectionMissing'))
  }
  if (errors.length) return { ok: false, errors }
  return { ok: true, value: { frontMatter, title, preamble, structure, templatesYaml, rulesYaml, groupsYaml } }
}
