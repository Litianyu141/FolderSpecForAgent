import * as fs from 'node:fs/promises'
import { resolveWithinWorkspace } from './workspace-path.js'

export const MAX_READ_BYTES = 1_048_576
const SNIFF_BYTES = 8192

export type FileReadResult =
  | { kind: 'text'; text: string }
  | { kind: 'binary' }
  | { kind: 'too-large'; size: number }
  | { kind: 'unreadable'; reason: string }

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
  if (stat.isDirectory()) return { kind: 'unreadable', reason: '这是一个目录' }
  if (!stat.isFile()) return { kind: 'unreadable', reason: '不是普通文件' }
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
