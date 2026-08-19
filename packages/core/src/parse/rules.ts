import { parseDocument } from 'yaml'
import { isSeverity } from '../types.js'
import { isPlainObject, lineAtOffset, topLevelItemOffsets } from './yaml-util.js'
import type { ParseError, Result, Rule, YamlBlock } from '../types.js'

export function parseRules(block: YamlBlock | null): Result<Rule[]> {
  if (block === null) return { ok: true, value: [] }

  const doc = parseDocument(block.text)
  if (doc.errors.length) {
    return {
      ok: false,
      errors: doc.errors.map(e => ({
        line: block.startLine + (e.linePos?.[0].line ?? 1) - 1,
        message: `YAML 语法错误：${e.message}`,
      })),
    }
  }

  const raw: unknown = doc.toJS()
  if (raw === null || raw === undefined) return { ok: true, value: [] }
  if (!Array.isArray(raw)) {
    return { ok: false, errors: [{ line: block.startLine, message: '规则区顶层必须是序列（每条规则一个 - 项）' }] }
  }

  const errors: ParseError[] = []
  const rules: Rule[] = []
  const seen = new Set<string>()
  const offsets = topLevelItemOffsets(doc)

  raw.forEach((item, idx) => {
    const at = { line: lineAtOffset(block, offsets[idx]) }
    if (!isPlainObject(item)) {
      errors.push({ ...at, message: `第 ${idx + 1} 条规则必须是映射` })
      return
    }
    const id = item.id
    if (typeof id !== 'string' || id === '') {
      errors.push({ ...at, message: `第 ${idx + 1} 条规则缺少非空的 id` })
      return
    }
    if (seen.has(id)) {
      errors.push({ ...at, message: `规则 id "${id}" 重复` })
      return
    }
    seen.add(id)

    // Check for unknown keys
    const allowedKeys = new Set(['id', 'severity', 'scope', 'text'])
    for (const key of Object.keys(item)) {
      if (!allowedKeys.has(key)) {
        errors.push({ ...at, message: `规则 "${id}" 有未知字段 "${key}"，只允许 id/severity/scope/text` })
      }
    }

    let bad = false
    if (!isSeverity(item.severity)) {
      errors.push({ ...at, message: `规则 "${id}" 的 severity 只能是 error/warning/advisory` })
      bad = true
    }
    if (typeof item.scope !== 'string' || item.scope === '') {
      errors.push({ ...at, message: `规则 "${id}" 缺少非空的 scope（glob 表达式）` })
      bad = true
    }
    if (typeof item.text !== 'string' || item.text === '') {
      errors.push({ ...at, message: `规则 "${id}" 缺少非空的 text` })
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
