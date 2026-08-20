import { parseDocument } from 'yaml'
import { parseError } from '../errors.js'
import { isSeverity } from '../types.js'
import { isPlainObject, lineAtOffset, topLevelItemOffsets } from './yaml-util.js'
import type { ParseError, Result, Rule, YamlBlock } from '../types.js'

export function parseRules(block: YamlBlock | null): Result<Rule[]> {
  if (block === null) return { ok: true, value: [] }

  const doc = parseDocument(block.text)
  if (doc.errors.length) {
    return {
      ok: false,
      errors: doc.errors.map(e => parseError(
        block.startLine + (e.linePos?.[0].line ?? 1) - 1,
        'parse.yamlSyntax',
        { message: e.message },
      )),
    }
  }

  const raw: unknown = doc.toJS()
  if (raw === null || raw === undefined) return { ok: true, value: [] }
  if (!Array.isArray(raw)) {
    return { ok: false, errors: [parseError(block.startLine, 'parse.rulesTopLevel')] }
  }

  const errors: ParseError[] = []
  const rules: Rule[] = []
  const seen = new Set<string>()
  const offsets = topLevelItemOffsets(doc)

  raw.forEach((item, idx) => {
    const at = lineAtOffset(block, offsets[idx])
    if (!isPlainObject(item)) {
      errors.push(parseError(at, 'parse.ruleNotMap', { index: idx + 1 }))
      return
    }
    const id = item.id
    if (typeof id !== 'string' || id === '') {
      errors.push(parseError(at, 'parse.ruleIdMissing', { index: idx + 1 }))
      return
    }
    if (seen.has(id)) {
      errors.push(parseError(at, 'parse.ruleIdDuplicate', { id }))
      return
    }
    seen.add(id)

    // Check for unknown keys
    const allowedKeys = new Set(['id', 'severity', 'scope', 'text'])
    for (const key of Object.keys(item)) {
      if (!allowedKeys.has(key)) {
        errors.push(parseError(at, 'parse.ruleUnknownField', { id, field: key }))
      }
    }

    let bad = false
    if (!isSeverity(item.severity)) {
      errors.push(parseError(at, 'parse.ruleSeverityInvalid', { id }))
      bad = true
    }
    if (typeof item.scope !== 'string' || item.scope === '') {
      errors.push(parseError(at, 'parse.ruleScopeMissing', { id }))
      bad = true
    }
    if (typeof item.text !== 'string' || item.text === '') {
      errors.push(parseError(at, 'parse.ruleTextMissing', { id }))
      bad = true
    }
    if (bad) return

    rules.push({
      id,
      severity: item.severity as Rule['severity'],
      scope: item.scope as string,
      text: item.text as string,
    })
  })

  if (errors.length) return { ok: false, errors }
  return { ok: true, value: rules }
}
