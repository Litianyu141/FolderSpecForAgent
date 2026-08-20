import { describe, it, expect } from 'vitest'
// **测试专用的运行期 import，源码里绝不许出现。** `@folderspec/core` 是 ui 的
// devDependency（不是 dependency），打进浏览器产物的只有 src/，而 src/ 对 core 一律
// `import type`。走 `/errors` 这条子路径而不是包根：dist/errors.js 编译后没有任何
// import 语句，拿它做覆盖率核对不会把 node:fs、yaml 这些东西拖进 jsdom 里。
// 代价是这份测试从此需要先 `pnpm -C packages/core build`（与 packages/cli 同款前提）。
import { EN_MESSAGES } from '@folderspec/core/errors'
import { zh, en, translate, translateError, ERROR_ZH, UiError } from './i18n.js'

describe('i18n 字典', () => {
  it('zh 与 en 键集完全一致——遍历比较，不是抽查几个键', () => {
    // `en` 在源码里已经声明成 `Record<TranslationKey, string>`（TranslationKey 就是
    // `keyof typeof zh`），赋值给这个类型的对象字面量本身就会让 tsc 在缺键/多键时报错
    // （excess property check + 必需属性检查）。但 `pnpm -C packages/ui test` 跑的是
    // vitest——esbuild 转译 TS 时只做语法检查、不做类型检查，这层保护在"单跑测试"这条
    // 路径上并不生效：esbuild 会放过一个漏了某个键的 en 字面量，那个键在运行时就是
    // undefined。这条断言补的正是 tsc 那道闸之外的第二道闸，两道闸各自堵一条不同的路径。
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('两份字典的键数量相等（从"有多少把锁"而不是"锁的名字"复核一遍，避免巧合掩盖遗漏）', () => {
    expect(Object.keys(en).length).toBe(Object.keys(zh).length)
    expect(Object.keys(en).length).toBeGreaterThan(0)
  })

  it('zh 下的取值与今天界面上硬编码的中文文案逐字节相同——这是本轮唯一的安全属性', () => {
    expect(translate('zh', 'toolbar.load')).toBe('载入')
    expect(translate('zh', 'toolbar.save')).toBe('保存')
    expect(translate('zh', 'toolbar.myStructure')).toBe('我的结构')
    expect(translate('zh', 'toolbar.diskStructure')).toBe('原始结构')
    expect(translate('zh', 'annotationPanel.empty')).toBe('在左侧选中一个文件或目录')
  })

  it('en 下的取值是真英文，不是占位符或者原样抄一遍中文', () => {
    const value = translate('en', 'toolbar.load')
    expect(value).toBe('Load')
    expect(value).not.toBe(translate('zh', 'toolbar.load'))
  })

  it('interpolate 用命名占位符替换动态部分', () => {
    expect(translate('zh', 'groupPanel.selectedCount', { count: 3 })).toBe('已选中 3 项')
    expect(translate('en', 'groupPanel.selectedCount', { count: 3 })).toBe('3 selected')
  })

  it('占位符对应的 key 不在 params 里时原样保留，不抛错也不静默吞掉', () => {
    expect(translate('zh', 'nodeRow.groupDotTitle', {})).toBe('属于分组 {group}')
  })
})

// ---------------------------------------------------------------------------
// translateError：把 core 抛来的「错误码 + 参数」按当前语言渲染。
//
// 英文只有一份，就在 core（SpecError.message 已经是渲染好的英文）。这里只存中文，
// 按码查；查不到码就把 message 原样显示——这条降级路径是本节的重点，它保证的是
// "新增一个还没翻译的码"退化成"这一句暂时是英文"，而不是"界面上蹦出一个键名"。
// ---------------------------------------------------------------------------

/**
 * 夹具：一条 SpecError 跨过 bridge 之后在 UI 侧的样子。
 *
 * **刻意不 import core 的任何运行期符号**（ui 对 core 只允许 import type），也刻意
 * 不用 wire-error.ts 的 BridgeError：translateError 是按**形状**判断的，用类实例来
 * 测会让"它其实偷偷用了 instanceof"这个缺陷测不出来——而跨过 bridge 之后原型早就没了，
 * instanceof 一定不成立。
 */
const wire = (message: string, code?: string, params?: Record<string, string | number>): Error => {
  const e = new Error(message)
  if (code !== undefined) Object.assign(e, { code })
  if (params !== undefined) Object.assign(e, { params })
  return e
}

/** core 的 EN_MESSAGES['name.reserved'] 代入 name='..' 之后的原文（errors.ts） */
const RESERVED_EN = 'A node may not be named "..": it has a special meaning in the filesystem, '
  + 'and an Agent reading the contract could not tell such a declaration apart from an '
  + 'instruction to act on the parent directory.'

describe('translateError', () => {
  it('中文界面：按码查到中文模板，params 代回占位符', () => {
    const out = translateError(wire(RESERVED_EN, 'name.reserved', { name: '..' }), 'zh')
    expect(out).toContain('名字不能是 ".."')
    // 必须真的是中文那份，而不是英文原样返回
    expect(out).not.toBe(RESERVED_EN)
  })

  it('英文界面：直接用 core 给的 message，不在 UI 里另存一份英文', () => {
    expect(translateError(wire(RESERVED_EN, 'name.reserved', { name: '..' }), 'en')).toBe(RESERVED_EN)
  })

  it('码不在中文表里时降级成英文 message——不是把码甩给用户', () => {
    // 夹具**必须**是一个真的没被翻译过的码：拿一个已有的码来测，测的是查表命中那条路，
    // 降级那条路一行都没跑到（本项目已记录 19 次"测试无法侦测它要防的东西"）。
    const notTranslated = 'parse.someFutureCodeNobodyTranslatedYet'
    expect(Object.keys(ERROR_ZH)).not.toContain(notTranslated)
    const out = translateError(wire('Something specific went wrong on line 7.', notTranslated, { line: 7 }), 'zh')
    expect(out).toBe('Something specific went wrong on line 7.')
    expect(out).not.toContain(notTranslated)
  })

  it('根本没有 code 的普通 Error（宿主自己的失败、core 那两条程序员错误）原样显示', () => {
    expect(translateError(wire('未知方法 "no/such/method"'), 'zh')).toBe('未知方法 "no/such/method"')
    expect(translateError(wire('EADDRINUSE'), 'en')).toBe('EADDRINUSE')
  })

  it('不是 Error 的值退化成 String(e)——与接线之前的行为逐字一致', () => {
    expect(translateError('炸了', 'zh')).toBe('炸了')
    expect(translateError(null, 'zh')).toBe('null')
    expect(translateError(undefined, 'en')).toBe('undefined')
  })

  it('中文模板缺参数时原样保留占位符，与 t() 的取舍一致（不抛错、不吞成空串）', () => {
    const out = translateError(wire(RESERVED_EN, 'name.reserved'), 'zh')
    expect(out).toContain('{name}')
  })

  it('ERROR_ZH 只存中文：没有任何一条是英文兜底抄过来的', () => {
    // 这张表存在的唯一理由就是"中文那一份"。哪天有人往里塞一条英文，
    // 英文就在 core 与 ui 两处各存了一份，从此开始漂移。
    for (const [code, text] of Object.entries(ERROR_ZH)) {
      expect(/[一-鿿]/.test(text), `${code} 应当是中文`).toBe(true)
    }
  })
})

describe('translateError 也管我们自己生成的那条界面报错', () => {
  it('UiMessage 带的是字典键，两种语言各自渲染——横幅上的它同样跟着开关走', () => {
    const msg = { uiKey: 'banner.copyFailed', uiParams: { text: '/tmp/repo/src' } } as const
    expect(translateError(msg, 'zh')).toBe('复制失败：浏览器拒绝了剪贴板写入。请手动复制：/tmp/repo/src')
    expect(translateError(msg, 'en'))
      .toBe('Copy failed: the browser denied clipboard access. Copy it manually: /tmp/repo/src')
  })
})

// ---------------------------------------------------------------------------
// 覆盖率：core 的每一个码都必须有中文。
//
// 这条脚本式用例遍历 EN_MESSAGES 的全部键，两个方向各查一次——"少一条"意味着某个
// 报错在中文界面上永远是英文（界面看着完全正常，没有任何症状能让人发现）；"多一条"
// 意味着 core 那侧删了或改名了一个码，而这边留下一条永远查不到的死条目。
// ---------------------------------------------------------------------------

describe('ERROR_ZH 对 core 错误码的覆盖率', () => {
  const CORE_CODES = Object.keys(EN_MESSAGES).sort()
  const ZH_CODES = Object.keys(ERROR_ZH).sort()

  it('一个不缺：core 的每个码都有中文', () => {
    const missing = CORE_CODES.filter(c => !ZH_CODES.includes(c))
    expect(missing).toEqual([])
  })

  it('一个不多：ERROR_ZH 里没有 core 已经不认识的死条目', () => {
    const extra = ZH_CODES.filter(c => !CORE_CODES.includes(c))
    expect(extra).toEqual([])
  })

  it('两边的码集完全相同（换个角度复核一遍，避免上面两条同时被同一个巧合骗过）', () => {
    expect(ZH_CODES).toEqual(CORE_CODES)
  })
})

// ---------------------------------------------------------------------------
// 解析错误：它是一条**纯数据**（{ line, message, code, params }），不是 Error 实例。
// 这一节钉的是"英文界面下解析错误不能变成 [object Object]"——那等于把"解析失败要能
// 定位"这条铁律拆掉一半。
// ---------------------------------------------------------------------------

/** 夹具：一条 ParseError 跨过 bridge 之后在 UI 侧的样子（纯数据，没有原型）。 */
const parseErr = (line: number, message: string, code?: string, params?: Record<string, string | number>) =>
  JSON.parse(JSON.stringify({ line, message, code, params })) as unknown

describe('translateError 认得纯数据形状的 ParseError', () => {
  const EN = 'Indentation must be a multiple of 2 spaces, but this line has 3.'

  it('中文界面：按码查到中文模板，params 代回占位符', () => {
    const out = translateError(parseErr(7, EN, 'parse.indentNotMultipleOfTwo', { indent: 3 }), 'zh')
    expect(out).toBe('缩进必须是 2 的倍数，实际 3 个空格')
  })

  it('英文界面：用 core 渲染好的 message，**不是** "[object Object]"', () => {
    const out = translateError(parseErr(7, EN, 'parse.indentNotMultipleOfTwo', { indent: 3 }), 'en')
    expect(out).toBe(EN)
    expect(out).not.toContain('[object Object]')
  })

  it('没有码的那一条（例如宿主给的旧格式）照旧原样显示 message', () => {
    expect(translateError(parseErr(3, 'line 3 went wrong'), 'zh')).toBe('line 3 went wrong')
  })

  it('行号不在文案里——两种语言下都由界面自己渲染，谁也不会把它翻丢', () => {
    for (const lang of ['zh', 'en'] as const) {
      const out = translateError(parseErr(7, EN, 'parse.indentNotMultipleOfTwo', { indent: 3 }), lang)
      expect(out).not.toContain('7')
    }
  })
})

// ---------------------------------------------------------------------------
// UiError：UI 自己抛的报错（bridge 层那两条）。bridge 不知道也不需要知道当前语言，
// 它抛一个带**字典键**的错误，翻译照旧推迟到显示那一刻。
// ---------------------------------------------------------------------------

describe('UiError', () => {
  it('是一个 Error：既有的 reject / catch / e.message 链路一个字都不用改', () => {
    const e = new UiError('error.connectionLost')
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('UiError')
  })

  it('message 是英文——与 core 的取舍一致：不翻译的消费者（日志）也得读得懂', () => {
    expect(new UiError('error.connectionLost').message).toBe(translate('en', 'error.connectionLost'))
    expect(new UiError('error.connectionLost').message).not.toMatch(/[\u4e00-\u9fff]/)
  })

  it('translateError 按当前语言渲染它，两个方向都对', () => {
    const e = new UiError('error.connectionLost')
    expect(translateError(e, 'zh')).toBe(translate('zh', 'error.connectionLost'))
    expect(translateError(e, 'en')).toBe(translate('en', 'error.connectionLost'))
    expect(translateError(e, 'zh')).not.toBe(translateError(e, 'en'))
  })
})
