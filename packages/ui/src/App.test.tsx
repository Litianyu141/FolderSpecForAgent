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
const groupBridge = (
  initial: Group[], delayMs = 20, failNth: number | null = null, nodes: ViewNode[] = FIXTURE,
) => {
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
      if (method === 'workspace/open') return openResult({ groups, tree: tree(nodes) })
      if (method === 'file/read') return { kind: 'text', text: 'hello\nworld' }
      if (method === 'spec/annotate') return { tree: tree(nodes), dirty: true, groups }
      if (method === 'spec/setGroup') {
        await new Promise(r => setTimeout(r, delayMs))
        // 第 failNth 次写入失败。挑第几次很重要：串行链上后一次的失败与前一次的失败
        // 走的不是同一条路径（前者要回滚到"上一次落地的那份"，后者回滚到最初那份）。
        if (failNth !== null && calls.filter(c => c.method === 'spec/setGroup').length === failNth) {
          throw new Error('写失败了')
        }
        const id = params.id as string | null
        const members = params.members as string[]
        // core 的 setGroup 返回的是**落地后**的 id：给了 name 就是改名后的那个
        // （spec-edit 的 targetId）。桩必须照做，否则改名后的链路根本测不到。
        const landedId = typeof params.name === 'string' && params.name !== '' ? params.name : (id ?? 'group')
        groups = groups.map(g => {
          if (g.id !== id) return g
          const next: Group = {
            ...g,
            members: [...members],
            ...(typeof params.name === 'string' && params.name !== '' ? { id: params.name } : {}),
            ...(params.text !== undefined ? { text: params.text as string } : {}),
          }
          // severity 是三态，桩必须照 core 来（spec-edit.ts 的 setGroup）：
          // undefined = 不变、null = `delete existing.severity`、其余 = 设值。
          // 旧桩写的是 `params.severity ? {...} : {}`——null 被当成"不变"，于是
          // "面板把一个陈旧的空值提交成 null、把用户设好的强度删掉"这类缺陷
          // 在桩上完全看不出来，契约断言照样绿。
          if (params.severity === null) delete next.severity
          else if (params.severity !== undefined) next.severity = params.severity as Severity
          return next
        })
        return { tree: tree(nodes), dirty: true, groups, id: landedId }
      }
      throw new Error(`本用例未配置 ${method}`)
    }) as Bridge['request'],
  }
  return self as typeof self & Bridge
}

/** 分组面板此刻**显示**的成员列表。断言"所见即所写"时，这一份就是"所见"那一半 */
const memberPathsOf = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('.fs-member-path')).map(e => e.textContent)

/**
 * 让串行链把当前这一步真的发出去。
 *
 * 真实用户的两次点击之间必然隔着宏任务，链条上排队的微任务早就跑过了，请求确实在途；
 * 而测试里两条 fireEvent 之间栈根本没空过，不主动让一次微任务，第二次点击会赶在
 * 请求发出**之前**改掉编辑目标，整步在闸口就被作废——那样测的是另一条路径，
 * "在途窗口"根本没被触发。
 */
const flushChain = () => act(async () => { await Promise.resolve() })

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

  it('改名之后再移除成员，收缩落在改名后的那个分组上', async () => {
    const bridge = groupBridge([G3])
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    selectAllThree(container)
    await screen.findByLabelText('分组注释')
    fireEvent.click(screen.getByLabelText('从选中集移除 README.md'))
    await waitFor(() => expect(screen.getByText(/已选中 2 项/)).toBeTruthy())

    const nameInput = screen.getByLabelText('分组名')
    fireEvent.change(nameInput, { target: { value: '核心' } })
    fireEvent.blur(nameInput)
    await waitFor(() => expect(bridge.groupsNow()[0].id).toBe('核心'))

    fireEvent.click(screen.getByLabelText('从选中集移除 docs'))

    // 缓存的 id 若还停在 'g1'，core 找不到该分组会走「清空即删除」的早退分支——
    // 对不存在的分组是空操作，且照样返回成功。界面收缩了，契约纹丝不动。
    await waitFor(() => expect(bridge.groupsNow()[0].members).toEqual(['src']))
    expect(bridge.groupsNow()[0].id).toBe('核心')
  })

  it('新建态连续两次移除，被移除的成员不会复活', async () => {
    // groups 为空 → 选中集不对应任何既有分组，走新建态
    const bridge = groupBridge([])
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    selectAllThree(container)
    await screen.findByLabelText('分组注释')

    fireEvent.click(screen.getByLabelText('从选中集移除 README.md'))
    fireEvent.click(screen.getByLabelText('从选中集移除 docs'))

    // 第二次若从渲染快照出发，rest 会变回 ['src','README.md']，被移除的 README.md 复活
    await waitFor(() => expect(screen.getByLabelText('注释')).toBeTruthy())
    expect(screen.queryByText(/已选中/)).toBeNull()
  })

  it('shift 点在已展开的目录行上，不折叠它，也不把它的子项选进来', async () => {
    const { container } = render(<App bridge={bridgeWith()} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    fireEvent.click(rowsOf(container)[0])                     // src/ 展开
    await waitFor(() => expect(rowsOf(container)).toHaveLength(5))
    fireEvent.click(rowsOf(container)[4])                     // README.md，落锚点

    fireEvent.click(rowsOf(container)[0], { shiftKey: true }) // shift 点回已展开的 src/

    await waitFor(() => expect(screen.getByText(/已选中 5 项/)).toBeTruthy())
    // 带修饰键的点击不该顺手折叠。若折叠了，屏幕只剩 3 行，而选中集仍是 5 项——
    // src/a.ts、src/b.ts 已经不在屏幕上却进了成员集，正是 §5.3 要防的
    expect(rowsOf(container)).toHaveLength(5)
  })

  it('收缩在途时改约束强度，提交的成员是收缩后的那一份', async () => {
    const bridge = groupBridge([G3], 40)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    selectAllThree(container)
    await screen.findByLabelText('分组注释')

    fireEvent.click(screen.getByLabelText('从选中集移除 README.md'))
    // 不等收缩落地就改约束强度：此刻 selection 还是收缩前那三项，
    // 拿它去提交会把刚移除的 README.md 又写回契约
    fireEvent.change(screen.getByLabelText('约束强度'), { target: { value: 'warning' } })

    await waitFor(() => expect(bridge.lastCall('spec/setGroup')).toMatchObject({ severity: 'warning' }))
    expect(bridge.lastCall('spec/setGroup')).toMatchObject({ members: ['src', 'docs'] })
  })

  it('串行链里前一次写失败，后一次不会带着累积结果生效', async () => {
    const bridge = groupBridge([G3], 20, 1)      // 第一次 setGroup 抛错
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    selectAllThree(container)
    await screen.findByLabelText('分组注释')

    fireEvent.click(screen.getByLabelText('从选中集移除 README.md'))
    fireEvent.click(screen.getByLabelText('从选中集移除 docs'))

    await waitFor(() => expect(screen.getByText(/写失败了/)).toBeTruthy())

    // 数调用次数是确定的、不依赖桩的延迟：request() 在 await 之前就把调用记进 calls，
    // 所以第二段链条只要**启动**过就会留下第二条记录。
    // （第一版这条用例只断言契约与界面，在横幅刚出现时第二段还没跑完，于是恒绿——
    //   典型的"夹具触发不到要防的路径"，已改掉。）
    expect(bridge.calls.filter(c => c.method === 'spec/setGroup')).toHaveLength(1)

    // 再把可能存在的第二段彻底跑完，确认提示与事实一致：报了失败，两边就都不能动
    await act(async () => { await new Promise(r => setTimeout(r, 60)) })
    expect(bridge.groupsNow()[0].members).toEqual(['src', 'docs', 'README.md'])
    expect(screen.getByText(/已选中 3 项/)).toBeTruthy()
  })

  // ── 面板显示与写入是同一个真源（pending） ────────────────────────────────
  //
  // 过去 pendingRef 只管**写入**，面板显示读的是 selection.selected，而 selection
  // 要等响应落地才更新。于是在途那 20–60ms 里两者发散：面板上列着三项，发出去的
  // members 只有两项。方向是"写得比面板少"，少的正是刚被点掉的那一个，没有把用户想留
  // 的写丢；受损的是"所见即所写"这条可审计性——用户看着三项按下提交，契约里落了两项。

  it('移除成员后面板立刻少一项，不等写入落地', async () => {
    const bridge = groupBridge([G3], 60)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    selectAllThree(container)
    await screen.findByLabelText('分组注释')
    expect(memberPathsOf(container)).toEqual(['src', 'docs', 'README.md'])

    fireEvent.click(screen.getByLabelText('从选中集移除 README.md'))

    // 这一行故意不 await：桩延迟 60ms，此刻写入必然还在途
    expect(memberPathsOf(container)).toEqual(['src', 'docs'])
    // 反过来确认夹具真的处在"在途"那一帧，而不是响应早就回来了
    expect(bridge.groupsNow()[0].members).toEqual(['src', 'docs', 'README.md'])
  })

  it('提交那一刻面板上显示的成员，就是写进契约的那一份', async () => {
    const bridge = groupBridge([G3], 60)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    selectAllThree(container)
    await screen.findByLabelText('分组注释')
    fireEvent.click(screen.getByLabelText('从选中集移除 README.md'))

    // 收缩还在途时就改约束强度：这一刻面板上是什么，契约里就得是什么
    const shownNow = memberPathsOf(container)
    expect(shownNow).toEqual(['src', 'docs'])
    fireEvent.change(screen.getByLabelText('约束强度'), { target: { value: 'warning' } })

    await waitFor(() =>
      expect(bridge.lastCall('spec/setGroup')).toMatchObject({ severity: 'warning' }))
    expect(bridge.lastCall('spec/setGroup')).toMatchObject({ members: shownNow })
  })

  it('分组写入失败时，被移除的成员回到面板列表上', async () => {
    const bridge = groupBridge([G3], 20, 1)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    selectAllThree(container)
    await screen.findByLabelText('分组注释')

    fireEvent.click(screen.getByLabelText('从选中集移除 README.md'))
    expect(memberPathsOf(container)).toEqual(['src', 'docs'])   // 乐观显示

    // 乐观更新的代价：写失败就必须把显示同步退回去，否则用户会以为已经生效
    await waitFor(() => expect(screen.getByText(/写失败了/)).toBeTruthy())
    await waitFor(() =>
      expect(memberPathsOf(container)).toEqual(['src', 'docs', 'README.md']))
  })

  // ── 在途窗口里用户的改选不能被无声撤销 ────────────────────────────────────
  //
  // 写成功后那一段回调（把收缩结果提交进 selection）跑在 await **之后**，而闸口只在
  // 步骤开头判过一次。那 20–60ms 里用户完全插得进来，插进来之后落地的回调会把他刚做的
  // 改选盖掉——右栏自己跳回分组面板、编辑目标被换成上一个分组，随后写的注释落在错的
  // 分组上并覆盖它原有的注释。下面三条分别对应普通单击 / ctrl 加选 / 点另一个分组的色点。

  it('收缩在途时普通单击别的节点，写入落地后右栏不会被拽回分组面板', async () => {
    const bridge = groupBridge([G3], 60)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    selectAllThree(container)
    await screen.findByLabelText('分组注释')
    fireEvent.click(screen.getByLabelText('从选中集移除 README.md'))
    await flushChain()
    expect(bridge.calls.filter(c => c.method === 'spec/setGroup')).toHaveLength(1)

    fireEvent.click(rowsOf(container)[1])          // src/a.ts，放弃多选
    expect(screen.queryByLabelText('分组注释')).toBeNull()

    await waitFor(() => expect(bridge.groupsNow()[0].members).toEqual(['src', 'docs']))
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })

    expect(screen.queryByLabelText('分组注释')).toBeNull()
    expect(container.querySelector('.fs-panel-path')?.textContent).toBe('src/a.ts')
  })

  it('收缩在途时 ctrl 加选，落地后加选不丢、被移除的成员也不复活', async () => {
    const bridge = groupBridge([G3], 60)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    selectAllThree(container)
    await screen.findByLabelText('分组注释')
    fireEvent.click(screen.getByLabelText('从选中集移除 README.md'))
    await flushChain()
    expect(bridge.calls.filter(c => c.method === 'spec/setGroup')).toHaveLength(1)

    fireEvent.click(rowsOf(container)[1], { ctrlKey: true })    // src/a.ts
    // 加选是在**面板上那一份**的基础上加，不是在尚未更新的 selection 上加，
    // 否则刚被移除的 README.md 会跟着回来
    expect(memberPathsOf(container)).toEqual(['src', 'docs', 'src/a.ts'])

    await waitFor(() => expect(bridge.groupsNow()[0].members).toEqual(['src', 'docs']))
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })

    expect(memberPathsOf(container)).toEqual(['src', 'docs', 'src/a.ts'])
  })

  it('收缩在途时点另一个分组的色点，落地后不会被拽回原分组', async () => {
    const G2: Group = { id: 'g2', members: ['README.md', 'src/a.ts'], text: '另一组' }
    const nodes = [SRC, DOCS, { ...README, groups: ['g2'] }]
    const bridge = groupBridge([G3, G2], 60, null, nodes)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    selectAllThree(container)
    await screen.findByLabelText('分组注释')
    fireEvent.click(screen.getByLabelText('从选中集移除 docs'))
    await flushChain()
    expect(bridge.calls.filter(c => c.method === 'spec/setGroup')).toHaveLength(1)

    fireEvent.click(screen.getByLabelText('选中分组 g2 的全部成员'))
    expect(memberPathsOf(container)).toEqual(['README.md', 'src/a.ts'])

    await waitFor(() => expect(bridge.groupsNow()[0].members).toEqual(['src', 'README.md']))
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })

    // 界面若在 ~60ms 后无提示地把编辑目标换回 g1，用户随后写的注释就落在 g1 上，
    // 把 g1 原有的注释覆盖掉——本项目唯一那条红线，只是入口从解析换成了时序
    expect(memberPathsOf(container)).toEqual(['README.md', 'src/a.ts'])
    expect((screen.getByLabelText('分组名') as HTMLInputElement).value).toBe('g2')
    expect((screen.getByLabelText('分组注释') as HTMLTextAreaElement).value).toBe('另一组')
  })

  it('在途写入落地时，编辑目标已经换过一轮，它不能把结果提交到新目标上', async () => {
    // 光判"pending 还在不在"不够：用户换了目标、又开始编辑**另一个**分组时 pending
    // 不为 null，旧写入落地照样会把它那一份成员提交进 selection。平时看不出来
    // （面板读的是 pending），直到新这一轮写失败、显示退回 selection —— 退到的是
    // 上一轮的成员集，一份用户在这一轮从没见过的列表。所以闸口判的是编辑会话号。
    const G2: Group = { id: 'g2', members: ['docs', 'README.md'], text: '另一组' }
    const bridge = groupBridge([G3, G2], 60, 2)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    selectAllThree(container)
    await screen.findByLabelText('分组注释')
    fireEvent.click(screen.getByLabelText('从选中集移除 README.md'))   // 第一轮：g1 收缩，在途
    await flushChain()
    expect(bridge.calls.filter(c => c.method === 'spec/setGroup')).toHaveLength(1)

    const rows = rowsOf(container)
    fireEvent.click(rows[3])                        // docs，另起一轮
    fireEvent.click(rows[4], { ctrlKey: true })     // README.md —— 恰好等于 g2
    expect((screen.getByLabelText('分组名') as HTMLInputElement).value).toBe('g2')
    fireEvent.click(screen.getByLabelText('从选中集移除 README.md'))   // 第二轮：g2 收缩

    await waitFor(() => expect(screen.getByText(/写失败了/)).toBeTruthy())
    expect(bridge.groupsNow()[0].members).toEqual(['src', 'docs'])   // 第一轮确实落地了

    // 第二轮写失败 → 显示退回这一轮开始时的那份，而不是第一轮的 [src, docs]
    await waitFor(() => expect(memberPathsOf(container)).toEqual(['docs', 'README.md']))
  })

  // ── 同成员分组的选择器（设计文档 §5.4.1）─────────────────────────────────
  //
  // 「若有多个分组的成员集完全相同，面板顶部列出这几个供选择，默认取文件中靠前的那个」。
  // 此前只做了后半句：提示写着"有 N 个分组的成员完全相同"，却没有任何切换入口。§5.5 的
  // 色点也够不着——同成员的两个分组，点哪个色点得到的选中集都一样。于是这类分组里的
  // 第二个，用户只能靠"先清空第一个的注释把它删掉"这种反直觉动作才碰得到。

  it('同成员的两个分组：点选择器切到第二个，之后的写入落在它身上', async () => {
    const SAME: Group = { id: 'g2', members: ['src', 'docs'], text: '第二个' }
    const bridge = groupBridge([G1, SAME])
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    const rows = rowsOf(container)
    fireEvent.click(rows[0])                       // src
    fireEvent.click(rows[1], { ctrlKey: true })    // docs —— 与 g1、g2 的成员集都相同

    const ta = await screen.findByLabelText('分组注释')
    expect((ta as HTMLTextAreaElement).value).toBe('一体的两个目录')   // 默认取靠前那个

    fireEvent.click(screen.getByLabelText('改为编辑分组 g2'))
    expect((screen.getByLabelText('分组注释') as HTMLTextAreaElement).value).toBe('第二个')

    fireEvent.change(ta, { target: { value: '只改第二个' } })
    fireEvent.blur(ta)

    await waitFor(() => expect(bridge.lastCall('spec/setGroup')).toMatchObject({
      id: 'g2', text: '只改第二个',
    }))
    // 另一半：靠前那个必须纹丝不动。切换目标只上抛 id、不换字段的话，用户看着 g2 的标题
    // 编辑的却是 g1 留在框里的文字，一失焦就把注释盖到对方头上——本项目唯一那条红线。
    expect(bridge.groupsNow().find(g => g.id === 'g1')!.text).toBe('一体的两个目录')
    expect(bridge.groupsNow().find(g => g.id === 'g2')!.text).toBe('只改第二个')
  })

  // 切换编辑目标必须**换编辑会话号**，不只是改 groupId。在途那笔写入是冲着旧分组去的，
  // 它落地时会执行 `setPending({ ...now, groupId: id })`（那句本身是必要的：core 可能把
  // 分组改了名）。少了会话号这道闸，那句就把编辑目标从用户刚选的 g2 无声拨回 g1，
  // 之后写的注释全落在 g1 上并覆盖它原有的注释——面板标题写着 g2，契约里动的是 g1。
  it('在途写入落地时用户已切到另一个同成员分组，编辑目标不被拨回去', async () => {
    const SAME: Group = { id: 'g2', members: ['src', 'docs'], text: '第二个' }
    const bridge = groupBridge([G1, SAME], 60)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    const rows = rowsOf(container)
    fireEvent.click(rows[0])
    fireEvent.click(rows[1], { ctrlKey: true })
    const ta = await screen.findByLabelText('分组注释')

    fireEvent.change(ta, { target: { value: '改 g1' } })
    fireEvent.blur(ta)
    await flushChain()      // 让请求真的发出去，停在"在途"那一帧
    expect(bridge.calls.filter(c => c.method === 'spec/setGroup')).toHaveLength(1)

    fireEvent.click(screen.getByLabelText('改为编辑分组 g2'))

    // 把在途那笔彻底跑完（桩延迟 60ms），让落地回调有机会去拨编辑目标
    await act(async () => { await new Promise(r => setTimeout(r, 120)) })
    expect(bridge.groupsNow().find(g => g.id === 'g1')!.text).toBe('改 g1')

    fireEvent.change(screen.getByLabelText('约束强度'), { target: { value: 'error' } })

    await waitFor(() => expect(bridge.lastCall('spec/setGroup')).toMatchObject({ id: 'g2' }))
    await waitFor(() => expect(bridge.groupsNow().find(g => g.id === 'g2')!.severity).toBe('error'))
    // 另一半：g1 不该跟着变强度
    expect(bridge.groupsNow().find(g => g.id === 'g1')!.severity).toBeUndefined()
  })

  it('切到另一个同成员分组后再移除成员，收缩的是切过去的那个', async () => {
    // 切换编辑目标必须换掉上层那份 pending.groupId，而不只是面板自己的显示。
    // 只换显示的话，下一次写入仍打在 g1 上：界面显示 g2 收缩了，契约里动的是 g1。
    const SAME: Group = { id: 'g2', members: ['src', 'docs'], text: '第二个' }
    const bridge = groupBridge([G1, SAME])
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    const rows = rowsOf(container)
    fireEvent.click(rows[0])
    fireEvent.click(rows[1], { ctrlKey: true })
    await screen.findByLabelText('分组注释')

    fireEvent.click(screen.getByLabelText('改为编辑分组 g2'))
    fireEvent.click(screen.getByLabelText('从选中集移除 docs'))

    await waitFor(() => expect(bridge.lastCall('spec/setGroup')).toMatchObject({
      id: 'g2', members: ['src'],
    }))
    await waitFor(() => expect(bridge.groupsNow().find(g => g.id === 'g2')!.members)
      .toEqual(['src']))
    expect(bridge.groupsNow().find(g => g.id === 'g1')!.members).toEqual(['src', 'docs'])
  })
  // ── 重置的触发条件错了：成员集变 ≠ 编辑目标变 ─────────────────────────────
  //
  // 面板的 name/text/severity 是 current 的**快照**，由一个按 keyOf(members) 重置的
  // effect 重新拍照。但成员集会因为用户自己的编辑动作（收缩这一组）而变，此时编辑目标
  // 并没有变——那一拍拍到的是宿主还没返回的**旧值**，快照从此陈旧，而成员键不再变化、
  // effect 不再重跑，陈旧值就一直留在框里，等下一次失焦把它写回契约。

  // 全程没有任何非常规时序：写注释 → 点某个成员的 ×（mousedown 使输入框失焦、写入派发）
  // → click 使 members 收缩。断言落在**契约的最终内容**上，而不只是发出去的 params——
  // 这条缺陷的要害正是"最终写进文件的是旧文本"。本项目唯一那条红线。
  it('写完注释紧接着移除成员：用户新写的注释不会被旧注释盖回去', async () => {
    const bridge = groupBridge([G3], 20)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    selectAllThree(container)
    const ta = await screen.findByLabelText('分组注释')
    expect((ta as HTMLTextAreaElement).value).toBe('一体的三个')

    fireEvent.change(ta, { target: { value: '用户新写的一大段注释' } })
    fireEvent.blur(ta)                                                // × 的 mousedown
    fireEvent.click(screen.getByLabelText('从选中集移除 README.md'))    // × 的 click

    await waitFor(() => expect(screen.getByText(/已选中 2 项/)).toBeTruthy())
    await waitFor(() => expect(bridge.groupsNow()[0].members).toEqual(['src', 'docs']))
    expect(bridge.groupsNow()[0].text).toBe('用户新写的一大段注释')

    // 此后**仅需一次失焦、无需任何输入**
    fireEvent.blur(screen.getByLabelText('分组注释'))
    await act(async () => { await new Promise(r => setTimeout(r, 60)) })

    expect(bridge.groupsNow()[0].text).toBe('用户新写的一大段注释')
    // 另一半：框里显示的也必须是新注释。显示与契约一分家，下一次失焦就再写回去一次。
    expect((screen.getByLabelText('分组注释') as HTMLTextAreaElement).value)
      .toBe('用户新写的一大段注释')
  })

  // 同一个根因，只差一帧：陈旧化的是 severity，而它"没碰过"的值是空串，提交时被翻译成
  // null —— core 的 `delete existing.severity`（spec-edit.ts）。契约里是 error，
  // 选择框却显示「（仅注释，不强制）」，下一次注释失焦就把强度删掉。
  it('改完约束强度紧接着移除成员：强度不会在下一次提交时被删掉', async () => {
    const bridge = groupBridge([G3], 40)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    selectAllThree(container)
    await screen.findByLabelText('分组注释')

    fireEvent.change(screen.getByLabelText('约束强度'), { target: { value: 'error' } })
    // 宿主往返期间移除一个成员。≥3 个成员才做得到：减到 1 个面板就卸载了。
    fireEvent.click(screen.getByLabelText('从选中集移除 README.md'))

    await waitFor(() => expect(bridge.groupsNow()[0].severity).toBe('error'))
    await waitFor(() => expect(bridge.groupsNow()[0].members).toEqual(['src', 'docs']))

    const ta = screen.getByLabelText('分组注释')
    fireEvent.change(ta, { target: { value: '再改一句注释' } })
    fireEvent.blur(ta)

    await waitFor(() => expect(bridge.groupsNow()[0].text).toBe('再改一句注释'))
    // 契约先断言：这一笔提交里 severity 是陈旧的空串翻译出来的 null 的话，
    // core 会 `delete existing.severity`，用户设好的强度就此消失
    expect(bridge.groupsNow()[0].severity).toBe('error')
    // 显示再断言：契约里是 error、选择框却写着「（仅注释，不强制）」，两者一分家，
    // 下一次失焦就会再把它删一次
    expect((screen.getByLabelText('约束强度') as HTMLSelectElement).value).toBe('error')
  })
})
