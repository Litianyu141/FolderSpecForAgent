import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { scan, MAX_CHILDREN } from './scan.js'
import type { ActualNode } from './types.js'

let root: string
/** 工作区外的临时目录，装着不该被枚举到的文件名——独立于 root 的另一个 mkdtemp */
let outsideRoot: string

const kid = (n: ActualNode, name: string): ActualNode => {
  const found = n.children?.find(c => c.name === name)
  if (!found) throw new Error(`未找到子节点 ${name}，实际有 ${n.children?.map(c => c.name).join(',')}`)
  return found
}

beforeAll(async () => {
  root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'folderspec-scan-'))
  await fs.mkdir(nodePath.join(root, 'src/core'), { recursive: true })
  await fs.mkdir(nodePath.join(root, 'src/deep/deeper'), { recursive: true })
  await fs.mkdir(nodePath.join(root, 'node_modules/pkg'), { recursive: true })
  await fs.mkdir(nodePath.join(root, '.git/objects'), { recursive: true })
  await fs.mkdir(nodePath.join(root, 'sub'), { recursive: true })
  await fs.mkdir(nodePath.join(root, 'sub/build'), { recursive: true })
  await fs.writeFile(nodePath.join(root, '.gitignore'), 'node_modules\n*.log\n')
  await fs.writeFile(nodePath.join(root, 'sub/.gitignore'), 'build\n')
  await fs.writeFile(nodePath.join(root, 'src/core/walk.ts'), '')
  await fs.writeFile(nodePath.join(root, 'debug.log'), '')
  await fs.writeFile(nodePath.join(root, 'README.md'), '')
  await fs.symlink(nodePath.join(root, 'src'), nodePath.join(root, 'link-to-src'), 'dir')

  // maxChildren 边界：恰好等于上限，不应截断
  await fs.mkdir(nodePath.join(root, 'cap-exact'), { recursive: true })
  await Promise.all(
    Array.from({ length: 3 }, (_, i) => fs.writeFile(nodePath.join(root, 'cap-exact', `f${i}.txt`), '')),
  )

  // maxChildren 边界：超过上限一个，应截断
  await fs.mkdir(nodePath.join(root, 'cap-over'), { recursive: true })
  await Promise.all(
    Array.from({ length: 4 }, (_, i) => fs.writeFile(nodePath.join(root, 'cap-over', `f${i}.txt`), '')),
  )

  // maxChildren 边界：被 ignore 掉的条目不应计入截断判断
  await fs.mkdir(nodePath.join(root, 'cap-ignored'), { recursive: true })
  await Promise.all([
    ...Array.from({ length: 3 }, (_, i) => fs.writeFile(nodePath.join(root, 'cap-ignored', `keep${i}.txt`), '')),
    ...Array.from({ length: 2 }, (_, i) => fs.writeFile(nodePath.join(root, 'cap-ignored', `skip${i}.log`), '')),
  ])
  await fs.writeFile(nodePath.join(root, 'cap-ignored/.gitignore'), '*.log\n.gitignore\n')

  outsideRoot = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'folderspec-scan-outside-'))
  await fs.writeFile(nodePath.join(outsideRoot, 'secret-marker-file.txt'), '')
  await fs.symlink(outsideRoot, nodePath.join(root, 'escape-dir'), 'dir')
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(outsideRoot, { recursive: true, force: true })
})

describe('scan', () => {
  it('默认扫两层，第三层的 children 为 undefined', async () => {
    const t = await scan(root)
    expect(t.path).toBe('')
    const deep = kid(kid(t, 'src'), 'deep')
    expect(deep.children).toBeUndefined()
    expect(kid(t, 'src').children).toBeDefined()
  })

  it('应用根 .gitignore：排除 node_modules 与 *.log', async () => {
    const t = await scan(root)
    const names = t.children!.map(c => c.name)
    expect(names).not.toContain('node_modules')
    expect(names).not.toContain('debug.log')
    expect(names).toContain('README.md')
  })

  it('无条件排除 .git', async () => {
    const t = await scan(root)
    expect(t.children!.map(c => c.name)).not.toContain('.git')
  })

  it('应用子目录自己的 .gitignore', async () => {
    const t = await scan(root, { depth: 3 })
    expect(kid(t, 'sub').children!.map(c => c.name)).not.toContain('build')
  })

  it('符号链接标为 symlink 且不递归进入', async () => {
    const t = await scan(root)
    const link = kid(t, 'link-to-src')
    expect(link.kind).toBe('symlink')
    expect(link.children).toBeUndefined()
  })

  it('path 是相对根的 posix 路径', async () => {
    const t = await scan(root)
    expect(kid(kid(t, 'src'), 'core').path).toBe('src/core')
  })

  it('子项排序：目录在前，同类按名称', async () => {
    const t = await scan(root)
    const names = t.children!.map(c => c.name)
    const firstFile = names.findIndex(n => n === 'README.md')
    const lastDir = names.lastIndexOf('src')
    expect(lastDir).toBeLessThan(firstFile)
  })

  it('可从子路径开始扫描', async () => {
    const t = await scan(root, { subPath: 'src', depth: 1 })
    expect(t.path).toBe('src')
    expect(t.children!.map(c => c.name).sort()).toEqual(['core', 'deep'])
    expect(kid(t, 'core').children).toBeUndefined()
  })

  it('不可读目录标 unreadable 且不中断扫描', async () => {
    const secret = nodePath.join(root, 'secret')
    await fs.mkdir(secret, { recursive: true })
    await fs.chmod(secret, 0o000)
    try {
      const t = await scan(root, { depth: 2 })
      const s = kid(t, 'secret')
      expect(s.unreadable).toBe(true)
      expect(s.children).toEqual([])
      expect(kid(t, 'src').children).toBeDefined()
    } finally {
      await fs.chmod(secret, 0o755)
      await fs.rm(secret, { recursive: true, force: true })
    }
  })

  it('超过 MAX_CHILDREN 时截断并标记', async () => {
    const big = nodePath.join(root, 'big')
    await fs.mkdir(big, { recursive: true })
    await Promise.all(
      Array.from({ length: MAX_CHILDREN + 5 }, (_, i) =>
        fs.writeFile(nodePath.join(big, `f${i}.txt`), '')),
    )
    try {
      const t = await scan(root, { subPath: 'big', depth: 1 })
      expect(t.truncated).toBe(true)
      expect(t.children).toHaveLength(MAX_CHILDREN)
    } finally {
      await fs.rm(big, { recursive: true, force: true })
    }
  }, 60_000)

  it('.gitignore 里的否定模式无法复活 .git', async () => {
    const negateRoot = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'folderspec-scan-negate-'))
    try {
      await fs.mkdir(nodePath.join(negateRoot, '.git'), { recursive: true })
      await fs.writeFile(nodePath.join(negateRoot, '.gitignore'), 'node_modules\n!.git\n')
      const t = await scan(negateRoot, { depth: 1 })
      expect(t.children!.map(c => c.name)).not.toContain('.git')
    } finally {
      await fs.rm(negateRoot, { recursive: true, force: true })
    }
  })

  it('恰好 maxChildren 个子项时不标记 truncated', async () => {
    const t = await scan(root, { subPath: 'cap-exact', depth: 1, maxChildren: 3 })
    expect(t.children).toHaveLength(3)
    expect(t.truncated).toBeUndefined()
  })

  it('超过 maxChildren 时标记 truncated', async () => {
    const t = await scan(root, { subPath: 'cap-over', depth: 1, maxChildren: 3 })
    expect(t.children).toHaveLength(3)
    expect(t.truncated).toBe(true)
  })

  it('被忽略的条目不计入截断', async () => {
    const t = await scan(root, { subPath: 'cap-ignored', depth: 1, maxChildren: 3 })
    expect(t.children!.map(c => c.name).sort()).toEqual(['keep0.txt', 'keep1.txt', 'keep2.txt'])
    expect(t.truncated).toBeUndefined()
  })

  it('拒绝越界的 subPath', async () => {
    await expect(scan(root, { subPath: '../../..' })).rejects.toThrow(/不得包含 "\.\." 段/)
  })

  it('subPath 经符号链接指向工作区外时拒绝，且不枚举到工作区外的文件名', async () => {
    // escape-dir 本身是指向 outsideRoot 的符号链接：subPath 的文本里没有任何 ".."，
    // 纯词法校验拦不住，必须靠 resolveWithinWorkspace 的 realpath 比对（与 file-read
    // 共用同一处实现）。这里泄漏的是文件名而非内容，比 file/read 轻，但同一类缺口。
    let result: ActualNode | undefined
    let threw = false
    try {
      result = await scan(root, { subPath: 'escape-dir', depth: 1 })
    } catch {
      threw = true
    }
    const leakedNames = result?.children?.map(c => c.name) ?? []
    expect(leakedNames).not.toContain('secret-marker-file.txt')
    expect(threw).toBe(true)
  })
})
