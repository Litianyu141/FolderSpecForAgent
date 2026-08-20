import { describe, it, expect } from 'vitest'
import { zh, en, translate, translateError, ERROR_ZH } from './i18n.js'

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
