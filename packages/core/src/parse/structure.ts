import { parseError } from '../errors.js'
import { isSeverity } from '../types.js'
import type { Line, ParseError, Result, SpecNode } from '../types.js'

const BULLET_RE = /^( *)- (.*)$/
const NAME_RE = /^`([^`]+)`/
const TAG_RE = /^ +`\[([A-Za-z-]+)(?::([^\]]*))?\]`/

/** 注释分隔符：空格 + U+2014 EM DASH + 空格 */
export const ANNOTATION_SEPARATOR = ' — '

export function parseStructure(lines: Line[]): Result<SpecNode[]> {
  const errors: ParseError[] = []
  const roots: SpecNode[] = []
  const stack: SpecNode[] = []
  let prevDepth = -1

  for (const { line, text } of lines) {
    if (text.trim() === '') continue

    const bullet = BULLET_RE.exec(text)
    if (!bullet) {
      errors.push(parseError(line, 'parse.bulletRequired'))
      continue
    }
    const indent = bullet[1].length
    if (indent % 2 !== 0) {
      errors.push(parseError(line, 'parse.indentNotMultipleOfTwo', { indent }))
      continue
    }
    const depth = indent / 2
    if (depth > prevDepth + 1) {
      errors.push(parseError(line, 'parse.indentSkipsLevel', { prev: prevDepth, depth }))
      continue
    }

    let rest = bullet[2]
    const nameMatch = NAME_RE.exec(rest)
    if (!nameMatch) {
      errors.push(parseError(line, 'parse.nameBackticksRequired'))
      continue
    }
    rest = rest.slice(nameMatch[0].length)
    const raw = nameMatch[1]
    const isDir = raw.endsWith('/')
    const name = isDir ? raw.slice(0, -1) : raw
    if (name === '') {
      errors.push(parseError(line, 'parse.nameEmpty'))
      continue
    }

    const node: SpecNode = { name, isDir, children: [] }

    let tagError = false
    for (;;) {
      const tag = TAG_RE.exec(rest)
      if (!tag) break
      rest = rest.slice(tag[0].length)
      const key = tag[1]
      const value = tag[2]
      if (key === 'role' || key === 'template') {
        if (!value) {
          errors.push(parseError(line, 'parse.tagValueMissing', { tag: key }))
          tagError = true
          break
        }
        if (key === 'role') node.role = value
        else node.template = value
      } else if (key === 'severity') {
        if (!isSeverity(value)) {
          errors.push(parseError(line, 'parse.severityInvalid', { value: value ?? '' }))
          tagError = true
          break
        }
        node.severity = value
      } else {
        errors.push(parseError(line, 'parse.unknownTag', { tag: key }))
        tagError = true
        break
      }
    }
    if (tagError) continue

    if (rest.length > 0) {
      if (!rest.startsWith(ANNOTATION_SEPARATOR)) {
        errors.push(parseError(line, 'parse.annotationSeparator'))
        continue
      }
      const annotation = rest.slice(ANNOTATION_SEPARATOR.length)
      if (annotation !== '') node.annotation = annotation
    }

    let siblings: SpecNode[]
    if (depth === 0) {
      siblings = roots
    } else {
      const parent = stack[depth - 1]
      if (!parent) {
        errors.push(parseError(line, 'parse.parentNotFound'))
        continue
      }
      if (!parent.isDir) {
        errors.push(parseError(line, 'parse.parentNotDir', { name: parent.name }))
        continue
      }
      siblings = parent.children
    }

    // 同一层重名 = 重复声明，必须报错，不能默默收下。
    //
    // 工具自己永远写不出重复项，但这个文件的设计初衷就是给人手改、进 git、被 Agent 追加——
    // 一次手抖、一次 merge 冲突解错，就能造出两个同名兄弟。此后下游两条路径对"哪一个才算数"
    // 的答案是相反的：merge 用 name → node 的 Map（后一个覆盖前一个，UI 只显示最后那个），
    // spec-edit 用 list.find（命中第一个，编辑落在第一个上）。于是用户编辑他看到的那一条，
    // 工具却改写了另一条，界面上毫无变化也毫无报错——注释被静默弄丢，正是本工具唯一
    // 有能力造成的那种伤害（spec §8）。
    //
    // 判重只看 name、不看 isDir：上面两条下游路径的键都只有 name，所以 `foo` 与 `foo/`
    // 作为兄弟同样会互相覆盖，同样是重复声明。
    const dup = siblings.find(n => n.name === node.name)
    if (dup) {
      const shown = `${node.name}${node.isDir ? '/' : ''}`
      const other = `${dup.name}${dup.isDir ? '/' : ''}`
      errors.push(parseError(line, 'parse.duplicateSibling', { name: shown, other }))
      continue
    }
    siblings.push(node)
    stack[depth] = node
    stack.length = depth + 1
    prevDepth = depth
  }

  if (errors.length) return { ok: false, errors }
  return { ok: true, value: roots }
}
