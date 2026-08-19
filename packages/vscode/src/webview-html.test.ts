import { describe, it, expect } from 'vitest'
import { buildWebviewHtml } from './webview-html.js'

const INDEX = [
  '<!doctype html>',
  '<html><head><link rel="stylesheet" href="./assets/index-abc.css"></head>',
  '<body><div id="root"></div><script type="module" src="./assets/index-abc.js"></script></body></html>',
].join('\n')

const build = () => buildWebviewHtml({
  indexHtml: INDEX,
  assetBase: 'https://vscode-webview.example/media/ui',
  cspSource: 'https://vscode-webview.example',
  nonce: 'NONCE123',
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
})
