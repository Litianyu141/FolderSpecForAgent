import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { gitStatus, rollupDirStates } from './git.js'
import { scan, DEFAULT_DEPTH } from './scan.js'
import { merge } from './merge.js'
import { emptySpec } from './spec-edit.js'
import type { GitState, GitStates, ViewNode } from './types.js'

const run = promisify(execFile)
let repo: string

beforeAll(async () => {
  repo = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'folderspec-git-'))
  const git = (...args: string[]) => run('git', args, { cwd: repo })
  await git('init', '-q')
  await git('config', 'user.email', 'test@example.com')
  await git('config', 'user.name', 'Test')
  await fs.writeFile(nodePath.join(repo, '.gitignore'), 'ignored.txt\n')
  await fs.writeFile(nodePath.join(repo, 'tracked.txt'), 'v1\n')
  await fs.mkdir(nodePath.join(repo, 'sub'), { recursive: true })
  await fs.writeFile(nodePath.join(repo, 'sub/nested.txt'), 'v1\n')
  // 诱饵文件：文件名以 '!' 开头。'!' 和 '?' 是 porcelain v2 里 ignored/untracked 记录的
  // 类型哨兵字符，且这两个分支直接 `states.set(rec.slice(2), ...)`，不像 1/2/u 分支那样有
  // "path 为空则跳过" 的兜底。用它做重命名的原始路径，可以在“跳过 origPath 额外字段”的
  // i++ 被去掉时，产生一个可观察的错误 Map 键——见下面“识别重命名”测试。
  await fs.writeFile(nodePath.join(repo, '!leak.txt'), 'v1\n')
  await fs.writeFile(nodePath.join(repo, 'todelete.txt'), 'v1\n')
  await git('add', '.')
  await git('commit', '-q', '-m', 'init')

  await fs.writeFile(nodePath.join(repo, 'tracked.txt'), 'v2\n')          // modified
  await fs.writeFile(nodePath.join(repo, 'fresh.txt'), 'new\n')           // untracked
  await fs.writeFile(nodePath.join(repo, 'ignored.txt'), 'junk\n')        // ignored
  await fs.writeFile(nodePath.join(repo, 'staged.txt'), 'added\n')
  await git('add', 'staged.txt')                                          // added
})

afterAll(async () => {
  await fs.rm(repo, { recursive: true, force: true })
})

describe('gitStatus', () => {
  it('识别已修改文件', async () => {
    expect((await gitStatus(repo)).get('tracked.txt')).toBe('modified')
  })

  it('识别未跟踪文件', async () => {
    expect((await gitStatus(repo)).get('fresh.txt')).toBe('untracked')
  })

  it('识别已忽略文件', async () => {
    expect((await gitStatus(repo)).get('ignored.txt')).toBe('ignored')
  })

  it('识别已暂存的新增文件', async () => {
    expect((await gitStatus(repo)).get('staged.txt')).toBe('added')
  })

  it('识别已删除文件', async () => {
    const target = nodePath.join(repo, 'todelete.txt')
    const original = await fs.readFile(target)
    await fs.rm(target)
    try {
      expect((await gitStatus(repo)).get('todelete.txt')).toBe('deleted')
    } finally {
      await fs.writeFile(target, original)
    }
  })

  it('未变更的已跟踪文件不出现在结果里', async () => {
    expect((await gitStatus(repo)).has('sub/nested.txt')).toBe(false)
  })

  it('路径用 posix 分隔符', async () => {
    await fs.writeFile(nodePath.join(repo, 'sub/another.txt'), 'x\n')
    try {
      const states = await gitStatus(repo)
      expect(states.has('sub/another.txt')).toBe(true)
    } finally {
      await fs.rm(nodePath.join(repo, 'sub/another.txt'))
    }
  })

  it('识别重命名（porcelain v2 的 2 记录多一个 NUL 字段）', async () => {
    const git = (...args: string[]) => run('git', args, { cwd: repo })
    await git('mv', 'sub/nested.txt', 'sub/renamed.txt')
    await git('mv', '!leak.txt', 'renamed-decoy.txt')
    try {
      const states = await gitStatus(repo)
      expect(states.get('sub/renamed.txt')).toBeDefined()
      expect(states.get('renamed-decoy.txt')).toBeDefined()
      // 决定性断言：'!leak.txt' → 'renamed-decoy.txt' 这条重命名记录后面，porcelain v2 -z
      // 会多输出一个 NUL 分隔的 origPath 字段，内容就是 '!leak.txt'。如果实现里跳过它的
      // i++ 被删掉，这个字段会被当成独立的顶层记录解析：rec[0] === '!' 命中 ignored 分支，
      // 该分支没有长度兜底，直接执行 states.set('!leak.txt'.slice(2), 'ignored')，也就是
      // states.set('eak.txt', 'ignored')，把一个错误的键写进 Map。
      // 用 sub/nested.txt 做诱饵测不出这个 bug：它的 origPath 首字符 's' 不是任何记录类型
      // 的哨兵字符，会被类型分派直接跳过，不管 i++ 在不在，结果都一样（已用脚本验证，
      // 见 fix report 的决定性演示）。
      expect(states.has('eak.txt')).toBe(false)
      expect(states.get('fresh.txt')).toBe('untracked')
    } finally {
      await git('mv', 'sub/renamed.txt', 'sub/nested.txt')
      await git('mv', 'renamed-decoy.txt', '!leak.txt')
    }
  })

  it('不是 git 仓库时返回空 Map 而非抛错', async () => {
    const plain = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'folderspec-plain-'))
    try {
      expect((await gitStatus(plain)).size).toBe(0)
    } finally {
      await fs.rm(plain, { recursive: true, force: true })
    }
  })
})

describe('gitStatus - 合并冲突', () => {
  let conflictRepo: string

  beforeAll(async () => {
    conflictRepo = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'folderspec-git-conflict-'))
    const git = (...args: string[]) => run('git', args, { cwd: conflictRepo })
    await git('init', '-q', '-b', 'main')
    await git('config', 'user.email', 'test@example.com')
    await git('config', 'user.name', 'Test')
    await fs.writeFile(nodePath.join(conflictRepo, 'conflict.txt'), 'base\n')
    await git('add', '.')
    await git('commit', '-q', '-m', 'base')

    await git('checkout', '-q', '-b', 'other')
    await fs.writeFile(nodePath.join(conflictRepo, 'conflict.txt'), 'other change\n')
    await git('commit', '-q', '-am', 'other change')

    await git('checkout', '-q', 'main')
    await fs.writeFile(nodePath.join(conflictRepo, 'conflict.txt'), 'main change\n')
    await git('commit', '-q', '-am', 'main change')

    try {
      // 两个分支修改了同一行，这里预期因冲突以非零退出——正是本 fixture 需要的状态
      await git('merge', 'other')
    } catch {
      // 冲突导致的非零退出是预期行为，忽略
    }
  })

  afterAll(async () => {
    await fs.rm(conflictRepo, { recursive: true, force: true })
  })

  it('识别冲突文件（porcelain v2 的 u 记录）', async () => {
    expect((await gitStatus(conflictRepo)).get('conflict.txt')).toBe('conflicted')
  })
})

describe('gitStatus —— 被忽略的目录（porcelain v2 会给它加尾斜杠）', () => {
  let ignoredRepo: string

  beforeAll(async () => {
    ignoredRepo = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'folderspec-git-ign-'))
    const git = (...args: string[]) => run('git', args, { cwd: ignoredRepo })
    await git('init', '-q', '-b', 'main')
    await git('config', 'user.email', 'test@example.com')
    await git('config', 'user.name', 'Test')
    await fs.writeFile(nodePath.join(ignoredRepo, 'README.md'), 'v1\n')
    await git('add', '.')
    await git('commit', '-q', '-m', 'init')

    // 忽略规则写进 .git/info/exclude，**不是** .gitignore。这不是图省事：scan() 只读
    // .gitignore/.ignore，写进 .gitignore 的话这棵子树在扫描阶段就被整个剪掉、根本不
    // 上树，那么"被忽略的目录查不查得到 git 状态"就永远观察不到，这条用例会变成一条
    // 检查了周边、没检查目标的假测试。走 exclude 时 git 照样报它、scan 照样把它扫上来，
    // 才是这条缺陷真正可见的那种情形。
    await fs.mkdir(nodePath.join(ignoredRepo, 'vendorcache/sub'), { recursive: true })
    await fs.writeFile(nodePath.join(ignoredRepo, 'vendorcache/sub/blob.bin'), 'x\n')
    await fs.writeFile(nodePath.join(ignoredRepo, '.git/info/exclude'), 'vendorcache/\n')
  })

  afterAll(async () => {
    await fs.rm(ignoredRepo, { recursive: true, force: true })
  })

  it('去掉尾斜杠后能按 ViewNode.path 查到', async () => {
    const states = await gitStatus(ignoredRepo)
    // 夹具自检：git 确实把它报成了一个目录（原始输出是 `! vendorcache/`），
    // 否则这条用例测的就不是它要防的那件事
    expect(states.has('vendorcache/sub/blob.bin')).toBe(false)
    expect(states.get('vendorcache')).toBe('ignored')
    expect(states.has('vendorcache/')).toBe(false)
  })

  it('树上的被忽略目录真的拿到了 ignored', async () => {
    const [actual, states] = await Promise.all([
      scan(ignoredRepo, { depth: DEFAULT_DEPTH }),
      gitStatus(ignoredRepo),
    ])
    const view = merge(actual, states, emptySpec())
    const node = (view.children ?? []).find(c => c.path === 'vendorcache')
    // 夹具自检：scan 读不到 .git/info/exclude，所以这个目录必须真的在树上
    expect(node).toBeDefined()
    expect(node?.gitState).toBe('ignored')
  })
})

describe('rollupDirStates —— 目录聚合（纯函数）', () => {
  const raw = (entries: [string, GitState][]): GitStates => new Map(entries)

  it('文件状态滚到它的每一层祖先目录上', () => {
    const out = rollupDirStates(raw([['src/deep/very/nested/file.ts', 'modified']]))
    expect(out.get('src')).toBe('modified')
    expect(out.get('src/deep')).toBe('modified')
    expect(out.get('src/deep/very')).toBe('modified')
    expect(out.get('src/deep/very/nested')).toBe('modified')
    // 文件自己那条原样保留，没有被聚合覆盖掉
    expect(out.get('src/deep/very/nested/file.ts')).toBe('modified')
    // 工作区根（空路径）不该被造出条目——merge 的根节点根本不查表，造了也只是垃圾
    expect(out.has('')).toBe(false)
  })

  it('同一目录里多种状态时取优先级最高的：conflicted > deleted > modified > added > untracked', () => {
    const pairs: [GitState, GitState][] = [
      ['conflicted', 'deleted'],
      ['deleted', 'modified'],
      ['modified', 'added'],
      ['added', 'untracked'],
    ]
    for (const [hi, lo] of pairs) {
      // 两种出现顺序都试：聚合结果不能依赖 git 输出的先后
      expect(rollupDirStates(raw([['d/a.ts', hi], ['d/b.ts', lo]])).get('d')).toBe(hi)
      expect(rollupDirStates(raw([['d/a.ts', lo], ['d/b.ts', hi]])).get('d')).toBe(hi)
    }
  })

  it('低优先级的条目先滚上去，也挡不住后面更高优先级的条目继续升级更上层的祖先', () => {
    // 这条专门盯住"祖先已经有值就提前收工"的剪枝：剪枝的判据必须是
    // "已有值的优先级 >= 当前值"，写成"已有值不为空"就会把 src 永久钉死在 untracked。
    const out = rollupDirStates(raw([
      ['src/a/x.ts', 'untracked'],
      ['src/b/y.ts', 'modified'],
    ]))
    expect(out.get('src')).toBe('modified')
    expect(out.get('src/a')).toBe('untracked')
    expect(out.get('src/b')).toBe('modified')
  })

  it('ignored 不参与聚合：目录里有被忽略的文件，目录本身不变灰', () => {
    const out = rollupDirStates(raw([['mixed/debug.log', 'ignored']]))
    expect(out.has('mixed')).toBe(false)
    expect(out.get('mixed/debug.log')).toBe('ignored')
  })

  it('被忽略的兄弟不影响真实改动往上滚', () => {
    const out = rollupDirStates(raw([
      ['pkg/dist/bundle.js', 'ignored'],
      ['pkg/src/index.ts', 'modified'],
    ]))
    expect(out.get('pkg')).toBe('modified')
    expect(out.has('pkg/dist')).toBe(false)
    expect(out.get('pkg/src')).toBe('modified')
  })

  it('目录自己被 git 报成 ignored 时原样保留', () => {
    const out = rollupDirStates(raw([['node_modules', 'ignored']]))
    expect(out.get('node_modules')).toBe('ignored')
  })

  it('目录自己是 ignored、底下又有真实改动时，聚合值盖过 ignored', () => {
    // 真实 git 今天造不出这对输入（实测：目录里一有被跟踪的文件，git 就改报逐个文件、
    // 不再报这个目录）。这条测的是纯函数自身的契约——聚合 = 自身与后代里优先级最高的
    // 那个，与输入顺序无关——保证它被单独调用时也讲得通。
    expect(rollupDirStates(raw([['build', 'ignored'], ['build/keep.ts', 'modified']])).get('build')).toBe('modified')
    expect(rollupDirStates(raw([['build/keep.ts', 'modified'], ['build', 'ignored']])).get('build')).toBe('modified')
  })

  it('空输入返回空 Map（非 git 仓库走的就是这条）', () => {
    expect(rollupDirStates(new Map()).size).toBe(0)
  })
})

describe('gitStatus —— 目录跟着内部文件着色', () => {
  let dirRepo: string

  beforeAll(async () => {
    dirRepo = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'folderspec-git-dir-'))
    const git = (...args: string[]) => run('git', args, { cwd: dirRepo })
    await git('init', '-q', '-b', 'main')
    await git('config', 'user.email', 'test@example.com')
    await git('config', 'user.name', 'Test')

    await fs.writeFile(nodePath.join(dirRepo, '.gitignore'), '*.log\n')
    await fs.writeFile(nodePath.join(dirRepo, 'README.md'), 'v1\n')
    await fs.mkdir(nodePath.join(dirRepo, 'src/deep/very/nested'), { recursive: true })
    await fs.writeFile(nodePath.join(dirRepo, 'src/deep/very/nested/file.ts'), 'v1\n')
    await fs.mkdir(nodePath.join(dirRepo, 'mixed'), { recursive: true })
    await fs.writeFile(nodePath.join(dirRepo, 'mixed/keep.ts'), 'v1\n')
    await git('add', '.')
    await git('commit', '-q', '-m', 'init')

    // 深度 4 的文件被改动——首屏 scan(depth=2) 根本扫不到它
    await fs.writeFile(nodePath.join(dirRepo, 'src/deep/very/nested/file.ts'), 'v2\n')
    // 未跟踪文件，同样藏在扫描边界之下
    await fs.mkdir(nodePath.join(dirRepo, 'fresh/sub'), { recursive: true })
    await fs.writeFile(nodePath.join(dirRepo, 'fresh/sub/new.ts'), 'x\n')
    // 一个有被跟踪文件的目录里放一个被忽略的文件：git 会逐个文件地报它（已实测）
    await fs.writeFile(nodePath.join(dirRepo, 'mixed/debug.log'), 'noise\n')
  })

  afterAll(async () => {
    await fs.rm(dirRepo, { recursive: true, force: true })
  })

  it('深层文件的改动染到它的每一层祖先目录上', async () => {
    const states = await gitStatus(dirRepo)
    expect(states.get('src/deep/very/nested/file.ts')).toBe('modified')
    expect(states.get('src')).toBe('modified')
    expect(states.get('src/deep')).toBe('modified')
    expect(states.get('src/deep/very')).toBe('modified')
    expect(states.get('src/deep/very/nested')).toBe('modified')
  })

  it('未跟踪文件所在的每一层目录跟着变未跟踪', async () => {
    const states = await gitStatus(dirRepo)
    expect(states.get('fresh')).toBe('untracked')
    expect(states.get('fresh/sub')).toBe('untracked')
  })

  it('只含被忽略文件的改动不会把所在目录染灰', async () => {
    const states = await gitStatus(dirRepo)
    // 夹具自检：确认 git 真的把它报成了一个被忽略的**文件**，这条用例才谈得上有效
    expect(states.get('mixed/debug.log')).toBe('ignored')
    expect(states.has('mixed')).toBe(false)
  })
})

describe('目录着色 —— 端到端：真实仓库 → scan(depth=2) → merge', () => {
  let e2eRepo: string
  let view: ViewNode

  beforeAll(async () => {
    e2eRepo = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'folderspec-git-e2e-'))
    const git = (...args: string[]) => run('git', args, { cwd: e2eRepo })
    await git('init', '-q', '-b', 'main')
    await git('config', 'user.email', 'test@example.com')
    await git('config', 'user.name', 'Test')

    await fs.writeFile(nodePath.join(e2eRepo, '.gitignore'), '*.log\n')
    await fs.writeFile(nodePath.join(e2eRepo, 'README.md'), 'v1\n')
    await fs.mkdir(nodePath.join(e2eRepo, 'src/deep/very/nested'), { recursive: true })
    await fs.writeFile(nodePath.join(e2eRepo, 'src/deep/very/nested/file.ts'), 'v1\n')
    await fs.mkdir(nodePath.join(e2eRepo, 'mixed'), { recursive: true })
    await fs.writeFile(nodePath.join(e2eRepo, 'mixed/keep.ts'), 'v1\n')
    await git('add', '.')
    await git('commit', '-q', '-m', 'init')

    await fs.writeFile(nodePath.join(e2eRepo, 'src/deep/very/nested/file.ts'), 'v2\n')
    await fs.mkdir(nodePath.join(e2eRepo, 'fresh/sub'), { recursive: true })
    await fs.writeFile(nodePath.join(e2eRepo, 'fresh/sub/new.ts'), 'x\n')
    await fs.writeFile(nodePath.join(e2eRepo, 'mixed/debug.log'), 'noise\n')

    const [actual, states] = await Promise.all([
      scan(e2eRepo, { depth: DEFAULT_DEPTH }),
      gitStatus(e2eRepo),
    ])
    view = merge(actual, states, emptySpec())
  })

  afterAll(async () => {
    await fs.rm(e2eRepo, { recursive: true, force: true })
  })

  const at = (path: string): ViewNode => {
    const walk = (n: ViewNode): ViewNode | null => {
      if (n.path === path) return n
      for (const c of n.children ?? []) {
        const hit = walk(c)
        if (hit) return hit
      }
      return null
    }
    const hit = walk(view)
    if (!hit) throw new Error(`树上没有 ${path}`)
    return hit
  }
  const has = (path: string): boolean => {
    try { at(path); return true } catch { return false }
  }

  it('夹具自检：首屏确实只扫到两层，深层文件根本不在树上', () => {
    expect(has('src')).toBe(true)
    expect(has('src/deep')).toBe(true)
    // 扫描边界就在这里：src/deep 尚未展开，children 是 undefined
    expect(at('src/deep').children).toBeUndefined()
    expect(has('src/deep/very')).toBe(false)
    expect(has('src/deep/very/nested/file.ts')).toBe(false)
    expect(has('fresh/sub')).toBe(true)
    expect(has('fresh/sub/new.ts')).toBe(false)
  })

  it('浅层祖先目录跟着扫不到的深层文件着色', () => {
    expect(at('src').gitState).toBe('modified')
    expect(at('src/deep').gitState).toBe('modified')
  })

  it('未跟踪文件所在的目录链跟着变未跟踪', () => {
    expect(at('fresh').gitState).toBe('untracked')
    expect(at('fresh/sub').gitState).toBe('untracked')
  })

  it('只含被忽略文件的目录不变灰', () => {
    expect(at('mixed').gitState).toBeUndefined()
  })

  it('无改动的已跟踪文件与工作区根不带 git 状态', () => {
    expect(at('README.md').gitState).toBeUndefined()
    expect(at('').gitState).toBeUndefined()
  })
})
