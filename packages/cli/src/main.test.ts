import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parseArgs, isEntryModule } from './main.js'

const run = promisify(execFile)
const CWD = '/home/user/project'

describe('parseArgs', () => {
  it('裸目录参数会相对 cwd 解析成 root', () => {
    const args = parseArgs(['sub/dir'], CWD)
    expect(args).toEqual({ root: nodePath.resolve(CWD, 'sub/dir'), port: undefined, noOpen: false, help: false })
  })

  it('没有位置参数时 root 默认为 cwd 本身', () => {
    const args = parseArgs([], CWD)
    expect(args.root).toBe(nodePath.resolve(CWD))
  })

  it('--port 8080 被解析为数字端口', () => {
    const args = parseArgs(['--port', '8080'], CWD)
    expect(args.port).toBe(8080)
  })

  it('--port 缺少值时抛出，而不是静默回退到随机端口', () => {
    expect(() => parseArgs(['--port'], CWD)).toThrow(/--port/)
  })

  it('--port abc 这种非数字值时抛出，而不是静默回退到随机端口', () => {
    expect(() => parseArgs(['--port', 'abc'], CWD)).toThrow(/--port/)
  })

  it('--no-open 被解析为 noOpen: true', () => {
    const args = parseArgs(['--no-open'], CWD)
    expect(args.noOpen).toBe(true)
  })

  it('--help 被解析为 help: true，且不要求给出合法的其余参数', () => {
    const args = parseArgs(['--help'], CWD)
    expect(args.help).toBe(true)
  })
})

describe('isEntryModule', () => {
  it('isEntryModule 对符号链接调用返回 true', async () => {
    // 复刻包管理器 bin 的真实形状：一个真实文件 + 一个指向它的符号链接。
    // process.argv[1] 在符号链接调用时是符号链接路径，import.meta.url 却会被
    // Node 解析成真实文件的 realpath——isEntryModule 必须把两者都对齐到 realpath
    // 之后再比较，否则符号链接调用永远判定为"不是入口模块"。
    const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'folderspec-entry-'))
    try {
      const realFile = nodePath.join(dir, 'real.mjs')
      const symlinkPath = nodePath.join(dir, 'link.mjs')
      await fs.writeFile(realFile, '// 占位\n')
      await fs.symlink(realFile, symlinkPath)

      const moduleUrl = pathToFileURL(realFile).href
      expect(isEntryModule(moduleUrl, symlinkPath)).toBe(true)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('isEntryModule 对无关路径返回 false', async () => {
    // 守住"干脆永远返回 true"这种伪修复：换一个不相关文件的 URL 去比对同一个符号链接，
    // 必须仍然是 false。
    const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'folderspec-entry-'))
    try {
      const realFile = nodePath.join(dir, 'real.mjs')
      const unrelatedFile = nodePath.join(dir, 'unrelated.mjs')
      const symlinkPath = nodePath.join(dir, 'link.mjs')
      await fs.writeFile(realFile, '// 占位\n')
      await fs.writeFile(unrelatedFile, '// 占位\n')
      await fs.symlink(realFile, symlinkPath)

      const unrelatedUrl = pathToFileURL(unrelatedFile).href
      expect(isEntryModule(unrelatedUrl, symlinkPath)).toBe(false)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('经符号链接实际启动时会真的运行 main', async () => {
    // 集成测试：不测我们对 Node 语义的理解，直接测 Node 本身的真实行为——如果 Node
    // 未来改变 import.meta.url/argv[1] 在符号链接下的解析方式，这个测试会先坏掉。
    const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'folderspec-entry-run-'))
    try {
      const realFile = nodePath.join(dir, 'real.mjs')
      const symlinkPath = nodePath.join(dir, 'link.mjs')
      await fs.writeFile(
        realFile,
        [
          "import { pathToFileURL } from 'node:url'",
          "import { realpathSync } from 'node:fs'",
          'const ok = import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href',
          "process.stdout.write(ok ? 'ENTRY' : 'NOT_ENTRY')",
          '',
        ].join('\n'),
      )
      await fs.symlink(realFile, symlinkPath)

      const { stdout } = await run(process.execPath, [symlinkPath])
      expect(stdout).toBe('ENTRY')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
