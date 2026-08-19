import { parseDocument } from 'yaml'
import { isSeverity } from '../types.js'
import { isPlainObject, lineAtOffset, topLevelItemOffsets } from './yaml-util.js'
import type { Group, ParseError, Result, YamlBlock } from '../types.js'

const ALLOWED = new Set(['id', 'members', 'text', 'severity'])

export function parseGroups(block: YamlBlock | null): Result<Group[]> {
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
    return { ok: false, errors: [{ line: block.startLine, message: '分组区顶层必须是序列（每个分组一个 - 项）' }] }
  }

  const offsets = topLevelItemOffsets(doc)
  const errors: ParseError[] = []
  const groups: Group[] = []
  const seen = new Set<string>()

  raw.forEach((item, idx) => {
    const at = { line: lineAtOffset(block, offsets[idx]) }
    if (!isPlainObject(item)) {
      errors.push({ ...at, message: `第 ${idx + 1} 个分组必须是映射` })
      return
    }

    const id = item.id
    if (typeof id !== 'string' || id === '') {
      errors.push({ ...at, message: `第 ${idx + 1} 个分组缺少非空的 id` })
      return
    }
    if (seen.has(id)) {
      errors.push({ ...at, message: `分组 id "${id}" 重复` })
      return
    }
    seen.add(id)

    for (const key of Object.keys(item)) {
      if (!ALLOWED.has(key)) {
        errors.push({ ...at, message: `分组 "${id}" 有未知字段 "${key}"，只允许 id/members/text/severity` })
      }
    }

    let bad = false
    const members = item.members
    if (!Array.isArray(members) || members.length === 0 || members.some(m => typeof m !== 'string' || m === '')) {
      errors.push({ ...at, message: `分组 "${id}" 的 members 必须是非空的字符串数组` })
      bad = true
    } else if ((members as string[]).some(m => m.split('/').includes('..'))) {
      errors.push({ ...at, message: `分组 "${id}" 的 members 不得包含 ".." 路径段` })
      bad = true
    }

    if (typeof item.text !== 'string' || item.text === '') {
      errors.push({ ...at, message: `分组 "${id}" 缺少非空的 text` })
      bad = true
    }

    if (item.severity !== undefined && !isSeverity(item.severity)) {
      errors.push({ ...at, message: `分组 "${id}" 的 severity 只能是 error/warning/advisory` })
      bad = true
    }

    if (bad || errors.length) return

    const g: Group = { id, members: members as string[], text: item.text as string }
    if (item.severity !== undefined) g.severity = item.severity as Group['severity']
    groups.push(g)
  })

  if (errors.length) return { ok: false, errors }
  return { ok: true, value: groups }
}
