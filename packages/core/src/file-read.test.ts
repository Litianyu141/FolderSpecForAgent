import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { readWorkspaceFile, MAX_READ_BYTES } from './file-read.js'
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
    await expect(readWorkspaceFile(root, '../../../etc/passwd')).rejects.toThrow(/不得包含 "\.\." 段/)
  })

  it('符号链接是路径最后一段、指向工作区外文件时，读不到该文件内容', async () => {
    const linkPath = nodePath.join(root, 'link-to-secret.txt')
    await fs.symlink(nodePath.join(outsideRoot, 'secret.txt'), linkPath)

    let result: FileReadResult | undefined
    let threw = false
    try {
      result = await readWorkspaceFile(root, 'link-to-secret.txt')
    } catch {
      threw = true
    }

    // 核心断言落在内容上：不管实现选择抛错还是返回某种"不可读"结果，唯一不可接受的
    // 是把符号链接背后、工作区外的秘密内容带回来。只断言"抛错了"钉不住这一点——
    // 一个"忘了处理某个分支但恰好也抛了别的错"的实现同样能让 rejects.toThrow() 变绿。
    expect(leakedText(result)).not.toContain(SECRET)
    // 当前实现的实际契约：越界（含经符号链接）统一抛错，不会静默退化成 unreadable。
    expect(threw).toBe(true)
  })

  it('符号链接是路径中间一段、整条路径本身不含 ".." 时，读不到该文件内容', async () => {
    // 这是最容易被漏掉的变体：`escape-dir/secret.txt` 是一条规规矩矩的工作区内相对
    // 路径，纯词法校验（normalizeWorkspacePath）在这里完全无能为力——escape-dir
    // 本身是指向工作区外目录的符号链接，逃逸发生在路径解析阶段而不是路径文本里。
    const linkDir = nodePath.join(root, 'escape-dir')
    await fs.symlink(outsideRoot, linkDir, 'dir')

    let result: FileReadResult | undefined
    let threw = false
    try {
      result = await readWorkspaceFile(root, 'escape-dir/secret.txt')
    } catch {
      threw = true
    }

    expect(leakedText(result)).not.toContain(SECRET)
    expect(threw).toBe(true)
  })
})
