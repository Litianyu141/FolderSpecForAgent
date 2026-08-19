#!/usr/bin/env node
import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer } from './server.js'
import { launch, pickBrowser } from './open-window.js'
import type { BrowserCandidate } from './open-window.js'

const HELP = `folderspec — 可视化声明仓库结构意图

用法：
  folderspec [目录]          在指定目录（默认为当前目录）打开
  folderspec --port <n>      指定端口（默认随机可用端口）
  folderspec --no-open       只起服务，不自动开窗口
  folderspec --help          显示本帮助
`

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP)
    return
  }

  const noOpen = argv.includes('--no-open')
  const portIdx = argv.indexOf('--port')
  const port = portIdx !== -1 ? Number(argv[portIdx + 1]) : undefined
  const positional = argv.filter((a, i) =>
    !a.startsWith('-') && !(portIdx !== -1 && i === portIdx + 1))
  const root = nodePath.resolve(positional[0] ?? process.cwd())

  const here = nodePath.dirname(fileURLToPath(import.meta.url))
  const uiDir = nodePath.join(here, 'ui')

  const server = await startServer({ root, uiDir, ...(port ? { port } : {}) })
  process.stdout.write(`FolderSpec 已启动\n  工作区：${root}\n  地址：  ${server.url}\n`)

  if (!noOpen) {
    const candidate = await detectBrowser()
    if (candidate) {
      launch(candidate, server.url, process.platform)
      if (!candidate.appMode) {
        process.stdout.write('未找到支持无边框窗口的浏览器，已在普通标签页中打开。\n')
      }
    } else {
      process.stdout.write('未检测到可用浏览器，请手动打开上面的地址。\n')
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

void main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
  process.exit(1)
})
