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

  it('未变更的已跟踪文件不出现在结果里', async () => {
    expect((await gitStatus(repo)).has('sub/nested.txt')).toBe(false)
  })

  it('路径用 posix 分隔符', async () => {
    await fs.writeFile(nodePath.join(repo, 'sub/another.txt'), 'x\n')
    const states = await gitStatus(repo)
    expect(states.has('sub/another.txt')).toBe(true)
    await fs.rm(nodePath.join(repo, 'sub/another.txt'))
  })

  it('识别重命名（porcelain v2 的 2 记录多一个 NUL 字段）', async () => {
    const git = (...args: string[]) => run('git', args, { cwd: repo })
    await git('mv', 'sub/nested.txt', 'sub/renamed.txt')
    try {
      const states = await gitStatus(repo)
      expect(states.get('sub/renamed.txt')).toBeDefined()
      // 关键：重命名记录的额外字段没有把后续记录解析歪
      expect(states.get('fresh.txt')).toBe('untracked')
    } finally {
      await git('mv', 'sub/renamed.txt', 'sub/nested.txt')
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
