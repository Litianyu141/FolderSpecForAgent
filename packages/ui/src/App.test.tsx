import { describe, it, expect, vi, afterEach } from 'vitest'
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
  // 平台路径分隔符（core 侧 OpenResult.sep）。UI 只用它拼「复制路径」那条绝对路径；
  // 与它无关的既有用例不必关心，所以放在前面、可被 `over` 覆盖（Windows 那条用例
  // 就是靠覆盖它来造出 'C:\\repo' + '\\' 的组合）。
  sep: '/',
  hasSpec: false,
  specPath: '/tmp/repo/.folderspec.md',
  parseErrors: null,
  tree: tree(FIXTURE),
  groups: [G1],
  // core 侧 OpenResult 已经带上必填的 lang 字段（另一轮加的，本轮的双语开关本身
  // 不读它——见 App.tsx 里 `lang` state 上那段注释）。这里只是补齐类型要求的
  // 一个默认值，不是本轮功能范围；这条 fixture 与本轮 UI 双语无关的既有用例
  // 全都不必关心它，所以放在最前面、可以被 `over` 覆盖。
  lang: 'zh',
  ...over,
})

/**
 * 把一条新建出来的声明插进固定夹具，模拟 core 侧 merge 的产出：新声明在磁盘上并不
 * 存在，所以 origin 是 'spec-only'（虚线那一档）；它的父目录因为 ensure() 补出了
 * spec 节点，从 'actual-only' 升格成 'both'。
 *
 * 桩**必须真的把它插进树里**：不插的话，"创建后自动选中新节点"那条用例里
 * `flatten(tree).get(r.path)` 查不到，AnnotationPanel 退回空态，断言"右栏能给它写
 * 注释"就变成了断言一个不存在的路径——正是本项目记录里那类"检查了周边、没检查目标"。
 *
 * 只处理 parentPath 为 '' 或某个顶层节点两种情形，本文件的用例只用到这两种。
 */
const withCreated = (parentPath: string, name: string, isDir: boolean): ViewNode[] => {
  const created: ViewNode = {
    name,
    path: parentPath === '' ? name : `${parentPath}/${name}`,
    isDir,
    origin: 'spec-only',
    ...(isDir ? { children: [] } : {}),
  }
  if (parentPath === '') return [...FIXTURE, created]
  return FIXTURE.map(n => n.path === parentPath
    ? { ...n, origin: 'both' as const, children: [...(n.children ?? []), created] }
    : n)
}

/** 与 core 的 createNode 同一条拼接规则（spec-edit.ts）：根下不带前导斜杠。
 *  桩里自己拼 `${parentPath}/${name}` 会在根下拼出 '/cases'，那正是 api.ts 里
 *  spec/createNode 特意返回 path 字段所要防的那种不一致——桩若也犯这个错，
 *  "UI 用的是 core 给的 path"这条就测不出来了。 */
const createdPath = (parentPath: string, name: string) =>
  parentPath === '' ? name : `${parentPath}/${name}`

/**
 * 把一次改名的结果做成 core 侧 merge 真实会给出的样子：旧路径那一行**整个消失**
 * （core 把它记进 hidden，见 Session.rename），新名字以 spec-only（虚线）出现，
 * 子树连同它们的路径跟着走。
 *
 * 桩必须真的这么改，不能原样返回 FIXTURE：不改的话"提交后重新选中改过名的那个节点"
 * 那条用例里 `flatten(tree).get(r.path)` 查不到，AnnotationPanel 退回空态，断言就
 * 变成了断言一个不存在的路径——正是本项目记录里那类"检查了周边、没检查目标"。
 *
 * 只处理顶层节点，本文件的改名用例只用到这一种。
 */
const withRenamed = (path: string, newName: string): ViewNode[] => {
  const target = FIXTURE.find(n => n.path === path)
  if (!target) return FIXTURE
  const renamed: ViewNode = {
    ...target,
    name: newName,
    path: newName,
    origin: 'spec-only',
    ...(target.children === undefined
      ? {}
      : { children: target.children.map(c => ({ ...c, path: `${newName}/${c.name}` })) }),
  }
  return [...FIXTURE.filter(n => n.path !== path), renamed]
}

/** 与 core 的 renameNode 同一条拼接规则：改名不换父级，根下的节点不带前导斜杠。
 *  桩若在根下拼出 '/lib'，"UI 用的是 core 给的 r.path、不是自己拼的"这条就测不出来了
 *  （api.ts 的 spec/rename 正是为这件事返回 path 字段）。 */
const renamedPath = (path: string, newName: string) => {
  const i = path.lastIndexOf('/')
  return i === -1 ? newName : `${path.slice(0, i)}/${newName}`
}

/**
 * 让一次响应晚 ms 毫秒才落地。真实宿主的往返必然晚于本次点击引发的渲染，"在途那一帧"
 * 里的缺陷只长在那个窗口里——零延迟的桩测不出来（与 groupBridge 上那段是同一条判据）。
 * 类型上骗过 FakeBridge 的同步 Handlers 签名：request() 本身是 async，返回 Promise
 * 时它会照常 await，运行时完全成立。
 */
const delayed = <T,>(value: T, ms = 20): T =>
  (new Promise(resolve => { setTimeout(() => resolve(value), ms) }) as unknown as T)

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
  // 下面三条是本轮（右键菜单 + 语言开关接线）接上的方法。加进这个共用工厂而不是逐条
  // 用例里补：App 现在会在既有流程里就调到它们（点语言开关必调 spec/setLang），
  // 桩缺一条，FakeBridge 会抛 "未配置方法"，那条报错会落到错误横幅上，把一批与本轮
  // 无关的既有用例污染成"界面上多了一条红横幅"。**既有用例的断言一个字没动。**
  'spec/createNode': ({ parentPath, name, isDir }: { parentPath: string; name: string; isDir: boolean }) => ({
    tree: tree(withCreated(parentPath, name, isDir)),
    dirty: true, groups: [G1], canUndo: true, canRedo: false,
    path: createdPath(parentPath, name),
  }),
  'spec/removeNode': () => ({ tree: tree(FIXTURE), dirty: true, groups: [G1], canUndo: true, canRedo: false }),
  'spec/rename': ({ path, newName }: { path: string; newName: string }) => ({
    tree: tree(withRenamed(path, newName)),
    dirty: true, groups: [G1], canUndo: true, canRedo: false,
    path: renamedPath(path, newName),
  }),
  // 切语言确实会置脏（core 会改写 lang 字段、可能连带换掉标题/导言），桩如实反映
  'spec/setLang': () => ({ tree: tree(FIXTURE), dirty: true, groups: [G1], canUndo: true, canRedo: false }),
  // 本轮（右键「复制」/「粘贴」）接上的方法。同样加进共用工厂而不是逐条用例里补：
  // 桩缺一条，FakeBridge 会抛 "未配置方法"，那条报错会落到错误横幅上，把一批与本轮
  // 无关的既有用例污染成"界面上多了一条红横幅"。**既有用例的断言一个字没动。**
  'spec/copyNode': ({ from, toParent }: { from: string; toParent: string }) => ({
    tree: tree(withCreated(toParent, copiedName(from, toParent), true)),
    dirty: true, groups: [G1], canUndo: true, canRedo: false,
    path: createdPath(toParent, copiedName(from, toParent)),
  }),
} as never)

/**
 * 落点的名字，照 core 的规则算（Session.uniqueCopyName）：**撞名才加后缀**，
 * 文件的后缀加在扩展名之前。
 *
 * 桩必须真的实现这条，不能一律原样返回源名字：往一个已经有同名兄弟的地方粘贴时，
 * 那样会造出一棵**同层重名**的树，React 当场报 duplicate key——而那是桩自己造的
 * 假象，被测代码并没有这个缺陷（core 那侧根本不可能产生同名兄弟）。
 *
 * 也不能一律加后缀：那样"UI 用的是 core 给的 r.path、不是自己拼的"这条就分不出来了
 * ——两种实现会给出同一个答案。默认桩走"不撞名 → 名字原样"这条路，带后缀的那一格由
 * 专门的用例自己改写 handler 覆盖。
 */
const copiedName = (from: string, toParent: string): string => {
  const base = from.slice(from.lastIndexOf('/') + 1)
  const siblings = (toParent === ''
    ? FIXTURE
    : FIXTURE.find(n => n.path === toParent)?.children ?? []).map(n => n.name)
  if (!siblings.includes(base)) return base
  const i = base.lastIndexOf('.')
  return i <= 0 ? `${base}-copy` : `${base.slice(0, i)}-copy${base.slice(i)}`
}

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
    // readOnly 有两条入口（App.tsx：`parseErrors !== null || viewMode === 'disk'`）。
    // 这条用例原来走 parseErrors：而 parseErrors 只有 openRoot 会写，且它与
    // setDirty(false) 在同一次 openRoot 调用里、之间没有任何 await——"parseErrors
    // 非空"与"dirty 仍是 true"在这个 App 里因此永远不可能同时成立，用这条入口测不出
    // `disabled` 那一半：删掉它，单靠 `!dirty` 这句断言照样为真。改走另一条入口
    // viewMode === 'disk'——它不碰 dirty（switchViewMode 只改 tree/viewMode），
    // 能在编辑之后真正切进只读态，让 `disabled` 那一半承重（与下面"原始结构"视图下
    // 保存按钮被禁用那条用例走的是同一个可达状态，此处专门覆盖"只读模式下保存按钮
    // 禁用"这条独立断言）。
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    clickFirstRow(container)
    await waitFor(() => screen.getByLabelText('注释'))
    fireEvent.change(screen.getByLabelText('注释'), { target: { value: 'x' } })
    fireEvent.blur(screen.getByLabelText('注释'))
    await waitFor(() => expect((screen.getByText('保存') as HTMLButtonElement).disabled).toBe(false))

    fireEvent.click(screen.getByText('原始结构'))
    await waitFor(() => expect(bridge.lastCall('view/setMode')).toEqual({ mode: 'disk' }))

    // dirty 此刻仍是 true；保存按钮被禁用必须是 viewMode === 'disk' 让 readOnly
    // 成立起的作用，不是靠 !dirty 侥幸为真。
    expect((screen.getByText('保存') as HTMLButtonElement).disabled).toBe(true)
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

  // 窄路径复现：两个宿主的消息回调都不排队（cli/src/server.ts 的
  // `socket.on('message', async ...)`、vscode/src/editor.ts 的 `onDidReceiveMessage`），
  // spec/save 横跨落盘的那个 await 期间完全可能又落地一笔 spec/annotate。core 侧
  // session.save() 已经用捕获时的 revision 记账，会如实在响应里回报 dirty: true——
  // 但如果 UI 收到 spec/save 成功后无条件 setDirty(false)，界面上的脏标记会被
  // 错误地抹掉，用户以为存好了、其实第二笔编辑从未写盘。
  //
  // 用手写 Bridge（不走 FakeBridge）把 spec/save 挂在一个受控 Promise 上，才能在
  // 它 resolve 之前插入一次真实的 fireEvent 编辑——这是唯一能让"编辑落在保存的
  // await 期间"这件事真实发生的桩形态，参照的是本文件"先点的大文件晚回来时"那条
  // 用例已经验证过的手法。
  it('保存的 await 期间落地一笔编辑，保存完成后脏标记必须仍然亮着', async () => {
    let resolveSave!: (v: { written: boolean; dirty: boolean }) => void
    let annotateCalls = 0
    let saveCalls = 0
    const bridge: Bridge = {
      request: (async (method: string, _params: unknown) => {
        if (method === 'workspace/open') return openResult()
        if (method === 'spec/annotate') {
          annotateCalls += 1
          return {
            tree: tree([{ ...SRC, annotation: `第${annotateCalls}版`, origin: 'both' }, DOCS, README]),
            dirty: true, groups: [G1], canUndo: true, canRedo: false,
          }
        }
        if (method === 'spec/save') {
          saveCalls += 1
          return new Promise(res => { resolveSave = res })
        }
        throw new Error(`本用例未配置 ${method}`)
      }) as Bridge['request'],
      on: () => () => {},
    }

    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))
    clickFirstRow(container)
    await waitFor(() => screen.getByLabelText('注释'))
    fireEvent.change(screen.getByLabelText('注释'), { target: { value: '第一版' } })
    fireEvent.blur(screen.getByLabelText('注释'))
    await waitFor(() => expect((screen.getByText('保存') as HTMLButtonElement).disabled).toBe(false))

    fireEvent.click(screen.getByText('保存'))   // spec/save 挂起，尚未 resolve
    await waitFor(() => expect(saveCalls).toBe(1))

    // 保存的 await 期间，第二笔编辑先落地——它此刻从未写盘
    fireEvent.change(screen.getByLabelText('注释'), { target: { value: '第二版——保存期间落地' } })
    fireEvent.blur(screen.getByLabelText('注释'))
    await waitFor(() => expect(annotateCalls).toBe(2))

    // 保存这才完成；桩如实回报 dirty: true（对应 core 侧 rawForSave 捕获的是
    // 第一版的 revision，"第二版"从未被这次保存覆盖）
    await act(async () => { resolveSave({ written: true, dirty: true }) })

    expect((screen.getByText('保存') as HTMLButtonElement).disabled).toBe(false)
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

    // 收尾：桩延迟 60ms，测试体到这里跑完时那笔 spec/setGroup 还在途，它的落地会在
    // act 之外更新 react-arborist 的 List，React 因此报 "not wrapped in act"。等它
    // 回来，让落地留在 act 里。上面那三句断言（含"故意不 await"的那一句）一个字没动——
    // 它们仍然排在这句 await 之前，在途那一帧照样被钉着。
    await act(async () => { await new Promise(r => setTimeout(r, 80)) })
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

      // 切视图前先提交一次编辑，让 dirty 变成 true——保存按钮是
      // `disabled={disabled || !dirty}`，若切视图前 dirty 仍是初始的 false，
      // 下面对保存按钮的断言单靠 `!dirty` 那一半就恒真，测不出 `disabled`
      // （也就是 viewMode === 'disk'）那一半是否真的在起作用。
      clickFirstRow(container)
      await waitFor(() => screen.getByLabelText('注释'))
      fireEvent.change(screen.getByLabelText('注释'), { target: { value: '核心源码' } })
      fireEvent.blur(screen.getByLabelText('注释'))
      await waitFor(() => expect((screen.getByText('保存') as HTMLButtonElement).disabled).toBe(false))

      fireEvent.click(screen.getByRole('button', { name: '原始结构' }))
      await waitFor(() => expect(bridge.lastCall('view/setMode')).toEqual({ mode: 'disk' }))

      // 横幅必须解释"为什么现在点不动"，且要给出怎么切回去——不能让用户自己猜。
      // 用 role="status" 定位而不是文字：顶栏的切换按钮本身文字也含"原始结构"，
      // 用文字找会撞上"多个元素匹配"（已实测：改用 getByText 前先见过这条报错）。
      await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/原始结构/))
      // dirty 此刻仍是 true（switchViewMode 不碰它）；保存按钮被禁用必须是
      // viewMode === 'disk' 起的作用，不是靠 !dirty 侥幸为真——这才是本用例
      // 真正要守住的那句断言。
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

      // 撤销一次，把 canRedo 也变成 true（桩的 spec/undo 回 canRedo: true）——
      // 不然下面对"重做"按钮的断言在 open() 之前本来就是 false（初始态从未启用过），
      // open() 有没有把它复位跟这句断言毫无关系，是一句恒真断言，测不出任何东西。
      fireEvent.click(screen.getByText('撤销'))
      await waitFor(() => expect((screen.getByText('重做') as HTMLButtonElement).disabled).toBe(false))

      fireEvent.click(screen.getByText('载入'))   // 重新打开当前根

      await waitFor(() => expect(bridge.calls.filter(c => c.method === 'workspace/open').length).toBe(2))
      await waitFor(() => expect((screen.getByText('撤销') as HTMLButtonElement).disabled).toBe(true))
      // 此刻 canRedo 承重：open() 之前它确实是 true（上面已断言过），这里变回
      // true 才真正证明 open() 把它复位了，而不是从头到尾都没变过。
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

// 本轮（UI 双语）范围严格限定在"操作界面"本身：开关不调用 spec/setLang（那会写进
// front-matter，是下一轮的事），初始语言也不取自 OpenResult.lang——即便这个字段现在
// 已经存在（core 侧另一轮已经加上了，openResult() 工厂那句 `lang: 'zh'` 就是为了满足
// 这个必填字段），本轮仍然按 brief 的既定范围不接这根线，留给下一轮一起接。所以这里的
// 用例只覆盖"点了开关之后界面文案真的变了"，不涉及任何 bridge 调用、不涉及持久化——
// 默认永远是 zh，这是有意的、暂时的行为。
describe('App 界面语言切换（右上角开关）', () => {
  it('默认是中文界面', async () => {
    const bridge = bridgeWith()
    render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    expect(screen.getByText('载入')).toBeTruthy()
    expect(screen.getByRole('button', { name: '中文' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'English' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('点击 English 后，顶栏按钮文案切成英文，且不需要重新载入工作区', async () => {
    const bridge = bridgeWith()
    render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))
    const openCallsBefore = bridge.calls.filter(c => c.method === 'workspace/open').length

    fireEvent.click(screen.getByRole('button', { name: 'English' }))

    expect(screen.getByText('Load')).toBeTruthy()
    expect(screen.getByText('My Structure')).toBeTruthy()
    expect(screen.getByText('Disk Structure')).toBeTruthy()
    expect(screen.getByText('Undo')).toBeTruthy()
    expect(screen.getByText('Redo')).toBeTruthy()
    expect(screen.getByText('Save')).toBeTruthy()
    expect(screen.getByLabelText('Workspace path')).toBeTruthy()
    // 切语言是纯前端状态，不经过 bridge——没有多打一次 workspace/open
    expect(bridge.calls.filter(c => c.method === 'workspace/open').length).toBe(openCallsBefore)

    // 上面每一句断言都刻意排在 fireEvent 之后、不带 await：界面文案是**同步**切的，
    // 一旦有人把它改成"等 spec/setLang 回来再切"，这些断言必须立刻变红。
    // 但点击同时还发出了一笔 spec/setLang（契约 front-matter 里的 lang 字段，见
    // App.handleSetLang 那两条线），它的落地回调会在测试体跑完之后才更新 state，
    // React 因此报 "not wrapped in act"。收尾冲一次微任务，让那笔落地留在 act 里——
    // 断言一个字没动，只是不再把噪声打进测试输出。
    await flushChain()
  })

  it('切到 English 再切回中文，文案回到今天原本的样子', async () => {
    const bridge = bridgeWith()
    render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    fireEvent.click(screen.getByRole('button', { name: 'English' }))
    expect(screen.getByText('Load')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '中文' }))
    expect(screen.getByText('载入')).toBeTruthy()
    expect(screen.getByText('撤销')).toBeTruthy()
    expect(screen.getByText('重做')).toBeTruthy()
    expect(screen.getByLabelText('工作区路径')).toBeTruthy()

    // 两次点击各发出一笔 spec/setLang，收尾一起冲掉，理由同上一条用例
    await flushChain()
  })

  // 本轮唯一的安全属性钉在这里：切到英文界面，用户自己写的中文注释必须原样显示，
  // 不能被当成"界面文案"一起过一遍字典。annotation 是数据，不是我们写的 chrome。
  it('英文界面下，节点上用户写的中文注释原样显示，不被翻译', async () => {
    const bridge = bridgeWith({
      tree: tree([{ ...SRC, annotation: '核心源码', origin: 'both' }, DOCS, README]),
    })
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    fireEvent.click(screen.getByRole('button', { name: 'English' }))
    expect(screen.getByText('Load')).toBeTruthy() // 先确认界面确实已经在英文态，不是误判

    // 行内摘要（NodeRow 里的 .fs-annotation）在切到英文之前就已经渲染，且从不经过 t()
    expect(screen.getByText('核心源码')).toBeTruthy()

    clickFirstRow(container) // FIXTURE 顺序固定，第一行是带注释的 src
    await waitFor(() => screen.getByLabelText('Annotation'))
    expect((screen.getByLabelText('Annotation') as HTMLTextAreaElement).value).toBe('核心源码')
  })
})

// ---------------------------------------------------------------------------
// 本轮：右键菜单（新建声明 / 取消声明）+ 语言开关接上 core
// ---------------------------------------------------------------------------

/** 菜单项按可见文案取。用 role 而不是 getByText：三条都是 <button role="menuitem">，
 *  禁用态也留在可访问性树里，"灰着"与"没渲染"这两种结果因此能被区分开。 */
const menuItem = (name: string) => screen.getByRole('menuitem', { name }) as HTMLButtonElement

/** 在某一行上按右键。坐标随便给一个非零值，只为验证浮层确实读了事件坐标 */
const rightClickRow = (container: HTMLElement, rowName: string) =>
  fireEvent.contextMenu(rowByName(container, rowName), { clientX: 120, clientY: 240 })

const nameInput = () => screen.getByLabelText('名称') as HTMLInputElement
const createBtn = () => screen.getByRole('button', { name: '创建' }) as HTMLButtonElement

describe('右键菜单：新建声明（仅契约）', () => {
  it('右键点在目录上：菜单写明目标，新建落在该目录下', async () => {
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    rightClickRow(container, 'src/')
    // 菜单顶部就是它作用的对象——右键刻意不改选中集，没有高亮可依赖
    expect(container.querySelector('.fs-context-menu-header')?.textContent).toBe('src')
    // 「仅契约」三个字是用户点名要的，它防的正是"以为点完磁盘上会冒出一个目录"
    expect(menuItem('新建目录（仅契约）')).toBeTruthy()

    fireEvent.click(menuItem('新建目录（仅契约）'))
    expect(screen.getByText('在「src」下新建目录（仅契约）')).toBeTruthy()

    fireEvent.change(nameInput(), { target: { value: 'cases' } })
    fireEvent.click(createBtn())

    await waitFor(() => expect(bridge.lastCall('spec/createNode'))
      .toEqual({ parentPath: 'src', name: 'cases', isDir: true }))
  })

  it('右键点在文件上：新建落到它的父目录，对话框标题写明真实目标', async () => {
    // 夹具必须是**嵌套**的文件（src/a.ts），不能拿顶层文件充数：顶层文件的父目录是
    // ''，与"空白区域 → 根"给出同一个答案，用它当夹具的话，即便实现根本没算父目录、
    // 直接退回根，用例照样绿——本项目记录里那类"检查了周边、没检查目标"的形状。
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    fireEvent.click(rowByName(container, 'src/')) // 展开，让 a.ts 出现在树上
    rightClickRow(container, 'a.ts')

    // 菜单说的是"你右键点中的那一个"
    expect(container.querySelector('.fs-context-menu-header')?.textContent).toBe('src/a.ts')

    fireEvent.click(menuItem('新建目录（仅契约）'))
    // 对话框说的是"真正会写到哪儿"。这一行就是"我明明点的是这个文件"那层困惑的解药
    expect(screen.getByText('在「src」下新建目录（仅契约）')).toBeTruthy()

    fireEvent.change(nameInput(), { target: { value: 'cases' } })
    fireEvent.click(createBtn())

    await waitFor(() => expect(bridge.lastCall('spec/createNode'))
      .toEqual({ parentPath: 'src', name: 'cases', isDir: true }))
  })

  it('树的空白区域右键：建在工作区根下', async () => {
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    const pane = container.querySelector('.fs-pane-tree') as HTMLElement
    fireEvent.contextMenu(pane, { clientX: 30, clientY: 400 })

    expect(container.querySelector('.fs-context-menu-header')?.textContent).toBe('工作区根')
    // 空白处没有节点被点中，「取消声明」整条不该出现（根节点本来也移不掉）
    expect(screen.queryByRole('menuitem', { name: '取消声明' })).toBeNull()

    fireEvent.click(menuItem('新建目录（仅契约）'))
    expect(screen.getByText('在「工作区根」下新建目录（仅契约）')).toBeTruthy()
    fireEvent.change(nameInput(), { target: { value: 'cases' } })
    fireEvent.click(createBtn())

    await waitFor(() => expect(bridge.lastCall('spec/createNode'))
      .toEqual({ parentPath: '', name: 'cases', isDir: true }))
    // 根下建出来的节点，路径是 'cases' 而不是 '/cases'。这条断言承的是"选中新节点时
    // 用的是 core 回来的 r.path、不是 UI 自己拼的 parentPath + name"——两边拼接规则
    // 在根这一档正好分叉（api.ts 的 spec/createNode 就是为这件事加的 path 字段），
    // 非根的情形下自己拼恰好也对，测不出来。
    await waitFor(() => expect(container.querySelector('.fs-panel-path')?.textContent).toBe('cases'))
  })

  it('顶栏「新建」按钮等价于在根下建', async () => {
    const bridge = bridgeWith()
    render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    fireEvent.click(screen.getByText('新建'))
    fireEvent.click(menuItem('新建文件（仅契约）'))
    fireEvent.change(nameInput(), { target: { value: 'CHANGELOG.md' } })
    fireEvent.click(createBtn())

    await waitFor(() => expect(bridge.lastCall('spec/createNode'))
      .toEqual({ parentPath: '', name: 'CHANGELOG.md', isDir: false }))
  })

  it('「新建文件（仅契约）」提交的 isDir 是 false，不是目录', async () => {
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    rightClickRow(container, 'src/')
    fireEvent.click(menuItem('新建文件（仅契约）'))
    expect(screen.getByText('在「src」下新建文件（仅契约）')).toBeTruthy()
    fireEvent.change(nameInput(), { target: { value: 'index.ts' } })
    fireEvent.click(createBtn())

    await waitFor(() => expect(bridge.lastCall('spec/createNode'))
      .toEqual({ parentPath: 'src', name: 'index.ts', isDir: false }))
  })

  it('Esc 取消：对话框消失，一个写请求都没发出去', async () => {
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    rightClickRow(container, 'src/')
    fireEvent.click(menuItem('新建目录（仅契约）'))
    fireEvent.change(nameInput(), { target: { value: 'cases' } })
    fireEvent.keyDown(nameInput(), { key: 'Escape' })

    expect(screen.queryByLabelText('名称')).toBeNull()
    await flushChain()
    expect(bridge.calls.some(c => c.method === 'spec/createNode')).toBe(false)
  })

  it('名字全是空白时不提交：创建按钮不可点，回车也发不出请求', async () => {
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    rightClickRow(container, 'src/')
    fireEvent.click(menuItem('新建目录（仅契约）'))
    fireEvent.change(nameInput(), { target: { value: '   ' } })

    expect(createBtn().disabled).toBe(true)
    fireEvent.keyDown(nameInput(), { key: 'Enter' })
    await flushChain()
    expect(bridge.calls.some(c => c.method === 'spec/createNode')).toBe(false)
    // 对话框留着，用户补个名字就能继续——不是悄悄关掉
    expect(screen.getByLabelText('名称')).toBeTruthy()
  })

  it('创建成功后自动选中新节点，右栏立刻能给它写注释', async () => {
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    rightClickRow(container, 'src/')
    fireEvent.click(menuItem('新建目录（仅契约）'))
    fireEvent.change(nameInput(), { target: { value: 'cases' } })
    fireEvent.click(createBtn())

    // 选中的是 core 回来的那个 path，不是 UI 自己拼的（根路径是 '' 时两边拼接规则
    // 一旦不一致就会选中错的节点，见 api.ts 的 spec/createNode）
    await waitFor(() => expect(container.querySelector('.fs-panel-path')?.textContent).toBe('src/cases'))
    expect((screen.getByLabelText('注释') as HTMLTextAreaElement).disabled).toBe(false)
    // 它是"契约里的声明"，磁盘上并不存在——面板据 origin 如实说明，正是本功能的全部意义
    expect(screen.getByText('spec 中声明，磁盘上不存在——可能待创建，也可能已被删除')).toBeTruthy()
    // 对话框收掉，脏标记亮起
    expect(screen.queryByLabelText('名称')).toBeNull()
    expect((screen.getByText('保存') as HTMLButtonElement).disabled).toBe(false)
  })

  it('提交在途时创建按钮禁用，回车也提交不出第二笔', async () => {
    const bridge = bridgeWith()
    bridge.setHandler('spec/createNode', ((p: { parentPath: string; name: string; isDir: boolean }) =>
      delayed({
        tree: tree(withCreated(p.parentPath, p.name, p.isDir)),
        dirty: true, groups: [G1], canUndo: true, canRedo: false,
        path: createdPath(p.parentPath, p.name),
      })) as never)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    rightClickRow(container, 'src/')
    fireEvent.click(menuItem('新建目录（仅契约）'))
    fireEvent.change(nameInput(), { target: { value: 'cases' } })
    fireEvent.keyDown(nameInput(), { key: 'Enter' })

    // 在途那一帧：按钮已经灰了
    expect(createBtn().disabled).toBe(true)
    fireEvent.keyDown(nameInput(), { key: 'Enter' })

    await waitFor(() => expect(screen.queryByLabelText('名称')).toBeNull())
    expect(bridge.calls.filter(c => c.method === 'spec/createNode').length).toBe(1)
  })
})

const renameInput = () => screen.getByLabelText('新名称') as HTMLInputElement
const renameBtn = () => screen.getByRole('button', { name: '重命名' }) as HTMLButtonElement

/**
 * 重命名走的是与「新建声明」同一个输入框（NewNodeDialog 的 kind: 'rename' 分支），
 * 所以 Esc / 空名字 / 在途禁用这三条在这里再钉一遍不是重复——它们要防的是"分派到
 * 改名这条分支之后某一件悄悄走样"，而不是那个组件本身。
 */
describe('右键菜单：重命名（仅契约）', () => {
  it('菜单项排在「新建…」与「取消声明」之间；契约里没声明过的节点上照样可点', async () => {
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    rightClickRow(container, 'src/') // SRC 在 FIXTURE 里是 actual-only
    // 上一轮在末尾追加了「复制路径」「复制相对路径」，这一轮又在它们之前插进了
    // 「复制」「粘贴（仅契约）」。这条断言是**穷举**的（querySelectorAll 全取），
    // 加菜单项就必然要跟着补——这正是它的价值：菜单里多出/少掉任何一项都瞒不过去。
    // 它钉的"改名排在新建与取消声明之间"这层语义一个字没变。
    expect(Array.from(container.querySelectorAll('[role="menuitem"]')).map(b => b.textContent))
      .toEqual(['新建目录（仅契约）', '新建文件（仅契约）', '重命名（仅契约）', '取消声明',
        '复制', '粘贴（仅契约）', '复制路径', '复制相对路径'])
    // 同一个节点上：改名可点、取消声明是灰的——两条菜单项用的**不是**同一条判据。
    // 少了这半条对照，"改名故意不看 declared"这件事就没有任何用例能侦测到。
    expect(menuItem('重命名（仅契约）').disabled).toBe(false)
    expect(menuItem('取消声明').disabled).toBe(true)
  })

  it('输入框预填当前名字，提交后带着新名字发出 spec/rename', async () => {
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    rightClickRow(container, 'src/')
    fireEvent.click(menuItem('重命名（仅契约）'))
    // 标题说的是"哪个节点"，不是"建在哪儿"——这是改名与新建唯一要分开的一件事
    expect(screen.getByText('重命名「src」（仅契约）')).toBeTruthy()
    // 「不会重命名磁盘上的任何文件」这句是本功能最容易被误解的地方，必须在眼前
    expect(screen.getByText(
      '只改契约里声明的名字，不会重命名磁盘上的任何文件或目录——真正去改名的是随后读契约的 Agent。',
    )).toBeTruthy()

    expect(renameInput().value).toBe('src') // 预填当前名字
    fireEvent.change(renameInput(), { target: { value: 'lib' } })
    fireEvent.click(renameBtn())

    await waitFor(() => expect(bridge.lastCall('spec/rename')).toEqual({ path: 'src', newName: 'lib' }))
  })

  it('提交后用 core 返回的 path 重新选中改过名的那个节点，右栏立刻能给它写注释', async () => {
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    rightClickRow(container, 'src/')
    fireEvent.click(menuItem('重命名（仅契约）'))
    fireEvent.change(renameInput(), { target: { value: 'lib' } })
    fireEvent.click(renameBtn())

    // 'lib' 而不是 '/lib'：根下的节点两边拼接规则正好分叉，这条承的是"UI 用的是
    // core 回来的 r.path、不是自己拼的"（api.ts 的 spec/rename）
    await waitFor(() => expect(container.querySelector('.fs-panel-path')?.textContent).toBe('lib'))
    expect((screen.getByLabelText('注释') as HTMLTextAreaElement).disabled).toBe(false)
    // 对话框收掉、脏标记亮起
    expect(screen.queryByLabelText('新名称')).toBeNull()
    expect((screen.getByText('保存') as HTMLButtonElement).disabled).toBe(false)
  })

  it('文件节点也能改名，目标是它自己而不是它的父目录', async () => {
    // 「新建」在文件上会落到父目录（ContextMenuTarget.parentPath），改名不能跟着走：
    // 用文件来测正是为了让这条区别真的承重。
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    rightClickRow(container, 'README.md')
    fireEvent.click(menuItem('重命名（仅契约）'))
    expect(renameInput().value).toBe('README.md')
    fireEvent.change(renameInput(), { target: { value: 'READ.md' } })
    fireEvent.click(renameBtn())

    await waitFor(() => expect(bridge.lastCall('spec/rename'))
      .toEqual({ path: 'README.md', newName: 'READ.md' }))
  })

  it('Esc 取消：对话框消失，一个写请求都没发出去', async () => {
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    rightClickRow(container, 'src/')
    fireEvent.click(menuItem('重命名（仅契约）'))
    fireEvent.change(renameInput(), { target: { value: 'lib' } })
    fireEvent.keyDown(renameInput(), { key: 'Escape' })

    expect(screen.queryByLabelText('新名称')).toBeNull()
    await flushChain()
    expect(bridge.calls.some(c => c.method === 'spec/rename')).toBe(false)
  })

  it('名字全是空白时不提交：按钮不可点，回车也发不出请求', async () => {
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    rightClickRow(container, 'src/')
    fireEvent.click(menuItem('重命名（仅契约）'))
    fireEvent.change(renameInput(), { target: { value: '   ' } })

    expect(renameBtn().disabled).toBe(true)
    fireEvent.keyDown(renameInput(), { key: 'Enter' })
    await flushChain()
    expect(bridge.calls.some(c => c.method === 'spec/rename')).toBe(false)
    expect(screen.getByLabelText('新名称')).toBeTruthy() // 对话框留着，补个名字就能继续
  })

  it('提交在途时按钮禁用，连按两次回车也只发得出一笔', async () => {
    const bridge = bridgeWith()
    bridge.setHandler('spec/rename', ((p: { path: string; newName: string }) => delayed({
      tree: tree(withRenamed(p.path, p.newName)),
      dirty: true, groups: [G1], canUndo: true, canRedo: false,
      path: renamedPath(p.path, p.newName),
    })) as never)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    rightClickRow(container, 'src/')
    fireEvent.click(menuItem('重命名（仅契约）'))
    fireEvent.change(renameInput(), { target: { value: 'lib' } })
    fireEvent.keyDown(renameInput(), { key: 'Enter' })

    expect(renameBtn().disabled).toBe(true) // 在途那一帧：按钮已经灰了
    fireEvent.keyDown(renameInput(), { key: 'Enter' })

    await waitFor(() => expect(screen.queryByLabelText('新名称')).toBeNull())
    expect(bridge.calls.filter(c => c.method === 'spec/rename').length).toBe(1)
  })

  it('切进「原始结构」只读视图：开着的改名输入框被收掉，菜单项也禁用', async () => {
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    rightClickRow(container, 'src/')
    fireEvent.click(menuItem('重命名（仅契约）'))
    expect(screen.getByLabelText('新名称')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '原始结构' }))
    await waitFor(() => expect(screen.queryByLabelText('新名称')).toBeNull())

    rightClickRow(container, 'src/')
    expect(menuItem('重命名（仅契约）').disabled).toBe(true)
  })

  it('输入框开着时按撤销：草稿留在屏幕上，目标也不跟着树漂移', async () => {
    // 目标在菜单被点中那一刻就冻住了（ContextMenuTarget）。撤销会换掉整棵树，
    // 若草稿的目标跟着重算，用户按下「重命名」时改的会是另一个节点。
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    // 先落一笔编辑，撤销按钮才点得动
    rightClickRow(container, 'src/')
    fireEvent.click(menuItem('新建目录（仅契约）'))
    fireEvent.change(nameInput(), { target: { value: 'cases' } })
    fireEvent.click(createBtn())
    await waitFor(() => expect((screen.getByText('撤销') as HTMLButtonElement).disabled).toBe(false))

    rightClickRow(container, 'README.md')
    fireEvent.click(menuItem('重命名（仅契约）'))
    fireEvent.click(screen.getByText('撤销'))
    await flushChain()

    expect(renameInput().value).toBe('README.md')
    fireEvent.change(renameInput(), { target: { value: 'READ.md' } })
    fireEvent.click(renameBtn())
    await waitFor(() => expect(bridge.lastCall('spec/rename'))
      .toEqual({ path: 'README.md', newName: 'READ.md' }))
  })

  it('提交在途时用户点了别的节点：落地后不把右栏拽到改过名的那个节点上', async () => {
    const bridge = bridgeWith()
    bridge.setHandler('spec/rename', ((p: { path: string; newName: string }) => delayed({
      tree: tree(withRenamed(p.path, p.newName)),
      dirty: true, groups: [G1], canUndo: true, canRedo: false,
      path: renamedPath(p.path, p.newName),
    }, 40)) as never)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    rightClickRow(container, 'src/')
    fireEvent.click(menuItem('重命名（仅契约）'))
    fireEvent.change(renameInput(), { target: { value: 'lib' } })
    fireEvent.click(renameBtn())

    // 用户亲手改了选中（这一下让 selectionEpochRef 自增）
    fireEvent.click(rowByName(container, 'README.md'))
    await act(async () => { await new Promise(r => setTimeout(r, 80)) })

    // 右栏必须停在用户自己点的那个节点上；被拽走会连带清掉他正在写的注释
    expect(container.querySelector('.fs-panel-path')?.textContent).toBe('README.md')
    // 而这笔编辑本身照常落地：树、脏标记、撤销可用性都得更新
    expect((screen.getByText('保存') as HTMLButtonElement).disabled).toBe(false)
    expect(rowsOf(container).some(r => r.querySelector('.fs-name')?.textContent === 'lib/')).toBe(true)
  })

  it('在别的行上再按一次右键：上一个改名草稿被收掉，屏幕上只留一个', async () => {
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    rightClickRow(container, 'src/')
    fireEvent.click(menuItem('重命名（仅契约）'))
    expect(renameInput().value).toBe('src')

    rightClickRow(container, 'docs/')
    expect(screen.queryByLabelText('新名称')).toBeNull()
    fireEvent.click(menuItem('重命名（仅契约）'))
    expect(renameInput().value).toBe('docs')
  })
})

describe('重命名：core 的报错必须原样显示在界面上', () => {
  const expectBannerAndKeepDraft = async (msg: string) => {
    const bridge = bridgeWith()
    bridge.setHandler('spec/rename', (() => { throw new Error(msg) }) as never)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    rightClickRow(container, 'src/')
    fireEvent.click(menuItem('重命名（仅契约）'))
    fireEvent.change(renameInput(), { target: { value: 'docs' } })
    fireEvent.click(renameBtn())

    await waitFor(() => expect(screen.getByText(msg)).toBeTruthy())
    // 输入框与已经打好的名字都留着：这几条全是用户能就地补救的
    expect(renameInput().value).toBe('docs')
  }

  it('撞上磁盘上的同名条目：那段话一字不改地出现在横幅上', async () => {
    await expectBannerAndKeepDraft(
      '`docs` 在磁盘上已经存在：改成这个名字会让契约把两个不同的东西说成同一个，'
      + '两边的注释也会被揉到一起。请换一个名字（本工具不会去动磁盘上的文件名）',
    )
  })

  it('撞上契约里的同名声明：同样原样显示', async () => {
    await expectBannerAndKeepDraft('`src` 下已经有同名节点 `docs`：同层同名兄弟是重复声明，解析器会拒绝，请换个名字')
  })

  it('名字非法（core 在输入边界拦下的那几条）：原样显示，UI 不复述一遍规则', async () => {
    await expectBannerAndKeepDraft('名字 "a/b" 不能包含 "/"：这里只接受单个路径段，不是路径')
  })
})

describe('右键菜单：取消声明', () => {
  it('契约里没有声明过的节点（origin: actual-only）上不可点，点了也不发请求', async () => {
    // README.md 在 FIXTURE 里是 actual-only —— 磁盘上有、契约里没有
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    rightClickRow(container, 'README.md')
    const item = menuItem('取消声明')
    expect(item.disabled).toBe(true)
    // 灰着还得说得出原因，否则只是把"点了没反应"换成"灰着没理由"
    expect(item.getAttribute('title')).toBe('这个节点在契约里还没有任何声明，没有可取消的东西')

    fireEvent.click(item)
    await flushChain()
    expect(bridge.calls.some(c => c.method === 'spec/removeNode')).toBe(false)
  })

  it('已声明的节点（origin: both）上可点，发出 spec/removeNode 并回填脏标记与撤销栈', async () => {
    const bridge = bridgeWith({
      tree: tree([{ ...SRC, origin: 'both', annotation: '核心源码' }, DOCS, README]),
    })
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))
    expect((screen.getByText('撤销') as HTMLButtonElement).disabled).toBe(true)

    rightClickRow(container, 'src/')
    expect(menuItem('取消声明').disabled).toBe(false)
    fireEvent.click(menuItem('取消声明'))

    await waitFor(() => expect(bridge.lastCall('spec/removeNode')).toEqual({ path: 'src' }))
    // EditResult 照常回填：脏标记亮、撤销可用（core 侧 removeNode 走的是同一套收口）
    await waitFor(() => expect((screen.getByText('保存') as HTMLButtonElement).disabled).toBe(false))
    expect((screen.getByText('撤销') as HTMLButtonElement).disabled).toBe(false)
    // 点完菜单要收掉，不能悬在屏幕上
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('spec-only 节点（契约里有、磁盘上没有）同样可以取消声明', async () => {
    const GHOST: ViewNode = { name: 'cases', path: 'cases', isDir: true, origin: 'spec-only', children: [] }
    const bridge = bridgeWith({ tree: tree([...FIXTURE, GHOST]) })
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    rightClickRow(container, 'cases/')
    expect(menuItem('取消声明').disabled).toBe(false)
    fireEvent.click(menuItem('取消声明'))
    await waitFor(() => expect(bridge.lastCall('spec/removeNode')).toEqual({ path: 'cases' }))
  })
})

describe('取消声明之后的选中集清理', () => {
  /** 契约里有、磁盘上没有的一个目录，带一个同样只存在于契约里的子节点 */
  const GHOST: ViewNode = {
    name: 'cases', path: 'cases', isDir: true, origin: 'spec-only',
    children: [{ name: 'x.md', path: 'cases/x.md', isDir: false, origin: 'spec-only', annotation: '占位' }],
  }
  /** 取消声明落地后 core 那侧的树：cases 整棵（连同 cases/x.md）从树上消失 */
  const removedGhost = () =>
    ({ tree: tree(FIXTURE), dirty: true, groups: [G1], canUndo: true, canRedo: false })

  it('取消一个 spec-only 节点的声明后，它的路径不再留在选中集里（否则会被写进分组成员）', async () => {
    const bridge = bridgeWith({ tree: tree([...FIXTURE, GHOST]) })
    bridge.setHandler('spec/removeNode', (() => removedGhost()) as never)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    // 先单击它——右栏证明它确实进了选中集
    fireEvent.click(rowByName(container, 'cases/'))
    await waitFor(() => expect(container.querySelector('.fs-panel-path')?.textContent).toBe('cases'))

    rightClickRow(container, 'cases/')
    fireEvent.click(menuItem('取消声明'))
    // 树上真的没有这一行了（前提先钉死，否则后面测的是另一回事）
    await waitFor(() => expect(rowsOf(container).some(
      r => r.querySelector('.fs-name')?.textContent === 'cases/')).toBe(false))
    // 右栏回到空态：选中集空了本来就该是这个样子
    await waitFor(() => expect(container.querySelector('.fs-panel-path')).toBeNull())

    // 关键的一步：接着 ctrl 点另一个节点。幽灵还在选中集里的话，这一下会变成"两项"，
    // 右栏跳出分组面板，一次失焦就把树上根本不存在的 'cases' 写进 members。
    fireEvent.click(rowByName(container, 'README.md'), { ctrlKey: true })
    await waitFor(() => expect(container.querySelector('.fs-panel-path')?.textContent).toBe('README.md'))
    expect(screen.queryByText(/已选中 2 项/)).toBeNull()
  })

  it('取消一个目录的声明会连带抹掉它的子声明，子路径也要一起离开选中集', async () => {
    const bridge = bridgeWith({ tree: tree([...FIXTURE, GHOST]) })
    bridge.setHandler('spec/removeNode', (() => removedGhost()) as never)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    // 展开 cases/，把子节点 x.md 也选进来——选中集这时是 ['cases/x.md']
    fireEvent.click(rowByName(container, 'cases/'))
    await waitFor(() => rowByName(container, 'x.md'))
    fireEvent.click(rowByName(container, 'x.md'))
    await waitFor(() => expect(container.querySelector('.fs-panel-path')?.textContent).toBe('cases/x.md'))

    // 取消的是**父目录**的声明，子声明被 core 一并抹掉
    rightClickRow(container, 'cases/')
    fireEvent.click(menuItem('取消声明'))
    await waitFor(() => expect(container.querySelector('.fs-panel-path')).toBeNull())

    fireEvent.click(rowByName(container, 'README.md'), { ctrlKey: true })
    await waitFor(() => expect(container.querySelector('.fs-panel-path')?.textContent).toBe('README.md'))
    // 只剔了 path 自己、没剔子路径的话，这里会是"已选中 2 项"（cases/x.md + README.md）
    expect(screen.queryByText(/已选中 2 项/)).toBeNull()
  })

  it('磁盘上真实存在的节点取消声明后行还在树上，选中集不许跟着被剔掉', async () => {
    // 这条钉的是反方向：按 `path + '/'` 前缀无脑剔的实现会在这里把 src 剔出去，
    // 用户看到的是"我右键的那一行还高亮着，右栏却空了"。
    const bridge = bridgeWith({ tree: tree([{ ...SRC, origin: 'both', annotation: '核心源码' }, DOCS, README]) })
    bridge.setHandler('spec/removeNode', (() => ({
      // 取消声明只去掉标注，src 因为磁盘上真的有，照旧留在树上
      tree: tree([{ ...SRC, origin: 'actual-only' }, DOCS, README]),
      dirty: true, groups: [G1], canUndo: true, canRedo: false,
    })) as never)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    clickFirstRow(container) // FIXTURE 第一行是 src
    await waitFor(() => expect(container.querySelector('.fs-panel-path')?.textContent).toBe('src'))

    rightClickRow(container, 'src/')
    fireEvent.click(menuItem('取消声明'))
    await waitFor(() => expect(bridge.lastCall('spec/removeNode')).toEqual({ path: 'src' }))
    await flushChain()

    expect(rowByName(container, 'src/')).toBeTruthy()
    expect(container.querySelector('.fs-panel-path')?.textContent).toBe('src')
  })
})

describe('落地回调的「还是不是同一次载入」闸门', () => {
  /** 换一个工作区之后 core 给出的另一棵树；只有这个工作区里才有 OTHER.md */
  const OTHER: ViewNode = { name: 'OTHER.md', path: 'OTHER.md', isDir: false, origin: 'actual-only' }

  /**
   * open 按 root 分岔：/tmp/other 是一份全新的、干净的工作区。
   * 原工作区里的 src 必须是 origin 'both'——它在 FIXTURE 里是 actual-only，
   * 那种节点上的「取消声明」是**禁用**的，请求根本发不出去，整条用例会变成空转
   * （删掉被测的闸门也照样绿，已实测）。
   */
  const twoWorkspaceBridge = () => {
    const bridge = bridgeWith()
    const HERE = tree([{ ...SRC, origin: 'both' as const, annotation: '核心源码' }, DOCS, README])
    bridge.setHandler('workspace/open', (({ root }: { root: string }) =>
      root === '/tmp/other'
        ? openResult({ root: '/tmp/other', tree: tree([OTHER]), groups: [] })
        : openResult({ tree: HERE })) as never)
    return bridge
  }

  /** 在顶栏路径框里换一个根并载入。label 可指定，因为切过语言之后它是英文的 */
  const switchWorkspace = async (label = '工作区路径') => {
    fireEvent.change(screen.getByLabelText(label), { target: { value: '/tmp/other' } })
    fireEvent.keyDown(screen.getByLabelText(label), { key: 'Enter' })
    // 载入成功的信号取"路径框停在新根上"：openRoot 会用 OpenResult.root 回填它
    await waitFor(() => expect(screen.getByLabelText('工作区路径')).toHaveProperty('value', '/tmp/other'))
  }

  it('在途的 spec/removeNode 在换工作区之后才落地：不把上一份树与脏标记贴回来', async () => {
    const bridge = twoWorkspaceBridge()
    bridge.setHandler('spec/removeNode', (() => delayed({
      tree: tree(FIXTURE), dirty: true, groups: [G1], canUndo: true, canRedo: false,
    }, 40)) as never)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    rightClickRow(container, 'src/')
    expect(menuItem('取消声明').disabled).toBe(false) // 先钉死请求真的发得出去
    fireEvent.click(menuItem('取消声明'))
    await waitFor(() => expect(bridge.lastCall('spec/removeNode')).toEqual({ path: 'src' }))
    await switchWorkspace()
    await waitFor(() => expect(rowByName(container, 'OTHER.md')).toBeTruthy())

    // 等在途那笔真的回来了（40ms 的桩 + 一点余量）
    await act(async () => { await new Promise(r => setTimeout(r, 80)) })

    // 新工作区刚载入：撤销栈空、没有未保存改动。旧树更不该回来。
    expect((screen.getByText('保存') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByText('撤销') as HTMLButtonElement).disabled).toBe(true)
    expect(rowsOf(container).some(r => r.querySelector('.fs-name')?.textContent === 'src/')).toBe(false)
  })

  it('在途的 spec/createNode 在换工作区之后才落地：同样不回贴', async () => {
    const bridge = twoWorkspaceBridge()
    bridge.setHandler('spec/createNode', ((pms: { parentPath: string; name: string; isDir: boolean }) =>
      delayed({
        tree: tree(withCreated(pms.parentPath, pms.name, pms.isDir)),
        dirty: true, groups: [G1], canUndo: true, canRedo: false,
        path: createdPath(pms.parentPath, pms.name),
      }, 40)) as never)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    const pane = container.querySelector('.fs-pane-tree') as HTMLElement
    fireEvent.contextMenu(pane, { clientX: 30, clientY: 400 })
    fireEvent.click(menuItem('新建目录（仅契约）'))
    fireEvent.change(nameInput(), { target: { value: 'cases' } })
    fireEvent.click(createBtn())

    await switchWorkspace()
    await waitFor(() => expect(rowByName(container, 'OTHER.md')).toBeTruthy())
    await act(async () => { await new Promise(r => setTimeout(r, 80)) })

    expect((screen.getByText('保存') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByText('撤销') as HTMLButtonElement).disabled).toBe(true)
    expect(rowsOf(container).some(r => r.querySelector('.fs-name')?.textContent === 'cases/')).toBe(false)
  })

  it('在途的 spec/rename 在换工作区之后才落地：同样不回贴', async () => {
    const bridge = twoWorkspaceBridge()
    bridge.setHandler('spec/rename', ((p: { path: string; newName: string }) => delayed({
      tree: tree(withRenamed(p.path, p.newName)),
      dirty: true, groups: [G1], canUndo: true, canRedo: false,
      path: renamedPath(p.path, p.newName),
    }, 40)) as never)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    rightClickRow(container, 'src/')
    fireEvent.click(menuItem('重命名（仅契约）'))
    fireEvent.change(renameInput(), { target: { value: 'lib' } })
    fireEvent.click(renameBtn())
    await waitFor(() => expect(bridge.lastCall('spec/rename')).toEqual({ path: 'src', newName: 'lib' }))

    await switchWorkspace()
    await waitFor(() => expect(rowByName(container, 'OTHER.md')).toBeTruthy())
    await act(async () => { await new Promise(r => setTimeout(r, 80)) })

    // 新工作区刚载入：撤销栈空、没有未保存改动。改过名的那一行更不该出现在这儿。
    expect((screen.getByText('保存') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByText('撤销') as HTMLButtonElement).disabled).toBe(true)
    expect(rowsOf(container).some(r => r.querySelector('.fs-name')?.textContent === 'lib/')).toBe(false)
  })

  it('这道闸门必须与「用户改选」那个序号分开：在途的注释落地前点了别的节点，编辑照样落地', async () => {
    // 反方向的钉子。终审那条 Minor 字面上写的是"epoch 只护住了 setSelection 那一半"，
    // 照字面把 selectionEpochRef 直接拿来当载入闸门是错的：它每点一行、每点一个色点
    // 都自增，用户在宿主往返的 20–60ms 里随手点一下，这笔编辑的落地回调就整段被丢掉,
    // 树、脏标记、撤销可用性一起停在编辑之前的样子，而 core 那侧编辑其实已经生效。
    const bridge = bridgeWith()
    bridge.setHandler('spec/annotate', (() => delayed({
      tree: tree([{ ...SRC, annotation: '核心源码', origin: 'both' }, DOCS, README]),
      dirty: true, groups: [G1], canUndo: true, canRedo: false,
    }, 40)) as never)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    clickFirstRow(container)
    await waitFor(() => screen.getByLabelText('注释'))
    fireEvent.change(screen.getByLabelText('注释'), { target: { value: '核心源码' } })
    fireEvent.blur(screen.getByLabelText('注释'))

    // 请求还在途，用户点走了（这一下会让 selectionEpochRef 自增，工作区却没变）
    fireEvent.click(rowByName(container, 'README.md'))
    await act(async () => { await new Promise(r => setTimeout(r, 80)) })

    expect((screen.getByText('保存') as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByText('撤销') as HTMLButtonElement).disabled).toBe(false)
  })

  it('在途的 spec/copyNode 在换工作区之后才落地：同样不回贴', async () => {
    const bridge = twoWorkspaceBridge()
    bridge.setHandler('spec/copyNode', ((p: { from: string; toParent: string }) => delayed({
      tree: tree(withCreated(p.toParent, 'src-copy', true)),
      dirty: true, groups: [G1], canUndo: true, canRedo: false,
      path: createdPath(p.toParent, 'src-copy'),
    }, 40)) as never)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    rightClickRow(container, 'src/')
    fireEvent.click(menuItem('复制'))
    rightClickRow(container, 'docs/')
    fireEvent.click(menuItem('粘贴（仅契约）'))
    await waitFor(() => expect(bridge.lastCall('spec/copyNode')).toEqual({ from: 'src', toParent: 'docs' }))

    await switchWorkspace()
    await waitFor(() => expect(rowByName(container, 'OTHER.md')).toBeTruthy())
    await act(async () => { await new Promise(r => setTimeout(r, 80)) })

    // 新工作区刚载入：撤销栈空、没有未保存改动。副本那一行更不该出现在这儿。
    expect((screen.getByText('保存') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByText('撤销') as HTMLButtonElement).disabled).toBe(true)
    expect(rowsOf(container).some(r => r.querySelector('.fs-name')?.textContent === 'src-copy/')).toBe(false)
  })

  it('在途的 spec/setLang 在换工作区之后才落地：同样不回贴', async () => {
    const bridge = twoWorkspaceBridge()
    bridge.setHandler('spec/setLang', (() => delayed({
      tree: tree(FIXTURE), dirty: true, groups: [G1], canUndo: true, canRedo: false,
    }, 40)) as never)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    fireEvent.click(screen.getByRole('button', { name: 'English' }))
    // 换工作区后界面语言会被 OpenResult.lang 拨回中文（见 App 里 lang state 的注释），
    // 所以这里先用英文标签找路径框，之后的断言又回到中文文案上。
    await switchWorkspace('Workspace path')
    await waitFor(() => expect(rowByName(container, 'OTHER.md')).toBeTruthy())
    await act(async () => { await new Promise(r => setTimeout(r, 80)) })

    expect((screen.getByText('保存') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByText('撤销') as HTMLButtonElement).disabled).toBe(true)
    expect(rowsOf(container).some(r => r.querySelector('.fs-name')?.textContent === 'src/')).toBe(false)
  })
})

describe('新建 / 取消声明：core 的报错必须原样显示在界面上', () => {
  // 三条都断言"那段话真的出现在界面上"，不是断言"调用抛错了"——后者测的是 core 不是 UI。

  it('懒加载边界：「请先展开该节点再重试」原样出现，输入框与已经打好的名字都留着', async () => {
    const MSG = '`lib` 尚未扫描到，无法确认磁盘上是文件还是目录；请先展开该节点再重试'
    const bridge = bridgeWith({ tree: tree([...FIXTURE, UNSCANNED]) })
    bridge.setHandler('spec/createNode', (() => { throw new Error(MSG) }) as never)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    rightClickRow(container, 'lib/')
    fireEvent.click(menuItem('新建目录（仅契约）'))
    fireEvent.change(nameInput(), { target: { value: 'cases' } })
    fireEvent.click(createBtn())

    // 这条报错是**可执行**的（"先展开该节点再重试"），一个字都不能改写或吞掉
    await waitFor(() => expect(screen.getByText(MSG)).toBeTruthy())
    // 名字留着：失败不该让用户重打一遍
    expect(nameInput().value).toBe('cases')
    expect(createBtn().disabled).toBe(false)
  })

  it('名字非法：core 在输入边界抛的那句原样出现在界面上', async () => {
    const MSG = '名字 "a`b" 含有反引号或换行，当前契约格式无法表示'
    const bridge = bridgeWith()
    bridge.setHandler('spec/createNode', (() => { throw new Error(MSG) }) as never)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    rightClickRow(container, 'src/')
    fireEvent.click(menuItem('新建目录（仅契约）'))
    fireEvent.change(nameInput(), { target: { value: 'a`b' } })
    fireEvent.click(createBtn())

    // UI 不在本地复述这几条规则，也不悄悄把名字改干净——"悄悄改掉一个标识符比报错更糟"
    await waitFor(() => expect(screen.getByText(MSG)).toBeTruthy())
    // 名字留在框里，改一个字就能重试
    expect(nameInput().value).toBe('a`b')
  })

  it('子树保护：removeNode 拒绝的那段话（含"请先分别移除这些子节点自己的声明"）原样出现', async () => {
    const MSG =
      '`src` 下还有带注释/角色/模板/严重级别的子节点，移除会连带丢失这些声明：' +
      '请先分别移除这些子节点自己的声明，再移除该节点本身'
    const bridge = bridgeWith({ tree: tree([{ ...SRC, origin: 'both' }, DOCS, README]) })
    bridge.setHandler('spec/removeNode', (() => { throw new Error(MSG) }) as never)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    rightClickRow(container, 'src/')
    fireEvent.click(menuItem('取消声明'))

    // 吞掉这一条，用户会以为「取消声明」坏了，转去手改 .folderspec.md——
    // 那才是真正会弄丢注释的路径。报错原文自带出路，必须原样呈现。
    await waitFor(() => expect(screen.getByText(MSG)).toBeTruthy())
  })
})

describe('本轮新增写入口的只读闸门', () => {
  // readOnly 有两条来源（App.tsx：`parseErrors !== null || viewMode === 'disk'`），
  // 两条都要覆盖：少接一个，用户就能在「原始结构」视图下改掉契约，而那个视图的全部
  // 意义就是"让你对比、不让你改"。

  it('「原始结构」视图下：顶栏新建按钮与菜单里三条全部禁用', async () => {
    const bridge = bridgeWith({ tree: tree([{ ...SRC, origin: 'both' }, DOCS, README]) })
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    fireEvent.click(screen.getByText('原始结构'))
    await waitFor(() => expect(bridge.lastCall('view/setMode')).toEqual({ mode: 'disk' }))

    expect((screen.getByText('新建') as HTMLButtonElement).disabled).toBe(true)

    rightClickRow(container, 'src/')
    expect(menuItem('新建目录（仅契约）').disabled).toBe(true)
    expect(menuItem('新建文件（仅契约）').disabled).toBe(true)
    // 这一行在可写态下是**可点**的（上面"origin: both 可点"那条用例钉着），
    // 所以这里的 true 不是恒真——它承的是 readOnly 那一半的重
    expect(menuItem('取消声明').disabled).toBe(true)

    fireEvent.click(menuItem('新建目录（仅契约）'))
    fireEvent.click(menuItem('取消声明'))
    await flushChain()
    expect(screen.queryByLabelText('名称')).toBeNull()
    expect(bridge.calls.some(c => c.method === 'spec/removeNode')).toBe(false)
  })

  it('契约解析失败的只读态下：同样全部禁用', async () => {
    const bridge = bridgeWith({
      parseErrors: [{ line: 7, message: '未知标签 [planned]' }],
      tree: tree([{ ...SRC, origin: 'both' }, DOCS, README]),
    })
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => expect(screen.getByText(/只读模式/)).toBeTruthy())

    expect((screen.getByText('新建') as HTMLButtonElement).disabled).toBe(true)

    rightClickRow(container, 'src/')
    expect(menuItem('新建目录（仅契约）').disabled).toBe(true)
    expect(menuItem('新建文件（仅契约）').disabled).toBe(true)
    expect(menuItem('取消声明').disabled).toBe(true)
    expect(menuItem('取消声明').getAttribute('title'))
      .toBe('当前不可编辑：契约解析失败，或正处在「原始结构」视图')
  })

  it('新建输入框开着时切到「原始结构」：输入框随即收起，这条写入口不可达', async () => {
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    rightClickRow(container, 'src/')
    fireEvent.click(menuItem('新建目录（仅契约）'))
    fireEvent.change(nameInput(), { target: { value: 'cases' } })
    expect(nameInput()).toBeTruthy() // 先确认它真的开着，别测了个空

    fireEvent.click(screen.getByText('原始结构'))

    // **等 DOM 真的变了，而不是等请求发出去。** readOnly 是 view/setMode 的响应落地
    // 之后才置上的，而 lastCall 在请求发出的那一刻就记上了——等它只能证明"发出去了"。
    // 本地 FakeBridge 快到两者看不出差别，CI 上一次稍慢的往返就会让断言跑在重渲染之前：
    // v0.6.0 的 release workflow 正是挂在这一条上（本地 993 全绿、CI 红）。
    // 复现方式：给 FakeBridge.request 加 60ms 延迟，这条立刻变红。
    //
    // 输入框里那个冻结的 parentPath 此刻已经无处可去；留在屏幕上而按钮全灰，
    // 用户只会以为界面卡了
    await waitFor(() => expect(screen.queryByLabelText('名称')).toBeNull())
    expect(bridge.lastCall('view/setMode')).toEqual({ mode: 'disk' })
    expect(bridge.calls.some(c => c.method === 'spec/createNode')).toBe(false)
  })
})

describe('新建输入框的时序（草稿 / 选中 / 异步写入）', () => {
  it('输入框开着时点了别的节点：写入目标不跟着选中集跑', async () => {
    // 目标在右键那一刻就冻结了。若实现改成"提交时按当前选中的节点算"，这里就会
    // 变成在根下建 README.md 的兄弟，用户在契约里得到一条他从没打算过的声明——
    // 而契约的消费者是真会照着去 mkdir 的 Agent。
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    rightClickRow(container, 'src/')
    fireEvent.click(menuItem('新建目录（仅契约）'))
    fireEvent.change(nameInput(), { target: { value: 'cases' } })

    fireEvent.click(rowByName(container, 'README.md'))
    await waitFor(() => expect(container.querySelector('.fs-panel-path')?.textContent).toBe('README.md'))

    fireEvent.keyDown(nameInput(), { key: 'Enter' })
    await waitFor(() => expect(bridge.lastCall('spec/createNode'))
      .toEqual({ parentPath: 'src', name: 'cases', isDir: true }))
  })

  it('创建在途时用户点了别的节点：落地后不把选中集拨到新节点上', async () => {
    // 拨过去的代价不是"选错行"，是 AnnotationPanel 会因为 node.path 变了而重置本地
    // 编辑态——用户此刻正在另一个节点上写、还没失焦的那段注释会被清掉。那正是本项目
    // 唯一那条红线（唯一能造成的伤害是弄丢人写的注释）。
    const bridge = bridgeWith()
    bridge.setHandler('spec/createNode', ((p: { parentPath: string; name: string; isDir: boolean }) =>
      delayed({
        tree: tree(withCreated(p.parentPath, p.name, p.isDir)),
        dirty: true, groups: [G1], canUndo: true, canRedo: false,
        path: createdPath(p.parentPath, p.name),
      })) as never)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    // 建在根下（而不是 src 下）：新节点因此是顶层的一行，落地后能直接在树上看见。
    // 建在 src 下的话它藏在未展开的目录里，"树真的换了一棵"这条前提就只能靠别的间接
    // 信号去推——而展开 src 又要点一下，那一点自己就会改选中集，把要测的东西冲掉。
    const pane = container.querySelector('.fs-pane-tree') as HTMLElement
    fireEvent.contextMenu(pane, { clientX: 30, clientY: 400 })
    fireEvent.click(menuItem('新建目录（仅契约）'))
    fireEvent.change(nameInput(), { target: { value: 'cases' } })
    fireEvent.click(createBtn())

    // 请求还在途，用户已经点走了
    fireEvent.click(rowByName(container, 'README.md'))
    await waitFor(() => expect(container.querySelector('.fs-panel-path')?.textContent).toBe('README.md'))
    // 在 README.md 的面板里写了半句还没失焦的注释
    fireEvent.change(screen.getByLabelText('注释'), { target: { value: '入口说明' } })

    // 等在途那笔真的落地（对话框关掉、树上真的多出了那一行）
    await waitFor(() => expect(screen.queryByLabelText('名称')).toBeNull())
    await waitFor(() => expect(rowByName(container, 'cases/')).toBeTruthy())

    // 右栏还停在 README.md 上，那半句注释还在
    expect(container.querySelector('.fs-panel-path')?.textContent).toBe('README.md')
    expect((screen.getByLabelText('注释') as HTMLTextAreaElement).value).toBe('入口说明')
  })

  it('按撤销不会把开着的新建输入框弄丢，冻结的目标也不变', async () => {
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    // 先制造一次可撤销的编辑，让撤销按钮真的能点（否则点了什么都不会发生，测了个空）
    clickFirstRow(container)
    await waitFor(() => screen.getByLabelText('注释'))
    fireEvent.change(screen.getByLabelText('注释'), { target: { value: 'x' } })
    fireEvent.blur(screen.getByLabelText('注释'))
    await waitFor(() => expect((screen.getByText('撤销') as HTMLButtonElement).disabled).toBe(false))

    rightClickRow(container, 'src/')
    fireEvent.click(menuItem('新建目录（仅契约）'))
    fireEvent.change(nameInput(), { target: { value: 'cases' } })

    fireEvent.click(screen.getByText('撤销'))
    await waitFor(() => expect(bridge.lastCall('spec/undo')).toEqual({}))

    // 撤销退的是已经提交的编辑，与这份还没提交的草稿无关：框还在，名字还在
    expect(nameInput().value).toBe('cases')
    fireEvent.keyDown(nameInput(), { key: 'Enter' })
    await waitFor(() => expect(bridge.lastCall('spec/createNode'))
      .toEqual({ parentPath: 'src', name: 'cases', isDir: true }))
  })

  it('右键菜单的遮罩层：点一下只关菜单，不留半个浮层', async () => {
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    rightClickRow(container, 'src/')
    expect(screen.getByRole('menu')).toBeTruthy()

    fireEvent.click(screen.getByTestId('fs-menu-backdrop'))
    expect(screen.queryByRole('menu')).toBeNull()
    await flushChain()
    expect(bridge.calls.some(c => c.method === 'spec/createNode')).toBe(false)
  })

  it('Esc 也能关掉右键菜单', async () => {
    // 监听器必须挂在 window 上：右键刻意不改选中集，也就没去抢焦点，键盘事件根本
    // 不会经过菜单自己的 DOM 子树。所以这里从 body 起冒泡，而不是从菜单元素上打。
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    rightClickRow(container, 'src/')
    expect(screen.getByRole('menu')).toBeTruthy()

    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })
})

describe('语言开关接上 core', () => {
  it('载入的契约写着 lang: en 时，界面初态就是英文', async () => {
    // 没有这根线，载入一份 en 契约后开关会停在与文件内容不符的一侧，
    // 用户第一次点它其实是在"切回"（api.ts 的 OpenResult.lang 有完整推导）
    const bridge = bridgeWith({ lang: 'en' })
    render(<App bridge={bridge} initialRoot="/tmp/repo" />)

    await waitFor(() => expect(screen.getByText('Load')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'English' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '中文' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('点击开关调用 spec/setLang，并照常回填脏标记与撤销栈', async () => {
    const bridge = bridgeWith()
    render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))
    expect((screen.getByText('保存') as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'English' }))

    await waitFor(() => expect(bridge.lastCall('spec/setLang')).toEqual({ lang: 'en' }))
    // 它是一笔真编辑：要落盘、要进撤销栈（api.ts 把它归在 spec/ 而不是 view/ 的理由）
    await waitFor(() => expect((screen.getByText('Save') as HTMLButtonElement).disabled).toBe(false))
    expect((screen.getByText('Undo') as HTMLButtonElement).disabled).toBe(false)
  })

  it('只读态下界面语言照样切，但不去调 spec/setLang', async () => {
    // 两个断言各钉一半，缺一条就漏掉一个方向的缺陷：
    // - 把界面语言也塞进 readOnly 闸门 → 第一条红（用户读不懂界面时永远出不去）
    // - 只读态照样发 spec/setLang → 第二条红（core 的 assertWritable 会抛错，
    //   而那个错跟"换界面语言"毫无关系，弹到横幅上纯属误导）
    const bridge = bridgeWith({ parseErrors: [{ line: 3, message: '缩进跳级' }] })
    render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => expect(screen.getByText(/只读模式/)).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'English' }))

    expect(screen.getByText('Load')).toBeTruthy()
    expect(screen.getByText('read-only mode')).toBeTruthy()
    await flushChain()
    expect(bridge.calls.some(c => c.method === 'spec/setLang')).toBe(false)
  })

  it('英文界面下，右键菜单与新建对话框也跟着走字典', async () => {
    const bridge = bridgeWith({ lang: 'en' })
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => expect(screen.getByText('Load')).toBeTruthy())

    rightClickRow(container, 'src/')
    fireEvent.click(screen.getByRole('menuitem', { name: 'New directory (contract only)' }))
    expect(screen.getByText('New directory under "src" (contract only)')).toBeTruthy()
    expect(screen.getByLabelText('Name')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 本轮：右键菜单加「复制路径」/「复制相对路径」（对标 VSCode 的 Copy Path /
// Copy Relative Path）。与菜单里既有的四项有一条根本区别：那四项全是写操作，
// 只读态整片禁用；这两项是**纯读**，只读态照样可用——契约解析失败或身处
// 「原始结构」视图时，用户反而更需要把路径复制到终端里去看那个文件。
// ---------------------------------------------------------------------------

/** 装一个假的 navigator.clipboard 并交回它的 writeText spy。
 *  jsdom 默认没有 navigator.clipboard（真实浏览器的非安全上下文同样没有）。 */
const stubClipboard = (impl: (text: string) => Promise<void> = async () => {}) => {
  const writeText = vi.fn(impl)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true, writable: true })
  return writeText
}

/** 卸掉假剪贴板 + 顺带把降级路径也堵死，让"两条路都不通"这一情形可造。 */
const breakClipboard = () => {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn(async () => { throw new DOMException('denied', 'NotAllowedError') }) },
    configurable: true, writable: true,
  })
  Object.defineProperty(document, 'execCommand', {
    value: vi.fn(() => false), configurable: true, writable: true,
  })
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard')
  Reflect.deleteProperty(document, 'execCommand')
})

describe('右键菜单：复制路径 / 复制相对路径', () => {
  it('两项排在菜单最底部，与写操作之间隔一条分隔线', async () => {
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    rightClickRow(container, 'src/')
    expect(Array.from(container.querySelectorAll('[role="menuitem"]')).map(b => b.textContent))
      .toEqual(['新建目录（仅契约）', '新建文件（仅契约）', '重命名（仅契约）', '取消声明',
        '复制', '粘贴（仅契约）', '复制路径', '复制相对路径'])
    // 三条分隔线：新建/改名之间一条，改名取消声明与复制粘贴之间一条，复制粘贴与
    // 「复制路径」之间一条。最后一条不能省：「复制」和「复制路径」名字只差两个字，
    // 干的却是完全不同的事（一个记契约子树，一个往剪贴板塞一条字符串）。
    expect(container.querySelectorAll('.fs-context-menu-sep').length).toBe(3)
  })

  it('「复制路径」复制的是工作区根 + 相对路径拼出来的绝对路径', async () => {
    const writeText = stubClipboard()
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    // 必须用**嵌套**节点：顶层节点的相对路径等于它的文件名，绝对路径又只比 root 多
    // 一段，三种可能的错误取值（文件名 / 相对路径 / 绝对路径）会有两种撞在一起，
    // 用例就分不出实现到底取了哪一个——本项目记录里那类"验证了管道通不通、
    // 没验证真实取值是多少"的形状。
    fireEvent.click(rowByName(container, 'src/'))
    rightClickRow(container, 'a.ts')
    fireEvent.click(menuItem('复制路径'))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('/tmp/repo/src/a.ts'))
  })

  it('「复制相对路径」复制的是工作区相对路径原样，不是绝对路径、也不是文件名', async () => {
    const writeText = stubClipboard()
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    fireEvent.click(rowByName(container, 'src/'))
    rightClickRow(container, 'a.ts')
    fireEvent.click(menuItem('复制相对路径'))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('src/a.ts'))
  })

  it('菜单项的 title 逐字等于它将要复制的那条字符串', async () => {
    // 所见即所复制：title 与写进剪贴板的值必须由同一个表达式产生。两处各算一遍的话，
    // 用户悬停看到的和粘出来的可以是两条不同的路径，而这种分歧没有任何别的信号。
    const writeText = stubClipboard()
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    fireEvent.click(rowByName(container, 'src/'))
    rightClickRow(container, 'a.ts')
    const abs = menuItem('复制路径').getAttribute('title')
    const rel = menuItem('复制相对路径').getAttribute('title')
    expect(abs).toBe('/tmp/repo/src/a.ts')
    expect(rel).toBe('src/a.ts')

    fireEvent.click(menuItem('复制路径'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(abs))
  })

  it('Windows：绝对路径用 OpenResult.sep 拼，相对路径仍是 "/" 分隔', async () => {
    // 相对路径是**契约自己的**标识符（.folderspec.md 里逐字就是这个串，Agent 拿它
    // 匹配节点），换成 "\" 会得到一条在我们自己的产物里根本不存在的字符串。
    // 绝对路径的消费者是操作系统，必须原生。两者服务的对象不同，分隔符因此不同。
    const writeText = stubClipboard()
    const bridge = bridgeWith({ root: 'C:\\repo', sep: '\\' })
    const { container } = render(<App bridge={bridge} initialRoot="C:\\repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    fireEvent.click(rowByName(container, 'src/'))
    rightClickRow(container, 'a.ts')
    fireEvent.click(menuItem('复制路径'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('C:\\repo\\src\\a.ts'))

    rightClickRow(container, 'a.ts')
    fireEvent.click(menuItem('复制相对路径'))
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('src/a.ts'))
  })

  it('拼绝对路径用的是 core 回来的 root，不是 initialRoot 那个占位值', async () => {
    // VSCode 宿主注入失败时 initialRoot 会退回字面量 '.'（见 editor.ts 的
    // shouldSwitchSession 注释）。若这里读的是它，复制出来的会是 './src/a.ts'。
    const writeText = stubClipboard()
    const bridge = bridgeWith({ root: '/real/workspace' })
    const { container } = render(<App bridge={bridge} initialRoot="." />)
    await waitFor(() => expect((screen.getByLabelText('工作区路径') as HTMLInputElement).value)
      .toBe('/real/workspace'))

    fireEvent.click(rowByName(container, 'src/'))
    rightClickRow(container, 'a.ts')
    fireEvent.click(menuItem('复制路径'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('/real/workspace/src/a.ts'))
  })

  it('spec-only 节点（磁盘上还不存在）照样能复制——那是"它应该在的位置"', async () => {
    const writeText = stubClipboard()
    const bridge = bridgeWith({
      tree: tree([...FIXTURE, { name: 'cases', path: 'cases', isDir: true, origin: 'spec-only', children: [] }]),
    })
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    rightClickRow(container, 'cases/')
    expect(menuItem('复制路径').disabled).toBe(false)
    fireEvent.click(menuItem('复制路径'))
    // 用户完全可能拿它去 mkdir。磁盘上没有不是禁用的理由。
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('/tmp/repo/cases'))
  })

  it('空白区域右键（目标是工作区根）时这两项整个不出现', async () => {
    // 根的相对路径是空串——复制它等于**清空剪贴板**，用户粘出来是空的，
    // 与"复制失败"在可观测状态上无法区分，正是本功能最该防的那种静默错误。
    // 而根的绝对路径顶栏那个「工作区路径」输入框里就摆着，选中即可复制，没有损失。
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    const pane = container.querySelector('.fs-pane-tree') as HTMLElement
    fireEvent.contextMenu(pane, { clientX: 30, clientY: 400 })
    expect(container.querySelector('.fs-context-menu-header')?.textContent).toBe('工作区根')
    expect(screen.queryByRole('menuitem', { name: '复制路径' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: '复制相对路径' })).toBeNull()
  })

  it('复制之后菜单关掉，且一条 bridge 请求都不发、脏标记不动', async () => {
    // 只读铁律：本功能纯读，不碰 Spec，因此不进撤销栈、不置脏、不写任何文件。
    const writeText = stubClipboard()
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))
    const before = bridge.calls.length

    rightClickRow(container, 'src/')
    fireEvent.click(menuItem('复制路径'))
    await waitFor(() => expect(writeText).toHaveBeenCalled())

    expect(screen.queryByRole('menu')).toBeNull()
    expect(bridge.calls.length).toBe(before)
    expect((screen.getByText('保存') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByText('撤销') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('复制路径不受只读闸门管辖', () => {
  // 菜单里既有的四项全是写操作，只读态整片禁用。复制是纯读——契约解析失败、
  // 或身处「原始结构」视图时，用户照样（其实是更）需要把路径复制到终端里去。
  // 两条只读来源（App.tsx：`parseErrors !== null || viewMode === 'disk'`）各钉一条。

  it('契约解析失败的只读态：四条写操作全灰，两条复制照样可点且复制的值正确', async () => {
    const writeText = stubClipboard()
    const bridge = bridgeWith({
      parseErrors: [{ line: 7, message: '未知标签 [planned]' }],
      tree: tree([{ ...SRC, origin: 'both' }, DOCS, README]),
    })
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => expect(screen.getByText(/只读模式/)).toBeTruthy())

    fireEvent.click(rowByName(container, 'src/'))
    rightClickRow(container, 'a.ts')
    // 对照组：同一个菜单里写操作确实是灰的——没有这半条，"复制没跟着禁用"就可能
    // 只是因为整个闸门根本没生效
    expect(menuItem('新建目录（仅契约）').disabled).toBe(true)
    expect(menuItem('重命名（仅契约）').disabled).toBe(true)
    expect(menuItem('取消声明').disabled).toBe(true)

    expect(menuItem('复制路径').disabled).toBe(false)
    expect(menuItem('复制相对路径').disabled).toBe(false)
    // 只读态下 title 也不该被换成那句"当前不可编辑…"——它说的是写操作，
    // 对一次复制而言是纯误导
    expect(menuItem('复制路径').getAttribute('title')).toBe('/tmp/repo/src/a.ts')

    fireEvent.click(menuItem('复制路径'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('/tmp/repo/src/a.ts'))
  })

  it('「原始结构」视图下：同样可点，且复制的值正确', async () => {
    const writeText = stubClipboard()
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    fireEvent.click(screen.getByText('原始结构'))
    await waitFor(() => expect(bridge.lastCall('view/setMode')).toEqual({ mode: 'disk' }))

    rightClickRow(container, 'src/')
    expect(menuItem('新建目录（仅契约）').disabled).toBe(true)
    expect(menuItem('复制相对路径').disabled).toBe(false)

    fireEvent.click(menuItem('复制相对路径'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('src'))
  })
})

describe('复制失败必须让用户看见', () => {
  it('两条剪贴板路都不通时弹错误横幅，并把那条路径原样摆出来给人手动复制', async () => {
    // 静默失败是这条功能最坏的结局：用户以为复制了，粘出来是上一次的内容。
    breakClipboard()
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    rightClickRow(container, 'src/')
    fireEvent.click(menuItem('复制路径'))

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    // 横幅里必须带上那条路径本身：失败时唯一的出路就是让用户从横幅里选中它手动复制，
    // 只说"复制失败"等于把人扔在原地
    expect(screen.getByRole('alert').textContent)
      .toBe('复制失败：浏览器拒绝了剪贴板写入。请手动复制：/tmp/repo/src')
  })

  it('降级路径成功时不弹横幅——它是成功，不是失败', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => { throw new DOMException('denied', 'NotAllowedError') }) },
      configurable: true, writable: true,
    })
    let seen: string | null = null
    Object.defineProperty(document, 'execCommand', {
      value: vi.fn(() => { seen = document.querySelector('textarea')?.value ?? null; return true }),
      configurable: true, writable: true,
    })
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    rightClickRow(container, 'src/')
    fireEvent.click(menuItem('复制路径'))

    await waitFor(() => expect(seen).toBe('/tmp/repo/src'))
    await flushChain()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('英文界面下的复制路径', () => {
  it('两条菜单项与失败横幅都走字典', async () => {
    breakClipboard()
    const bridge = bridgeWith({ lang: 'en' })
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => expect(screen.getByText('Load')).toBeTruthy())

    rightClickRow(container, 'src/')
    expect(screen.getByRole('menuitem', { name: 'Copy Path' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy Relative Path' }))

    await waitFor(() => expect(screen.getByRole('alert').textContent)
      .toBe('Copy failed: the browser denied clipboard access. Copy it manually: src'))
  })
})

// ---------------------------------------------------------------------------
// 本轮：右键菜单加「复制」/「粘贴」。全是**虚拟的**——只往契约里再声明一份，磁盘
// 一个字节不动（CLAUDE.md 铁律 1）。两项的闸门不一样，这是本轮最容易一刀切的地方：
// 「复制」只是把源路径记进剪贴板，纯读、不碰 Spec，**不受 readOnly 管辖**；
// 「粘贴」会往契约里加声明，是写，**必须走 readOnly 闸门**。
// 剪贴板放 UI、不进 core：它是"上次复制的是哪条路径"，与 hidden 同类的会话内状态。
// ---------------------------------------------------------------------------

/** 先复制某一行，再在另一行上右键——把"剪贴板里有东西"这个前提摆出来 */
const copyThen = (container: HTMLElement, fromRow: string, thenRow: string) => {
  rightClickRow(container, fromRow)
  fireEvent.click(menuItem('复制'))
  rightClickRow(container, thenRow)
}

describe('右键菜单：复制 / 粘贴（虚拟的——只改契约，磁盘一个字节不动）', () => {
  it('空白区域右键（目标是工作区根）时只出现「粘贴」，不出现「复制」', async () => {
    // 复制需要一个具体的节点当源；空白区域没有。粘贴的目标是工作区根，成立。
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    const pane = container.querySelector('.fs-pane-tree') as HTMLElement
    fireEvent.contextMenu(pane, { clientX: 30, clientY: 400 })
    expect(screen.queryByRole('menuitem', { name: '复制' })).toBeNull()
    expect(menuItem('粘贴（仅契约）')).toBeTruthy()
  })

  it('剪贴板为空时「粘贴」置灰，且 title 写明原因（不是那句只读文案）', async () => {
    // 摆一个点下去什么都不会发生的菜单项，界面就是在说谎；灰着又不给理由，
    // 只是把"点了没反应"换成"灰着没理由"（与「取消声明」在未声明时同一条模式）。
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    rightClickRow(container, 'src/')
    expect(menuItem('粘贴（仅契约）').disabled).toBe(true)
    expect(menuItem('粘贴（仅契约）').getAttribute('title'))
      .toBe('剪贴板是空的：先在某个节点上点「复制」')
    // 对照组：同一个菜单里的写操作此刻是可点的——没有这半条，"粘贴灰了"可能只是
    // 因为整个菜单都灰着
    expect(menuItem('新建目录（仅契约）').disabled).toBe(false)
  })

  it('「复制」是纯读：一条 bridge 请求都不发、脏标记不动、选中集不动，菜单关掉', async () => {
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))
    const before = bridge.calls.length

    rightClickRow(container, 'src/')
    fireEvent.click(menuItem('复制'))
    await flushChain()

    expect(screen.queryByRole('menu')).toBeNull()
    expect(bridge.calls.length).toBe(before)
    expect((screen.getByText('保存') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByText('撤销') as HTMLButtonElement).disabled).toBe(true)
    // 右键刻意不改选中集，「复制」也不该改：右栏仍是空态
    expect(screen.getByText('在左侧选中一个文件或目录')).toBeTruthy()
  })

  it('复制之后「粘贴」可点，title 同时写明源与落点', async () => {
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    copyThen(container, 'src/', 'docs/')
    expect(menuItem('粘贴（仅契约）').disabled).toBe(false)
    expect(menuItem('粘贴（仅契约）').getAttribute('title'))
      .toBe('把「src」的契约声明粘到「docs」下（不会在磁盘上创建任何东西）')
  })

  it('右键目录 → 粘进它下面', async () => {
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    copyThen(container, 'README.md', 'docs/')
    fireEvent.click(menuItem('粘贴（仅契约）'))
    await waitFor(() => expect(bridge.lastCall('spec/copyNode'))
      .toEqual({ from: 'README.md', toParent: 'docs' }))
  })

  it('右键文件 → 粘进它的父目录（文件不可能有子节点）', async () => {
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    fireEvent.click(rowByName(container, 'src/'))
    copyThen(container, 'docs/', 'a.ts')
    fireEvent.click(menuItem('粘贴（仅契约）'))
    // 落点是 src，不是 src/a.ts —— 与「新建」完全一致，直接复用 parentPath
    await waitFor(() => expect(bridge.lastCall('spec/copyNode'))
      .toEqual({ from: 'docs', toParent: 'src' }))
  })

  it('右键空白 → 粘到工作区根（toParent 是空串，不是 "/"）', async () => {
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    rightClickRow(container, 'src/')
    fireEvent.click(menuItem('复制'))
    const pane = container.querySelector('.fs-pane-tree') as HTMLElement
    fireEvent.contextMenu(pane, { clientX: 30, clientY: 400 })
    fireEvent.click(menuItem('粘贴（仅契约）'))
    await waitFor(() => expect(bridge.lastCall('spec/copyNode'))
      .toEqual({ from: 'src', toParent: '' }))
  })

  it('粘贴落地后回填树、脏标记与撤销栈', async () => {
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))
    expect((screen.getByText('保存') as HTMLButtonElement).disabled).toBe(true)

    copyThen(container, 'README.md', 'docs/')
    fireEvent.click(menuItem('粘贴（仅契约）'))

    await waitFor(() => expect(rowByName(container, 'README.md')).toBeTruthy())
    await waitFor(() => expect((screen.getByText('保存') as HTMLButtonElement).disabled).toBe(false))
    expect((screen.getByText('撤销') as HTMLButtonElement).disabled).toBe(false)
  })

  it('选中的是 core 给的 r.path（带自动后缀的那一条），不是 UI 自己拼的名字', async () => {
    // 撞名时 core 会自动加后缀，落点名字 UI 根本猜不到——这正是 spec/copyNode 返回
    // path 的全部理由。自己拼 `${toParent}/${basename(from)}` 会选中一个树上没有的
    // 路径，右栏退回空态，用户以为粘贴失败了。
    const bridge = bridgeWith()
    bridge.setHandler('spec/copyNode', ((p: { from: string; toParent: string }) => ({
      tree: tree(withCreated(p.toParent, 'docs-copy', true)),
      dirty: true, groups: [G1], canUndo: true, canRedo: false,
      path: createdPath(p.toParent, 'docs-copy'),
    })) as never)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    copyThen(container, 'docs/', 'src/')
    fireEvent.click(menuItem('粘贴（仅契约）'))

    // 右栏落在带后缀的那个副本上，用户能紧接着给它写注释
    await waitFor(() => expect(screen.getByLabelText('注释')).toBeTruthy())
    expect(screen.getByText('src/docs-copy')).toBeTruthy()
  })

  it('剪贴板跨菜单存活：复制一次可以粘很多次', async () => {
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    copyThen(container, 'README.md', 'docs/')
    fireEvent.click(menuItem('粘贴（仅契约）'))
    await waitFor(() => expect(bridge.lastCall('spec/copyNode'))
      .toEqual({ from: 'README.md', toParent: 'docs' }))

    rightClickRow(container, 'src/')
    expect(menuItem('粘贴（仅契约）').disabled).toBe(false)
    fireEvent.click(menuItem('粘贴（仅契约）'))
    await waitFor(() => expect(bridge.lastCall('spec/copyNode'))
      .toEqual({ from: 'README.md', toParent: 'src' }))
  })

  it('workspace/open 之后剪贴板清空——与 hidden 同类，永不跨越一次载入', async () => {
    // 重新载入之后契约是从磁盘重读的，剪贴板里那条路径完全可能已经不在了。
    // 留着它等于让用户拿一条过期的源路径去粘，报错来自 core，看着像功能坏了。
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    rightClickRow(container, 'src/')
    fireEvent.click(menuItem('复制'))

    fireEvent.keyDown(screen.getByLabelText('工作区路径'), { key: 'Enter' })
    await waitFor(() => expect(bridge.calls.filter(c => c.method === 'workspace/open').length).toBe(2))

    rightClickRow(container, 'docs/')
    expect(menuItem('粘贴（仅契约）').disabled).toBe(true)
    expect(menuItem('粘贴（仅契约）').getAttribute('title'))
      .toBe('剪贴板是空的：先在某个节点上点「复制」')
  })

  it('粘贴不产生任何文件系统写入：整条链路只发得出 spec/copyNode 一种写请求', async () => {
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    copyThen(container, 'README.md', 'docs/')
    fireEvent.click(menuItem('粘贴（仅契约）'))
    await waitFor(() => expect(bridge.lastCall('spec/copyNode')).toBeTruthy())
    await flushChain()

    // 尤其不该顺手 save()：粘贴是一次编辑，落不落盘由用户按保存决定
    expect(bridge.calls.some(c => c.method === 'spec/save')).toBe(false)
  })
})

describe('复制不受只读闸门管辖，粘贴必须受管辖（两个方向各钉一条）', () => {
  it('契约解析失败的只读态：「复制」可点，「粘贴」灰且 title 是那句只读文案', async () => {
    const bridge = bridgeWith({
      parseErrors: [{ line: 7, message: '未知标签 [planned]' }],
      tree: tree([{ ...SRC, origin: 'both' }, DOCS, README]),
    })
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => expect(screen.getByText(/只读模式/)).toBeTruthy())

    rightClickRow(container, 'src/')
    expect(menuItem('复制').disabled).toBe(false)
    // 复制的 title 也不该被换成那句"当前不可编辑…"：它说的是写操作
    expect(menuItem('复制').getAttribute('title'))
      .toBe('把「src」在契约里的声明记进剪贴板，稍后可粘到别处')
    // **两个禁用理由同时成立时，只读优先。** 此刻剪贴板确实是空的，但说"剪贴板是空的"
    // 会把用户支去点「复制」，点完发现粘贴照样灰着——真正的原因从头到尾都是不可编辑。
    // 这是这条 title 的分支顺序唯一能被侦测到的地方：剪贴板非空时两种顺序给出同一个
    // 答案，只有"两条理由同时成立"这一格分得开。
    expect(menuItem('粘贴（仅契约）').getAttribute('title'))
      .toBe('当前不可编辑：契约解析失败，或正处在「原始结构」视图')

    fireEvent.click(menuItem('复制'))
    // 复制成功了（剪贴板里确实有东西），但粘贴照样灰着——灰的理由是只读，不是空剪贴板
    rightClickRow(container, 'docs/')
    expect(menuItem('粘贴（仅契约）').disabled).toBe(true)
    expect(menuItem('粘贴（仅契约）').getAttribute('title'))
      .toBe('当前不可编辑：契约解析失败，或正处在「原始结构」视图')
  })

  it('「原始结构」视图下：同样是复制可点、粘贴灰', async () => {
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    fireEvent.click(screen.getByText('原始结构'))
    await waitFor(() => expect(bridge.lastCall('view/setMode')).toEqual({ mode: 'disk' }))

    rightClickRow(container, 'src/')
    expect(menuItem('新建目录（仅契约）').disabled).toBe(true)
    expect(menuItem('复制').disabled).toBe(false)
    expect(menuItem('粘贴（仅契约）').disabled).toBe(true)
  })

  it('可写态下复制、切到只读态再粘：请求一条都发不出去', async () => {
    // 剪贴板不受只读影响（它是纯 UI 状态），但那条写路径必须被闸死。
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    rightClickRow(container, 'src/')
    fireEvent.click(menuItem('复制'))

    fireEvent.click(screen.getByText('原始结构'))
    await waitFor(() => expect(bridge.lastCall('view/setMode')).toEqual({ mode: 'disk' }))

    rightClickRow(container, 'docs/')
    expect(menuItem('粘贴（仅契约）').disabled).toBe(true)
    fireEvent.click(menuItem('粘贴（仅契约）'))
    await flushChain()
    expect(bridge.calls.some(c => c.method === 'spec/copyNode')).toBe(false)
  })

  it('切进只读态时开着的菜单被收掉——这条写入口连屏幕上都不该留着', async () => {
    const bridge = bridgeWith()
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    copyThen(container, 'src/', 'docs/')
    expect(screen.getByRole('menu')).toBeTruthy()

    fireEvent.click(screen.getByText('原始结构'))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  })
})

describe('粘贴：core 的报错必须原样显示在界面上', () => {
  const failWith = (message: string) => {
    const bridge = bridgeWith()
    bridge.setHandler('spec/copyNode', (() => { throw new Error(message) }) as never)
    return bridge
  }

  it('粘进自己的子树下被 core 拒绝：那段话一字不改地出现在横幅上', async () => {
    const msg = '不能把节点粘贴到它自己或它的子树下：那会让这个节点声明自己内部还有一份自己，'
      + '再粘一次又翻一倍，而契约的消费者是会照着它真去建目录的 Agent'
    const bridge = failWith(msg)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    copyThen(container, 'src/', 'src/')
    fireEvent.click(menuItem('粘贴（仅契约）'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(msg))
  })

  it('目标父级尚未展开：「请先展开该目录再重试」原样出现，UI 不复述一遍规则', async () => {
    const msg = '`src/deep` 的子项尚未扫描，无法确认磁盘上有没有同名的东西；请先展开该目录再重试'
    const bridge = failWith(msg)
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => screen.getByLabelText('工作区路径'))

    copyThen(container, 'README.md', 'docs/')
    fireEvent.click(menuItem('粘贴（仅契约）'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(msg))
  })
})

describe('英文界面下的复制 / 粘贴', () => {
  it('两条菜单项与两句 title 都走字典', async () => {
    const bridge = bridgeWith({ lang: 'en' })
    const { container } = render(<App bridge={bridge} initialRoot="/tmp/repo" />)
    await waitFor(() => expect(screen.getByText('Load')).toBeTruthy())

    rightClickRow(container, 'src/')
    expect(screen.getByRole('menuitem', { name: 'Copy' }).getAttribute('title'))
      .toBe('Records the contract declaration of "src" to the clipboard, ready to paste elsewhere')
    expect((screen.getByRole('menuitem', { name: 'Paste (contract only)' }) as HTMLButtonElement).getAttribute('title'))
      .toBe('Clipboard is empty — click "Copy" on a node first')

    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy' }))
    rightClickRow(container, 'docs/')
    expect(screen.getByRole('menuitem', { name: 'Paste (contract only)' }).getAttribute('title'))
      .toBe('Pastes the contract declaration of "src" under "docs" (nothing is created on disk)')
  })
})
