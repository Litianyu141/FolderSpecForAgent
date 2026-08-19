import { parseDocument } from 'yaml'
import { isPlainObject, lineAtOffset, topLevelKeyOffsets } from './yaml-util.js'
import type { ParseError, Result, Template, TemplateChild, YamlBlock } from '../types.js'

/** 把 yaml 块内的相对行号换算成整个文件的行号 */
function yamlErrors(doc: ReturnType<typeof parseDocument>, block: YamlBlock): ParseError[] {
  return doc.errors.map(e => ({
    line: block.startLine + (e.linePos?.[0].line ?? 1) - 1,
    message: `YAML 语法错误：${e.message}`,
  }))
}

export function parseTemplates(block: YamlBlock | null): Result<Template[]> {
  if (block === null) return { ok: true, value: [] }

  const doc = parseDocument(block.text)
  if (doc.errors.length) return { ok: false, errors: yamlErrors(doc, block) }

  const raw: unknown = doc.toJS()
  if (raw === null || raw === undefined) return { ok: true, value: [] }
  if (!isPlainObject(raw)) {
    return { ok: false, errors: [{ line: block.startLine, message: '模板区顶层必须是映射（模板名 → 定义）' }] }
  }

  const errors: ParseError[] = []
  const templates: Template[] = []
  const keyOffsets = topLevelKeyOffsets(doc)

  for (const [name, def] of Object.entries(raw)) {
    const at = { line: lineAtOffset(block, keyOffsets.get(name)) }

    if (!isPlainObject(def)) {
      errors.push({ ...at, message: `模板 "${name}" 的定义必须是映射` })
      continue
    }
    const tpl: Template = { name, children: [], exemplar: [] }

    // Check for unknown keys at template level
    const allowedKeys = new Set(['description', 'root', 'children', 'exemplar'])
    for (const key of Object.keys(def)) {
      if (!allowedKeys.has(key)) {
        errors.push({ ...at, message: `模板 "${name}" 有未知字段 "${key}"，只允许 description/root/children/exemplar` })
      }
    }

    if (def.description !== undefined) {
      if (typeof def.description !== 'string') {
        errors.push({ ...at, message: `模板 "${name}" 的 description 必须是字符串` })
      } else {
        tpl.description = def.description
      }
    }

    if (def.root !== undefined) {
      if (!isPlainObject(def.root)) {
        errors.push({ ...at, message: `模板 "${name}" 的 root 必须是映射` })
      } else {
        // Check for unknown keys in root
        const rootAllowedKeys = new Set(['variable', 'naming'])
        for (const key of Object.keys(def.root)) {
          if (!rootAllowedKeys.has(key)) {
            errors.push({ ...at, message: `模板 "${name}" 的 root 有未知字段 "${key}"，只允许 variable/naming` })
          }
        }

        if (def.root.variable !== undefined) {
          if (typeof def.root.variable !== 'string') {
            errors.push({ ...at, message: `模板 "${name}" 的 root.variable 必须是字符串` })
          } else {
            tpl.rootVariable = def.root.variable
          }
        }
        if (def.root.naming !== undefined) {
          if (typeof def.root.naming !== 'string') {
            errors.push({ ...at, message: `模板 "${name}" 的 root.naming 必须是字符串` })
          } else {
            tpl.rootNaming = def.root.naming
          }
        }
      }
    }

    if (def.children !== undefined) {
      if (!isPlainObject(def.children)) {
        errors.push({ ...at, message: `模板 "${name}" 的 children 必须是映射` })
      } else {
        for (const [rawName, spec] of Object.entries(def.children)) {
          if (!isPlainObject(spec)) {
            errors.push({ ...at, message: `模板 "${name}" 的子项 "${rawName}" 必须是映射` })
            continue
          }

          // Check for unknown keys in child entry
          const childAllowedKeys = new Set(['role', 'required'])
          for (const key of Object.keys(spec)) {
            if (!childAllowedKeys.has(key)) {
              errors.push({ ...at, message: `模板 "${name}" 子项 "${rawName}" 有未知字段 "${key}"，只允许 role/required` })
            }
          }

          if (typeof spec.required !== 'boolean') {
            errors.push({ ...at, message: `模板 "${name}" 子项 "${rawName}" 的 required 必须是 true 或 false` })
            continue
          }
          const isDir = rawName.endsWith('/')
          const child: TemplateChild = {
            name: isDir ? rawName.slice(0, -1) : rawName,
            isDir,
            required: spec.required,
          }
          if (spec.role !== undefined) {
            if (typeof spec.role !== 'string') {
              errors.push({ ...at, message: `模板 "${name}" 子项 "${rawName}" 的 role 必须是字符串` })
              continue
            }
            child.role = spec.role
          }
          tpl.children.push(child)
        }
      }
    }

    if (def.exemplar !== undefined) {
      if (!Array.isArray(def.exemplar) || def.exemplar.some(x => typeof x !== 'string')) {
        errors.push({ ...at, message: `模板 "${name}" 的 exemplar 必须是字符串数组` })
      } else {
        tpl.exemplar = def.exemplar as string[]
      }
    }

    templates.push(tpl)
  }

  if (errors.length) return { ok: false, errors }
  return { ok: true, value: templates }
}
