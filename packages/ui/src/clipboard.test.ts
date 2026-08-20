import { describe, it, expect, vi, afterEach } from 'vitest'
import { absolutePathOf, copyText } from './clipboard.js'

describe('absolutePathOf', () => {
  it('POSIX：root 与工作区相对路径拼成一条绝对路径', () => {
    expect(absolutePathOf('/tmp/repo', '/', 'src/a.ts')).toBe('/tmp/repo/src/a.ts')
  })

  it('Windows：相对路径里的 "/" 全部换成 "\\"，不留混合物', () => {
    // 直接字符串拼接会得到 'C:\\repo/src/a.ts'——一条哪个 shell 都认不全的路径。
    // ViewNode.path 恒用 '/'（契约的书写规范），换分隔符是**拼绝对路径时**才做的事。
    expect(absolutePathOf('C:\\repo', '\\', 'src/a.ts')).toBe('C:\\repo\\src\\a.ts')
  })

  it('root 自带尾部分隔符时不拼出双分隔符', () => {
    expect(absolutePathOf('/tmp/repo/', '/', 'src')).toBe('/tmp/repo/src')
    expect(absolutePathOf('C:\\repo\\', '\\', 'src')).toBe('C:\\repo\\src')
  })

  it('root 就是文件系统根 / 盘符根时，那个尾部分隔符不能被剃掉', () => {
    // 剃掉就成了 'src/a.ts'（一条相对路径）和 'C:src'（Windows 上是"C 盘当前目录下的
    // src"，与 'C:\\src' 是两个不同的位置）。两处都是**静默**给出一条能读、但指向别处
    // 的路径，正是这个功能最该防的失败形态。
    expect(absolutePathOf('/', '/', 'src/a.ts')).toBe('/src/a.ts')
    expect(absolutePathOf('C:\\', '\\', 'src')).toBe('C:\\src')
  })

  it('相对路径为空（工作区根自己）时给出 root 本身，不带尾巴', () => {
    expect(absolutePathOf('/tmp/repo', '/', '')).toBe('/tmp/repo')
    expect(absolutePathOf('/tmp/repo/', '/', '')).toBe('/tmp/repo')
    // root 就是文件系统根：剃掉尾巴之后什么都不剩，答案是那个分隔符本身而不是空串
    expect(absolutePathOf('/', '/', '')).toBe('/')
  })
})

/** 装/卸 navigator.clipboard：jsdom 默认根本没有这个属性（真实浏览器的非安全上下文
 *  同样没有），所以"装上"和"卸掉"两种情形都得能造出来。 */
const setClipboard = (value: unknown) => {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true, writable: true })
}
const clearClipboard = () => {
  Reflect.deleteProperty(navigator, 'clipboard')
}

afterEach(() => {
  clearClipboard()
  Reflect.deleteProperty(document, 'execCommand')
  document.body.innerHTML = ''
})

describe('copyText', () => {
  it('有 navigator.clipboard 时用它，且写进去的是那一整条字符串', async () => {
    const writeText = vi.fn(async () => {})
    setClipboard({ writeText })

    expect(await copyText('/tmp/repo/src/a.ts')).toBe(true)
    // 断言的是**参数的真实取值**，不是"调用发生了"：本项目记录里那一类"验证了管道
    // 通不通、没验证真实取值是多少"的缺陷，在这条功能上等于复制了一条错的路径。
    expect(writeText).toHaveBeenCalledWith('/tmp/repo/src/a.ts')
  })

  it('没有 navigator.clipboard 时降级到 execCommand，且 textarea 里装的就是那条字符串', async () => {
    clearClipboard()
    let seen: string | null = null
    let attached = false
    const execCommand = vi.fn((cmd: string) => {
      // 在**复制发生的那一刻**读 DOM：只断言 execCommand('copy') 被调用过，
      // 完全测不出"textarea 建了但没赋值"或"赋的是别的值"——那正是静默复制错东西。
      const ta = document.querySelector('textarea')
      seen = ta?.value ?? null
      attached = ta !== null && document.body.contains(ta)
      return cmd === 'copy'
    })
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true, writable: true })

    expect(await copyText('src/a.ts')).toBe(true)
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(seen).toBe('src/a.ts')
    // 选区只在元素真的挂在文档里时才成立；游离节点上 select() 是空操作，
    // execCommand('copy') 会复制页面上原本的选区（多半是空）
    expect(attached).toBe(true)
    // 用完必须摘掉，否则每复制一次页面上就多一个隐藏 textarea
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('writeText 被拒（VSCode webview / 非安全上下文的典型形态）时照样走降级路径', async () => {
    setClipboard({ writeText: vi.fn(async () => { throw new DOMException('Write permission denied', 'NotAllowedError') }) })
    let seen: string | null = null
    Object.defineProperty(document, 'execCommand', {
      value: vi.fn(() => { seen = document.querySelector('textarea')?.value ?? null; return true }),
      configurable: true, writable: true,
    })

    expect(await copyText('src/a.ts')).toBe(true)
    expect(seen).toBe('src/a.ts')
  })

  it('两条路都不通时返回 false（绝不抛，也绝不假装成功）', async () => {
    setClipboard({ writeText: vi.fn(async () => { throw new Error('nope') }) })
    Object.defineProperty(document, 'execCommand', {
      value: vi.fn(() => false), configurable: true, writable: true,
    })

    // 返回 false 是调用方弹横幅的唯一依据。若这里改成"抛"，onClick 里那个 promise
    // 会变成一次没人接的 rejection——用户看到的就是"点了没反应"，而剪贴板里还是上一次
    // 的内容，粘出去的是别的东西。
    expect(await copyText('src/a.ts')).toBe(false)
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('execCommand 抛异常时也只是 false，并且把 textarea 收干净', async () => {
    clearClipboard()
    Object.defineProperty(document, 'execCommand', {
      value: vi.fn(() => { throw new Error('boom') }), configurable: true, writable: true,
    })

    expect(await copyText('src/a.ts')).toBe(false)
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('降级路径跑完把焦点还给原来那个元素', async () => {
    // 焦点掉到 <body> 上，键盘用户就丢了位置——而这是一次"复制"，不该动界面上的任何东西
    clearClipboard()
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    Object.defineProperty(document, 'execCommand', {
      value: vi.fn(() => true), configurable: true, writable: true,
    })

    await copyText('src/a.ts')
    expect(document.activeElement).toBe(input)
  })
})
