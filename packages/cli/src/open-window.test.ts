import { describe, it, expect } from 'vitest'
import { pickBrowser } from './open-window.js'

describe('pickBrowser', () => {
  it('Linux 上优先选支持 --app 的 Chromium 系', () => {
    const b = pickBrowser('linux', ['firefox', 'google-chrome'])
    expect(b).toEqual({ command: 'google-chrome', appMode: true })
  })

  it('macOS 上用 open -a 走 Chrome', () => {
    const b = pickBrowser('darwin', ['/Applications/Google Chrome.app'])
    expect(b?.appMode).toBe(true)
  })

  it('只有 Firefox 时回退到非 app 模式', () => {
    const b = pickBrowser('linux', ['firefox'])
    expect(b).toEqual({ command: 'firefox', appMode: false })
  })

  it('一个浏览器都没有时返回 null', () => {
    expect(pickBrowser('linux', [])).toBeNull()
  })

  it('候选顺序稳定：chrome 优先于 chromium 优先于 edge', () => {
    const b = pickBrowser('linux', ['microsoft-edge', 'chromium', 'google-chrome'])
    expect(b?.command).toBe('google-chrome')
  })
})
