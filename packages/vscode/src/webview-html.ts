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

  const head = [
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    // 必须带 nonce：严格 CSP 下没有 nonce 的内联脚本会被直接拦下，root 就送不到 UI，
    // 又会退回 initialRoot ?? '.' 的占位值——正是这次要修的那个 bug。
    `<script nonce="${nonce}">window.__folderspecRoot=${jsonForScript(root)};</script>`,
    `<style>${THEME_BRIDGE}</style>`,
  ].join('\n')

  // 用函数替换而非字符串替换：字符串替换会展开 $&、$`、$'、$$，
  // 把 jsonForScript 刚转义掉的 '<' 又放回去，重新打开 </script> 突破口。
  return html.replace('<head>', () => `<head>\n${head}`)
}
