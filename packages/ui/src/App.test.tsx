import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { App } from './App.js'
import { FakeBridge } from './test-bridge.js'
import type { Bridge, FileReadResult, Group, OpenResult, Severity, ViewNode } from '@folderspec/core/api'

const tree = (children: ViewNode[]): ViewNode =>
  ({ name: 'repo', path: '', isDir: true, origin: 'both', children })

// 固定树夹具：src/ 与 docs/ 同属分组 g1（行尾各带一个色点），README.md 不属于任何分组。
// 三个顶层节点缺一不可：色点用例要求"点一下就恰好选中两项"，而新建分组的用例要求选中集
// **不等于** 任何既有分组的成员集——否则面板会回填 g1 并以 id: 'g1' 提交，"新建"这条路径
// 根本走不到，测试看着绿其实什么都没测。src 带子节点是为了让 shift 区间用例能跨越展开层。
const SRC: ViewNode = {
  name: 'src', path: 'src', isDir: true, origin: 'actual-only', groups: ['g1'],
  children: [
    { name: 'a.ts', path: 'src/a.ts', isDir: false, origin: 'actual-only' },
    { name: 'b.ts', path: 'src/b.ts', isDir: false, origin: 'actual-only' },
  ],
}
const DOCS: ViewNode =
  { name: 'docs', path: 'docs', isDir: true, origin: 'actual-only', groups: ['g1'], children: [] }
const README: ViewNode = { name: 'README.md', path: 'README.md', isDir: false, origin: 'actual-only' }
const FIXTURE = [SRC, DOCS, README]

const G1: Group = { id: 'g1', members: ['src', 'docs'], text: '一体的两个目录' }

// 目录，children 未定义——代表"尚未扫描"，触发 tree/expand 的唯一形状
// （见 Tree.tsx 的 onToggle：只有 n.children === undefined 才会调用 onExpand）
const UNSCANNED: ViewNode = { name: 'lib', path: 'lib', isDir: true, origin: 'unscanned' }

const openResult = (over: Partial<OpenResult> = {}): OpenResult => ({
  root: '/tmp/repo',
  rootName: 'repo',
  hasSpec: false,
  specPath: '/tmp/repo/.folderspec.md',
  parseErrors: null,
  tree: tree(FIXTURE),
  groups: [G1],
  ...over,
})

const bridgeWith = (over: Partial<Record<string, unknown>> = {}) => new FakeBridge({
  'workspace/open': () => openResult(over as Partial<OpenResult>),
  'spec/annotate': () => ({
    tree: tree([{ ...SRC, annotation: '核心源码', origin: 'both' }, DOCS, README]),
    dirty: true, groups: [G1],
  }),
  'spec/move': () => ({ tree: tree(FIXTURE), dirty: true, groups: [G1] }),
  'spec/save': () => ({ written: true }),
  'tree/expand': () => ({ tree: tree(FIXTURE) }),
  'spec/setGroup': () => ({ tree: tree(FIXTURE), dirty: true, groups: [G1], id: 'g1' }),
  'spec/deleteGroup': () => ({ tree: tree(FIXTURE), dirty: true, groups: [] }),
  'file/read': () => ({ kind: 'text', text: 'hello\nworld' }),
} as never)

const rowsOf = (container: HTMLElement) => Array.from(container.querySelectorAll('.fs-row'))

const G3: Group = { id: 'g1', members: ['src', 'docs', 'README.md'], text: '一体的三个' }

/**
 * 会真的按参数收缩分组、且响应带非零延迟的桩。两点缺一不可：
 * 上一轮 bridgeWith 的 spec/setGroup 恒返回未收缩的 G1，把一个会销毁用户注释的缺陷
 * 完全掩盖住了；而零延迟的桩测不出"请求在途的那一帧"——真实宿主的响应必然晚于本次
 * 点击引发的渲染，缺陷就长在那一帧里。
 */
const groupBridge = (initial: Group[], delayMs = 20) => {
  let groups: Group[] = initial.map(g => ({ ...g, members: [...g.members] }))
  const calls: Array<{ method: string; params: unknown }> = []
  const self = {
    calls,
    groupsNow: () => groups,
    lastCall(method: string): unknown {
      for (let i = calls.length - 1; i >= 0; i--) if (calls[i].method === method) return calls[i].params
      return undefined
    },
    on: () => () => {},
    request: (async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'workspace/open') return openResult({ groups })
      if (method === 'file/read') return { kind: 'text', text: 'hello\nworld' }
      if (method === 'spec/annotate') return { tree: tree(FIXTURE), dirty: true, groups }
      if (method === 'spec/setGroup') {
        await new Promise(r => setTimeout(r, delayMs))
        const id = params.id as string | null
        const members = params.members as string[]
        groups = groups.map(g => g.id !== id ? g : {
          ...g,
          members: [...members],
          ...(typeof params.name === 'string' && params.name !== '' ? { id: params.name } : {}),
          ...(params.text !== undefined ? { text: params.text as string } : {}),
          ...(params.severity ? { severity: params.severity as Severity } : {}),
        })
        return { tree: tree(FIXTURE), dirty: true, groups, id: id ?? 'group' }
      }
      throw new Error(`本用例未配置 ${method}`)
    }) as Bridge['request'],
  }
  return self as typeof self & Bridge
}

/** 选中 src + docs + README.md 三项，恰好等于 G3 的成员集 */
const selectAllThree = (container: HTMLElement) => {
  const rows = rowsOf(container)
  fireEvent.click(rows[0])
  fireEvent.click(rows[1], { ctrlKey: true })
  fireEvent.click(rows[2], { ctrlKey: true })
}


const clickFirstRow = (container: HTMLElement) => {
  const row = container.querySelector('.fs-row')
  expect(row).toBeTruthy()
  fireEvent.click(row!)
}

/** 先普通点 src、再 ctrl 点 README.md：两项，且与 g1 的成员集不同 */
const selectTwoUnrelated = (container: HTMLElement) => {
  const rows = rowsOf(container)
  fireEvent.click(rows[0])
  fireEvent.click(rows[2], { ctrlKey: true })
}

describe('App', () => {
  it('挂载时打开初始工作区', async () => {
    const bridge = bridgeWith()
    render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => expect(bridge.lastCall('workspace/open')).toEqual({ root: '/tmp/repo' }))
  })

  it('工具栏回填当前根路径', async () => {
    render(<App bridge={bridgeWith()} initialRoot="/tmp/repo" />)
    await waitFor(() =>
      expect((screen.getByLabelText('工作区路径') as HTMLInputElement).value).toBe('/tmp/repo'))
  })

  it('点击载入按钮用新路径重新打开', async () => {
    const bridge = bridgeWith()
    render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))
    fireEvent.change(screen.getByLabelText('工作区路径'), { target: { value: '/tmp/other' } })
    fireEvent.click(screen.getByText('载入'))
    await waitFor(() => expect(bridge.lastCall('workspace/open')).toEqual({ root: '/tmp/other' }))
  })

  it('解析失败时显示只读横幅并列出行号', async () => {
    const bridge = bridgeWith({ parseErrors: [{ line: 7, message: '未知标签 [planned]' }] })
    render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => expect(screen.getByText(/只读模式/)).toBeTruthy())
    expect(screen.getByText(/第 7 行：未知标签 \[planned\]/)).toBeTruthy()
  })

  it('只读模式下保存按钮禁用', async () => {
    const bridge = bridgeWith({ parseErrors: [{ line: 1, message: 'x' }] })
    render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => expect((screen.getByText('保存') as HTMLButtonElement).disabled).toBe(true))
  })

  it('只读模式下面板控件被禁用', async () => {
    const bridge = bridgeWith({ parseErrors: [{ line: 1, message: 'x' }] })
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))
    clickFirstRow(container)
    await waitFor(() => screen.getByLabelText('注释'))
    expect((screen.getByLabelText('注释') as HTMLTextAreaElement).disabled).toBe(true)
    expect((screen.getByLabelText('语义角色') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText('约束强度') as HTMLSelectElement).disabled).toBe(true)
  })

  it('无未保存改动时保存按钮禁用', async () => {
    render(<App bridge={bridgeWith()} initialRoot="/tmp/repo" />)
    await waitFor(() => expect((screen.getByText('保存') as HTMLButtonElement).disabled).toBe(true))
  })

  it('搜索框把词传给树', async () => {
    render(<App bridge={bridgeWith()} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('搜索'))
    fireEvent.change(screen.getByLabelText('搜索'), { target: { value: 'core' } })
    expect((screen.getByLabelText('搜索') as HTMLInputElement).value).toBe('core')
  })

  it('面板改动经 bridge 发出 spec/annotate 并刷新树', async () => {
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    // 直接触发 App 暴露给树的选中回调，避开虚拟列表的测量问题
    clickFirstRow(container)
    await waitFor(() => screen.getByLabelText('注释'))

    const ta = screen.getByLabelText('注释')
    fireEvent.change(ta, { target: { value: '核心源码' } })
    fireEvent.blur(ta)

    await waitFor(() => expect(bridge.lastCall('spec/annotate')).toMatchObject({
      path: 'src', isDir: true, annotation: '核心源码',
    }))
    await waitFor(() => expect((screen.getByText('保存') as HTMLButtonElement).disabled).toBe(false))
  })

  it('点击保存调用 spec/save 并清除脏标记', async () => {
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))
    clickFirstRow(container)
    await waitFor(() => screen.getByLabelText('注释'))
    fireEvent.change(screen.getByLabelText('注释'), { target: { value: 'x' } })
    fireEvent.blur(screen.getByLabelText('注释'))
    await waitFor(() => expect((screen.getByText('保存') as HTMLButtonElement).disabled).toBe(false))

    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(bridge.calls.some(c => c.method === 'spec/save')).toBe(true))
    await waitFor(() => expect((screen.getByText('保存') as HTMLButtonElement).disabled).toBe(true))
  })

  it('收到 external-change 事件时提示可重载', async () => {
    const bridge = bridgeWith()
    render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))
    act(() => { bridge.emit('external-change', {}) })
    await waitFor(() => expect(screen.getByText(/已在外部修改/)).toBeTruthy())
  })

  it('横幅出现时会重新测量头部高度', async () => {
    // 用同一个根重新载入，第二次返回 parseErrors，只触发只读横幅这一条状态变化——
    // 不掺入 externalChange，这样测试才是专门盯着 parseErrors 这个依赖项的。
    let opens = 0
    const bridge = new FakeBridge({
      'workspace/open': () => {
        opens += 1
        return opens === 1 ? openResult() : openResult({ parseErrors: [{ line: 1, message: 'x' }] })
      },
      'spec/annotate': () => ({ tree: tree(FIXTURE), dirty: true, groups: [G1] }),
      'spec/move': () => ({ tree: tree(FIXTURE), dirty: true, groups: [G1] }),
      'spec/save': () => ({ written: true }),
      'tree/expand': () => ({ tree: tree(FIXTURE) }),
    } as never)

    render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect')
    const before = spy.mock.calls.length

    fireEvent.click(screen.getByText('载入'))
    await waitFor(() => expect(screen.getByText(/只读模式/)).toBeTruthy())

    expect(spy.mock.calls.length).toBeGreaterThan(before)
    spy.mockRestore()
  })

  it('有未保存改动时点重新载入会先确认，取消则不重载', async () => {
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))
    clickFirstRow(container)
    await waitFor(() => screen.getByLabelText('注释'))
    fireEvent.change(screen.getByLabelText('注释'), { target: { value: 'x' } })
    fireEvent.blur(screen.getByLabelText('注释'))
    await waitFor(() => expect((screen.getByText('保存') as HTMLButtonElement).disabled).toBe(false))

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    act(() => { bridge.emit('external-change', {}) })
    await waitFor(() => screen.getByText(/已在外部修改/))

    const openCallsBefore = bridge.calls.filter(c => c.method === 'workspace/open').length
    fireEvent.click(screen.getByText('重新载入'))

    expect(confirmSpy).toHaveBeenCalled()
    expect(bridge.calls.filter(c => c.method === 'workspace/open').length).toBe(openCallsBefore)
    confirmSpy.mockRestore()
  })

  it('确认后正常重载', async () => {
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))
    clickFirstRow(container)
    await waitFor(() => screen.getByLabelText('注释'))
    fireEvent.change(screen.getByLabelText('注释'), { target: { value: 'x' } })
    fireEvent.blur(screen.getByLabelText('注释'))
    await waitFor(() => expect((screen.getByText('保存') as HTMLButtonElement).disabled).toBe(false))

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    act(() => { bridge.emit('external-change', {}) })
    await waitFor(() => screen.getByText(/已在外部修改/))

    const openCallsBefore = bridge.calls.filter(c => c.method === 'workspace/open').length
    fireEvent.click(screen.getByText('重新载入'))

    expect(confirmSpy).toHaveBeenCalled()
    await waitFor(() => expect(bridge.calls.filter(c => c.method === 'workspace/open').length)
      .toBe(openCallsBefore + 1))
    confirmSpy.mockRestore()
  })

  it('没有未保存改动时重新载入不弹确认', async () => {
    const bridge = bridgeWith()
    render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true) // 哨兵值：不该被调用
    act(() => { bridge.emit('external-change', {}) })
    await waitFor(() => screen.getByText(/已在外部修改/))

    const openCallsBefore = bridge.calls.filter(c => c.method === 'workspace/open').length
    fireEvent.click(screen.getByText('重新载入'))

    expect(confirmSpy).not.toHaveBeenCalled()
    await waitFor(() => expect(bridge.calls.filter(c => c.method === 'workspace/open').length)
      .toBe(openCallsBefore + 1))
    confirmSpy.mockRestore()
  })

  it('tree/expand 失败时显示错误横幅', async () => {
    const bridge = new FakeBridge({
      'workspace/open': () => openResult({ tree: tree([UNSCANNED]) }),
      'tree/expand': () => { throw new Error('展开失败') },
    } as never)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    clickFirstRow(container)

    await waitFor(() => expect(screen.getByText('展开失败')).toBeTruthy())
  })

  it('单击文件后中间栏请求并显示其内容', async () => {
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    fireEvent.click(rowsOf(container)[2])   // README.md

    await waitFor(() => expect(bridge.lastCall('file/read')).toEqual({ path: 'README.md' }))
    await waitFor(() => expect(container.querySelectorAll('.fs-code-line')).toHaveLength(2))
    // 按 .fs-code-text 断言而不是 getByText：Prism 可能把某些词切成子 token，
    // 逐行的 code 元素文本内容才是不受语法着色影响的稳定断言点
    expect(container.querySelectorAll('.fs-code-text')[1].textContent).toBe('world')
  })

  it('单击目录不请求文件内容', async () => {
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    fireEvent.click(rowsOf(container)[0])   // src/
    await waitFor(() => screen.getByLabelText('注释'))

    expect(bridge.calls.some(c => c.method === 'file/read')).toBe(false)
  })

  it('ctrl 多选后右栏切换为分组面板', async () => {
    const { container } = render(<App bridge={bridgeWith()} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    selectTwoUnrelated(container)

    await waitFor(() => expect(screen.getByText(/已选中 2 项/)).toBeTruthy())
  })

  it('分组面板提交后发出 spec/setGroup，成员就是当前选中集', async () => {
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    selectTwoUnrelated(container)
    const ta = await screen.findByLabelText('分组注释')
    fireEvent.change(ta, { target: { value: '这两个是一体的' } })
    fireEvent.blur(ta)

    await waitFor(() => expect(bridge.lastCall('spec/setGroup')).toMatchObject({
      id: null, text: '这两个是一体的', members: ['src', 'README.md'],
    }))
  })

  it('选中集恰好等于某个既有分组时，回填它并以它的 id 提交', async () => {
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    const rows = rowsOf(container)
    fireEvent.click(rows[0])                       // src
    fireEvent.click(rows[1], { ctrlKey: true })    // docs —— 与 g1 的成员集相同

    const ta = await screen.findByLabelText('分组注释')
    // 回填证明 groups 真的过了桥：ViewNode.groups 只有 id，text 只能来自 OpenResult.groups
    expect((ta as HTMLTextAreaElement).value).toBe('一体的两个目录')
    expect((screen.getByLabelText('分组名') as HTMLInputElement).value).toBe('g1')

    fireEvent.change(ta, { target: { value: '改过的注释' } })
    fireEvent.blur(ta)

    await waitFor(() => expect(bridge.lastCall('spec/setGroup')).toMatchObject({
      id: 'g1', text: '改过的注释',
    }))
  })

  it('点击行尾的分组色点，选中该分组的全部成员并进入分组面板', async () => {
    const { container } = render(<App bridge={bridgeWith()} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    const dot = container.querySelector('.fs-group-dot')
    expect(dot, '固定树夹具里至少要有一个节点带 groups').toBeTruthy()
    fireEvent.click(dot!)

    await waitFor(() => expect(screen.getByText(/已选中 2 项/)).toBeTruthy())
    expect(screen.getByText('src')).toBeTruthy()
    expect(screen.getByText('docs')).toBeTruthy()
  })

  it('单选时注释面板列出所属分组，点击它切到该分组的成员', async () => {
    const { container } = render(<App bridge={bridgeWith()} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    clickFirstRow(container)                       // src 属于 g1
    await waitFor(() => screen.getByLabelText('注释'))
    // 注释首行来自 Group.text，ViewNode.groups 里没有——这一条守着 Step 0 的整条数据通路
    expect(screen.getByText('一体的两个目录')).toBeTruthy()

    fireEvent.click(screen.getByText('g1'))

    await waitFor(() => expect(screen.getByText(/已选中 2 项/)).toBeTruthy())
  })

  it('从分组面板移除成员后退回单选的注释面板', async () => {
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    selectTwoUnrelated(container)
    await screen.findByLabelText('分组注释')

    fireEvent.click(screen.getByLabelText('从选中集移除 README.md'))

    await waitFor(() => expect(screen.getByLabelText('注释')).toBeTruthy())
    // 这是"新建态"（选中集不等于任何既有分组），移除只该改选中集，不该去写谁的成员
    expect(bridge.calls.some(c => c.method === 'spec/setGroup')).toBe(false)
  })

  it('shift 区间跨越已展开的子节点', async () => {
    const { container } = render(<App bridge={bridgeWith()} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    fireEvent.click(rowsOf(container)[0])           // 点 src：既选中它，也把它展开
    await waitFor(() => expect(rowsOf(container)).toHaveLength(5))

    fireEvent.click(rowsOf(container)[4], { shiftKey: true })   // README.md

    // 区间以"当前可见顺序"为准：src、src/a.ts、src/b.ts、docs、README.md 共 5 项。
    // 若 App 不跟踪展开态，可见顺序会退化成 3 个顶层节点，这里就会是"已选中 3 项"。
    await waitFor(() => expect(screen.getByText(/已选中 5 项/)).toBeTruthy())
  })

  it('拖动左侧分隔条改变树栏宽度', async () => {
    const { container } = render(<App bridge={bridgeWith()} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))
    const pane = container.querySelector('.fs-pane-tree') as HTMLElement
    const before = pane.style.flexBasis
    const splitter = container.querySelectorAll('.fs-splitter')[0] as HTMLElement
    // 必须自己造 MouseEvent，不能用 fireEvent.pointerDown：jsdom 没有实现 PointerEvent，
    // testing-library 退化成 window.Event 构造，clientX/pointerId 全被丢掉（实测按下时
    // 收到的合成事件里 clientX 是 undefined），起点坐标成了 NaN，拖多远宽度都不会变——
    // 一条永远绿的假测试。用 MouseEvent 冒泡到 React 的根监听器则能带上 clientX。
    fireEvent(splitter, new MouseEvent('pointerdown', { clientX: 260, bubbles: true }))
    fireEvent(splitter, new MouseEvent('pointermove', { clientX: 320 }))
    fireEvent(splitter, new MouseEvent('pointerup', {}))
    expect(before).toBe('260px')
    expect(pane.style.flexBasis).toBe('320px')
  })

  it('file/read 失败时显示错误横幅', async () => {
    const bridge = bridgeWith()
    bridge.setHandler('file/read', () => { throw new Error('读取炸了') })
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    fireEvent.click(rowsOf(container)[2])

    await waitFor(() => expect(screen.getByText(/读取炸了/)).toBeTruthy())
  })

  it('spec/setGroup 失败时显示错误横幅', async () => {
    const bridge = bridgeWith()
    bridge.setHandler('spec/setGroup', () => { throw new Error('建组炸了') })
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    selectTwoUnrelated(container)
    const ta = await screen.findByLabelText('分组注释')
    fireEvent.change(ta, { target: { value: 'x' } })
    fireEvent.blur(ta)

    await waitFor(() => expect(screen.getByText(/建组炸了/)).toBeTruthy())
  })

  it('单击目录时中间栏显示该目录的子项统计', async () => {
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    fireEvent.click(rowsOf(container)[0])   // src/，夹具里有两个子项

    await waitFor(() => expect(screen.getByText(/这是一个目录，共 2 项/)).toBeTruthy())
    expect(bridge.calls.some(c => c.method === 'file/read')).toBe(false)
  })

  // 注意这条断言的**只是**"代码视图被目录统计取代"。它无法侦测 handleSelect 里那句
  // setContent(null) 被删掉——ContentPane 遇到 isDir 会在读 content 之前就 return，
  // 陈旧内容在目录形态下结构上不可见（已用单点变异证实：删掉那句，本用例照样绿）。
  // 那句是防御性的，理由写在 App.tsx 的注释里，不在这里假装被测到。
  it('从文件切到目录时，中间栏由代码视图换成目录统计', async () => {
    const { container } = render(<App bridge={bridgeWith()} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    fireEvent.click(rowsOf(container)[2])   // README.md
    await waitFor(() => expect(container.querySelectorAll('.fs-code-line')).toHaveLength(2))

    fireEvent.click(rowsOf(container)[0])   // src/

    await waitFor(() => expect(container.querySelector('.fs-content-path')?.textContent).toBe('src'))
    expect(container.querySelectorAll('.fs-code-line')).toHaveLength(0)
  })

  it('搜索过滤生效时，shift 区间只覆盖屏幕上还在的行', async () => {
    const { container } = render(<App bridge={bridgeWith()} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('搜索'))

    // "docs" 里没有 r，被过滤掉；src 与 README.md 留下。a.ts/b.ts 同样不含 r，
    // 所以 src 展开后它们也不会出现——屏幕上自始至终只有两行。
    fireEvent.change(screen.getByLabelText('搜索'), { target: { value: 'r' } })
    await waitFor(() => expect(rowsOf(container)).toHaveLength(2))

    fireEvent.click(rowsOf(container)[0])                      // src
    expect(rowsOf(container)).toHaveLength(2)
    fireEvent.click(rowsOf(container)[1], { shiftKey: true })  // README.md

    // 所见即所选：屏幕上就两行，区间不能把被过滤掉的 docs / 未显示的 a.ts、b.ts 卷进来，
    // 那些路径会随下一次提交写进用户的 .folderspec.md。
    await waitFor(() => expect(screen.getByText(/已选中 2 项/)).toBeTruthy())
  })

  it('从既有分组的成员列表里移除一项，收缩的是那个分组而不是分叉出新分组', async () => {
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    const rows = rowsOf(container)
    fireEvent.click(rows[0])                       // src
    fireEvent.click(rows[1], { ctrlKey: true })    // docs —— 选中集恰好等于 g1
    await screen.findByLabelText('分组注释')

    fireEvent.click(screen.getByLabelText('从选中集移除 docs'))

    // 带着 g1 的 id 提交剩余成员；若只改选中集，下一次失焦会以 id: null 新建一个分组，
    // 用户看着在编辑 g1，实际分叉出了第二个分组，g1 原封不动。
    await waitFor(() => expect(bridge.lastCall('spec/setGroup')).toMatchObject({
      id: 'g1', members: ['src'],
    }))
  })

  it('先点的大文件晚回来时，不会盖掉后点文件的内容', async () => {
    let resolveSlow!: (v: FileReadResult) => void
    const bridge: Bridge = {
      request: (async (method: string, params: { path?: string }) => {
        if (method === 'workspace/open') return openResult()
        if (method === 'file/read') {
          if (params.path === 'src/a.ts') return new Promise(res => { resolveSlow = res })
          return { kind: 'text', text: 'README 的内容' }
        }
        throw new Error(`本用例未配置 ${method}`)
      }) as Bridge['request'],
      on: () => () => {},
    }

    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    fireEvent.click(rowsOf(container)[0])                       // 展开 src
    await waitFor(() => expect(rowsOf(container)).toHaveLength(5))
    fireEvent.click(rowsOf(container)[1])                       // src/a.ts —— 慢
    fireEvent.click(rowsOf(container)[4])                       // README.md —— 快

    await waitFor(() =>
      expect(container.querySelector('.fs-code-text')?.textContent).toBe('README 的内容'))

    // 宿主对每条消息各起一个异步任务、不排队（cli/src/server.ts），先发的可以后到
    await act(async () => { resolveSlow({ kind: 'text', text: 'a.ts 的内容' }) })

    expect(container.querySelector('.fs-content-path')?.textContent).toBe('README.md')
    expect(container.querySelector('.fs-code-text')?.textContent).toBe('README 的内容')
  })

  it('搜索词是纯空白时不算过滤，shift 区间照常成立', async () => {
    const { container } = render(<App bridge={bridgeWith()} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('搜索'))

    // react-arborist 的 isFiltered 是 searchTerm?.trim()，纯空白等于没搜索。
    // App 若自己按 searchTerm === '' 判定并把未 trim 的原串拿去匹配，就会认为在过滤、
    // 且没有任何节点命中，区间静默退化成单选——两边对"算不算在过滤"的判断必须一致。
    fireEvent.change(screen.getByLabelText('搜索'), { target: { value: '   ' } })
    await waitFor(() => expect(rowsOf(container)).toHaveLength(3))

    fireEvent.click(rowsOf(container)[0])                        // src，展开
    await waitFor(() => expect(rowsOf(container)).toHaveLength(5))
    fireEvent.click(rowsOf(container)[4], { shiftKey: true })    // README.md

    await waitFor(() => expect(screen.getByText(/已选中 5 项/)).toBeTruthy())
  })

  it('过滤态下折叠一个目录后，shift 区间不会把屏幕上没有的行卷进来', async () => {
    const { container } = render(<App bridge={bridgeWith()} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('搜索'))

    // 搜 a：src 自己不含 a，但子项 a.ts 含，按 markMatch 作为祖先留下；docs、b.ts 落选。
    // 过滤态下 react-arborist 让所有目录默认展开（tree-api 的 isOpen：filtered 表默认 true）
    fireEvent.change(screen.getByLabelText('搜索'), { target: { value: 'a' } })
    await waitFor(() => expect(rowsOf(container)).toHaveLength(3))

    fireEvent.click(rowsOf(container)[0])      // 过滤态下点 src 是**折叠**
    await waitFor(() => expect(rowsOf(container)).toHaveLength(2))
    fireEvent.click(rowsOf(container)[1], { shiftKey: true })   // README.md

    // 屏幕上只剩 src 与 README.md；src/a.ts 已被折叠起来，绝不能进成员列表
    await waitFor(() => expect(screen.getByText(/已选中 2 项/)).toBeTruthy())
    expect(screen.queryByText('src/a.ts')).toBeNull()
  })

  it('过滤态下不折叠，shift 区间照样成立而不是退化成单选', async () => {
    const { container } = render(<App bridge={bridgeWith()} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('搜索'))

    fireEvent.change(screen.getByLabelText('搜索'), { target: { value: 'a' } })
    await waitFor(() => expect(rowsOf(container)).toHaveLength(3))

    fireEvent.click(rowsOf(container)[1])                        // src/a.ts
    fireEvent.click(rowsOf(container)[2], { shiftKey: true })    // README.md

    // 两行都在屏幕上，区间必须成立。过去 App 自己算可见顺序时，src 不在 openPaths 里，
    // src/a.ts 压根不在顺序表中，applyClick 的 indexOf 落空、静默退化成单选。
    await waitFor(() => expect(screen.getByText(/已选中 2 项/)).toBeTruthy())
  })

  it('收缩既有分组后，面板仍显示该分组的名字与注释', async () => {
    const bridge = groupBridge([G3])
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    selectAllThree(container)
    const ta = await screen.findByLabelText('分组注释')
    expect((ta as HTMLTextAreaElement).value).toBe('一体的三个')

    fireEvent.click(screen.getByLabelText('从选中集移除 README.md'))

    await waitFor(() => expect(screen.getByText(/已选中 2 项/)).toBeTruthy())
    // 编辑目标仍然是 g1，字段不该被清空
    expect((screen.getByLabelText('分组注释') as HTMLTextAreaElement).value).toBe('一体的三个')
    expect((screen.getByLabelText('分组名') as HTMLInputElement).value).toBe('g1')
  })

  it('收缩后紧接着改约束强度，提交的注释不是空串', async () => {
    const bridge = groupBridge([G3])
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    selectAllThree(container)
    await screen.findByLabelText('分组注释')
    fireEvent.click(screen.getByLabelText('从选中集移除 README.md'))
    await waitFor(() => expect(screen.getByText(/已选中 2 项/)).toBeTruthy())

    fireEvent.change(screen.getByLabelText('约束强度'), { target: { value: 'warning' } })

    // text 为空串会被 core 当成"删除该分组"（spec-edit.ts 的「清空 text 即删除」），
    // 用户写的注释就此消失——本项目唯一那条红线
    await waitFor(() => expect(bridge.lastCall('spec/setGroup')).toMatchObject({
      id: 'g1', text: '一体的三个', severity: 'warning',
    }))
  })

  it('连续两次移除成员，契约里的成员与界面一致', async () => {
    const bridge = groupBridge([G3], 30)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    selectAllThree(container)
    await screen.findByLabelText('分组注释')

    // 第二次点击时第一次的响应还没回来，必须以最新的成员集为基准，不能各自从渲染快照出发
    fireEvent.click(screen.getByLabelText('从选中集移除 README.md'))
    fireEvent.click(screen.getByLabelText('从选中集移除 docs'))

    await waitFor(() => expect(screen.getByLabelText('注释')).toBeTruthy())   // 只剩 1 项
    await waitFor(() => expect(bridge.groupsNow()[0].members).toEqual(['src']))
  })

  it('分组收缩到只剩一个成员：注释保住，但此后再也进不了分组面板', async () => {
    const bridge = groupBridge([{ id: 'g1', members: ['src', 'docs'], text: '两个一体' }])
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    const rows = rowsOf(container)
    fireEvent.click(rows[0])
    fireEvent.click(rows[1], { ctrlKey: true })
    await screen.findByLabelText('分组注释')

    fireEvent.click(screen.getByLabelText('从选中集移除 docs'))

    await waitFor(() => expect(bridge.groupsNow()[0].members).toEqual(['src']))
    expect(bridge.groupsNow()[0].text).toBe('两个一体')          // 注释没丢
    await waitFor(() => expect(screen.getByLabelText('注释')).toBeTruthy())
    expect(screen.getByText('两个一体')).toBeTruthy()             // §5.4.2 的入口还列着它

    fireEvent.click(screen.getByText('g1'))

    // 单成员分组：点入口只会选中 1 项，右栏仍是单节点面板，进不去分组面板。
    // 这是钉住"当前实际行为"的用例，不是在主张它理想——判断见报告。
    await waitFor(() => expect(screen.getByLabelText('注释')).toBeTruthy())
    expect(screen.queryByLabelText('分组注释')).toBeNull()
  })

  // 下面两条盯的是 contentReqRef 的自增，而不是 setContent(null)。
  // 走的是**失败**路径：晚到的拒绝会调 setError 弹出错误横幅，而那时用户早已切走——
  // 成功路径不可观测（ContentPane 遇到 isDir 或 node 为 null 都在读 content 之前就
  // return），失败路径可观测。
  it('切到目录后，先前那次读取失败不再弹错误横幅', async () => {
    let rejectSlow!: (e: Error) => void
    const bridge: Bridge = {
      request: (async (method: string) => {
        if (method === 'workspace/open') return openResult()
        if (method === 'file/read') return new Promise((_, rej) => { rejectSlow = rej })
        throw new Error(`本用例未配置 ${method}`)
      }) as Bridge['request'],
      on: () => () => {},
    }
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    fireEvent.click(rowsOf(container)[2])            // README.md，慢
    fireEvent.click(rowsOf(container)[0])            // 切到 src/ 目录
    await waitFor(() => expect(screen.getByText(/这是一个目录/)).toBeTruthy())

    await act(async () => { rejectSlow(new Error('这条读取早就该作废了')) })

    expect(screen.queryByText(/这条读取早就该作废了/)).toBeNull()
  })

  it('换工作区后，先前那次读取失败不再弹错误横幅', async () => {
    let rejectSlow!: (e: Error) => void
    let opens = 0
    const bridge: Bridge = {
      request: (async (method: string) => {
        if (method === 'workspace/open') { opens += 1; return openResult() }
        if (method === 'file/read') return new Promise((_, rej) => { rejectSlow = rej })
        throw new Error(`本用例未配置 ${method}`)
      }) as Bridge['request'],
      on: () => () => {},
    }
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    fireEvent.click(rowsOf(container)[2])            // README.md，慢
    fireEvent.click(screen.getByText('载入'))        // 换工作区
    await waitFor(() => expect(opens).toBe(2))

    await act(async () => { rejectSlow(new Error('上一个工作区的读取')) })

    expect(screen.queryByText(/上一个工作区的读取/)).toBeNull()
  })
})
