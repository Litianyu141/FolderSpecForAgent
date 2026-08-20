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
 * 聚合优先级：一个目录里同时有多种状态时，显示"最需要人注意"的那一种。
 * 数字大 = 优先。这条排序是一个单一维度——**需要人工介入的程度**：
 *
 * - `conflicted`：必须手动解决，不解决连提交都做不了，永远排第一。
 * - `deleted`：树的结构变了；误删是最难在 diff 里一眼看出、后果又最重的一类改动。
 * - `modified`：已跟踪的内容偏离了 HEAD——原本就存在的东西被改了，最容易被忽略。
 * - `added`：也是改动，但已经明确进了暂存区，是用户刚刚有意识做的事，比 modified 更"已知"。
 * - `untracked`：git 还完全没管它，信息量最低。
 * - `ignored`：见下面 rollupDirStates 里"ignored 不参与聚合"的推导。它排最低只为让
 *   "目录自己被 git 报成 ignored" 能被任何真实改动盖过，不代表它会被滚上去。
 */
const PRIORITY: Record<GitState, number> = {
  conflicted: 5,
  deleted: 4,
  modified: 3,
  added: 2,
  untracked: 1,
  ignored: 0,
}

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

/**
 * 把文件级的 git 状态沿祖先链滚上去，让目录也带上"它整棵子树的聚合状态"
 * （与 VSCode 资源管理器一致：目录里有改动，目录名就变色）。
 *
 * **为什么必须从这张 Map 上滚，而不是遍历已扫描的树**：首屏只扫 `DEFAULT_DEPTH=2` 层，
 * 深处的文件根本不在 ViewNode 树上；但 `git status` 报的是整个仓库，不受扫描深度限制。
 * 靠遍历树聚合，`src/deep/very/nested/file.ts` 的改动就永远染不到 `src` 上。
 *
 * **为什么预计算一次而不是让 merge 查**：给每个目录扫一遍 Map 是 O(目录数 × 条目数)，
 * 而 merge 是纯函数、每次 tree() 都重跑（每一笔 annotate/move/expand 都会触发）。
 * 这里只在 gitStatus() 里跑一次，跟着 `git status` 的生命周期走——见 Session.open()。
 *
 * **ignored 不参与聚合**：`.gitignore` 本身就是"这里的东西不必关心"的声明；一个目录里
 * 有几个 `*.log` 就把整个目录染灰，等于把"部分内容被刻意排除"读成"整个目录被排除"，
 * 与用户写下的声明正好相反。而且 `--ignored=matching` 下 ignored 条目在真实仓库里数量
 * 最多（构建产物），滚上去几乎每个目录都会变灰，颜色通道直接失去信息量。
 * 目录**自己**被 git 报成 ignored（`! node_modules/`）是另一回事：那是 git 的原始判定，
 * 原样保留。
 *
 * **复杂度 O(N + U)**，N = 条目数、U = 出现过的祖先目录数，与路径深度无关：
 * while 循环每一轮要么 break（每个条目至多一次，合计 ≤ N），要么真的写一次 `rolled`；
 * 而同一个祖先上写入的优先级严格递增，`GitState` 只有 6 个取值，所以每个祖先至多被写
 * 6 次，合计 ≤ 6U。
 *
 * 聚合结果写进独立的 `rolled` 再合并回去，而不是边遍历边改 `out`：break 的正确性依赖
 * "祖先已有的值 ≥ 当前值 ⇒ 它更上面的祖先也 ≥ 当前值"这条不变量，只有当被比较的值
 * 全部出自本函数自己的滚动时才成立。git 原始输出里混着目录条目（`!` 的被忽略目录、
 * 以及子模块——子模块路径本身就是一个目录），拿它们参与 break 判断会让不变量出现缺口。
 */
export function rollupDirStates(files: GitStates): GitStates {
  const rolled = new Map<string, GitState>()

  for (const [path, state] of files) {
    if (state === 'ignored') continue
    const prio = PRIORITY[state]
    let i = path.lastIndexOf('/')
    while (i > 0) {
      const anc = path.slice(0, i)
      const cur = rolled.get(anc)
      if (cur !== undefined && PRIORITY[cur] >= prio) break
      rolled.set(anc, state)
      i = anc.lastIndexOf('/')
    }
  }

  const out: GitStates = new Map(files)
  for (const [dirPath, state] of rolled) {
    // 取最大而不是直接覆盖：让这个纯函数的契约是"聚合 = 自身与后代里优先级最高的那个"，
    // 与输入顺序无关。当前 git 不会同时报出"目录 X 被忽略"和"X 底下有改动"
    // （实测：目录里一有被跟踪的文件，git 就改报逐个文件而不再报这个目录），
    // 所以这条比较今天判不到真实输入；它保证的是这个函数单独被调用时也讲得通。
    const raw = out.get(dirPath)
    if (raw === undefined || PRIORITY[raw] < PRIORITY[state]) out.set(dirPath, state)
  }
  return out
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

  // 返回值里同时包含 git 报出的路径与由它们滚上去的祖先目录——`GitStates` 的语义是
  // "每个路径该显示成什么状态"，不是 `git status` 输出的逐行镜像（见 types.ts 的字段注释）。
  // 放在这里而不是让调用方自己滚：gitStatus 每次 open() 只跑一次，且这样任何拿到这张 Map
  // 的宿主都不会漏掉这一步。
  return rollupDirStates(states)
}

function toState(type: string, xy: string): GitState {
  if (type === 'u') return 'conflicted'
  if (xy.includes('A')) return 'added'
  if (xy.includes('D')) return 'deleted'
  return 'modified'
}
