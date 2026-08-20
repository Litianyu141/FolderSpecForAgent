import { parseDocument } from 'yaml'
import { parseError } from '../errors.js'
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
    return { ok: false, errors: [parseError(block.startLine, 'parse.groupsTopLevel')] }
  }

  const offsets = topLevelItemOffsets(doc)
  const errors: ParseError[] = []
  const groups: Group[] = []
  const seen = new Set<string>()

  raw.forEach((item, idx) => {
    const at = lineAtOffset(block, offsets[idx])
    if (!isPlainObject(item)) {
      errors.push(parseError(at, 'parse.groupNotMap', { index: idx + 1 }))
      return
    }

    const id = item.id
    if (typeof id !== 'string' || id === '') {
      errors.push(parseError(at, 'parse.groupIdMissing', { index: idx + 1 }))
      return
    }
    if (seen.has(id)) {
      errors.push(parseError(at, 'parse.groupIdDuplicate', { id }))
      return
    }
    seen.add(id)

    for (const key of Object.keys(item)) {
      if (!ALLOWED.has(key)) {
        errors.push(parseError(at, 'parse.groupUnknownField', { id, field: key }))
      }
    }

    let bad = false
    const members = item.members
    if (!Array.isArray(members) || members.length === 0 || members.some(m => typeof m !== 'string' || m === '')) {
      errors.push(parseError(at, 'parse.groupMembersType', { id }))
      bad = true
    } else if ((members as string[]).some(m => m.split('/').includes('..'))) {
      errors.push(parseError(at, 'parse.groupMembersParentSegment', { id }))
      bad = true
    } else if ((members as string[]).some(m => m.startsWith('/') || /^[A-Za-z]:[\\/]/.test(m))) {
      // 绝对路径（含 Windows 盘符形式 C:\ / C:/）不满足"工作区相对路径"的约定；
      // 静默收下会导致 merge 反查永远匹配不上——界面上什么都不显示，也没有报错，
      // 这正是本项目明令禁止的"静默丢数据"，所以必须在解析边界就拦下。
      errors.push(parseError(at, 'parse.groupMembersAbsolute', { id }))
      bad = true
    } else if ((members as string[]).some(m => m.includes('\\'))) {
      errors.push(parseError(at, 'parse.groupMembersBackslash', { id }))
      bad = true
    }

    if (typeof item.text !== 'string' || item.text === '') {
      errors.push(parseError(at, 'parse.groupTextMissing', { id }))
      bad = true
    }

    if (item.severity !== undefined && !isSeverity(item.severity)) {
      errors.push(parseError(at, 'parse.groupSeverityInvalid', { id }))
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
