import Prism from 'prismjs'
import 'prismjs/components/prism-typescript.js'
import 'prismjs/components/prism-jsx.js'
import 'prismjs/components/prism-tsx.js'
import 'prismjs/components/prism-json.js'
import 'prismjs/components/prism-markdown.js'
import 'prismjs/components/prism-yaml.js'
import 'prismjs/components/prism-python.js'
import 'prismjs/components/prism-rust.js'
import 'prismjs/components/prism-go.js'
import 'prismjs/components/prism-bash.js'
import 'prismjs/components/prism-css.js'
import 'prismjs/components/prism-toml.js'

const BY_EXT: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  tsx: 'tsx', jsx: 'jsx',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json',
  md: 'markdown', markdown: 'markdown',
  yaml: 'yaml', yml: 'yaml',
  py: 'python', rs: 'rust', go: 'go',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  css: 'css', scss: 'css', less: 'css',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup',
  toml: 'toml',
}

export function languageFor(fileName: string): string | null {
  const lower = fileName.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot <= 0) return null
  return BY_EXT[lower.slice(dot + 1)] ?? null
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * 语言未知或 Prism 未注册该语法时一律走 HTML 转义分支。
 * 这里的输出会经 dangerouslySetInnerHTML 注入，转义是唯一的防线，不能省。
 */
export function highlightToHtml(code: string, lang: string | null): string {
  if (!lang) return escapeHtml(code)
  const grammar = Prism.languages[lang]
  if (!grammar) return escapeHtml(code)
  return Prism.highlight(code, grammar, lang)
}
