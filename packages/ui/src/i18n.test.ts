import { describe, it, expect } from 'vitest'
// **测试专用的运行期 import，源码里绝不许出现。** `@folderspec/core` 是 ui 的
// devDependency（不是 dependency），打进浏览器产物的只有 src/，而 src/ 对 core 一律
// `import type`。走 `/errors` 这条子路径而不是包根：dist/errors.js 编译后没有任何
// import 语句，拿它做覆盖率核对不会把 node:fs、yaml 这些东西拖进 jsdom 里。
// 代价是这份测试从此需要先 `pnpm -C packages/core build`（与 packages/cli 同款前提）。
import { EN_MESSAGES } from '@folderspec/core/errors'
import { zh, en, translate, translateError, ERROR_ZH, UiError } from './i18n.js'
import type { WireError } from '@folderspec/core/api'

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
const wire = (message: string, code?: string, params?: WireError['params']): Error => {
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
const parseErr = (line: number, message: string, code?: string, params?: WireError['params']) =>
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

// ---------------------------------------------------------------------------
// 嵌套明细：一条报错的 params 里可以装**一串还没被渲染成任何语言的明细**
// （形状就是 WireError 自己）。这一节钉的是"中文界面下那两条报错整句都是中文"，
// 以及递归渲染路径上的兜底。
//
// 夹具一律手写纯数据、**不 import core 的运行期符号**（除了覆盖率用例那个已经批准的
// 例外）：跨过 bridge 之后原型早就没了，用类实例来测会让"它其实偷偷用了 instanceof"
// 这个缺陷测不出来。
// ---------------------------------------------------------------------------

/** 夹具：core 造的一条冲突明细跨过 bridge 之后的样子。message 是 core 渲染好的英文。 */
const conflictDetail = (code: string, message: string, params: Record<string, string>): WireError =>
  ({ message, code, params })

const MERGE_EN = 'The destination already has a node with this name, and this move would '
  + 'overwrite content already written there: …. Decide which side to keep first — clear one '
  + 'side, or make both sides say exactly the same thing — then retry the move.'

describe('translateError 渲染嵌套明细（move.mergeConflict）', () => {
  const conflicts: WireError[] = [
    conflictDetail('detail.conflictAnnotation',
      'the comment of `src/utils.ts` (“共享工具函数，勿删”) would be overwritten by “旧的”',
      { path: 'src/utils.ts', kept: '共享工具函数，勿删', coming: '旧的' }),
    conflictDetail('detail.conflictRole',
      'the semantic role of `src/utils.ts` (“shared”) would be overwritten by “legacy”',
      { path: 'src/utils.ts', kept: 'shared', coming: 'legacy' }),
    conflictDetail('detail.conflictTemplate',
      'the template of `src/cases` (“case-dir”) would be overwritten by “legacy-dir”',
      { path: 'src/cases', kept: 'case-dir', coming: 'legacy-dir' }),
    conflictDetail('detail.conflictSeverity',
      'the severity of `src/cases` (“error”) would be overwritten by “warning”',
      { path: 'src/cases', kept: 'error', coming: 'warning' }),
  ]
  const e = wire(MERGE_EN, 'move.mergeConflict', { conflicts, count: conflicts.length })

  it('中文界面：整句连同四条明细全是中文，一个英文词都不剩', () => {
    expect(translateError(e, 'zh')).toBe(
      '目标位置已经有同名节点，这次移动会覆盖掉它已经写下的内容（共 4 处）：'
      + '`src/utils.ts` 的注释（“共享工具函数，勿删”）会被“旧的”覆盖；'
      + '`src/utils.ts` 的语义角色（“shared”）会被“legacy”覆盖；'
      + '`src/cases` 的模板（“case-dir”）会被“legacy-dir”覆盖；'
      + '`src/cases` 的约束强度（“error”）会被“warning”覆盖。'
      + '请先决定保留哪一份（把其中一侧清空，或把两侧改成相同内容），再重试这次移动')
  })

  it('中文界面：不含 core 那边的英文措辞，也不含 "[object Object]"', () => {
    // 这一条是"两侧递归实现漂移"的真闸门：把 renderZhValue 的数组分支删掉（退化成
    // String(v)），界面上就会出现 "[object Object]"，而**英文界面完全正常**——
    // 那种缺陷没有任何其他症状能让人发现。
    const out = translateError(e, 'zh')
    expect(out).not.toContain('[object Object]')
    expect(out).not.toContain('would be overwritten by')
    expect(out).not.toContain('the semantic role of')
    expect(out).not.toContain('{conflicts}')
  })

  it('英文界面：原样是 core 渲染好的那句，UI 一个字都不掺和', () => {
    expect(translateError(e, 'en')).toBe(MERGE_EN)
  })

  it('四个字段的中文与用户在标注面板上看到的标签逐字相同', () => {
    // 把词当参数传的年代做不到这一点：那四个词一旦拼进 core 的 message 就固定是英文。
    const out = translateError(e, 'zh')
    expect(out).toContain(translate('zh', 'annotationPanel.annotationLabel'))
    expect(out).toContain(translate('zh', 'annotationPanel.roleLabel'))
    expect(out).toContain(translate('zh', 'common.severity'))
  })

  it('逐条降级：某一条明细的码这边还没有中文时，只有那一条退回英文，其余仍是中文', () => {
    // 真正会发生的场景是宿主与 UI 版本不齐——收到一个这份字典根本没有的码。
    // **必须用一个真的没被翻译过的码**，不能 mock 掉字典：mock 掉的用例在字典被改坏
    // 时不会红。
    const untranslated: WireError = {
      message: 'something a newer host knows how to say',
      code: 'brand.newCodeFromTheFuture',
      params: { path: 'src/x' },
    }
    const mixed = wire(MERGE_EN, 'move.mergeConflict', {
      conflicts: [conflicts[0], untranslated],
      count: 2,
    })
    const out = translateError(mixed, 'zh')

    // 外层是中文
    expect(out).toContain('目标位置已经有同名节点')
    // 已翻译的那一条仍是中文
    expect(out).toContain('`src/utils.ts` 的注释（“共享工具函数，勿删”）会被“旧的”覆盖')
    // 没翻译的那一条退回**英文人话**——不是码、不是占位符、不是空串
    expect(out).toContain('something a newer host knows how to say')
    expect(out).not.toContain('brand.newCodeFromTheFuture')
  })

  it('没有 code 的明细照样显示它自己的 message', () => {
    const out = translateError(
      wire(MERGE_EN, 'move.mergeConflict', { conflicts: [{ message: 'a bare detail' }], count: 1 }), 'zh')
    expect(out).toContain('a bare detail')
  })

  it('明细嵌套很深时不抛错、不爆栈：触底退回 message', () => {
    let d: WireError = { message: 'bottom', code: 'detail.conflictRole', params: { path: 'p', kept: 'k', coming: 'c' } }
    for (let i = 0; i < 20000; i++) {
      d = { message: `level ${i}`, code: 'move.mergeConflict', params: { conflicts: [d], count: 1 } }
    }
    let out = ''
    expect(() => { out = translateError(wire(MERGE_EN, 'move.mergeConflict', { conflicts: [d], count: 1 }), 'zh') })
      .not.toThrow()
    expect(out).toContain('level ')
  })

  it('从线上收来的纯数据（JSON.parse 的产物，没有原型）渲染出同一句中文', () => {
    // **断的是那句完整中文，不是"与另一个渲染结果相同"**——后者是一条恒真式：
    // 两边走的是同一个渲染器，把渲染器整个改坏它照样绿。
    // 这一格覆盖的是真实链路：宿主回的 error 经 JSON.parse 到达 UI，原型早就没了，
    // 而 translateError 是按**形状**判断的。
    const revived = JSON.parse(JSON.stringify(
      { message: MERGE_EN, code: 'move.mergeConflict', params: { conflicts, count: conflicts.length } },
    )) as unknown
    expect(translateError(revived, 'zh')).toBe(
      '目标位置已经有同名节点，这次移动会覆盖掉它已经写下的内容（共 4 处）：'
      + '`src/utils.ts` 的注释（“共享工具函数，勿删”）会被“旧的”覆盖；'
      + '`src/utils.ts` 的语义角色（“shared”）会被“legacy”覆盖；'
      + '`src/cases` 的模板（“case-dir”）会被“legacy-dir”覆盖；'
      + '`src/cases` 的约束强度（“error”）会被“warning”覆盖。'
      + '请先决定保留哪一份（把其中一侧清空，或把两侧改成相同内容），再重试这次移动')
  })
})

// ---------------------------------------------------------------------------
// serialize.selfCheckFailed：明细是一串 ParseError，每条自带行号。
//
// **行号有两条渲染路径，它们不得相交**：顶层解析错误由 App.tsx 自己拼
// banner.parseErrorLine，嵌套明细由 renderZhDetail 自己拼。哪一侧多拼一次，
// 横幅上就会出现「第 3 行：第 3 行：…」。
// ---------------------------------------------------------------------------

describe('translateError 渲染带行号的嵌套明细（serialize.selfCheckFailed）', () => {
  const SELF_EN = 'The serialize → parse self-check failed, so the write was aborted to avoid '
    + 'corrupting the contract file: line 3: Indentation must be a multiple of 2 spaces, but '
    + 'this line has 3.; line 12: The node name is empty.'
  const details: WireError[] = [
    { line: 3, message: 'Indentation must be a multiple of 2 spaces, but this line has 3.', code: 'parse.indentNotMultipleOfTwo', params: { indent: 3 } },
    { line: 12, message: 'The node name is empty.', code: 'parse.nameEmpty', params: {} },
  ]
  const e = wire(SELF_EN, 'serialize.selfCheckFailed', { details })

  it('中文界面：行号与原因分开渲染，两条明细都是中文', () => {
    expect(translateError(e, 'zh')).toBe(
      '序列化自校验失败，已中止以免损坏契约文件：'
      + '第 3 行：缩进必须是 2 的倍数，实际 3 个空格；'
      + '第 12 行：节点名为空')
  })

  it('行号前缀与只读横幅走同一个字典键、同一个数字', () => {
    expect(translateError(e, 'zh')).toContain(translate('zh', 'banner.parseErrorLine', { line: 3 }))
  })

  it('每条明细的「第 N 行：」只出现一次——嵌套这一侧不许双份', () => {
    const out = translateError(e, 'zh')
    expect(out.split('第 3 行：').length - 1).toBe(1)
    expect(out.split('第 12 行：').length - 1).toBe(1)
  })

  it('line 为 0 的那一条（spec.unreadable）照样拼前缀——不设 `line > 0` 的闸', () => {
    const zeroLine = wire(SELF_EN, 'serialize.selfCheckFailed', {
      details: [{ line: 0, message: 'The node name is empty.', code: 'parse.nameEmpty', params: {} }],
    })
    expect(translateError(zeroLine, 'zh')).toContain('第 0 行：节点名为空')
  })

  it('英文界面：原样是 core 渲染好的那句', () => {
    expect(translateError(e, 'en')).toBe(SELF_EN)
  })
})

describe('双前缀陷阱：一条顶层 ParseError 在横幅上只带一次「第 N 行：」', () => {
  // App.tsx 的只读横幅是这么拼的：`t('banner.parseErrorLine', {line}) + translateError(e, lang)`。
  // 所以 translateError 在**顶层**绝不能自己再拼一次行号——嵌套明细那一侧拼，顶层不拼。
  const banner = (e: unknown, lang: 'zh' | 'en'): string =>
    translate(lang, 'banner.parseErrorLine', { line: (e as { line: number }).line }) + translateError(e, lang)

  const EN = 'Indentation must be a multiple of 2 spaces, but this line has 3.'

  it('中文横幅：整行是「第 3 行：<中文原因>」，「第 3 行：」只出现一次', () => {
    const line = banner(parseErr(3, EN, 'parse.indentNotMultipleOfTwo', { indent: 3 }), 'zh')
    expect(line).toBe('第 3 行：缩进必须是 2 的倍数，实际 3 个空格')
    expect(line.split('第 3 行：').length - 1).toBe(1)
  })

  it('英文横幅同理：「Line 3: 」只出现一次', () => {
    const line = banner(parseErr(3, EN, 'parse.indentNotMultipleOfTwo', { indent: 3 }), 'en')
    expect(line).toBe(`Line 3: ${EN}`)
    expect(line.split('Line 3: ').length - 1).toBe(1)
  })
})
