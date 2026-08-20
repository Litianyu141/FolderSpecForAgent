import { spawn } from 'node:child_process'

export interface BrowserCandidate {
  command: string
  appMode: boolean
}

/** 支持 --app 无边框窗口的 Chromium 系，按优先级排列 */
const APP_CAPABLE: Record<string, readonly string[]> = {
  linux: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'],
  darwin: ['/Applications/Google Chrome.app', '/Applications/Microsoft Edge.app', '/Applications/Chromium.app'],
  win32: ['chrome.exe', 'msedge.exe'],
}

/** 不支持 --app，只能开普通标签页 */
const FALLBACK: readonly string[] = ['firefox', 'firefox-esr', '/Applications/Firefox.app']

export function pickBrowser(platform: NodeJS.Platform, available: readonly string[]): BrowserCandidate | null {
  for (const c of APP_CAPABLE[platform] ?? []) {
    if (available.includes(c)) return { command: c, appMode: true }
  }
  for (const c of FALLBACK) {
    if (available.includes(c)) return { command: c, appMode: false }
  }
  const first = available[0]
  return first ? { command: first, appMode: false } : null
}

/**
 * 存在性探测（which/fs.access）和真正 spawn 之间有一个 TOCTOU 窗口——二进制可能在这中间
 * 消失，或者探测通过但没有执行权限（EACCES）。spawn 对这类失败是异步 emit 'error'，不监听
 * 就会被当成未处理异常抛出，和 Finding 1 是同一类"一次意外请求就能杀死整个进程"的问题。
 */
function spawnDetached(command: string, args: readonly string[]): void {
  const child = spawn(command, args, { detached: true, stdio: 'ignore' })
  child.on('error', () => {
    process.stderr.write(`Could not launch the browser: ${command}\n`)
  })
  child.unref()
}

export function launch(candidate: BrowserCandidate, url: string, platform: NodeJS.Platform): void {
  const args = candidate.appMode
    ? [`--app=${url}`, '--window-size=1200,800']
    : [url]

  if (platform === 'darwin') {
    spawnDetached('open', ['-na', candidate.command, '--args', ...args])
    return
  }
  spawnDetached(candidate.command, args)
}
