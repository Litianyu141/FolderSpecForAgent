import { describe, it, expect } from 'vitest'
import { languageFor, highlightToHtml } from './highlight.js'

describe('languageFor', () => {
  it('按扩展名映射到 Prism 语言名', () => {
    expect(languageFor('a.ts')).toBe('typescript')
    expect(languageFor('a.tsx')).toBe('tsx')
    expect(languageFor('a.js')).toBe('javascript')
    expect(languageFor('a.json')).toBe('json')
    expect(languageFor('a.md')).toBe('markdown')
    expect(languageFor('a.yaml')).toBe('yaml')
    expect(languageFor('a.yml')).toBe('yaml')
    expect(languageFor('a.py')).toBe('python')
    expect(languageFor('a.rs')).toBe('rust')
    expect(languageFor('a.go')).toBe('go')
    expect(languageFor('a.sh')).toBe('bash')
    expect(languageFor('a.css')).toBe('css')
    expect(languageFor('a.html')).toBe('markup')
    expect(languageFor('a.toml')).toBe('toml')
  })

  it('忽略大小写', () => {
    expect(languageFor('A.TS')).toBe('typescript')
  })

  it('未知扩展名返回 null', () => {
    expect(languageFor('a.zzz')).toBeNull()
    expect(languageFor('LICENSE')).toBeNull()
  })
})

describe('highlightToHtml', () => {
  it('已知语言产出带 token 标记的 HTML', () => {
    const html = highlightToHtml('const a = 1', 'typescript')
    expect(html).toContain('token')
  })

  it('lang 为 null 时做 HTML 转义而不是原样输出', () => {
    const html = highlightToHtml('<script>alert(1)</script>', null)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('未注册的语言也走转义分支，不抛错', () => {
    const html = highlightToHtml('<b>x</b>', 'not-a-language')
    expect(html).toContain('&lt;b&gt;')
  })
})
