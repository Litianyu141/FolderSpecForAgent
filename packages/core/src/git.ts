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

/**
 * porcelain v2 对**被忽略的目录**输出带尾斜杠的路径（实测 git 2.43.0：`! node_modules/`、
 * `! build/`），而 `ViewNode.path` 一律不带尾斜杠。不去掉这个斜杠，merge 的精确查表对
 * 被忽略的目录就永远落空——被忽略的目录从来就没变过灰。
 *
 * `?` 分支当前拿不到带尾斜杠的路径（`--untracked-files=all` 会把未跟踪目录展开成逐个
 * 文件），但一并归一化：实测把那个开关改成 `normal` 时 git 立刻输出 `? untracked_dir/`，
 * 只在 `!` 分支处理等于把这条缺陷的复活条件藏进一个看似无关的参数里。
 *
 * 无条件去尾斜杠是安全的：POSIX 文件名不允许含 '/'，真实路径不可能以它结尾。
 */
function stripTrailingSlash(p: string): string {
  return p.endsWith('/') ? p.slice(0, -1) : p
}

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
      states.set(stripTrailingSlash(rec.slice(2)), 'untracked')
      continue
    }
    if (type === '!') {
      states.set(stripTrailingSlash(rec.slice(2)), 'ignored')
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
