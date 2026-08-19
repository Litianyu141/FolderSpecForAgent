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

export function launch(candidate: BrowserCandidate, url: string, platform: NodeJS.Platform): void {
  const args = candidate.appMode
    ? [`--app=${url}`, '--window-size=1200,800']
    : [url]

  if (platform === 'darwin') {
    spawn('open', ['-na', candidate.command, '--args', ...args], { detached: true, stdio: 'ignore' }).unref()
    return
  }
  spawn(candidate.command, args, { detached: true, stdio: 'ignore' }).unref()
}
