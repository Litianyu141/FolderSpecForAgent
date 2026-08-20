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
    expect(html).toContain('--fs-group-dot: var(--vscode-charts-purple')
    expect(html).toContain('--fs-line-number: var(--vscode-editorLineNumber-foreground')
  })

  it('语法高亮 token 颜色映射到 VSCode 的语义色（symbolIcon.*/debugTokenExpression.*/descriptionForeground/charts.*）', () => {
    // 每条都在 vscode 源码里核实过确实存在、会被注入进 webview，见 theme-report.md。
    // keyword/property/operator/namespace/constant 五个特意不用 symbolIcon.* 对应色——
    // 那五个 id 的 registerColor() 默认值就是 foreground（正文色）本身，映射了也不会
    // 显示出颜色，改用 charts.*（各自核实过默认值独立于正文色），见「C1」一节与下面
    // 那个专门断言"默认值真的不等于正文色"的用例。
    const html = build()
    expect(html).toContain('--fs-token-keyword: var(--vscode-charts-red')
    expect(html).toContain('--fs-token-function: var(--vscode-symbolIcon-functionForeground')
    expect(html).toContain('--fs-token-class-name: var(--vscode-symbolIcon-classForeground')
    expect(html).toContain('--fs-token-variable: var(--vscode-symbolIcon-variableForeground')
    expect(html).toContain('--fs-token-property: var(--vscode-charts-green')
    expect(html).toContain('--fs-token-operator: var(--vscode-charts-yellow')
    expect(html).toContain('--fs-token-namespace: var(--vscode-charts-purple')
    expect(html).toContain('--fs-token-constant: var(--vscode-charts-blue')
    expect(html).toContain('--fs-token-string: var(--vscode-debugTokenExpression-string')
    expect(html).toContain('--fs-token-number: var(--vscode-debugTokenExpression-number')
    expect(html).toContain('--fs-token-boolean: var(--vscode-debugTokenExpression-boolean')
    expect(html).toContain('--fs-token-comment: var(--vscode-descriptionForeground')
    expect(html).toContain('--fs-token-punctuation: var(--vscode-editorLineNumber-foreground')
  })

  it('界面字体与代码字体分别指向 VSCode 的两套字体变量（--vscode-font-* / --vscode-editor-font-*）', () => {
    const html = build()
    expect(html).toContain('--fs-font-family: var(--vscode-font-family')
    expect(html).toContain('--fs-font-size: var(--vscode-font-size')
    expect(html).toContain('--fs-code-font-family: var(--vscode-editor-font-family')
    expect(html).toContain('--fs-code-font-size: var(--vscode-editor-font-size')
  })

  it('THEME_BRIDGE 的 <style> 必须排在 UI 产物的 <link rel="stylesheet"> 之后', () => {
    // 这两者都是 :root 选择器，特异度相同——CSS 级联规则下后出现的赢。之前
    // THEME_BRIDGE 被塞在 <head> 最前面，UI 产物的 <link> 停在原来的位置（更靠后），
    // 于是 styles.css 里那份写死的 CLI 默认色反而覆盖了 THEME_BRIDGE 对 --vscode-*
    // 的映射——在真实 webview 里整套主题桥接从未生效过，只是没人用渲染后的浏览器
    // 核实过，之前的测试全是 toContain 字符串存在性检查，测不出级联顺序的问题。
    // 用真实 Playwright 渲染 + getComputedStyle 核实过这个断言必须成立，见 theme-report.md。
    const html = build()
    const styleIdx = html.indexOf('<style>')
    const linkIdx = html.indexOf('<link rel="stylesheet"')
    expect(styleIdx).toBeGreaterThan(-1)
    expect(linkIdx).toBeGreaterThan(-1)
    expect(styleIdx).toBeGreaterThan(linkIdx)
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

describe('token 颜色变量的 VSCode 默认值必须真的和正文色不同', () => {
  // 光是变量名存在、var() 的 fallback 不炸，不代表选对了——VSCode 里不少
  // symbolIcon.* 直接把 registerColor() 的默认值注册成 `foreground`（正文色）本身：
  // keywordForeground/propertyForeground/operatorForeground/namespaceForeground/
  // constantForeground 都是。默认主题从不覆盖这些 id（dark_modern.json 的 colors
  // 里没有任何 symbolIcon.* 键），挂上去的 token 在真实 VSCode 里会和正文同色，
  // "上色"名不副实——var() 的 fallback 救不了：变量本身有定义，只是值恰好等于
  // 正文色，fallback 永远不会被触发。
  //
  // 这张表是逐条用 WebFetch 去 vscode 源码 registerColor() 查证的结果（不是凭
  // 名字猜的，见 theme-report.md「C1」）：
  //   - src/vs/editor/contrib/symbolIcons/browser/symbolIcons.ts
  //   - src/vs/workbench/contrib/debug/browser/debugColors.ts
  //   - src/vs/platform/theme/common/colors/{baseColors,editorColors,chartsColors}.ts
  //   - src/vs/editor/common/core/editorColorRegistry.ts
  const VSCODE_COLOR_DEFAULT: Record<string, 'distinct' | 'sameAsForeground'> = {
    'symbolIcon-functionForeground': 'distinct', // {dark:'#B180D7', light:'#652D90'}
    'symbolIcon-classForeground': 'distinct', // {dark:'#EE9D28', light:'#D67E00'}
    'symbolIcon-variableForeground': 'distinct', // {dark:'#75BEFF', light:'#007ACC'}
    'symbolIcon-keywordForeground': 'sameAsForeground',
    'symbolIcon-propertyForeground': 'sameAsForeground',
    'symbolIcon-operatorForeground': 'sameAsForeground',
    'symbolIcon-namespaceForeground': 'sameAsForeground',
    'symbolIcon-constantForeground': 'sameAsForeground',
    'debugTokenExpression-string': 'distinct', // {dark:'#ce9178', light:'#a31515'}
    'debugTokenExpression-number': 'distinct', // {dark:'#b5cea8', light:'#098658'}
    'debugTokenExpression-boolean': 'distinct', // {dark:'#4e94ce', light:'#0000ff'}
    'descriptionForeground': 'distinct', // light:'#717171'；dark 是 foreground 70% 透明度，非满色正文色
    'editorLineNumber-foreground': 'distinct', // {dark:'#858585', light:'#237893'}
    'charts-red': 'distinct', // = editorError.foreground，light:'#E51400'
    'charts-blue': 'distinct', // = editorInfo.foreground，light:'#0063d3'
    'charts-yellow': 'distinct', // = editorWarning.foreground，light:'#BF8803'
    'charts-green': 'distinct', // 显式 hex，light:'#388A34'
    'charts-purple': 'distinct', // 显式 hex，light:'#652D90'
  }

  it('THEME_BRIDGE 里每条 --fs-token-* 映射都指向一个默认值真的独立于正文色的 --vscode-* 变量', () => {
    const html = build()
    const matches = [...html.matchAll(/--fs-token-[a-z-]+: var\(--vscode-([a-zA-Z-]+),/g)]
    expect(matches.length).toBe(13) // 十三个 token 桶，数目不对说明映射被删了/多了
    for (const [, vscodeVar] of matches) {
      const status = VSCODE_COLOR_DEFAULT[vscodeVar]
      expect(status, `--vscode-${vscodeVar} 没有在核实表里，先去 vscode 源码查 registerColor 的默认值再收进来`).toBeDefined()
      expect(status, `--vscode-${vscodeVar} 的默认值就是 foreground（正文色），映射到它的桶在真实 VSCode 默认主题下不会显示出颜色`).toBe('distinct')
    }
  })
})
