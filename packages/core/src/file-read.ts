import * as fs from 'node:fs/promises'
import { renderEnglish } from './errors.js'
import { resolveWithinWorkspace } from './workspace-path.js'
import type { SpecErrorCode, SpecErrorParams } from './errors.js'

export const MAX_READ_BYTES = 1_048_576
const SNIFF_BYTES = 8192

export type FileReadResult =
  | { kind: 'text'; text: string }
  | { kind: 'binary' }
  | { kind: 'too-large'; size: number }
  /**
   * `reason` 是渲染好的英文，直接跟在中间栏「无法读取：」后面显示。
   *
   * `code`/`params` 只有我们自己判定的那两格才有（是目录 / 不是普通文件），显示端按码
   * 换成另一种语言；来自 fs 的失败（EACCES、EIO……）没有码——那是 node 给的原文，是
   * 外来数据，翻译它既无从下手，也会把 errno 这种唯一能拿去搜索的线索改掉。没有码就
   * 原样显示，正是既有的降级路径。
   */
  | { kind: 'unreadable'; reason: string; code?: SpecErrorCode; params?: SpecErrorParams }

/**
 * 只读。本工具只写 .folderspec.md 一个文件，这里不会有任何写操作。
 *
 * 用 resolveWithinWorkspace 而不是 normalizeWorkspacePath：内容会直接回传前端，
 * 必须挡住经符号链接逃出工作区的路径，纯词法校验看不见符号链接（见该函数的注释）。
 */
export async function readWorkspaceFile(root: string, subPath: string): Promise<FileReadResult> {
  const abs = await resolveWithinWorkspace(root, subPath)

  let stat
  try {
    stat = await fs.stat(abs)
  } catch (e) {
    return { kind: 'unreadable', reason: e instanceof Error ? e.message : String(e) }
  }
  if (stat.isDirectory()) return unreadable('file.isDirectory')
  if (!stat.isFile()) return unreadable('file.notRegularFile')
  if (stat.size > MAX_READ_BYTES) return { kind: 'too-large', size: stat.size }

  let buf: Buffer
  try {
    buf = await fs.readFile(abs)
  } catch (e) {
    return { kind: 'unreadable', reason: e instanceof Error ? e.message : String(e) }
  }
  if (buf.subarray(0, SNIFF_BYTES).includes(0)) return { kind: 'binary' }
  return { kind: 'text', text: buf.toString('utf8') }
}

/** 我们自己判定的"读不了"：reason 是渲染好的英文，同时带上码供显示端翻译。 */
function unreadable(code: SpecErrorCode): FileReadResult {
  return { kind: 'unreadable', reason: renderEnglish(code), code }
}
