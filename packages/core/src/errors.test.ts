import { describe, it, expect } from 'vitest'
import { EN_MESSAGES, SpecError, isSpecError, renderEnglish } from './errors.js'
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
