import { describe, it, expect } from 'vitest'
import { EN_MESSAGES, SpecError, detail, isSpecError, parseError, renderEnglish } from './errors.js'
import type { ErrorDetail, SpecErrorCode } from './errors.js'

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

/**
 * 形状断言按**命名空间**切成两组，判据写死在这里：
 *
 * - `detail.*` —— 能嵌进别的句子的**从句**（今天是 move.mergeConflict 的那四条冲突
 *   明细）。它后面还接着分隔符和下一条，所以**不许以句号收尾**。
 * - 其余一切 —— 能独立成句的**整句**，沿用原来那四条断言，一字不改。
 *
 * **为什么不是把收尾正则放松成 `/(\.|”|\{\w+\})$/`**：在这个仓库里放松一道闸天然
 * 可疑，而且放松之后任何一条整句错误也能以引号收尾溜过去——那正是这条断言要挡的
 * "码 + 一点点装饰"。切分反而把约束变**严**了（短语组另有一组断言）。
 *
 * 代价：命名前缀是约定，不是类型——有人把一条整句错误起名叫 `detail.xxx`，它就悄悄
 * 逃出整句组。这只能靠 code review 兜住，但比"给短语另起一张侧表"好：那样会让新码
 * 彻底逃出 ui 那侧的翻译覆盖率脚本。
 */
const SENTENCE_CODES = ALL_CODES.filter(c => !c.startsWith('detail.'))
const PHRASE_CODES = ALL_CODES.filter(c => c.startsWith('detail.'))

describe('文案本身的约束（这几条守的是 errors.ts 顶部的要点 1）', () => {
  it('每一条 message 都是英文人话，不是把错误码当文案', () => {
    for (const code of SENTENCE_CODES) {
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

  it('`detail.*` 是能嵌进别人句子的从句：有词、不以句号收尾、不带首尾空白', () => {
    // 两头的空白由分隔符（core 的 '; '、ui 的 '；'）负责，明细自己带就会双份。
    expect(PHRASE_CODES.length, 'detail.* 一条都没有了？切分就成了空转').toBeGreaterThan(0)
    for (const code of PHRASE_CODES) {
      const msg = EN_MESSAGES[code]
      expect(msg.length, code).toBeGreaterThan(0)
      expect(msg, code).toMatch(/\s/)
      expect(msg, code).not.toMatch(/\.$/)
      expect(msg, code).toBe(msg.trim())
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

// ---------------------------------------------------------------------------
// 嵌套明细：params 的值域从"标量"放宽到"标量 | 一串明细"之后，这一节钉住的是
// **英文一个字节都没变**，以及这条递归渲染路径上的三处兜底。
//
// 明细本身是纯数据（`{message, code?, params?, line?}`），一律由 detail() /
// parseError() 派生——EN_MESSAGES 仍然是英文的唯一定义处。
// ---------------------------------------------------------------------------

describe('嵌套明细的英文渲染', () => {
  it('move.mergeConflict：多条明细用 "; " 连起来嵌进外层，与改造前逐字节相同', () => {
    // 夹具里写死的是**改造前**那句完整英文（改造前 spec-edit.ts 里
    // `conflicts.join('; ')` 的产物）。分隔符换成别的、或者外层文案被挪动一个字，
    // 这一条就红——它守的是"这次只改渲染路径，不改用户看到的英文"。
    const conflicts = [
      detail('detail.conflictAnnotation', { path: 'src/utils.ts', kept: '共享工具函数，勿删', coming: '旧的' }),
      detail('detail.conflictRole', { path: 'src/utils.ts', kept: 'shared', coming: 'legacy' }),
    ]
    expect(renderEnglish('move.mergeConflict', { conflicts, count: conflicts.length })).toBe(
      'The destination already has a node with this name, and this move would overwrite content '
      + 'already written there: '
      + 'the comment of `src/utils.ts` (“共享工具函数，勿删”) would be overwritten by “旧的”; '
      + 'the semantic role of `src/utils.ts` (“shared”) would be overwritten by “legacy”. '
      + 'Decide which side to keep first — clear one side, or make both sides say exactly the '
      + 'same thing — then retry the move.')
  })

  it('serialize.selfCheckFailed：每条明细前面拼 "line N: "，与改造前那句 map/join 逐字节相同', () => {
    // 改造前是 `verify.errors.map(e => \`line ${e.line}: ${e.message}\`).join('; ')`。
    // 行号前缀现在由 renderDetail 拼——位置、格式、数字都必须一模一样。
    const details = [
      parseError(3, 'parse.indentNotMultipleOfTwo', { indent: 3 }),
      parseError(12, 'parse.nameEmpty'),
    ]
    expect(renderEnglish('serialize.selfCheckFailed', { details })).toBe(
      'The serialize → parse self-check failed, so the write was aborted to avoid corrupting '
      + 'the contract file: '
      + 'line 3: Indentation must be a multiple of 2 spaces, but this line has 3.; '
      + 'line 12: The node name is empty.')
  })

  it('line 为 0 时照样拼前缀——不设 `line > 0` 的闸', () => {
    // session.ts 确实有一条 `parseError(0, 'spec.unreadable', …)`（错的不是某一行，
    // 是整个文件），而 App.tsx 的只读横幅对它同样无条件拼"第 0 行："。这里加一道闸
    // 就会造出第二套与界面不一致的行号策略。
    const out = renderEnglish('serialize.selfCheckFailed', {
      details: [parseError(0, 'parse.nameEmpty')],
    })
    expect(out).toContain('line 0: The node name is empty.')
  })

  it('按 code 重渲染，不信明细自带的 message——线上收来的伪造明细带不进假文案', () => {
    // 明细可能是从进程外收来的（宿主与 UI 版本不齐时尤其）。message 与 code 说的
    // 不是一件事时，以 EN_MESSAGES 为准：它才是英文的唯一定义处。
    const forged: ErrorDetail = {
      message: '<<a message that does not match its code>>',
      code: 'detail.conflictRole',
      params: { path: 'a/b', kept: 'x', coming: 'y' },
    }
    const out = renderEnglish('move.mergeConflict', { conflicts: [forged], count: 1 })
    expect(out).toContain('the semantic role of `a/b` (“x”) would be overwritten by “y”')
    expect(out).not.toContain('<<a message that does not match its code>>')
  })

  it('码不认识时退回明细自带的 message，**不抛错**', () => {
    // EN_MESSAGES[未知码] 是 undefined，直接 .replace 会在**构造一个 Error 的过程中**
    // 再炸一次，把真正的错因整个盖掉——errors.ts 白纸黑字禁止的事。
    const fromNewerHost = { message: 'a message from a newer host', code: 'brand.newCode' } as unknown as ErrorDetail
    expect(() => renderEnglish('move.mergeConflict', { conflicts: [fromNewerHost], count: 1 })).not.toThrow()
    expect(renderEnglish('move.mergeConflict', { conflicts: [fromNewerHost], count: 1 }))
      .toContain('a message from a newer host')
  })

  it('完全没有 code 的明细（旧宿主给的）原样用它的 message', () => {
    const noCode: ErrorDetail = { message: 'YAML: something the library said' }
    expect(renderEnglish('serialize.selfCheckFailed', { details: [noCode] }))
      .toContain('YAML: something the library said')
  })

  it('嵌套很深时触底退回 message：不抛错、不爆栈', () => {
    // 从进程外收来的明细可以嵌任意深（JSON 造不出环，但造得出一万层）。没有深度上限
    // 时这里会直接栈溢出——而它正跑在别人的错误路径上。
    let d: ErrorDetail = { message: 'bottom', code: 'detail.conflictRole', params: { path: 'p', kept: 'k', coming: 'c' } }
    for (let i = 0; i < 20000; i++) {
      d = { message: `level ${i}`, code: 'move.mergeConflict', params: { conflicts: [d], count: 1 } }
    }
    let out = ''
    expect(() => { out = renderEnglish('move.mergeConflict', { conflicts: [d], count: 1 }) }).not.toThrow()
    // 触底那一层退回的是它自己那句已经渲染好的英文，不是一个码、不是空串。
    expect(out).toContain('level ')
  })

  it('明细是纯数据：JSON round-trip 之后渲染结果一个字节不变', () => {
    // params 是要经 bridge 走 JSON 的。detail() 若哪天返回一个带方法的类实例，
    // 跨过边界之后方法全没了，而这一条会先在这里红。
    const params = {
      conflicts: [detail('detail.conflictRole', { path: 'a/b', kept: 'x', coming: 'y' })],
      count: 1,
    }
    const before = renderEnglish('move.mergeConflict', params)
    const after = renderEnglish('move.mergeConflict', JSON.parse(JSON.stringify(params)))
    expect(after).toBe(before)
  })
})

describe('detail()', () => {
  it('message 是 EN_MESSAGES 对这对 (code, params) 的渲染结果，不是手写的第二份英文', () => {
    const d = detail('detail.conflictTemplate', { path: 'src/cases', kept: 'a', coming: 'b' })
    expect(d.message).toBe(renderEnglish('detail.conflictTemplate', { path: 'src/cases', kept: 'a', coming: 'b' }))
    expect(d.code).toBe('detail.conflictTemplate')
    expect(d.params).toEqual({ path: 'src/cases', kept: 'a', coming: 'b' })
  })

  it('没有 line 字段——行号只属于解析层的明细（parseError）', () => {
    expect(detail('detail.conflictRole').line).toBeUndefined()
  })

  it('params 省略时是空对象，与 parseError 逐字同构', () => {
    expect(detail('detail.conflictRole').params).toEqual({})
  })
})
