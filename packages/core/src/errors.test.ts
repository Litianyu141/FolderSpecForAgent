import { describe, it, expect } from 'vitest'
import { EN_MESSAGES, SpecError, isSpecError, parseError, renderEnglish } from './errors.js'
import type { SpecErrorCode } from './errors.js'

const ALL_CODES = Object.keys(EN_MESSAGES) as SpecErrorCode[]

describe('SpecError', () => {
  it('code 与 params 原样带在错误对象上——宿主要靠它们查字典', () => {
    const e = new SpecError('name.reserved', { name: '..' })
    expect(e.code).toBe('name.reserved')
    expect(e.params).toEqual({ name: '..' })
  })

  it('是一个 Error：既有的 `e instanceof Error ? e.message` 链路一个字都不用改', () => {
    const e = new SpecError('readonly.parseFailed')
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('SpecError')
    expect(isSpecError(e)).toBe(true)
    expect(isSpecError(new Error('普通错误'))).toBe(false)
    expect(isSpecError('不是错误对象')).toBe(false)
  })

  it('params 省略时是空对象，不是 undefined——调用方不必判空', () => {
    expect(new SpecError('move.rootNode').params).toEqual({})
  })
})

describe('英文渲染', () => {
  it('占位符替换成 params 里的值', () => {
    expect(new SpecError('parent.fileOnDisk', { path: 'README.md' }).message)
      .toBe('`README.md` is a file on disk, so no node can be created underneath it.')
  })

  it('同一个占位符出现多次时全部替换（identifier.forbiddenChar 里 {field} 出现两次）', () => {
    const msg = new SpecError('identifier.forbiddenChar', { field: 'role', value: '"a b"' }).message
    expect(msg).toContain('role may not contain')
    expect(msg).toContain('`[role:...]`')
    expect(msg).toContain('"a b"')
    expect(msg).not.toContain('{field}')
  })

  it('数字参数照样渲染', () => {
    expect(renderEnglish('move.mergeConflict', { conflicts: 'x', count: 2 })).toContain('x')
  })

  it('params 里缺这个键时原样保留占位符——不抛错、不静默吞掉', () => {
    // 抛错会在别人的错误路径上再炸一次、把真正的错因整个盖掉；替换成空串会让缺陷
    // 肉眼不可见。留着 `{path}` 难看，但一眼看得出"这里漏传了参数"。
    expect(renderEnglish('parent.fileOnDisk')).toContain('{path}')
  })
})

describe('文案本身的约束（这几条守的是 errors.ts 顶部的要点 1）', () => {
  it('每一条 message 都是英文人话，不是把错误码当文案', () => {
    for (const code of ALL_CODES) {
      const msg = EN_MESSAGES[code]
      // 不是空的、不是码本身、也不是"码 + 一点点装饰"
      expect(msg.length, code).toBeGreaterThan(20)
      expect(msg, code).not.toContain(code)
      // 一整句话该有的样子：至少一个空格分隔的词，且以句号收尾（或以一个占位符收尾——
      // serialize.selfCheckFailed 那条把解析器的明细放在最后）
      expect(msg, code).toMatch(/\s/)
      expect(msg, code).toMatch(/(\.|\{\w+\})$/)
    }
  })

  it('没有一条 message 里混着中文——报错文案一律英文，中文归第二轮的 UI 字典', () => {
    for (const code of ALL_CODES) {
      expect(EN_MESSAGES[code], code).not.toMatch(/[一-鿿]/)
    }
  })

  it('每个 code 都是点分命名空间，与 ui/src/i18n.ts 的键风格一致', () => {
    for (const code of ALL_CODES) {
      expect(code).toMatch(/^[a-z][a-zA-Z]*(\.[a-z][a-zA-Z]*)+$/)
    }
  })
})

// ---------------------------------------------------------------------------
// parseError：解析层用的那半边。解析错误不是 throw 出来的，它是 `ParseError` 里的
// 一条纯数据（带行号，成组出现在只读横幅上），但它同样要按码翻译，所以英文来自
// 同一张 EN_MESSAGES。
// ---------------------------------------------------------------------------

describe('parseError', () => {
  it('带上行号、渲染好的英文 message，以及 code + params', () => {
    const e = parseError(7, 'parse.indentNotMultipleOfTwo', { indent: 3 })
    expect(e.line).toBe(7)
    expect(e.code).toBe('parse.indentNotMultipleOfTwo')
    expect(e.params).toEqual({ indent: 3 })
    expect(e.message).toBe(renderEnglish('parse.indentNotMultipleOfTwo', { indent: 3 }))
    expect(e.message).toContain('3')
  })

  it('params 省略时是空对象，不是 undefined——收端不必判空', () => {
    expect(parseError(1, 'parse.frontMatterMissing').params).toEqual({})
  })

  it('**不是** Error 实例：它是要经 JSON 过 bridge 的纯数据', () => {
    // 这一条钉住的是 UI 侧的一个坑：translateError 原本只认 `e instanceof Error`，
    // 一个纯数据的 ParseError 会掉进 String(e)、在英文界面上显示成 "[object Object]"。
    // 那正是"解析失败要能定位"这条铁律被架空的样子，所以这里先把形状钉死。
    expect(parseError(1, 'parse.frontMatterMissing')).not.toBeInstanceOf(Error)
  })
})

describe('解析层的码', () => {
  const PARSE_CODES = ALL_CODES.filter(c => c.startsWith('parse.'))

  it('58 处解析报错收敛成 56 个码，全在同一张 EN_MESSAGES 里——英文只有一份', () => {
    // 58 与 56 的差：parse.yamlSyntax 一个码覆盖 templates/rules/groups 三处同样的
    // "YAML 语法错误：…"。
    //
    // 这是一次**清点**，不是设计约束：将来真要新增一个解析码，改掉这个数字就是了。
    // 留着它是因为改这个数字的那一刻，正好是顺手确认"ui 的 ERROR_ZH 也跟上了"的时刻
    // ——而漏翻一条的运行期表现是"这一句永远是英文"，界面上没有任何症状。
    expect(PARSE_CODES.length).toBe(56)
  })

  it('每一条解析错误的英文里都不含行号——行号是 ParseError.line，由界面自己渲染', () => {
    // 揉进文案就意味着它只在一种语言下正确。而"解析失败 → 只读 + 报行号"是本工具的
    // 红线，行号是"能定位"的那一半。
    for (const code of PARSE_CODES) {
      expect(EN_MESSAGES[code], code).not.toMatch(/\{line\}/)
      expect(EN_MESSAGES[code], code).not.toMatch(/\bline \d/i)
    }
  })
})
