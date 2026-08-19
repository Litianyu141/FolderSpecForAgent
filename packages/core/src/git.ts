import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GitState, GitStates } from './types.js'

const run = promisify(execFile)

const ARGS = [
  'status',
  '--porcelain=v2',
  '-z',
  '--untracked-files=all',
  '--ignored=matching',
]

export async function gitStatus(root: string): Promise<GitStates> {
  const states: GitStates = new Map()

  let stdout: string
  try {
    const result = await run('git', ARGS, { cwd: root, maxBuffer: 64 * 1024 * 1024 })
    stdout = result.stdout
  } catch {
    // 不是 git 仓库、git 不在 PATH、或 git 返回非零——一律降级为"无 git 信息"
    return states
  }

  const records = stdout.split('\0')
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]
    if (rec === '') continue

    const type = rec[0]
    if (type === '?') {
      states.set(rec.slice(2), 'untracked')
      continue
    }
    if (type === '!') {
      states.set(rec.slice(2), 'ignored')
      continue
    }
    if (type !== '1' && type !== '2' && type !== 'u') continue

    const fields = rec.split(' ')
    // porcelain v2 字段布局：
    //   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>              → path 在下标 8
    //   2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X score> <path>    → path 在下标 9，且后跟一个额外的 NUL 字段 origPath
    //   u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>    → path 在下标 10
    let path: string
    if (type === '2') {
      path = fields.slice(9).join(' ')
      i++ // 跳过紧随其后的 origPath 记录，否则后续记录会整体错位
    } else if (type === 'u') {
      path = fields.slice(10).join(' ')
    } else {
      path = fields.slice(8).join(' ')
    }
    if (path === '') continue

    states.set(path, toState(type, fields[1] ?? ''))
  }

  return states
}

function toState(type: string, xy: string): GitState {
  if (type === 'u') return 'conflicted'
  if (xy.includes('A')) return 'added'
  if (xy.includes('D')) return 'deleted'
  return 'modified'
}
