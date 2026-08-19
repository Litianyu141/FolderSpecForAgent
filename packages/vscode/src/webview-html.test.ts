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

  it('新增的表面色 token 也映射到 VSCode 主题变量', () => {
    const html = build()
    expect(html).toContain('--fs-sidebar-bg: var(--vscode-sideBar-background')
    expect(html).toContain('--fs-editor-bg: var(--vscode-editor-background')
    expect(html).toContain('--fs-panel-border: var(--vscode-panel-border')
    expect(html).toContain('--fs-row-hover-bg: var(--vscode-list-hoverBackground')
    expect(html).toContain('--fs-indent-guide: var(--vscode-tree-indentGuidesStroke')
    expect(html).toContain('--fs-line-number: var(--vscode-editorLineNumber-foreground')
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

describe('buildWebviewHtml 注入值的转义', () => {
  it('root 字面量含 "</script>" 时不能提前闭合 script 标签', () => {
    // `a<` 目录里套一个 `script>` 目录，拼起来就是一个真实可创建、且字面量含
    // "</script>" 的绝对路径。JSON.stringify 不转义 '/'，不额外处理 '<' 的话，
    // 这段注入脚本会被 HTML 分词器在这里截断，后面的内容变成新的元素。
    // 这里的 CSP nonce 会拦住它执行，但同一份注入代码在 CLI 宿主那边没有任何 CSP。
    const evilRoot = '/workspace/a</script><script>alert(1)</script>'
    const html = buildWebviewHtml({
      indexHtml: INDEX,
      assetBase: 'https://vscode-webview.example/media/ui',
      cspSource: 'https://vscode-webview.example',
      nonce: 'NONCE123',
      root: evilRoot,
    })

    const open = html.indexOf('window.__folderspecRoot')
    const body = html.slice(open, html.indexOf('</script>', open))
    expect(body).toContain('a\\u003c/script>')
    expect(body).not.toContain('<')

    // INDEX 自带一个 script，注入的算第二个；一个都不能多出来
    expect((html.match(/<script/g) ?? []).length).toBe(2)
    expect((html.match(/<\/script>/g) ?? []).length).toBe(2)
    // 转义后所有 script 依然带 nonce（没有被截断出一个无 nonce 的新标签）
    expect((html.match(/nonce="NONCE123"/g) ?? []).length).toBe(2)
  })

  it('root 含 a$`b 时，$` 展开不会再次激活 </script> 突破口', () => {
    // String.replace 的字符串替换参数会展开 $&、$`、$'、$$。
    // 用函数替换而非字符串替换可以完全避免这种扩展。
    const evilRoot = '/workspace/a$`b'
    const html = buildWebviewHtml({
      indexHtml: INDEX,
      assetBase: 'https://vscode-webview.example/media/ui',
      cspSource: 'https://vscode-webview.example',
      nonce: 'NONCE123',
      root: evilRoot,
    })

    const open = html.indexOf('window.__folderspecRoot')
    const body = html.slice(open, html.indexOf('</script>', open))

    // 脚本体内不能出现任何字面量 '<'
    expect(body).not.toContain('<')

    // 必须是 2 个 script：INDEX 自带一个，注入的算第二个
    expect((html.match(/<script/g) ?? []).length).toBe(2)
    expect((html.match(/<\/script>/g) ?? []).length).toBe(2)

    // 所有 script 都必须带 nonce（没有被截断出新的标签）
    expect((html.match(/nonce="NONCE123"/g) ?? []).length).toBe(2)

    // root 值必须完整轮转回去
    const rootMatch = body.match(/window\.__folderspecRoot=(.*?);/)
    expect(rootMatch).not.toBeNull()
    const parsed = JSON.parse(rootMatch![1])
    expect(parsed).toBe(evilRoot)
  })

  it('root 含 a$\'b 时，$\' 展开不会再次激活 </script> 突破口', () => {
    const evilRoot = '/workspace/a$\'b'
    const html = buildWebviewHtml({
      indexHtml: INDEX,
      assetBase: 'https://vscode-webview.example/media/ui',
      cspSource: 'https://vscode-webview.example',
      nonce: 'NONCE123',
      root: evilRoot,
    })

    const open = html.indexOf('window.__folderspecRoot')
    const body = html.slice(open, html.indexOf('</script>', open))

    expect(body).not.toContain('<')
    expect((html.match(/<script/g) ?? []).length).toBe(2)
    expect((html.match(/<\/script>/g) ?? []).length).toBe(2)
    expect((html.match(/nonce="NONCE123"/g) ?? []).length).toBe(2)

    const rootMatch = body.match(/window\.__folderspecRoot=(.*?);/)
    const parsed = JSON.parse(rootMatch![1])
    expect(parsed).toBe(evilRoot)
  })

  it('root 含 a$&b 时，$& 展开不会再次激活 </script> 突破口', () => {
    const evilRoot = '/workspace/a$&b'
    const html = buildWebviewHtml({
      indexHtml: INDEX,
      assetBase: 'https://vscode-webview.example/media/ui',
      cspSource: 'https://vscode-webview.example',
      nonce: 'NONCE123',
      root: evilRoot,
    })

    const open = html.indexOf('window.__folderspecRoot')
    const body = html.slice(open, html.indexOf('</script>', open))

    expect(body).not.toContain('<')
    expect((html.match(/<script/g) ?? []).length).toBe(2)
    expect((html.match(/<\/script>/g) ?? []).length).toBe(2)
    expect((html.match(/nonce="NONCE123"/g) ?? []).length).toBe(2)

    const rootMatch = body.match(/window\.__folderspecRoot=(.*?);/)
    const parsed = JSON.parse(rootMatch![1])
    expect(parsed).toBe(evilRoot)
  })
})
