import { describe, it, expect } from 'vitest'
import { buildWebviewHtml } from './webview-html.js'

const INDEX = [
  '<!doctype html>',
  '<html><head><link rel="stylesheet" href="./assets/index-abc.css"></head>',
  '<body><div id="root"></div><script type="module" src="./assets/index-abc.js"></script></body></html>',
].join('\n')

const ROOT = '/workspace/demo'

const build = () => buildWebviewHtml({
  indexHtml: INDEX,
  assetBase: 'https://vscode-webview.example/media/ui',
  cspSource: 'https://vscode-webview.example',
  nonce: 'NONCE123',
  root: ROOT,
})

describe('buildWebviewHtml', () => {
  it('把相对资源路径改写成 webview URI', () => {
    const html = build()
    expect(html).toContain('https://vscode-webview.example/media/ui/assets/index-abc.js')
    expect(html).toContain('https://vscode-webview.example/media/ui/assets/index-abc.css')
    expect(html).not.toContain('"./assets/')
  })

  it('给所有 script 标签打上 nonce', () => {
    const html = build()
    const scripts = html.match(/<script/g) ?? []
    const nonces = html.match(/nonce="NONCE123"/g) ?? []
    expect(nonces.length).toBe(scripts.length)
  })

  it('注入 CSP，且脚本只允许带 nonce 的', () => {
    const html = build()
    expect(html).toContain('Content-Security-Policy')
    expect(html).toContain("script-src 'nonce-NONCE123'")
    expect(html).toContain("default-src 'none'")
  })

  it('注入把 --fs-* 指向 VSCode 主题色的样式', () => {
    const html = build()
    expect(html).toContain('--fs-git-modified: var(--vscode-gitDecoration-modifiedResourceForeground')
    expect(html).toContain('--fs-git-ignored: var(--vscode-gitDecoration-ignoredResourceForeground')
    expect(html).toContain('--fs-fg: var(--vscode-foreground')
  })

  it('注入真实的工作区根路径，且脚本带 nonce（CLI 宿主靠这个脚本让 UI 拿到真实 root，VSCode 之前漏了）', () => {
    const html = build()
    expect(html).toContain(`window.__folderspecRoot=${JSON.stringify(ROOT)}`)
    // 复用上面"脚本数等于 nonce 数"的不变量：新增的注入脚本也必须带 nonce，
    // 否则严格 CSP（script-src 'nonce-...'）会直接拦下它，root 永远送不到 UI。
    const scripts = html.match(/<script/g) ?? []
    const nonces = html.match(/nonce="NONCE123"/g) ?? []
    expect(nonces.length).toBe(scripts.length)
  })
})
