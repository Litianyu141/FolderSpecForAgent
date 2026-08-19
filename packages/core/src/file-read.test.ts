import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { readWorkspaceFile, MAX_READ_BYTES } from './file-read.js'

let root: string

beforeAll(async () => {
  root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'fileread-'))
  await fs.mkdir(nodePath.join(root, 'sub'), { recursive: true })
  await fs.writeFile(nodePath.join(root, 'sub/a.txt'), '第一行\n第二行\n')
  await fs.writeFile(nodePath.join(root, 'bin.dat'), Buffer.from([0x41, 0x00, 0x42]))
  await fs.writeFile(nodePath.join(root, 'big.txt'), Buffer.alloc(MAX_READ_BYTES + 1, 0x61))
})

afterAll(async () => { await fs.rm(root, { recursive: true, force: true }) })

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
})
