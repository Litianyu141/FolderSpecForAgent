#!/usr/bin/env node
import * as fs from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import * as nodePath from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startServer } from './server.js'
import { launch, pickBrowser } from './open-window.js'
import type { BrowserCandidate } from './open-window.js'

const HELP = `folderspec — declare your repository's intended structure, visually

Usage:
  folderspec [dir]           open the given directory (defaults to the current one)
  folderspec --port <n>      listen on this port (default: a random free one)
  folderspec --no-open       start the server only, do not open a window
  folderspec --help          show this help
`

export interface CliArgs {
  root: string
  port?: number
  noOpen: boolean
  help: boolean
}

/**
 * 纯函数：只依赖显式传入的 argv/cwd，不读 process.*，方便直接单测
 * （参照本项目 pickBrowser 的写法）。
 *
 * --port 后面缺值或给了非正整数时必须抛出，而不是静默丢弃退回随机端口——
 * 否则用户没法区分"我就是要随机端口"和"我打错了 --port 的值"。
 */
export function parseArgs(argv: readonly string[], cwd: string): CliArgs {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { root: nodePath.resolve(cwd), noOpen: false, help: true }
  }

  const noOpen = argv.includes('--no-open')
  const portIdx = argv.indexOf('--port')
  let port: number | undefined
  if (portIdx !== -1) {
    const raw = argv[portIdx + 1] as string | undefined
    const parsed = raw !== undefined ? Number(raw) : NaN
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`--port needs a positive integer port number, got: ${raw ?? '(missing)'}`)
    }
    port = parsed
  }

  const positional = argv.filter((a, i) =>
    !a.startsWith('-') && !(portIdx !== -1 && i === portIdx + 1))
  const root = nodePath.resolve(cwd, positional[0] ?? '.')

  return { root, port, noOpen, help: false }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), process.cwd())
  if (args.help) {
    process.stdout.write(HELP)
    return
  }

  const here = nodePath.dirname(fileURLToPath(import.meta.url))
  const uiDir = nodePath.join(here, 'ui')

  const server = await startServer({ root: args.root, uiDir, ...(args.port ? { port: args.port } : {}) })
  process.stdout.write(`FolderSpec is running\n  workspace: ${args.root}\n  url:       ${server.url}\n`)

  if (!args.noOpen) {
    const candidate = await detectBrowser()
    if (candidate) {
      launch(candidate, server.url, process.platform)
      if (!candidate.appMode) {
        process.stdout.write('No browser supporting app-mode windows was found; opened a normal tab instead.\n')
      }
    } else {
      process.stdout.write('No usable browser detected — please open the URL above manually.\n')
    }
  }

  const shutdown = () => { void server.close().then(() => process.exit(0)) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

async function detectBrowser(): Promise<BrowserCandidate | null> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)

  const probe = async (name: string): Promise<boolean> => {
    if (name.startsWith('/')) {
      try { await fs.access(name); return true } catch { return false }
    }
    try {
      await run(process.platform === 'win32' ? 'where' : 'which', [name])
      return true
    } catch { return false }
  }

  const all = [
    'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge',
    'chrome.exe', 'msedge.exe', 'firefox', 'firefox-esr',
    '/Applications/Google Chrome.app', '/Applications/Microsoft Edge.app',
    '/Applications/Chromium.app', '/Applications/Firefox.app',
  ]
  const available: string[] = []
  for (const name of all) if (await probe(name)) available.push(name)
  return pickBrowser(process.platform, available)
}

/**
 * 只有作为入口脚本被直接执行时才真的跑起来。main.test.ts 要单测 parseArgs 就得
 * `import { parseArgs } from './main.js'`——如果没有这层判断，那次 import 本身就会把
 * 整个 CLI（真起一个 HTTP/WS 服务、真去探测并可能拉起浏览器）当副作用跑起来，服务
 * 永远不会被关掉，是货真价实的"没关掉的 handle"。
 *
 * Node 会把入口模块的 import.meta.url 解析成 realpath，却原样保留 process.argv[1]。
 * 经由包管理器 bin 生成的符号链接调用时（`npx folderspec`、全局安装等——这正是这个
 * 包唯一真正被使用的方式）两者必然不同：import.meta.url 指向 dist/main.js 的真实路径，
 * argv[1] 还停在符号链接那一层。不先 realpath 就直接比较，会让符号链接调用永远判定为
 * "不是入口模块"，main() 就再也不会执行——`npx folderspec` 会静默退出、什么都不做，
 * 且不打印任何错误。所以这里必须先对 argv[1] 求 realpath 再比较。
 */
export function isEntryModule(moduleUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined) return false
  try {
    return moduleUrl === pathToFileURL(realpathSync(argv1)).href
  } catch {
    return false
  }
}

if (isEntryModule(import.meta.url, process.argv[1])) {
  void main().catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
    process.exit(1)
  })
}
