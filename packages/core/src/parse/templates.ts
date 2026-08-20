import { isMap, parseDocument } from 'yaml'
import { parseError } from '../errors.js'
import { isPlainObject, lineAtOffset, topLevelKeyOffsets } from './yaml-util.js'
import type { Document } from 'yaml'
import type { ParseError, Result, Template, TemplateChild, YamlBlock } from '../types.js'

/** 把 yaml 块内的相对行号换算成整个文件的行号 */
function yamlErrors(doc: ReturnType<typeof parseDocument>, block: YamlBlock): ParseError[] {
  return doc.errors.map(e => parseError(
    block.startLine + (e.linePos?.[0].line ?? 1) - 1,
    'parse.yamlSyntax',
    { message: e.message },
  ))
}

/** 取出映射键节点对应的字符串值 */
function keyString(key: unknown): string {
  if (key !== null && typeof key === 'object' && 'value' in key) {
    return String((key as { value: unknown }).value)
  }
  return String(key)
}

/**
 * 把一个 YAML 值节点换算成 JS 值。
 * 用于不需要保留内部键顺序的场景（叶子映射的键都是固定字面量，如 role/required）。
 */
function nodeToJS(doc: Document, node: unknown): unknown {
  if (node === null || node === undefined) return node
  return (node as { toJS: (doc: Document) => unknown }).toJS(doc)
}

export function parseTemplates(block: YamlBlock | null): Result<Template[]> {
  if (block === null) return { ok: true, value: [] }

  const doc = parseDocument(block.text)
  if (doc.errors.length) return { ok: false, errors: yamlErrors(doc, block) }

  const raw: unknown = doc.toJS()
  if (raw === null || raw === undefined) return { ok: true, value: [] }
  if (!isMap(doc.contents)) {
    return { ok: false, errors: [parseError(block.startLine, 'parse.templatesTopLevel')] }
  }

  const errors: ParseError[] = []
  const templates: Template[] = []
  const keyOffsets = topLevelKeyOffsets(doc)

  // 按 YAML 文档中的原始顺序遍历顶层键：先用 doc.toJS() 转成 JS 对象再遍历，
  // 会被 ECMAScript「形如数组下标的键排到最前面」的规则打乱顺序——例如模板名
  // "0" 会被排到 "a" 前面，哪怕它在文档里排在后面。因此必须直接遍历 AST 节点的
  // items，而不是 Object.entries(doc.toJS())。
  for (const pair of doc.contents.items) {
    const name = keyString(pair.key)
    const at = lineAtOffset(block, keyOffsets.get(name))

    const defNode = pair.value
    if (!isMap(defNode)) {
      errors.push(parseError(at, 'parse.templateDefNotMap', { name }))
      continue
    }
    const def = defNode.toJS(doc) as Record<string, unknown>
    const tpl: Template = { name, children: [], exemplar: [] }

    // Check for unknown keys at template level
    const allowedKeys = new Set(['description', 'root', 'children', 'exemplar'])
    for (const key of Object.keys(def)) {
      if (!allowedKeys.has(key)) {
        errors.push(parseError(at, 'parse.templateUnknownField', { name, field: key }))
      }
    }

    if (def.description !== undefined) {
      if (typeof def.description !== 'string') {
        errors.push(parseError(at, 'parse.templateDescriptionType', { name }))
      } else {
        tpl.description = def.description
      }
    }

    if (def.root !== undefined) {
      if (!isPlainObject(def.root)) {
        errors.push(parseError(at, 'parse.templateRootNotMap', { name }))
      } else {
        // Check for unknown keys in root
        const rootAllowedKeys = new Set(['variable', 'naming'])
        for (const key of Object.keys(def.root)) {
          if (!rootAllowedKeys.has(key)) {
            errors.push(parseError(at, 'parse.templateRootUnknownField', { name, field: key }))
          }
        }

        if (def.root.variable !== undefined) {
          if (typeof def.root.variable !== 'string') {
            errors.push(parseError(at, 'parse.templateRootVariableType', { name }))
          } else {
            tpl.rootVariable = def.root.variable
          }
        }
        if (def.root.naming !== undefined) {
          if (typeof def.root.naming !== 'string') {
            errors.push(parseError(at, 'parse.templateRootNamingType', { name }))
          } else {
            tpl.rootNaming = def.root.naming
          }
        }
      }
    }

    if (def.children !== undefined) {
      const childrenPair = defNode.items.find(p => keyString(p.key) === 'children')
      const childrenNode = childrenPair?.value
      if (!isMap(childrenNode)) {
        errors.push(parseError(at, 'parse.templateChildrenNotMap', { name }))
      } else {
        // 子项名同样可能形如整数（如 "0"），理由同上，按 AST 顺序遍历
        for (const childPair of childrenNode.items) {
          const rawName = keyString(childPair.key)
          const spec = nodeToJS(doc, childPair.value)
          if (!isPlainObject(spec)) {
            errors.push(parseError(at, 'parse.templateChildNotMap', { name, child: rawName }))
            continue
          }

          // Check for unknown keys in child entry
          const childAllowedKeys = new Set(['role', 'required'])
          for (const key of Object.keys(spec)) {
            if (!childAllowedKeys.has(key)) {
              errors.push(parseError(at, 'parse.templateChildUnknownField', { name, child: rawName, field: key }))
            }
          }

          if (typeof spec.required !== 'boolean') {
            errors.push(parseError(at, 'parse.templateChildRequiredType', { name, child: rawName }))
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
              errors.push(parseError(at, 'parse.templateChildRoleType', { name, child: rawName }))
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
        errors.push(parseError(at, 'parse.templateExemplarType', { name }))
      } else {
        tpl.exemplar = def.exemplar as string[]
      }
    }

    templates.push(tpl)
  }

  if (errors.length) return { ok: false, errors }
  return { ok: true, value: templates }
}
