export interface WebviewHtmlOpts {
  indexHtml: string
  assetBase: string
  cspSource: string
  nonce: string
  /** 工作区绝对路径，注入给 UI 当 App 的 initialRoot；不注入的话 UI 会退回 '.' 占位值，
   *  而 '.' 一旦被当成 workspace/open 的目标 resolve，解析基准是扩展宿主进程的 cwd，
   *  和真正的工作区毫无关系（见 editor.ts 的 shouldSwitchSession 注释）。CLI 宿主一直
   *  是这么做的（server.ts 往返回的 HTML 里塞 <script>window.__folderspecRoot=...）；
   *  VSCode 宿主之前漏了这一步。 */
  root: string
}

/** 把 UI 的 --fs-* 变量指到 VSCode 主题色上，UI 本身对宿主一无所知 */
const THEME_BRIDGE = `
:root {
  --fs-git-ignored: var(--vscode-gitDecoration-ignoredResourceForeground, #7a7a7a);
  --fs-git-untracked: var(--vscode-gitDecoration-untrackedResourceForeground, #3fa34d);
  --fs-git-modified: var(--vscode-gitDecoration-modifiedResourceForeground, #d1a000);
  --fs-git-added: var(--vscode-gitDecoration-addedResourceForeground, #3fa34d);
  --fs-git-deleted: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39);
  --fs-git-conflicted: var(--vscode-gitDecoration-conflictingResourceForeground, #c74e39);
  --fs-annotated: var(--vscode-textLink-foreground, #4aa3ff);
  --fs-fg: var(--vscode-foreground, #1f1f1f);
  --fs-bg: var(--vscode-editor-background, #ffffff);
  --fs-border: var(--vscode-panel-border, #d4d4d4);
  --fs-selected-bg: var(--vscode-list-activeSelectionBackground, #e4ecf7);
  --fs-sidebar-bg: var(--vscode-sideBar-background, #f3f3f3);
  --fs-editor-bg: var(--vscode-editor-background, #ffffff);
  --fs-panel-border: var(--vscode-panel-border, #e0e0e0);
  --fs-row-hover-bg: var(--vscode-list-hoverBackground, #e8e8e8);
  --fs-indent-guide: var(--vscode-tree-indentGuidesStroke, #d0d0d0);
  --fs-group-dot: var(--vscode-charts-purple, #b180d7);
  --fs-line-number: var(--vscode-editorLineNumber-foreground, #9a9a9a);

  /* Prism 语法高亮 token → VSCode 语义色。VSCode 不把完整的 TextMate 语法着色
   * 暴露成 CSS 变量，只有这批语义化的变量能用来近似。但名字对不代表值真的独立于
   * 正文色——用 WebFetch 逐条查过 vscode 源码的 registerColor() 默认值（见
   * theme-report.md「C1」）后发现 symbolIcon.keyword/property/operator/
   * namespace/constantForeground 这五个的默认值直接就是 foreground 常量本身，
   * 默认主题也从不覆盖，挂上去的 token 在真实 VSCode 里会和正文同色——var() 的
   * fallback 救不了，因为变量本身有定义，只是值恰好等于正文色。这五个改用
   * charts.*（red/yellow/green/purple/blue，来自图表配色，各自要么是显式 hex
   * 要么转引 editorError/Warning/Info.foreground，都核实过真的独立于正文色），
   * 语义不如"关键字色"贴切，但换来的是真会显示出颜色。剩下八个（function/
   * class-name/variable/string/number/boolean/comment/punctuation）本来就有
   * 独立默认值，维持原映射。每条都带 --fs-* 同名的默认色兜底——那批变量本身在
   * 极旧主题里也可能未定义。 */
  --fs-token-keyword: var(--vscode-charts-red, #e51400);
  --fs-token-function: var(--vscode-symbolIcon-functionForeground, #795e26);
  --fs-token-class-name: var(--vscode-symbolIcon-classForeground, #267f99);
  --fs-token-variable: var(--vscode-symbolIcon-variableForeground, #001080);
  --fs-token-property: var(--vscode-charts-green, #388a34);
  --fs-token-operator: var(--vscode-charts-yellow, #bf8803);
  --fs-token-namespace: var(--vscode-charts-purple, #652d90);
  --fs-token-constant: var(--vscode-charts-blue, #0063d3);
  --fs-token-string: var(--vscode-debugTokenExpression-string, #a31515);
  --fs-token-number: var(--vscode-debugTokenExpression-number, #098658);
  --fs-token-boolean: var(--vscode-debugTokenExpression-boolean, #0000ff);
  --fs-token-comment: var(--vscode-descriptionForeground, #008000);
  --fs-token-punctuation: var(--vscode-editorLineNumber-foreground, #9a9a9a);

  /* 界面字体用工作台字体，代码预览用编辑器等宽字体——VSCode 源码
   * (webview/browser/themeing.ts) 分别从 DEFAULT_FONT_FAMILY 常量与
   * editor.fontFamily/fontSize 配置生成这两组变量，语义不同，不能共用。 */
  --fs-font-family: var(--vscode-font-family, system-ui, sans-serif);
  --fs-font-size: var(--vscode-font-size, 13px);
  --fs-code-font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  --fs-code-font-size: var(--vscode-editor-font-size, 12px);
}
`

/**
 * 注入到内联 <script> 里的值必须额外转义 '<'。
 *
 * JSON.stringify 不转义 '/'：一个字面量含 "</script>" 的工作区路径会提前闭合这个标签，
 * 后面的内容被当成新的 HTML 元素解析。这里的 CSP nonce 会拦住注入脚本的执行，但那是
 * 第二道防线——同一份注入代码在 CLI 宿主那边完全没有 CSP。两边都转义，别指望某一层
 * 的兜底（CLI 那边的同款函数见 packages/cli/src/server.ts 的 jsonForScript）。
 */
function jsonForScript(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c')
}

export function buildWebviewHtml(opts: WebviewHtmlOpts): string {
  const { indexHtml, assetBase, cspSource, nonce, root } = opts

  const csp = [
    `default-src 'none'`,
    `img-src ${cspSource} data:`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `font-src ${cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ')

  let html = indexHtml
    .replace(/(src|href)="\.\/(.*?)"/g, (_m, attr: string, path: string) => `${attr}="${assetBase}/${path}"`)
    .replace(/<script(?![^>]*\bnonce=)/g, `<script nonce="${nonce}"`)

  const headStart = [
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    // 必须带 nonce：严格 CSP 下没有 nonce 的内联脚本会被直接拦下，root 就送不到 UI，
    // 又会退回 initialRoot ?? '.' 的占位值——正是这次要修的那个 bug。
    `<script nonce="${nonce}">window.__folderspecRoot=${jsonForScript(root)};</script>`,
  ].join('\n')

  // THEME_BRIDGE 必须排在 </head> 之前而不是 <head> 之后：它和 UI 产物那份
  // <link rel="stylesheet">（indexHtml 自带、指向 styles.css 编译出的 :root 默认值）
  // 特异度完全相同（都是 :root 选择器），CSS 级联规则下后出现的赢。之前把它塞在
  // <head> 最前面、<link> 留在原位（更靠后），实际效果是 styles.css 里写死的 CLI
  // 默认色反过来覆盖了这里对 --vscode-* 的映射——在真实 webview 里主题桥接从未生效，
  // 只是这里的测试一直是 toContain 字符串存在性检查，测不出级联顺序，直到用真实
  // Playwright 渲染 + getComputedStyle 核实才发现（见 theme-report.md）。
  const themeStyle = `<style>${THEME_BRIDGE}</style>`

  // String.replace 找不到匹配时是无操作——若 indexHtml（vite 产物）缺 <head> 或
  // </head> 中的任意一个，对应那次 replace 会静默失败，CSP/root 注入脚本或
  // THEME_BRIDGE 会被整段丢掉且没有任何告警，症状是"VSCode 里颜色/root 全不对"
  // 却毫无线索。两个标签都先显式校验存在，任一缺失就直接抛错，而不是生成一份
  // 残缺的页面——比事后检查替换结果是否命中更可靠：分别检查能同时防住"只丢了
  // CSP/root 脚本、主题桥接却意外注入成功"这类只有一半失败的情形。
  if (!html.includes('<head>') || !html.includes('</head>')) {
    throw new Error('buildWebviewHtml: indexHtml 里找不到 <head>/</head>，无法注入 CSP/root/THEME_BRIDGE')
  }

  // 用函数替换而非字符串替换：字符串替换会展开 $&、$`、$'、$$，
  // 把 jsonForScript 刚转义掉的 '<' 又放回去，重新打开 </script> 突破口。
  return html
    .replace('<head>', () => `<head>\n${headStart}`)
    .replace('</head>', () => `${themeStyle}\n</head>`)
}
