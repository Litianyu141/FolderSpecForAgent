import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// 这里直接读源文件文本做断言，而不是走 jsdom 的 getComputedStyle——探针实测过
// jsdom(25.0.1) 不解析 var()，getComputedStyle 会原样吐回字符串 "var(--x)"，
// 用它比较"token 颜色 != 父级颜色"只会恒真（两边都是未解析的字符串），
// 侦测不到真实回归。CSS 变量链路是否真的生效，交给 scratchpad 里的 Playwright 脚本核实；
// 这里只保证"选择器 → 变量 → 默认色"这条源码级别的接线没有被改掉。
// import.meta.url 在 vitest 的 jsdom 环境里不保证是 file: scheme（实测会抛
// "The URL must be of scheme file"），用 vitest 进程自身的 cwd（== 本包根目录）
// 拼路径更稳。
const SRC_DIR = join(process.cwd(), 'src')
const stylesCss = readFileSync(join(SRC_DIR, 'styles.css'), 'utf8')
const layoutCss = readFileSync(join(SRC_DIR, 'layout.css'), 'utf8')

// Prism 在 highlight.ts 实际 import 的 12 种语法（ts/tsx/jsx/json/markdown/yaml/
// python/rust/go/bash/css/toml）在真实样例文件上跑出来的 token 类名 → 应上色的
// --fs-token-* 变量。类名是跑探测脚本产出的实测结果，不是凭记忆列的（见 theme-report.md）。
const TOKEN_VAR: Record<string, string> = {
  keyword: '--fs-token-keyword',
  atrule: '--fs-token-keyword',
  rule: '--fs-token-keyword',
  function: '--fs-token-function',
  'class-name': '--fs-token-class-name',
  tag: '--fs-token-class-name',
  selector: '--fs-token-class-name',
  variable: '--fs-token-variable',
  property: '--fs-token-property',
  'attr-name': '--fs-token-property',
  operator: '--fs-token-operator',
  namespace: '--fs-token-namespace',
  table: '--fs-token-namespace',
  constant: '--fs-token-constant',
  builtin: '--fs-token-constant',
  string: '--fs-token-string',
  'attr-value': '--fs-token-string',
  regex: '--fs-token-string',
  'regex-delimiter': '--fs-token-string',
  'regex-flags': '--fs-token-string',
  'regex-source': '--fs-token-string',
  'string-interpolation': '--fs-token-string',
  'template-string': '--fs-token-string',
  url: '--fs-token-string',
  number: '--fs-token-number',
  boolean: '--fs-token-boolean',
  comment: '--fs-token-comment',
  shebang: '--fs-token-comment',
  punctuation: '--fs-token-punctuation',
}

function ruleFor(cls: string, varName: string): RegExp {
  // 类名可能出现在逗号分隔的多分支选择器里的任意位置，例如
  // `.token.class-name, .token.tag, .token.selector { color: var(--fs-token-class-name); }`
  const escaped = cls.replace(/-/g, '\\-')
  return new RegExp(`\\.token\\.${escaped}\\b[^{]*\\{[^}]*color:\\s*var\\(${varName}\\)`)
}

describe('Prism token 上色（layout.css）', () => {
  for (const [cls, varName] of Object.entries(TOKEN_VAR)) {
    it(`.token.${cls} 映射到 ${varName}`, () => {
      expect(layoutCss).toMatch(ruleFor(cls, varName))
    })
  }
})

describe('--fs-token-* 默认色（styles.css）', () => {
  it('每个用到的 --fs-token-* 变量都有默认色，且不等于正文色 --fs-fg', () => {
    const fg = stylesCss.match(/--fs-fg:\s*(#[0-9a-fA-F]+)/)?.[1]
    expect(fg, '--fs-fg 本身必须先能在 styles.css 里找到').toBeTruthy()
    for (const varName of new Set(Object.values(TOKEN_VAR))) {
      const m = stylesCss.match(new RegExp(`${varName}:\\s*(#[0-9a-fA-F]+)`))
      expect(m, `${varName} 未在 styles.css :root 里定义默认色`).not.toBeNull()
      expect(m![1].toLowerCase(), `${varName} 的默认色不该和 --fs-fg 相同——否则退化成继承父色`)
        .not.toBe(fg!.toLowerCase())
    }
  })
})

describe('字体跟随主题', () => {
  it('body 用 --fs-font-family / --fs-font-size，不再硬编码字体', () => {
    expect(stylesCss).toMatch(/body\s*\{[^}]*font-family:\s*var\(--fs-font-family\)/)
    expect(stylesCss).toMatch(/body\s*\{[^}]*font-size:\s*var\(--fs-font-size\)/)
  })

  it('.fs-code 用 --fs-code-font-family / --fs-code-font-size，不再硬编码字体', () => {
    expect(layoutCss).toMatch(/\.fs-code\s*\{[^}]*font-family:\s*var\(--fs-code-font-family\)/)
    expect(layoutCss).toMatch(/\.fs-code\s*\{[^}]*font-size:\s*var\(--fs-code-font-size\)/)
  })

  it('四个字体变量在 styles.css 都有默认值兜底', () => {
    for (const v of ['--fs-font-family', '--fs-font-size', '--fs-code-font-family', '--fs-code-font-size']) {
      expect(stylesCss, `${v} 没有默认值，CLI 宿主会拿到 unset`).toMatch(new RegExp(`${v}:\\s*[^;]+;`))
    }
  })
})

describe('大字号下代码预览不会挤压/错位（I2）', () => {
  // 字号跟着主题走之后（.fs-code 的 font-size 已经是 var(--fs-code-font-size)），
  // 行高/中间栏文字大小/行号列宽如果还按当初为 12px 硬编码的像素数写死，用户把
  // editor.fontSize 调大（16~20px 很常见）就会出现行与行重叠、或多位数行号被挤断——
  // 而这块代码上方的注释专门写着"行号与内容必须严格对齐"，排版在这里是承重的。
  it('.fs-code 的 line-height 是跟着字号缩放的无单位数，不是写死的像素', () => {
    const m = layoutCss.match(/\.fs-code\s*\{[^}]*line-height:\s*([^;]+);/)
    expect(m, '.fs-code 里找不到 line-height').not.toBeNull()
    const value = m![1].trim()
    expect(value, `line-height 是 "${value}"——像素/字号等绝对单位不会跟着 --fs-code-font-size 缩放`)
      .not.toMatch(/px|em|rem|%/)
  })

  it('.fs-content（中间栏非代码文字）用 --fs-font-size，不再硬编码 13px', () => {
    expect(layoutCss).toMatch(/\.fs-content\s*\{[^}]*font-size:\s*var\(--fs-font-size\)/)
  })

  it('.fs-line-no 的宽度按 ch（字符宽度）算，不是写死的像素——否则大字号下装不下多位数行号', () => {
    const m = layoutCss.match(/\.fs-line-no\s*\{[^}]*flex:\s*0\s+0\s+([^;]+);/)
    expect(m, '.fs-line-no 里找不到 flex').not.toBeNull()
    expect(m![1]).toMatch(/ch/)
  })
})
