import { describe, it, expect } from 'vitest'
import { zh, en, translate } from './i18n.js'

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
