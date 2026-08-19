export interface WebviewHtmlOpts {
  indexHtml: string
  assetBase: string
  cspSource: string
  nonce: string
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

export function buildWebviewHtml(opts: WebviewHtmlOpts): string {
  const { indexHtml, assetBase, cspSource, nonce } = opts

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
    `<style>${THEME_BRIDGE}</style>`,
  ].join('\n')

  return html.replace('<head>', `<head>\n${head}`)
}
