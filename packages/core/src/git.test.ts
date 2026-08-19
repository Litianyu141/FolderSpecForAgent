import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { gitStatus } from './git.js'

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
