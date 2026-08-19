import { isMap, isSeq } from 'yaml'
import type { Document } from 'yaml'
import type { YamlBlock } from '../types.js'

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 把 yaml 块内的字符偏移量换算成整个文件的 1-based 行号 */
export function lineAtOffset(block: YamlBlock, offset: number | undefined): number {
  if (offset === undefined || offset < 0) return block.startLine
  let newlines = 0
  const upTo = Math.min(offset, block.text.length)
  for (let i = 0; i < upTo; i++) {
    if (block.text[i] === '\n') newlines++
  }
  return block.startLine + newlines
}

function startOffsetOf(node: unknown): number | undefined {
  if (node && typeof node === 'object' && 'range' in node) {
    const range = (node as { range?: [number, number, number] }).range
    if (range) return range[0]
  }
  return undefined
}

/** 顶层映射里每个键名 → 该键在块内的起始偏移量 */
export function topLevelKeyOffsets(doc: Document): Map<string, number> {
  const out = new Map<string, number>()
  const contents = doc.contents
  if (!isMap(contents)) return out
  for (const pair of contents.items) {
    const key = pair.key
    const offset = startOffsetOf(key)
    if (key && typeof key === 'object' && 'value' in key && offset !== undefined) {
      out.set(String((key as { value: unknown }).value), offset)
    }
  }
  return out
}

/** 顶层序列里每一项在块内的起始偏移量，按下标对齐 */
export function topLevelItemOffsets(doc: Document): Array<number | undefined> {
  const contents = doc.contents
  if (!isSeq(contents)) return []
  return contents.items.map(startOffsetOf)
}
