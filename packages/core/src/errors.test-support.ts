import { expect } from 'vitest'
import type { SpecErrorCode, SpecErrorParams } from './errors.js'

/**
 * 断言"抛出的是哪一条 SpecError"，配合 `toThrow` / `rejects.toThrow` 使用：
 *
 * ```ts
 * expect(() => s.rename({ path: '', newName: 'x' })).toThrow(specError('rename.rootNode'))
 * await expect(s.save()).rejects.toThrow(specError('readonly.parseFailed'))
 * ```
 *
 * **为什么断言 code 而不是文案。** 报错文案现在是英文、将来还要跟着界面语言开关走，
 * 润色一个词就会让一批用例变红——那种红是假的，它证明不了任何一道闸门失效了。code
 * 是这条错误的身份，只在"这里该不该抛、该抛哪一条"真的变了的时候才变。这是本轮改动
 * 的附带收益：用例从此绑在**行为**上，不是绑在措辞上。
 *
 * **params 是可选的第二道断言，不是装饰。** 有一批用例原先断的是文案里那个具体的
 * 路径/名字（`.toThrow('src/we\`ird')`、`.toThrow('共享工具函数，勿删')`），它们要
 * 证明的不只是"抛了"，还有"抛的是**针对这一个对象**的那条错"——只对 code 不对
 * params，闸门错抓一个无辜节点也照样绿。这类用例必须把那个值挪进 params 断言里，
 * 承重的部分一格都不能少。
 *
 * 用 `objectContaining` 而不是全等：SpecError 上还有 message/name/stack，全等会把
 * 用例绑死在英文文案上，等于绕一圈又回到原地。
 */
export function specError(code: SpecErrorCode, params?: SpecErrorParams): unknown {
  return params === undefined
    ? expect.objectContaining({ code })
    : expect.objectContaining({ code, params: expect.objectContaining(params) })
}
