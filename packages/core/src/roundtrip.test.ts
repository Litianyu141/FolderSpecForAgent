import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { serializeSpec } from './serialize.js'
import { parseSpec } from './parse/index.js'
import type { Group, Rule, Spec, SpecNode, Template } from './types.js'

const chars = (pool: string, min: number, max: number) =>
  fc.array(fc.constantFrom(...pool.split('')), { minLength: min, maxLength: max })
    .map(a => a.join(''))

const nameArb = chars('abzAZ09._-{}', 1, 10)
const identArb = chars('abz09-', 1, 8).filter(s => s !== '')
const textArb = chars('ab中文 ,.—!', 1, 20).map(s => s.trim()).filter(s => s !== '')

const nodeArb: fc.Arbitrary<SpecNode> = fc.letrec<{ node: SpecNode }>(tie => ({
  node: fc.record({
    name: nameArb,
    isDir: fc.boolean(),
    role: fc.option(identArb, { nil: undefined }),
    template: fc.option(identArb, { nil: undefined }),
    severity: fc.option(fc.constantFrom('error' as const, 'warning' as const, 'advisory' as const), { nil: undefined }),
    annotation: fc.option(textArb, { nil: undefined }),
    children: fc.oneof(
      { depthSize: 'small' },
      fc.constant([] as SpecNode[]),
      // 同一层同名兄弟是重复声明，解析器现在直接拒绝（见下面的专门用例）。
      // 生成器只产唯一兄弟，是为了让 round-trip 这条用例始终测的是"往返不丢数据"，
      // 而不是变成一条重复检测用例。
      fc.uniqueArray(tie('node'), { maxLength: 3, selector: n => n.name }),
    ),
  }).map(n => (n.isDir ? n : { ...n, children: [] })),
})).node

const templateArb: fc.Arbitrary<Template> = fc.record({
  name: identArb,
  description: fc.option(textArb, { nil: undefined }),
  rootVariable: fc.option(identArb, { nil: undefined }),
  rootNaming: fc.option(identArb, { nil: undefined }),
  children: fc.array(fc.record({
    name: nameArb,
    isDir: fc.boolean(),
    role: fc.option(identArb, { nil: undefined }),
    required: fc.boolean(),
  }), { maxLength: 4 }),
  exemplar: fc.array(chars('abz/-', 1, 12), { maxLength: 3 }),
}).map(t => ({
  ...t,
  // 同名子项在 YAML 映射里会互相覆盖，生成器层面去重
  children: t.children.filter((c, i, all) =>
    all.findIndex(o => o.name === c.name && o.isDir === c.isDir) === i),
}))

const ruleArb: fc.Arbitrary<Rule> = fc.record({
  id: identArb,
  severity: fc.constantFrom('error' as const, 'warning' as const, 'advisory' as const),
  scope: chars('abz/*-', 1, 10).filter(s => s !== ''),
  text: textArb,
})

/** 成员路径：多段 posix 路径，不含 '..' 段（解析器会拒绝它） */
const memberArb = fc
  .array(chars('abz09-', 1, 6), { minLength: 1, maxLength: 3 })
  .map(segs => segs.join('/'))

/**
 * 分组 id 用比 identArb 宽得多的字符池：它是**用户在面板里手打的组名**，
 * 会出现中文、空格，以及 : # - " 这些对 YAML 有特殊含义的字符。
 * 模板名与规则 id 目前没有编辑入口，所以沿用窄的 identArb；分组名不能照抄。
 */
const groupIdArb = chars('ab中文 -:#"', 1, 12).map(s => s.trim()).filter(s => s !== '')

const groupArb: fc.Arbitrary<Group> = fc.record({
  id: groupIdArb,
  members: fc.uniqueArray(memberArb, { minLength: 1, maxLength: 4 }),
  text: textArb,
  severity: fc.option(fc.constantFrom('error' as const, 'warning' as const, 'advisory' as const), { nil: undefined }),
})

const specArb: fc.Arbitrary<Spec> = fc.record({
  version: fc.constant(1),
  root: fc.constant('.'),
  ownership: fc.constant('human'),
  title: fc.oneof(fc.constant(''), textArb),
  preamble: fc.array(textArb, { maxLength: 3 }),
  nodes: fc.uniqueArray(nodeArb, { maxLength: 4, selector: n => n.name }),
  templates: fc.array(templateArb, { maxLength: 2 }),
  rules: fc.array(ruleArb, { maxLength: 3 }),
  groups: fc.array(groupArb, { maxLength: 3 }),
}).map(s => ({
  ...s,
  templates: s.templates.filter((t, i, all) => all.findIndex(o => o.name === t.name) === i),
  rules: s.rules.filter((r, i, all) => all.findIndex(o => o.id === r.id) === i),
  groups: s.groups.filter((g, i, all) => all.findIndex(o => o.id === g.id) === i),
}))

/** 对齐 undefined 属性的表示，让比较只关注实际数据 */
const norm = (v: unknown) => JSON.parse(JSON.stringify(v))

describe('serializeSpec ↔ parseSpec round-trip', () => {
  it('任意 Spec 序列化后再解析必须完全相等', () => {
    fc.assert(
      fc.property(specArb, spec => {
        const text = serializeSpec(spec)
        const back = parseSpec(text)
        if (!back.ok) {
          throw new Error(`解析失败 ${JSON.stringify(back.errors)}\n--- 原文 ---\n${text}`)
        }
        expect(norm(back.value)).toEqual(norm(spec))
      }),
      { numRuns: 500 },
    )
  })

  it('序列化是幂等的', () => {
    fc.assert(
      fc.property(specArb, spec => {
        const once = serializeSpec(spec)
        const back = parseSpec(once)
        if (!back.ok) throw new Error(JSON.stringify(back.errors))
        expect(serializeSpec(back.value)).toBe(once)
      }),
      { numRuns: 300 },
    )
  })
})

describe('同名兄弟节点', () => {
  it('任意 Spec 的第一个根节点被复制一份后，序列化的结果必须解析失败', () => {
    // 以前这里有个 dedupeSiblings() 帮解析器把重复项擦掉，注释写着"同名节点在语义上是
    // 重复声明"——可当时谁也没有真的拒绝它，那句注释是空话。现在解析器会报错，这条用例
    // 就是那句话的执行者：任何被复制出来的兄弟都必须让整份文档解析失败，而不是被静默
    // 收下（收下之后 merge 显示最后一个、spec-edit 编辑第一个，注释会被无声改写）。
    fc.assert(
      fc.property(
        specArb.filter(s => s.nodes.length > 0),
        spec => {
          const dup: Spec = { ...spec, nodes: [...spec.nodes, structuredClone(spec.nodes[0])] }
          const back = parseSpec(serializeSpec(dup))
          expect(back.ok).toBe(false)
          if (back.ok) return
          expect(back.errors.some(e => e.message.includes('重名'))).toBe(true)
        },
      ),
      { numRuns: 200 },
    )
  })
})

describe('回归：round-trip property test 发现的反例', () => {
  it('模板子项名形如整数（如 "0"）时必须保持声明顺序', () => {
    // fast-check 最小反例（seed 890569006，12 次收缩后得到）：
    //   templates: [{ name: 'a', children: [{ name: 'a', ... }, { name: '0', ... }] }]
    // 根因：'0' 是合法的 ECMAScript 数组下标字符串。普通 JS 对象在枚举自身键时，
    // 会把这类“形如数组下标”的键排到所有其他字符串键之前、按数值升序排列，
    // 无论真实的插入顺序如何——这条规则来自 ECMAScript 规范本身的
    // [[OwnPropertyKeys]] 顺序，不是 yaml 库的行为。
    // 它咬了两处：
    //   1) 序列化器把 children 用普通对象承载（`children[name] = entry`），
    //      写出的 YAML 文本本身顺序就错了。
    //   2) 解析器把整份 YAML 映射转换成 JS 对象后再 Object.entries() 遍历
    //      （无论 YAML 源文本顺序是否正确，转换成 JS 对象后一样会被打乱）。
    // 修复：两处都改为不经过“转普通对象再枚举键”这一步——序列化器改用
    // Map（保证按插入顺序序列化），解析器改为直接遍历 YAML AST 节点的
    // items（保证按文档原始顺序读取）。
    const spec: Spec = {
      version: 1, root: '.', ownership: 'human', title: 'a', preamble: [],
      nodes: [],
      templates: [{
        name: 'a',
        children: [
          { name: 'a', isDir: false, required: false },
          { name: '0', isDir: false, required: false },
        ],
        exemplar: [],
      }],
      rules: [],
      groups: [],
    }
    const text = serializeSpec(spec)
    const back = parseSpec(text)
    if (!back.ok) throw new Error(`解析失败 ${JSON.stringify(back.errors)}\n--- 原文 ---\n${text}`)
    expect(norm(back.value)).toEqual(norm(spec))
    expect(back.value.templates[0]?.children.map(c => c.name)).toEqual(['a', '0'])
  })

  it('模板名本身形如整数时也必须保持声明顺序', () => {
    // 同一个根因的另一处触发点：顶层模板名 → 定义的映射。
    const spec: Spec = {
      version: 1, root: '.', ownership: 'human', title: 'a', preamble: [],
      nodes: [],
      templates: [
        { name: 'b', children: [], exemplar: [] },
        { name: '0', children: [], exemplar: [] },
      ],
      rules: [],
      groups: [],
    }
    const text = serializeSpec(spec)
    const back = parseSpec(text)
    if (!back.ok) throw new Error(`解析失败 ${JSON.stringify(back.errors)}\n--- 原文 ---\n${text}`)
    expect(norm(back.value)).toEqual(norm(spec))
    expect(back.value.templates.map(t => t.name)).toEqual(['b', '0'])
  })
})
