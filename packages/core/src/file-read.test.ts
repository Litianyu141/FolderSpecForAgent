import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { readWorkspaceFile, MAX_READ_BYTES } from './file-read.js'
import { specError } from './errors.test-support.js'
import type { FileReadResult } from './file-read.js'

let root: string
/** 工作区外的临时目录，装着不该被读到的"秘密"——独立于 root 的另一个 mkdtemp，真实在磁盘外面 */
let outsideRoot: string

/** 秘密内容的独有标记：不管 readWorkspaceFile 是抛错、返回 unreadable、还是别的什么，
 *  唯一不可接受的结果是这段文本出现在返回值里。用它而不是整段相等比较，是为了不给
 *  "内容被截断/拼接后仍然泄漏"这类变体留活口。 */
const SECRET = 'sup3r-secret-outside-workspace-8f3a1c9d'

/** 从 readWorkspaceFile 的返回值里提取文本，非 text 结果一律视为空串（没有内容可泄漏） */
const leakedText = (r: FileReadResult | undefined): string => (r?.kind === 'text' ? r.text : '')

beforeAll(async () => {
  root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'fileread-'))
  await fs.mkdir(nodePath.join(root, 'sub'), { recursive: true })
  await fs.writeFile(nodePath.join(root, 'sub/a.txt'), '第一行\n第二行\n')
  await fs.writeFile(nodePath.join(root, 'bin.dat'), Buffer.from([0x41, 0x00, 0x42]))
  await fs.writeFile(nodePath.join(root, 'big.txt'), Buffer.alloc(MAX_READ_BYTES + 1, 0x61))

  outsideRoot = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'fileread-outside-'))
  await fs.writeFile(nodePath.join(outsideRoot, 'secret.txt'), SECRET)
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(outsideRoot, { recursive: true, force: true })
})

describe('readWorkspaceFile', () => {
  it('读取文本文件', async () => {
    const r = await readWorkspaceFile(root, 'sub/a.txt')
    expect(r).toEqual({ kind: 'text', text: '第一行\n第二行\n' })
  })

  it('含 NUL 字节的文件判为二进制', async () => {
    expect(await readWorkspaceFile(root, 'bin.dat')).toEqual({ kind: 'binary' })
  })

  it('超过上限的文件不读内容', async () => {
    const r = await readWorkspaceFile(root, 'big.txt')
    expect(r.kind).toBe('too-large')
    if (r.kind === 'too-large') expect(r.size).toBe(MAX_READ_BYTES + 1)
  })

  it('目录返回 unreadable', async () => {
    const r = await readWorkspaceFile(root, 'sub')
    expect(r.kind).toBe('unreadable')
  })

  it('不存在的路径返回 unreadable 而非抛错', async () => {
    const r = await readWorkspaceFile(root, 'nope.txt')
    expect(r.kind).toBe('unreadable')
  })

  it('拒绝越界路径且不读到工作区外的内容', async () => {
    await expect(readWorkspaceFile(root, '../../../etc/passwd'))
      .rejects.toThrow(specError('path.parentSegment', { path: '"../../../etc/passwd"' }))
  })

  it('符号链接是路径最后一段、指向工作区外文件时，读不到该文件内容', async () => {
    const linkPath = nodePath.join(root, 'link-to-secret.txt')
    await fs.symlink(nodePath.join(outsideRoot, 'secret.txt'), linkPath)

    let result: FileReadResult | undefined
    let caught: unknown
    try {
      result = await readWorkspaceFile(root, 'link-to-secret.txt')
    } catch (e) {
      caught = e
    }

    // 核心断言落在内容上：不管实现选择抛错还是返回某种"不可读"结果，唯一不可接受的
    // 是把符号链接背后、工作区外的秘密内容带回来。只断言"抛错了"钉不住这一点——
    // 一个"忘了处理某个分支但恰好也抛了别的错"的实现同样能让 rejects.toThrow() 变绿。
    expect(leakedText(result)).not.toContain(SECRET)
    // 当前实现的实际契约：越界（含经符号链接）统一抛错，不会静默退化成 unreadable。
    // 断到 code 而不是只断"抛了"：上面那段注释记的正是"恰好也抛了别的错"能骗过
    // 一条只看抛没抛的用例——现在它骗不过了。
    expect(caught).toEqual(specError('path.escapesWorkspace', { path: '"link-to-secret.txt"' }))
  })

  it('符号链接是路径中间一段、整条路径本身不含 ".." 时，读不到该文件内容', async () => {
    // 这是最容易被漏掉的变体：`escape-dir/secret.txt` 是一条规规矩矩的工作区内相对
    // 路径，纯词法校验（normalizeWorkspacePath）在这里完全无能为力——escape-dir
    // 本身是指向工作区外目录的符号链接，逃逸发生在路径解析阶段而不是路径文本里。
    const linkDir = nodePath.join(root, 'escape-dir')
    await fs.symlink(outsideRoot, linkDir, 'dir')

    let result: FileReadResult | undefined
    let caught: unknown
    try {
      result = await readWorkspaceFile(root, 'escape-dir/secret.txt')
    } catch (e) {
      caught = e
    }

    expect(leakedText(result)).not.toContain(SECRET)
    expect(caught).toEqual(specError('path.escapesWorkspace', { path: '"escape-dir/secret.txt"' }))
  })

  it('符号链接环（自引用/相互引用）返回 unreadable 而非抛错', async () => {
    // 解析失败不等于越界证据：ELOOP 只是"这次没解析成功"，不是"证实它指向工作区外"。
    // 修复越界漏洞时若把 realpath 的失败一律重抛，会把这类本该走 unreadable 分支的
    // 普通解析失败错误地升级成未捕获异常——scan() 顶层 readdir 仍会把它列成一个
    // 普通的 symlink 子项，用户点开它是最自然的下一步动作。
    await fs.symlink('loop-b.txt', nodePath.join(root, 'loop-a.txt'))
    await fs.symlink('loop-a.txt', nodePath.join(root, 'loop-b.txt'))

    const r = await readWorkspaceFile(root, 'loop-a.txt')
    expect(r.kind).toBe('unreadable')
  })

  it('目录不可搜索（EACCES）时返回 unreadable 而非抛错', async () => {
    expect(
      process.getuid?.(),
      '这条用例必须以非 root 身份运行：root 无视目录的执行位，chmod 0o600 造不出 EACCES，用例会假绿',
    ).not.toBe(0)

    const dir = nodePath.join(root, 'noexec')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(nodePath.join(dir, 'f.txt'), 'x')
    await fs.chmod(dir, 0o600) // 可读写、不可搜索——realpath 穿过这一级目录时应得到 EACCES

    try {
      const r = await readWorkspaceFile(root, 'noexec/f.txt')
      expect(r.kind).toBe('unreadable')
    } finally {
      await fs.chmod(dir, 0o755) // 还原，否则 afterAll 的 recursive rm 进不去这个目录
    }
  })
})
