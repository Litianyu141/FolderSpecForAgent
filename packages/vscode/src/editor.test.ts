import { describe, it, expect, vi } from 'vitest'

/**
 * editor.ts 顶层 `import * as vscode from 'vscode'`——真实运行时这个模块由 VSCode 的
 * 扩展宿主注入，Node 环境里根本不存在这个包。shouldSwitchSession 是个纯函数，测试它
 * 不需要 vscode 提供任何真东西，只需要模块能被 import 进来而不在加载阶段报错：
 * editor.ts 里所有 vscode.* 的引用都发生在方法体内部（调用时才执行），不是模块顶层，
 * 所以一个空对象就够撑起 import。
 */
vi.mock('vscode', () => ({}))

const { shouldSwitchSession } = await import('./editor.js')

describe('shouldSwitchSession', () => {
  it('wanted 为 undefined 时不切换', () => {
    expect(shouldSwitchSession('/workspace/a', undefined)).toBeNull()
  })

  it('wanted 是相对路径（UI 未收到注入 root 时的占位默认值 "."）时不切换——这是本次要修的 bug', () => {
    // resolve('.') 会解析到扩展宿主进程的 cwd，和当前 session 的 root 毫无关系；
    // 相对路径本身就该被直接拒绝，而不是先 resolve 再比较。
    expect(shouldSwitchSession('/workspace/a', '.')).toBeNull()
  })

  it('wanted 是绝对路径但等于当前 root 时不切换', () => {
    expect(shouldSwitchSession('/workspace/a', '/workspace/a')).toBeNull()
  })

  it('wanted 是不同的绝对路径时返回解析后的路径', () => {
    expect(shouldSwitchSession('/workspace/a', '/workspace/b')).toBe('/workspace/b')
  })
})
