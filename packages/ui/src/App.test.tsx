import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from './App.js'
import { FakeBridge } from './test-bridge.js'
import type { Bridge, FileReadResult, Group, OpenResult, Severity, ViewMode, ViewNode } from '@folderspec/core/api'

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

// canUndo: true 是四个写操作桩的如实反映——core 侧真实 Session 提交一次编辑之后
// undoStack 必然非空（见 session.test.ts「四个写操作的返回值都带上 canUndo / canRedo」）。
// 桩若省略这两个字段，App 里任何"编辑后撤销按钮该启用"的断言都测不出对应缺陷。
const bridgeWith = (over: Partial<Record<string, unknown>> = {}) => new FakeBridge({
  'workspace/open': () => openResult(over as Partial<OpenResult>),
  'spec/annotate': () => ({
    tree: tree([{ ...SRC, annotation: '核心源码', origin: 'both' }, DOCS, README]),
    dirty: true, groups: [G1], canUndo: true, canRedo: false,
  }),
  'spec/move': () => ({ tree: tree(FIXTURE), dirty: true, groups: [G1], canUndo: true, canRedo: false }),
  'spec/save': () => ({ written: true }),
  'tree/expand': () => ({ tree: tree(FIXTURE) }),
  'spec/setGroup': () => ({ tree: tree(FIXTURE), dirty: true, groups: [G1], id: 'g1', canUndo: true, canRedo: false }),
  'spec/deleteGroup': () => ({ tree: tree(FIXTURE), dirty: true, groups: [], canUndo: true, canRedo: false }),
  'file/read': () => ({ kind: 'text', text: 'hello\nworld' }),
  'view/setMode': ({ mode }: { mode: ViewMode }) => ({ tree: tree(FIXTURE), mode }),
  'spec/undo': () => ({ tree: tree(FIXTURE), dirty: false, groups: [G1], canUndo: false, canRedo: true }),
  'spec/redo': () => ({ tree: tree(FIXTURE), dirty: true, groups: [G1], canUndo: true, canRedo: false }),
} as never)

const rowsOf = (container: HTMLElement) => Array.from(container.querySelectorAll('.fs-row'))

const G3: Group = { id: 'g1', members: ['src', 'docs', 'README.md'], text: '一体的三个' }

/** core 的 uniqueId（spec-edit.ts）：冲突时追加 -2、-3。改名与自动取名共用同一条规则。 */
const uniqueId = (base: string, taken: ReadonlySet<string>): string => {
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`
}

/** core 的 deriveGroupId：取成员的最长公共父目录 basename，没有就退回 group。 */
const deriveId = (members: readonly string[], taken: ReadonlySet<string>): string => {
  if (members.length === 0) return uniqueId('group', taken)
  const parents = members.map(m => m.split('/').filter(s => s !== '').slice(0, -1))
  let common = parents[0]
  for (const p of parents.slice(1)) {
    let i = 0
    while (i < common.length && i < p.length && common[i] === p[i]) i++
    common = common.slice(0, i)
  }
  const last = common[common.length - 1]
  return uniqueId(last && last !== '..' ? last : 'group', taken)
}

/**
 * 会真的按参数收缩分组、且响应带非零延迟的桩。两点缺一不可：
 * 上一轮 bridgeWith 的 spec/setGroup 恒返回未收缩的 G1，把一个会销毁用户注释的缺陷
 * 完全掩盖住了；而零延迟的桩测不出"请求在途的那一帧"——真实宿主的响应必然晚于本次
 * 点击引发的渲染，缺陷就长在那一帧里。
 *
 * `spec/setGroup` 这一段是照着 `core/src/spec-edit.ts` 的 `setGroup` 抄的**同构实现**，
 * 不是"够用就行"的近似。此前它缺了两条语义，各掩盖了一整类缺陷：
 *
 * - **`id: null` 的建组是空实现**。于是"新建态下的草稿最后建出了一个凭空多出来的
 *   重复分组"这种结果，在断言 `groupsNow()` 时完全看不见——桩里压根没有那个分组。
 * - **不实现「text 清空即删除」**。而这条正是本项目那条红线的执行者：面板一旦把空串
 *   提交上去，core 就把分组连同用户写的注释一起抹掉。桩不照做，任何"注释被清空"的
 *   缺陷在契约断言上都是绿的。
 *
 * 仍未建模的一条：core 会把 members 排序（`sort(localeCompare)`），这里保持点击顺序。
 * 排序与本文件任何一条用例要防的缺陷都无关，而改掉它会让十几处断言变成噪声；
 * "顺序也照做"那一半由 lock-members 的双树探针用真实 `Session` 覆盖。
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
        const members = params.members as string[] | undefined
        const wanted = typeof params.name === 'string' ? params.name.trim() : ''
        const current = id === null ? undefined : groups.find(g => g.id === id)
        // 改名时自身的旧 id 不算冲突，否则每改一次名字就多一个 -2 后缀
        const others = new Set(groups.filter(g => g !== current).map(g => g.id))
        // core 的 setGroup 返回的是**落地后**的 id：给了 name 就是改名后的那个
        // （spec-edit 的 targetId）。桩必须照做，否则改名后的链路根本测不到。
        const landedId = wanted
          ? uniqueId(wanted, others)
          : (id ?? deriveId(members ?? [], new Set(groups.map(g => g.id))))
        // 给了 name 却撞上另一个分组时，core 编辑的是**那一个**，不是新建
        const existing = current ?? groups.find(g => g.id === landedId)
        const text = params.text === undefined
          ? existing?.text
          : String(params.text ?? '').trim()

        // 清空 text 即删除该分组；对尚不存在的分组是空操作（spec-edit.ts 同款早退）
        if (text === undefined || text === '') {
          if (existing) groups = groups.filter(g => g !== existing)
          return { tree: tree(nodes), dirty: true, groups, id: landedId }
        }

        if (existing) {
          groups = groups.map(g => {
            if (g !== existing) return g
            const next: Group = {
              ...g, id: landedId, text,
              members: members ? [...members] : [...g.members],
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
        } else {
          const created: Group = { id: landedId, members: [...(members ?? [])], text }
          if (params.severity) created.severity = params.severity as Severity
          groups = [...groups, created]
        }
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

/**
 * 按显示名取行。点 src 会把它展开，行数与下标从此错位，缓存的下标就指到别处去了；
 * 名字是稳定的（`.fs-name` 里目录带尾斜杠）。
 */
const rowByName = (container: HTMLElement, name: string): HTMLElement => {
  const row = rowsOf(container).find(r => r.querySelector('.fs-name')?.textContent === name)
  expect(row, `树上没有名为 ${name} 的行`).toBeTruthy()
  return row as HTMLElement
}

/** 某个成员的 × 按钮。锁定态下它必须是禁用的 */
const removeBtn = (path: string) =>
  screen.getByLabelText(`从选中集移除 ${path}`) as HTMLButtonElement


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

  // 从 GroupPanel.test 搬过来的：切换编辑目标时丢草稿的动作已经从面板移到了 App
  // （草稿归上层所有），继续在组件级测就只能测桩自己。这条守的还是同一件事：
  // 用户看着 g2 的标题、框里却是写给 g1 的半句话，一失焦就把它盖到 g2 原有的注释上。
  it('在 g1 的框里写了字、还没失焦就切到 g2，那些字不会落到 g2 头上', async () => {
    const SAME: Group = { id: 'g2', members: ['src', 'docs'], text: '第二个' }
    const bridge = groupBridge([G1, SAME], 20)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    const rows = rowsOf(container)
    fireEvent.click(rows[0])
    fireEvent.click(rows[1], { ctrlKey: true })
    const ta = await screen.findByLabelText('分组注释')
    fireEvent.change(ta, { target: { value: '本来要写给 g1 的' } })

    fireEvent.click(screen.getByLabelText('改为编辑分组 g2'))

    expect((screen.getByLabelText('分组注释') as HTMLTextAreaElement).value).toBe('第二个')
    fireEvent.blur(screen.getByLabelText('分组注释'))
    await act(async () => { await new Promise(r => setTimeout(r, 60)) })

    expect(bridge.groupsNow().find(g => g.id === 'g2')!.text).toBe('第二个')
    expect(bridge.groupsNow().find(g => g.id === 'g1')!.text).toBe('一体的两个目录')
    expect(bridge.calls.filter(c => c.method === 'spec/setGroup')).toHaveLength(0)
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
  //
  // 序列里多出的那一次"点了没反应"不是凑数：草稿落地之前成员集是锁着的（见
  // PendingGroup.draft），这一下 × 本来就该被挡回去。别把它删成一次点击——那样这条
  // 用例会绕开锁，而锁正是同一条红线上另外两条 Critical 的收口。
  it('写完注释紧接着移除成员：用户新写的注释不会被旧注释盖回去', async () => {
    const bridge = groupBridge([G3], 20)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    selectAllThree(container)
    const ta = await screen.findByLabelText('分组注释')
    expect((ta as HTMLTextAreaElement).value).toBe('一体的三个')

    fireEvent.change(ta, { target: { value: '用户新写的一大段注释' } })
    fireEvent.blur(ta)                                                // × 的 mousedown
    expect(removeBtn('README.md').disabled).toBe(true)                // 草稿在途，锁着
    fireEvent.click(removeBtn('README.md'))                           // × 的 click，被挡下
    expect(memberPathsOf(container)).toEqual(['src', 'docs', 'README.md'])

    await waitFor(() => expect(bridge.groupsNow()[0].text).toBe('用户新写的一大段注释'))
    await waitFor(() => expect(removeBtn('README.md').disabled).toBe(false))
    fireEvent.click(removeBtn('README.md'))                           // 落地解锁后再点

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
    // 改强度也是一次草稿，宿主往返期间成员集锁着——这一下点不动（见 PendingGroup.draft）
    expect(removeBtn('README.md').disabled).toBe(true)
    fireEvent.click(removeBtn('README.md'))
    expect(memberPathsOf(container)).toEqual(['src', 'docs', 'README.md'])

    await waitFor(() => expect(bridge.groupsNow()[0].severity).toBe('error'))
    // 落地解锁后再移除。≥3 个成员才做得到：减到 1 个面板就卸载了。
    await waitFor(() => expect(removeBtn('README.md').disabled).toBe(false))
    fireEvent.click(removeBtn('README.md'))
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

  // 点选择器里**已经是当前编辑目标**的那一项时也自增会话号，会作废在途写入落地时的
  // `setPending({ ...now, groupId: id })`——那句正是"改名后把 groupId 换成新 id"的地方。
  // 于是 pending.groupId 停在一个已被改名掉的旧 id 上，此后的写入全打在幽灵分组上：
  // 没有丢文字，但用户以为在编辑 parser，实际每次都在新建一个重复的 g2。
  // 草稿搬到上层之后顺带修好的一处：点选择器里**已经是当前目标**的那一项，从前会连带把
  // 框里没提交的字一起丢掉（面板的 pick 无条件 dropDrafts）。目标一步没动，没有任何理由
  // 丢用户打的字——这是本项目那条红线的正方向，钉在这里免得后人"修回去"。
  it('点选择器里已经在编辑的那一项，框里没提交的字不会被丢掉', async () => {
    const SAME: Group = { id: 'g2', members: ['src', 'docs'], text: '第二个' }
    const bridge = groupBridge([G1, SAME], 20)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    const rows = rowsOf(container)
    fireEvent.click(rows[0])
    fireEvent.click(rows[1], { ctrlKey: true })
    await screen.findByLabelText('分组注释')
    fireEvent.click(screen.getByLabelText('改为编辑分组 g2'))

    fireEvent.change(screen.getByLabelText('分组注释'), { target: { value: '写给 g2 的半句话' } })
    fireEvent.click(screen.getByLabelText('改为编辑分组 g2'))          // 点的就是当前目标

    expect((screen.getByLabelText('分组注释') as HTMLTextAreaElement).value).toBe('写给 g2 的半句话')
    fireEvent.blur(screen.getByLabelText('分组注释'))
    await waitFor(() => expect(bridge.groupsNow().find(g => g.id === 'g2')!.text)
      .toBe('写给 g2 的半句话'))
    expect(bridge.groupsNow().find(g => g.id === 'g1')!.text).toBe('一体的两个目录')
  })

  it('点选择器里已经在编辑的那一项，不会把在途改名的结果拨丢', async () => {
    const SAME: Group = { id: 'g2', members: ['src', 'docs'], text: '第二个' }
    const bridge = groupBridge([G1, SAME], 60)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    const rows = rowsOf(container)
    fireEvent.click(rows[0])
    fireEvent.click(rows[1], { ctrlKey: true })
    await screen.findByLabelText('分组注释')

    fireEvent.click(screen.getByLabelText('改为编辑分组 g2'))

    const nameInput = screen.getByLabelText('分组名')
    fireEvent.change(nameInput, { target: { value: 'parser' } })
    fireEvent.blur(nameInput)
    await flushChain()          // 改名那笔真的在途

    // 选择器上这一项还标着 g2（groups 尚未回来），而它就是当前编辑目标
    fireEvent.click(screen.getByLabelText('改为编辑分组 g2'))

    await waitFor(() => expect(bridge.groupsNow().some(g => g.id === 'parser')).toBe(true))

    const ta = screen.getByLabelText('分组注释')
    fireEvent.change(ta, { target: { value: '改名之后写的注释' } })
    fireEvent.blur(ta)

    // 编辑目标必须跟着改名走；停在旧 id 上的话这一笔打的是一个不存在的 g2
    await waitFor(() => expect(bridge.lastCall('spec/setGroup')).toMatchObject({ id: 'parser' }))
    // lastCall 是**发出时**记的，桩还压着 60ms 才落地——契约那一半必须自己等
    await waitFor(() => expect(bridge.groupsNow().find(g => g.id === 'parser')!.text)
      .toBe('改名之后写的注释'))
  })

  // ── 草稿的生命周期，以及"草稿活着时成员集锁定" ─────────────────────────────
  //
  // 前四轮把"显示"与"写入"统一到了一份 pending 上，唯独**草稿**（用户打了字还没提交的
  // 那一份）留在面板自己的 state 里，与"它是写给谁的"分家。两条 Critical 由此而来，
  // 机制同源：草稿还活着的时候成员集变了，编辑目标跟着换，草稿却原地不动。
  //
  //   N1：落地之后草稿没清空 → 成员移走又加回来 → 目标已换成同成员的另一个分组
  //   N2：新建态下写了一半 → 点 × 让剩下两项恰好等于某个既有分组 → 目标凭空变成它
  //
  // 修法两条，缺一不可：草稿**落地即清空**（治 N1），草稿**活着时成员集锁定**（治 N2）。
  // 下面每一条的断言都尽量落在契约的最终内容上——"另一个分组的注释被覆盖"这件事，
  // 在发出去的 params 上是看不出来的：那笔请求本身完全合法。

  it('注释落地后把成员移走又加回来，成员集相同的另一个分组的注释不被覆盖', async () => {
    // N1 的完整序列。全程没有任何非常规时序，每一步都等到落地。
    const g9: Group = { id: 'g9', members: ['src', 'docs', 'README.md'], text: 'g9 原有的注释' }
    const g1: Group = { id: 'g1', members: ['src', 'docs', 'README.md'], text: 'g1 原有的注释' }
    const bridge = groupBridge([g9, g1], 20)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    selectAllThree(container)
    const ta = await screen.findByLabelText('分组注释')
    expect((ta as HTMLTextAreaElement).value).toBe('g9 原有的注释')   // 默认取文件里靠前那个

    fireEvent.click(screen.getByLabelText('改为编辑分组 g1'))
    fireEvent.change(screen.getByLabelText('分组注释'), { target: { value: '写给 g1 的新注释' } })
    fireEvent.blur(screen.getByLabelText('分组注释'))
    await waitFor(() =>
      expect(bridge.groupsNow().find(g => g.id === 'g1')!.text).toBe('写给 g1 的新注释'))

    // 落地了，草稿该没了，锁也该开了——否则下面这一点根本点不动
    fireEvent.click(removeBtn('README.md'))
    await waitFor(() =>
      expect(bridge.groupsNow().find(g => g.id === 'g1')!.members).toEqual(['src', 'docs']))

    // 反悔：没有撤销按钮，ctrl 点一下把它加回来是最自然的动作
    fireEvent.click(rowByName(container, 'README.md'), { ctrlKey: true })
    await waitFor(() => expect(screen.getByText(/已选中 3 项/)).toBeTruthy())
    // 此刻编辑目标已经是 g9（只有它的成员集还等于这三项），框里必须是 g9 的注释
    expect((screen.getByLabelText('分组注释') as HTMLTextAreaElement).value).toBe('g9 原有的注释')

    // 此后**仅需一次失焦、无需任何输入**
    fireEvent.blur(screen.getByLabelText('分组注释'))
    await act(async () => { await new Promise(r => setTimeout(r, 60)) })

    expect(bridge.groupsNow().find(g => g.id === 'g9')!.text).toBe('g9 原有的注释')
    expect(bridge.groupsNow().find(g => g.id === 'g1')!.text).toBe('写给 g1 的新注释')
  })

  it('新建态下写了一半注释再点 ×：成员集不动，既有分组的注释不被覆盖', async () => {
    // N2 的完整序列。**确定性的，没有任何往返窗口**：用户从头到尾没见过 g1 原有的注释，
    // 唯一的信号是「分组名」栏悄悄从空变成 g1。
    const g1: Group = { id: 'g1', members: ['src', 'docs'], text: 'g1 原有的注释' }
    const bridge = groupBridge([g1], 20)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    selectAllThree(container)                       // 三项，不构成任何分组
    const ta = await screen.findByLabelText('分组注释')
    expect((ta as HTMLTextAreaElement).value).toBe('')

    fireEvent.change(ta, { target: { value: '写给这三个的注释' } })
    fireEvent.click(removeBtn('README.md'))         // 锁着，点了也不该有反应

    expect(memberPathsOf(container)).toEqual(['src', 'docs', 'README.md'])
    fireEvent.blur(screen.getByLabelText('分组注释'))
    await act(async () => { await new Promise(r => setTimeout(r, 60)) })

    expect(bridge.groupsNow().find(g => g.id === 'g1')!.text).toBe('g1 原有的注释')
    // 另一半：这一笔该建的是一个新分组，成员是用户看着的那三项
    expect(bridge.groupsNow().find(g => g.text === '写给这三个的注释')!.members)
      .toEqual(['src', 'docs', 'README.md'])
  })

  it('草稿未提交时 ctrl 改选不动本轮成员集，另一个分组的注释不被覆盖', async () => {
    // 与 N2 同一个洞，入口换成树上的 ctrl 加选：加完之后选中集恰好等于 g1。
    const g1: Group = { id: 'g1', members: ['src', 'docs', 'README.md'], text: '三个一体' }
    const bridge = groupBridge([g1], 20)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    const rows = rowsOf(container)
    fireEvent.click(rows[0])                        // src
    fireEvent.click(rows[1], { ctrlKey: true })     // docs —— 两项，不等于 g1
    const ta = await screen.findByLabelText('分组注释')
    fireEvent.change(ta, { target: { value: '写给这两个的' } })

    fireEvent.click(rowByName(container, 'README.md'), { ctrlKey: true })

    expect(memberPathsOf(container)).toEqual(['src', 'docs'])
    expect((screen.getByLabelText('分组注释') as HTMLTextAreaElement).value).toBe('写给这两个的')

    fireEvent.blur(screen.getByLabelText('分组注释'))
    await act(async () => { await new Promise(r => setTimeout(r, 60)) })
    expect(bridge.groupsNow().find(g => g.id === 'g1')!.text).toBe('三个一体')
  })

  it('草稿未提交时点分组色点不动本轮成员集', async () => {
    // 第三个入口：§5.5 的色点，点一下就把选中集换成该分组的全部成员。
    const g1: Group = { id: 'g1', members: ['src', 'docs'], text: 'g1 原有的注释' }
    const bridge = groupBridge([g1], 20)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    selectTwoUnrelated(container)                   // src + README.md，不等于 g1
    const ta = await screen.findByLabelText('分组注释')
    fireEvent.change(ta, { target: { value: '写给 src 与 README 的' } })

    // src 与 docs 行尾都挂着 g1 的色点，取 src 那一个
    fireEvent.click(within(rowByName(container, 'src/')).getByLabelText('选中分组 g1 的全部成员'))

    expect(memberPathsOf(container)).toEqual(['src', 'README.md'])
    fireEvent.blur(screen.getByLabelText('分组注释'))
    await act(async () => { await new Promise(r => setTimeout(r, 60)) })
    expect(bridge.groupsNow().find(g => g.id === 'g1')!.text).toBe('g1 原有的注释')
  })

  it('写入落地后草稿清空，成员集随之解锁', async () => {
    // 锁与"落地即清空"是配套的：草稿若永不清空，"草稿存在期间锁定"就等于永久锁定。
    const bridge = groupBridge([G3], 30)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    selectAllThree(container)
    const ta = await screen.findByLabelText('分组注释')
    expect(removeBtn('README.md').disabled).toBe(false)

    fireEvent.change(ta, { target: { value: '新注释' } })
    expect(removeBtn('README.md').disabled).toBe(true)      // 草稿一出现就锁

    fireEvent.blur(ta)
    await waitFor(() => expect(bridge.groupsNow()[0].text).toBe('新注释'))
    await waitFor(() => expect(removeBtn('README.md').disabled).toBe(false))
  })

  it('写入在途时继续输入，落地不会把新打的字清掉', async () => {
    // "落地即清空"只能清**这一笔写出去的那一份**。一律清空的话，用户在宿主往返的
    // 20–60ms 里补的半句话会被无声抹掉——同样是弄丢人写的字。
    const bridge = groupBridge([G3], 60)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    selectAllThree(container)
    const ta = await screen.findByLabelText('分组注释')
    fireEvent.change(ta, { target: { value: '第一版' } })
    fireEvent.blur(ta)
    await flushChain()
    expect(bridge.calls.filter(c => c.method === 'spec/setGroup')).toHaveLength(1)

    fireEvent.change(ta, { target: { value: '第一版加了后半句' } })
    await waitFor(() => expect(bridge.groupsNow()[0].text).toBe('第一版'))
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })

    expect((ta as HTMLTextAreaElement).value).toBe('第一版加了后半句')
    fireEvent.blur(ta)
    await waitFor(() => expect(bridge.groupsNow()[0].text).toBe('第一版加了后半句'))
  })

  it('收缩在途时开始写注释：收缩落地不会把这段新草稿清掉，锁也立刻生效', async () => {
    // 这是"重置/落地发生在写入在途的那一帧"那个组合，此前 216 条里没有一条走到过它：
    // 收缩派发时还没有草稿，草稿是在宿主往返的那 60ms 里冒出来的。落地回调若一律
    // 清草稿，用户在这段窗口里打的字就被无声抹掉。
    const bridge = groupBridge([G3], 60)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    selectAllThree(container)
    const ta = await screen.findByLabelText('分组注释')
    fireEvent.click(removeBtn('README.md'))            // 此刻没有草稿，收缩是允许的
    await flushChain()
    expect(bridge.calls.filter(c => c.method === 'spec/setGroup')).toHaveLength(1)

    fireEvent.change(ta, { target: { value: '收缩在途时写的' } })
    expect(removeBtn('docs').disabled).toBe(true)      // 草稿一冒出来就锁上

    await waitFor(() => expect(bridge.groupsNow()[0].members).toEqual(['src', 'docs']))
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })

    expect((ta as HTMLTextAreaElement).value).toBe('收缩在途时写的')
    fireEvent.blur(ta)
    await waitFor(() => expect(bridge.groupsNow()[0].text).toBe('收缩在途时写的'))
  })

  it('分组写入失败时草稿与锁都留着，用户不必白打一遍', async () => {
    const bridge = groupBridge([G3], 20, 1)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    selectAllThree(container)
    const ta = await screen.findByLabelText('分组注释')
    fireEvent.change(ta, { target: { value: '很长的一段注释' } })
    fireEvent.blur(ta)

    await waitFor(() => expect(screen.getByText(/写失败了/)).toBeTruthy())
    expect((screen.getByLabelText('分组注释') as HTMLTextAreaElement).value).toBe('很长的一段注释')
    expect(removeBtn('README.md').disabled).toBe(true)
  })

  // 「发现 1」的第三次出现。前两次分别是"severity 没有本地 state"与"提交时读陈旧快照"，
  // 这一次的载体是**落地即清草稿**：新建态下 current 恒为 null，submit 带的 text 是空串，
  // 而 core 的 setGroup 对空 text 走早退（spec-edit.ts 的 `text === '' → return`）——
  // 那是一次什么都没改的**空操作，却照样"落地成功"**，于是落地回调把草稿连同用户刚选的
  // 强度一起清掉，下拉框视觉上弹回「（仅注释，不强制）」，随后建出的分组不带 severity。
  //
  // 触发条件是"新建态 + 两次字段编辑之间隔了一个宿主往返"——真实用户必然如此。
  // 这条**必须走 App 级真实接线**：守它的两条组件级用例跑在 Harness 上，而 Harness 故意
  // 不复刻 App 的"落地后清空草稿"，于是它们只证明了"合并逻辑对"，证明不了"合并有机会发生"。
  it('新建态先选约束强度、等那次空操作落地、再写注释——强度必须还在', async () => {
    const bridge = groupBridge([G1], 20)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    selectAllThree(container)                       // 三项，不等于 G1：新建态
    const ta = await screen.findByLabelText('分组注释')
    expect((ta as HTMLTextAreaElement).value).toBe('')

    fireEvent.change(screen.getByLabelText('约束强度'), { target: { value: 'error' } })
    // 停顿：真实用户在"选完强度"与"开始写注释"之间必然隔着一个宿主往返
    await act(async () => { await new Promise(r => setTimeout(r, 250)) })

    // 空 text 那一笔在 core 侧是空操作，根本不该发出去
    expect(bridge.calls.filter(c => c.method === 'spec/setGroup')).toHaveLength(0)
    expect((screen.getByLabelText('约束强度') as HTMLSelectElement).value).toBe('error')

    fireEvent.change(ta, { target: { value: '新分组' } })
    fireEvent.blur(ta)

    await waitFor(() => expect(bridge.groupsNow().find(g => g.text === '新分组')).toBeTruthy())
    expect(bridge.groupsNow().find(g => g.text === '新分组')!.severity).toBe('error')
  })

  // 上面那道"空操作就别发"的闸有一条必须放行的路：**清空某个既有分组的注释 = 删除它**
  // （core 的同一条早退，只是这回 existing 存在）。判据因此取 `p.groupId ?? sub.id` 而不是
  // 只看 `p.groupId`——本轮的 groupId 可能还是 null（新建态开的轮次），而面板此刻编辑的
  // 却已经是一个既有分组：成员集缩到恰好等于它。把它一起挡掉的话，框里空了、契约里那段
  // 注释还在，而且此后每次失焦都会被同一道闸挡住，显示与契约永久分家。
  it('新建态里成员集缩成某个既有分组后清空它的注释：那个分组确实被删掉', async () => {
    const bridge = groupBridge([{ id: 'g1', members: ['src', 'docs'], text: '两个一体' }], 20)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    selectAllThree(container)                       // 三项：新建态，没有草稿
    await screen.findByLabelText('分组注释')
    fireEvent.click(removeBtn('README.md'))         // 缩成 ['src','docs'] —— 恰好等于 g1
    await waitFor(() =>
      expect((screen.getByLabelText('分组注释') as HTMLTextAreaElement).value).toBe('两个一体'))

    const ta = screen.getByLabelText('分组注释')
    fireEvent.change(ta, { target: { value: '' } })
    fireEvent.blur(ta)

    await waitFor(() => expect(bridge.groupsNow()).toHaveLength(0))
  })

  // 同一条早退路径的另一半：新建态下用户先填了分组名。那一笔同样是空操作，
  // 落地回调照样会把名字草稿清掉，输入框弹回空、随后建出的分组用的是自动取的名字。
  it('新建态先填分组名、等那次空操作落地、再写注释——名字必须还在', async () => {
    const bridge = groupBridge([G1], 20)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    selectAllThree(container)
    const ta = await screen.findByLabelText('分组注释')
    const nameInput = screen.getByLabelText('分组名')
    fireEvent.change(nameInput, { target: { value: '这一批' } })
    fireEvent.blur(nameInput)
    await act(async () => { await new Promise(r => setTimeout(r, 250)) })

    expect(bridge.calls.filter(c => c.method === 'spec/setGroup')).toHaveLength(0)
    expect((screen.getByLabelText('分组名') as HTMLInputElement).value).toBe('这一批')

    fireEvent.change(ta, { target: { value: '新分组' } })
    fireEvent.blur(ta)

    await waitFor(() => expect(bridge.groupsNow().find(g => g.text === '新分组')).toBeTruthy())
    expect(bridge.groupsNow().find(g => g.text === '新分组')!.id).toBe('这一批')
  })

  // 锁不能把用户困住。普通单击本来就有"放弃多选"的语义，它必然把选中集收成 1 项，
  // 分组面板随之卸载——这就是留出来的那条出路，不需要新按钮。
  //
  // **这一下的真实语义是"先提交、再离开"，不是"放弃"**：鼠标按下时输入框先失焦，
  // onBlur 把草稿提交出去，之后才轮到 click 换选中集。所以必须用 userEvent（它真的搬焦点），
  // 不能用 fireEvent.click —— 后者在 jsdom 里不搬焦点，会把一个产品里根本不存在的
  // "点树上节点等于放弃"钉成不变量，而界面上那句提示曾经就是照着这个假象写的。
  it('草稿未提交时普通单击树上另一个节点：先提交、再离开本轮', async () => {
    const user = userEvent.setup()
    const bridge = groupBridge([G3], 20)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    selectAllThree(container)
    const ta = await screen.findByLabelText('分组注释')
    await user.click(ta)                                   // 焦点真的落在输入框里
    fireEvent.change(ta, { target: { value: '我打了一半就反悔了' } })

    await user.click(rowByName(container, 'docs/'))        // mousedown → blur → click
    expect(screen.queryByLabelText('分组注释')).toBeNull()  // 确实离开了本轮

    // 提交落在**正确的目标**上：就是这一轮在编辑的 g1，没有多出别的分组
    await waitFor(() => expect(bridge.groupsNow()[0].text).toBe('我打了一半就反悔了'))
    expect(bridge.groupsNow()).toHaveLength(1)
    expect(bridge.groupsNow()[0].members).toEqual(['src', 'docs', 'README.md'])

    // 再凑回同样这三项：草稿没有跟过来（否则 × 会是锁着的），框里是契约里的那份
    fireEvent.click(rowByName(container, 'src/'), { ctrlKey: true })
    fireEvent.click(rowByName(container, 'README.md'), { ctrlKey: true })
    const back = await screen.findByLabelText('分组注释')
    expect((back as HTMLTextAreaElement).value).toBe('我打了一半就反悔了')
    expect(removeBtn('README.md').disabled).toBe(false)
    expect(bridge.calls.filter(c => c.method === 'spec/setGroup')).toHaveLength(1)
  })

  // ---------------------------------------------------------------------
  // 「原始结构 / 我的结构」视图切换
  //
  // 核心动机（用户原话）：拖拽改完结构之后，没有任何地方能看出自己到底改了什么。
  // 判据因此是"一眼能看出当前在哪个视图"——下面第一条钉的就是这件事本身。
  // ---------------------------------------------------------------------
  describe('原始结构 / 我的结构视图切换', () => {
    it('默认显示"我的结构"为当前视图', async () => {
      render(<App bridge={bridgeWith()} initialRoot="/tmp/repo" />)
      await waitFor(() => screen.getByLabelText('工作区路径'))

      expect(screen.getByRole('button', { name: '我的结构' }).getAttribute('aria-pressed')).toBe('true')
      expect(screen.getByRole('button', { name: '原始结构' }).getAttribute('aria-pressed')).toBe('false')
    })

    it('点击"原始结构"发出 view/setMode 请求，控件随之切换高亮', async () => {
      const bridge = bridgeWith()
      render(<App bridge={bridge} initialRoot="/tmp/repo" />)
      await waitFor(() => screen.getByLabelText('工作区路径'))

      fireEvent.click(screen.getByRole('button', { name: '原始结构' }))

      await waitFor(() => expect(bridge.lastCall('view/setMode')).toEqual({ mode: 'disk' }))
      await waitFor(() =>
        expect(screen.getByRole('button', { name: '原始结构' }).getAttribute('aria-pressed')).toBe('true'))
      expect(screen.getByRole('button', { name: '我的结构' }).getAttribute('aria-pressed')).toBe('false')
    })

    // 这是本节的回归重点：core 的 assertWritable() 在 disk 视图下拒绝一切写入，
    // UI 必须把编辑入口全部禁用，而不是让用户点了没反应。单点变异见实现后的验证记录。
    it('"原始结构"视图下：横幅说明原因，保存按钮与注释面板控件均被禁用', async () => {
      const bridge = bridgeWith()
      const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
      await waitFor(() => screen.getByLabelText('工作区路径'))

      fireEvent.click(screen.getByRole('button', { name: '原始结构' }))
      await waitFor(() => expect(bridge.lastCall('view/setMode')).toEqual({ mode: 'disk' }))

      // 横幅必须解释"为什么现在点不动"，且要给出怎么切回去——不能让用户自己猜。
      // 用 role="status" 定位而不是文字：顶栏的切换按钮本身文字也含"原始结构"，
      // 用文字找会撞上"多个元素匹配"（已实测：改用 getByText 前先见过这条报错）。
      await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/原始结构/))
      expect((screen.getByText('保存') as HTMLButtonElement).disabled).toBe(true)

      clickFirstRow(container)
      await waitFor(() => screen.getByLabelText('注释'))
      expect((screen.getByLabelText('注释') as HTMLTextAreaElement).disabled).toBe(true)
      expect((screen.getByLabelText('语义角色') as HTMLInputElement).disabled).toBe(true)
      expect((screen.getByLabelText('约束强度') as HTMLSelectElement).disabled).toBe(true)
    })

    it('切回"我的结构"后恢复可编辑', async () => {
      const bridge = bridgeWith()
      const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
      await waitFor(() => screen.getByLabelText('工作区路径'))

      fireEvent.click(screen.getByRole('button', { name: '原始结构' }))
      await waitFor(() => expect(bridge.lastCall('view/setMode')).toEqual({ mode: 'disk' }))

      fireEvent.click(screen.getByRole('button', { name: '我的结构' }))
      await waitFor(() => expect(bridge.lastCall('view/setMode')).toEqual({ mode: 'spec' }))

      clickFirstRow(container)
      await waitFor(() => screen.getByLabelText('注释'))
      expect((screen.getByLabelText('注释') as HTMLTextAreaElement).disabled).toBe(false)
    })

    it('再次点击当前已激活的视图不重复发请求', async () => {
      const bridge = bridgeWith()
      render(<App bridge={bridge} initialRoot="/tmp/repo" />)
      await waitFor(() => screen.getByLabelText('工作区路径'))

      fireEvent.click(screen.getByRole('button', { name: '我的结构' }))
      // 给一次微任务窗口，让"万一真发了"的请求有机会落地
      await act(async () => { await Promise.resolve() })

      expect(bridge.calls.some(c => c.method === 'view/setMode')).toBe(false)
    })

    // 验证"旧位置重新出现"这件事在 UI 侧真正生效的机制：view/setMode 换回来的树
    // 必须真的替换掉当前显示的树，而不是被忽略。src 折叠时 docs 被挪进 src 后不可见，
    // 切到 disk 视图应看到它重新出现在顶层——这正是这个功能对用户的全部意义。
    it('切到原始结构后，被移动进 src 的节点重新出现在顶层旧位置', async () => {
      const movedDocs: ViewNode = { ...DOCS, path: 'src/docs' }
      const specTree = tree([{ ...SRC, children: [...(SRC.children ?? []), movedDocs] }, README])
      const diskTree = tree(FIXTURE)

      const bridge = new FakeBridge({
        'workspace/open': () => openResult({ tree: specTree }),
        'view/setMode': ({ mode }: { mode: ViewMode }) => ({ tree: mode === 'disk' ? diskTree : specTree, mode }),
      } as never)

      const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
      await waitFor(() => screen.getByLabelText('工作区路径'))

      // 切换前：src 折叠，docs 已被挪进它下面，顶层只剩 src 与 README.md 两行
      expect(rowsOf(container)).toHaveLength(2)

      fireEvent.click(screen.getByRole('button', { name: '原始结构' }))
      await waitFor(() => expect(bridge.lastCall('view/setMode')).toEqual({ mode: 'disk' }))

      // 切换后：按磁盘状态重建，docs 回到顶层——与打开时的原始 FIXTURE 一致
      await waitFor(() => expect(rowsOf(container)).toHaveLength(3))
      expect(rowsOf(container).map(r => r.querySelector('.fs-name')?.textContent))
        .toEqual(['src/', 'docs/', 'README.md'])
    })

    it('载入不同工作区后视图复位为「我的结构」；重新载入同一个工作区保留原视图', async () => {
      // 照真实 CLI 宿主的规则（cli/src/server.ts）：同一个 root 复用同一个 Session，
      // viewMode 不会被重置；换一个 root 则换一个全新 Session，天生是默认值 'spec'。
      const bridge = new FakeBridge({
        'workspace/open': ({ root }: { root: string }) => openResult({ root }),
        'view/setMode': ({ mode }: { mode: ViewMode }) => ({ tree: tree(FIXTURE), mode }),
      } as never)

      render(<App bridge={bridge} initialRoot="/tmp/repo" />)
      await waitFor(() => screen.getByLabelText('工作区路径'))

      fireEvent.click(screen.getByRole('button', { name: '原始结构' }))
      await waitFor(() => expect(bridge.lastCall('view/setMode')).toEqual({ mode: 'disk' }))

      // 重新载入同一个根（不改路径框直接点载入）
      fireEvent.click(screen.getByText('载入'))
      await waitFor(() => expect(bridge.calls.filter(c => c.method === 'workspace/open').length).toBe(2))
      expect(screen.getByRole('button', { name: '原始结构' }).getAttribute('aria-pressed')).toBe('true')

      // 换成不同的根
      fireEvent.change(screen.getByLabelText('工作区路径'), { target: { value: '/tmp/other' } })
      fireEvent.click(screen.getByText('载入'))
      await waitFor(() => expect(bridge.calls.filter(c => c.method === 'workspace/open').length).toBe(3))
      await waitFor(() =>
        expect(screen.getByRole('button', { name: '我的结构' }).getAttribute('aria-pressed')).toBe('true'))
    })

    it('view/setMode 失败时显示错误横幅', async () => {
      const bridge = bridgeWith()
      bridge.setHandler('view/setMode', () => { throw new Error('切换视图炸了') })
      render(<App bridge={bridge} initialRoot="/tmp/repo" />)
      await waitFor(() => screen.getByLabelText('工作区路径'))

      fireEvent.click(screen.getByRole('button', { name: '原始结构' }))

      await waitFor(() => expect(screen.getByText('切换视图炸了')).toBeTruthy())
    })
  })

  // ---------------------------------------------------------------------
  // 撤销 / 重做
  //
  // 核心动机（用户原话）：拖拽的时候可能会不小心拖拽错。粒度是"一次已提交的编辑"。
  // ---------------------------------------------------------------------
  describe('撤销 / 重做', () => {
    it('初始加载后撤销/重做按钮均禁用', async () => {
      render(<App bridge={bridgeWith()} initialRoot="/tmp/repo" />)
      await waitFor(() => screen.getByLabelText('工作区路径'))

      expect((screen.getByText('撤销') as HTMLButtonElement).disabled).toBe(true)
      expect((screen.getByText('重做') as HTMLButtonElement).disabled).toBe(true)
    })

    it('提交一次编辑后撤销按钮启用；点击后发出 spec/undo 并回退树/分组/脏标记', async () => {
      const bridge = bridgeWith()
      const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
      await waitFor(() => screen.getByLabelText('工作区路径'))

      clickFirstRow(container)
      await waitFor(() => screen.getByLabelText('注释'))
      fireEvent.change(screen.getByLabelText('注释'), { target: { value: '核心源码' } })
      fireEvent.blur(screen.getByLabelText('注释'))
      await waitFor(() => expect((screen.getByText('撤销') as HTMLButtonElement).disabled).toBe(false))

      fireEvent.click(screen.getByText('撤销'))

      await waitFor(() => expect(bridge.calls.some(c => c.method === 'spec/undo')).toBe(true))
      expect(bridge.lastCall('spec/undo')).toEqual({})
      await waitFor(() => expect((screen.getByText('撤销') as HTMLButtonElement).disabled).toBe(true))
      expect((screen.getByText('重做') as HTMLButtonElement).disabled).toBe(false)
      // 桩里 spec/undo 回的 dirty:false——脏标记与撤销共用同一份 EditResult 才会同步
      expect((screen.getByText('保存') as HTMLButtonElement).disabled).toBe(true)
    })

    it('点击重做发出 spec/redo 并前进树/分组/脏标记', async () => {
      const bridge = bridgeWith()
      const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
      await waitFor(() => screen.getByLabelText('工作区路径'))

      clickFirstRow(container)
      await waitFor(() => screen.getByLabelText('注释'))
      fireEvent.change(screen.getByLabelText('注释'), { target: { value: '核心源码' } })
      fireEvent.blur(screen.getByLabelText('注释'))
      await waitFor(() => expect((screen.getByText('撤销') as HTMLButtonElement).disabled).toBe(false))

      fireEvent.click(screen.getByText('撤销'))
      await waitFor(() => expect((screen.getByText('重做') as HTMLButtonElement).disabled).toBe(false))

      fireEvent.click(screen.getByText('重做'))
      await waitFor(() => expect(bridge.calls.some(c => c.method === 'spec/redo')).toBe(true))
      expect(bridge.lastCall('spec/redo')).toEqual({})
      await waitFor(() => expect((screen.getByText('重做') as HTMLButtonElement).disabled).toBe(true))
      expect((screen.getByText('撤销') as HTMLButtonElement).disabled).toBe(false)
      expect((screen.getByText('保存') as HTMLButtonElement).disabled).toBe(false)
    })

    it('spec/undo 失败时显示错误横幅', async () => {
      const bridge = bridgeWith()
      bridge.setHandler('spec/undo', () => { throw new Error('撤销炸了') })
      const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
      await waitFor(() => screen.getByLabelText('工作区路径'))

      clickFirstRow(container)
      await waitFor(() => screen.getByLabelText('注释'))
      fireEvent.change(screen.getByLabelText('注释'), { target: { value: 'x' } })
      fireEvent.blur(screen.getByLabelText('注释'))
      await waitFor(() => expect((screen.getByText('撤销') as HTMLButtonElement).disabled).toBe(false))

      fireEvent.click(screen.getByText('撤销'))

      await waitFor(() => expect(screen.getByText('撤销炸了')).toBeTruthy())
    })

    // 明确要求 2：OpenResult 上没有 canUndo/canRedo（open 会清空撤销栈，两值恒 false
    // 不携带信息），UI 收到 open 结果时必须自己把两个按钮复位——不能指望桩里有这两个字段。
    it('workspace/open 之后撤销/重做按钮复位为禁用，即便此前已有可撤销的编辑', async () => {
      const bridge = bridgeWith()
      const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
      await waitFor(() => screen.getByLabelText('工作区路径'))

      clickFirstRow(container)
      await waitFor(() => screen.getByLabelText('注释'))
      fireEvent.change(screen.getByLabelText('注释'), { target: { value: 'x' } })
      fireEvent.blur(screen.getByLabelText('注释'))
      await waitFor(() => expect((screen.getByText('撤销') as HTMLButtonElement).disabled).toBe(false))

      fireEvent.click(screen.getByText('载入'))   // 重新打开当前根

      await waitFor(() => expect(bridge.calls.filter(c => c.method === 'workspace/open').length).toBe(2))
      await waitFor(() => expect((screen.getByText('撤销') as HTMLButtonElement).disabled).toBe(true))
      expect((screen.getByText('重做') as HTMLButtonElement).disabled).toBe(true)
    })

    // 明确要求 1：canUndo 只表示"栈非空"，不含只读判断（core 故意不重复实现只读规则）。
    // 按钮的禁用条件必须是 canUndo && 可编辑。这里构造一个真实可达的场景——在编辑态下
    // 提交过一次编辑（canUndo 变 true），随后切到「原始结构」视图（这一步完全不经过
    // open()，不会重置 canUndo）——如果按钮只判 canUndo，会在这里被误判成可点，
    // 点下去会撞上 core 的 assertWritable()「原始结构」错误，界面上凭空弹出一条报错。
    it('切到原始结构视图后，即便 canUndo 仍为 true，撤销按钮也必须禁用', async () => {
      const bridge = bridgeWith()
      const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
      await waitFor(() => screen.getByLabelText('工作区路径'))

      clickFirstRow(container)
      await waitFor(() => screen.getByLabelText('注释'))
      fireEvent.change(screen.getByLabelText('注释'), { target: { value: '核心源码' } })
      fireEvent.blur(screen.getByLabelText('注释'))
      await waitFor(() => expect((screen.getByText('撤销') as HTMLButtonElement).disabled).toBe(false))

      fireEvent.click(screen.getByRole('button', { name: '原始结构' }))
      await waitFor(() => expect(bridge.lastCall('view/setMode')).toEqual({ mode: 'disk' }))

      expect((screen.getByText('撤销') as HTMLButtonElement).disabled).toBe(true)
    })
  })
})
