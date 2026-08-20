import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Bridge, FileReadResult, Group, OpenResult, ParseError, SetGroupParams, ViewMode, ViewNode,
} from '@folderspec/core/api'
import { SpecTree, flatten } from './Tree.js'
import { AnnotationPanel } from './AnnotationPanel.js'
import type { PanelPatch } from './AnnotationPanel.js'
import { ContentPane } from './ContentPane.js'
import { GroupPanel } from './GroupPanel.js'
import type { GroupDraft, GroupSubmit } from './GroupPanel.js'
import { applyClick, matchingGroups } from './selection.js'
import type { ClickMods, SelectionState } from './selection.js'
import type { TreeApi } from 'react-arborist'
import { useSplitter } from './splitter.js'
import { useElementSize } from './useElementSize.js'
import { Toolbar } from './Toolbar.js'
import { ContextMenu } from './ContextMenu.js'
import type { ContextMenuTarget } from './ContextMenu.js'
import { NewNodeDialog } from './NewNodeDialog.js'
import type { NewNodeDraft } from './NewNodeDialog.js'
import { I18nContext, translate } from './i18n.js'
import type { I18n, Lang } from './i18n.js'

export interface AppProps {
  bridge: Bridge
  initialRoot: string
}

const EMPTY_SELECTION: SelectionState = { selected: [], anchor: null }

/**
 * 一条路径的父目录，根下的节点给出 ''（core 对"根"的表示，见 CreateNodeParams.parentPath）。
 * 只在右键点在**文件**节点上时用到：文件不能有子节点，新建落到它的父目录。
 */
function parentOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

/**
 * 正在雕琢的这一组：成员集、锚点，以及它绑定到哪个既有分组（null = 还没落地成分组）。
 *
 * 它是**显示与写入共用的同一个真源**。曾经它只管写入、面板显示读 selection.selected，
 * 而 selection 要等响应落地才更新——在途那 20–60ms 里两者发散：面板上列着三项，发出去的
 * members 只有两项。用户看着三项按下提交，契约里落了两项。方向是"写得比面板少"，
 * 没把他想留的写丢，但"所见即所写"这条可审计性没了。现在两边读同一份。
 */
interface PendingGroup {
  /**
   * 编辑会话号。每次"重新决定编辑目标"就换一个新号。
   * 在途的写入靠它认出"我依据的前提还在不在"——光判 pending 是否为 null 不够：
   * 用户换了目标、又开始编辑另一个分组时 pending 不为 null，旧写入落地照样会把它那一份
   * 提交到新目标上。
   */
  session: number
  members: string[]
  anchor: string | null
  groupId: string | null
  /**
   * 面板里尚未提交的那一份编辑（null = 用户这一轮还没碰过任何字段）。
   *
   * **它必须和 groupId、members 待在同一个对象里**，这是本轮两条 Critical 的收口。
   * 草稿曾经只活在 GroupPanel 自己的 state 里，与"它是写给谁的"分家：
   *
   *   N1：写注释、失焦、**落地** → 点某个成员的 × → ctrl 点把它加回来 → 一次失焦。
   *       落地后草稿没人清，成员集绕一圈回到原样，编辑目标却已经换成成员集相同的
   *       **另一个**分组，那段草稿于是盖掉了它的注释。
   *   N2：ctrl 选三项（不构成分组）→ 写字 → 点 × 去掉一项 → 剩下两项恰好等于某个既有
   *       分组 → 一次失焦，它的注释被草稿覆盖。确定性的，没有任何往返窗口；用户从头到尾
   *       没见过那段被盖掉的注释，唯一的信号是「分组名」栏悄悄从空变成那个 id。
   *
   * 两条同源，收口也只有两条，写在这里以免后人只捡其中一条：
   *
   * 1. **草稿活着时成员集锁定**（× 置灰、ctrl/shift 改选与色点点击都不改成员集）。
   *    出路是普通单击——它必然把选中集收成 1 项，分组面板随之卸载，草稿一起消失。
   * 2. **写入落地即清空草稿**，且只清"这一笔写出去的那一份"（用户可能在宿主往返的
   *    20–60ms 里补了半句话，一律清空就把它抹了）。写**失败**则留着草稿，别让用户
   *    白打一遍字；锁跟着留着，他直接再失焦就是重试。
   *
   * 少了第 2 条，第 1 条就等于永久锁定；少了第 1 条，第 2 条挡不住 N2。
   */
  draft: GroupDraft | null
}

export function App({ bridge, initialRoot }: AppProps) {
  const [root, setRoot] = useState(initialRoot)
  const [tree, setTree] = useState<ViewNode | null>(null)
  const [groups, setGroups] = useState<Group[]>([])
  const [parseErrors, setParseErrors] = useState<ParseError[] | null>(null)
  const [selection, setSelection] = useState<SelectionState>(EMPTY_SELECTION)
  const [contentPath, setContentPath] = useState<string | null>(null)
  const [content, setContent] = useState<FileReadResult | null>(null)
  const [contentLoading, setContentLoading] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [dirty, setDirty] = useState(false)
  const [externalChange, setExternalChange] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [bodyHeight, setBodyHeight] = useState(600)
  /** 「原始结构 / 我的结构」显示模式，默认与 Session 的默认值一致（api.ts view/setMode）。 */
  const [viewMode, setViewModeState] = useState<ViewMode>('spec')
  /**
   * 撤销 / 重做栈是否非空，供按钮置灰。EditResult.canUndo/canRedo 只表示"栈非空"，
   * 不含只读判断（core 故意不重复实现只读规则）——按钮真正的禁用条件在 Toolbar 里
   * 是 `disabled || !canUndo`，`disabled` 那半才是"现在允不允许写"。
   */
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  /**
   * 界面语言。初始值是中文，但 openRoot() 一落地就会被 `OpenResult.lang` 覆盖成
   * 契约里真实写着的那个（api.ts 的 OpenResult.lang 有完整推导：三种载入结局各自
   * 从哪儿取值，以及为什么解析失败时不去嗅探）。没有这一步，载入一份 `lang: en`
   * 的契约后开关会停在与文件内容不符的一侧，用户第一次点它其实是在"切回"。
   *
   * 它同时也是**界面**语言，与契约里的 lang 只在"载入那一刻"和"用户点开关那一刻"
   * 对齐，中间不做任何同步——两者分叉的唯一情形是只读态下切了界面语言，
   * 见 handleSetLang 里那段关于只读分叉的注释。
   */
  const [lang, setLang] = useState<Lang>('zh')
  /**
   * 正开着的右键菜单（null = 没开）。目标在右键按下那一刻定死，见 ContextMenuTarget。
   */
  const [menu, setMenu] = useState<ContextMenuTarget | null>(null)
  /** 正开着的「新建声明」输入框（null = 没开）。父目录/类型同样在打开那一刻定死。 */
  const [newNode, setNewNode] = useState<NewNodeDraft | null>(null)
  /** spec/createNode 在途：按钮禁用。同步的那道闸在 creatingRef 上，见 submitNewNode。 */
  const [creating, setCreating] = useState(false)
  const creatingRef = useRef(false)
  const newNodeIdRef = useRef(0)
  /**
   * 用户"重新决定选中谁"的次数。
   *
   * spec/createNode 横跨一个宿主往返（20–60ms，实测），落地后要把选中集拨到新节点上
   * （用 result.path，见 api.ts）。但这期间用户完全可能已经点了别的节点——此时再拨
   * 一次，右栏会跳走，AnnotationPanel 里那半句还没失焦的注释会随 `node?.path` 变化
   * 被 useEffect 重置掉。那正是本项目唯一那条红线（"唯一能造成的伤害是弄丢人写的
   * 注释"），也是前四轮反复栽的同一个形状：在途落地无声盖掉用户在途做出的改选。
   * 提交前捕获一次，落地时相等才拨。
   */
  const selectionEpochRef = useRef(0)
  /**
   * 工作区载入序号。**必须与上面的 selectionEpochRef 分成两个**，这是最容易接错的地方：
   * 那一个数的是"用户重新决定选中谁"的次数，点一行、点一个色点都会自增。拿它当
   * "工作区还是不是同一次载入"的判据，等于用户随手点一下就把所有在途编辑的落地回调
   * 全部作废——树、脏标记、撤销可用性会一起停在编辑之前的样子。这一个只在
   * workspace/open 成功落地时自增。
   *
   * openRoot 会把 tree/groups/dirty/canUndo/canRedo/selection 整套复位（Session 那侧
   * 也已经重读磁盘、清空撤销栈）。任何横跨一个宿主往返的落地回调若在重载之后才回来，
   * 就会把上一份工作区的树连同脏标记、撤销按钮一起贴回屏幕：界面显示的树、脏标记、
   * 撤销可用性三者同时与会话真实状态不符。所以每个落地回调都在发请求前捕获一次，
   * 回来时不相等就整段放弃——**连 catch 里那句错误横幅也放弃**，那是上一个工作区的
   * 报错，弹在新工作区上只会让人以为刚做的事失败了（与 contentReqRef 同一条判据）。
   *
   * 诚实说明可达性：CLI 宿主里多数写操作在 core 侧是纯同步的，响应通常快于
   * workspace/open 的磁盘扫描；但两个宿主都对每条消息各起一个互不排队的异步任务
   * （server.ts / editor.ts），顺序没有任何保证，tree/expand 这种同样要扫盘的路径上
   * 窗口是实打实的。
   */
  const loadEpochRef = useRef(0)
  const t = useCallback<I18n['t']>((key, params) => translate(lang, key, params), [lang])
  // I18nContext 的 value：见 i18n.ts 里那段解释"为什么用 Context 而不是一路传 props"
  // 的注释。这里用 useMemo 是因为 Provider 的 value 一变，整棵消费了 useContext 的
  // 子树都会重渲染——lang 没变时不必跟着 App 别的 state 变化一起抖一遍。
  const i18n = useMemo(() => ({ lang, t }), [lang, t])

  const headerRef = useRef<HTMLDivElement>(null)
  const treeApiRef = useRef<TreeApi<ViewNode> | undefined>(undefined)
  /**
   * 上一次 workspace/open 成功后的根路径（已经过宿主解析）。
   *
   * 用来判断下一次 open 是"重新载入同一个工作区"还是"换一个工作区"：CLI 宿主里
   * 同根 open 复用同一个 Session（server.ts 的 `wanted !== session.root` 才换新的），
   * viewMode 不随之重置；换根则换新 Session，viewMode 天生是默认值 'spec'（Session
   * 的字段初始值）。UI 拿不到"服务端到底有没有换 Session"这个事实本身——OpenResult
   * 没有携带 viewMode 字段——只能靠根路径是否变化去推断，这正是两个宿主都要遵守的
   * open()/reload() 契约（session.ts 的 `reload()` 就是 `return this.open()`）。
   * 不这样推断的后果：外部变更触发"重新载入"时，UI 会把用户正看着的「原始结构」
   * 视图悄悄切回「我的结构」，而这时 server 返回的树其实仍是磁盘视图——按钮显示
   * 与实际画面对不上，正是这个功能最忌讳的"界面说谎"。
   */
  const openedRootRef = useRef<string | null>(null)

  /**
   * PendingGroup 的两副本：
   * - `pendingRef` 是**同步**真源。串行链里 await 之后必须读到最新值，React 状态那时还没提交。
   * - `pending` 是**渲染**真源。面板必须显示与写入完全同一份成员集。
   *
   * 两者只能经 `setPending` 一起改，别单独动其中一个。
   *
   * 这份状态存在的三个理由，其实是同一个机制的三面：
   *
   * 1. 移除成员是乐观更新：成员立刻从面板上消失，请求随后排队发出。GroupPanel 在那一帧里
   *    会看到"成员少了、groups 还没更新"，matchingGroups 必然失配——所以编辑目标由这里
   *    给定（`currentGroupId`），不让面板自己去猜。猜错的后果是它把用户的分组名与注释
   *    清成空串，那个空串一提交，core 的「清空 text 即删除」就把分组连同注释一起抹掉，
   *    正踩在本项目唯一那条红线上。
   * 2. 连续两次移除不能各自从渲染快照出发，否则第二次会把第一次移掉的成员又加回去。
   *    **新建态同样如此**，所以无论有没有绑定分组都要记。
   * 3. 改名会让 core 把分组 rename 成新 id。缓存的旧 id 从此指向一个不存在的分组，而
   *    core 在 id 找不到时走的是「清空 text 即删除」的早退分支——对不存在的分组是空操作，
   *    **照样返回成功**。界面收缩了，契约纹丝不动，且没有任何提示。所以每次写成功后都要
   *    用 EditResult.id 把它刷新一遍（那正是改名后的新 id）。
   *
   * 任何"重新决定编辑目标"的路径（选行、点分组入口、换工作区）都要把它清空。
   */
  const [pending, setPendingState] = useState<PendingGroup | null>(null)
  const pendingRef = useRef<PendingGroup | null>(null)
  const sessionRef = useRef(0)
  const chainRef = useRef<Promise<void>>(Promise.resolve())

  const setPending = useCallback((next: PendingGroup | null) => {
    pendingRef.current = next
    setPendingState(next)
  }, [])

  // 读文件请求的序号。宿主对每条消息各起一个异步任务、彼此不排队（cli/src/server.ts），
  // 于是先发的大文件可以晚于后发的小文件到达。没有这道闸门，晚到的旧响应会盖掉新内容，
  // 而路径头与高亮语言取自 contentPath（已经是新的那个）——界面上就是"路径写着 B、
  // 内容是 A"。切到目录时也要自增，让在途的读取作废。
  const contentReqRef = useRef(0)

  const left = useSplitter({ initial: 260, min: 160, max: 600, side: 'left' })
  const right = useSplitter({ initial: 320, min: 220, max: 720, side: 'right' })

  const [treePaneRef, measured] = useElementSize<HTMLDivElement>({ width: 0, height: 0 })

  const measure = useCallback(() => {
    const headerHeight = headerRef.current?.getBoundingClientRect().height ?? 0
    setBodyHeight(Math.max(200, window.innerHeight - headerHeight))
  }, [])

  useEffect(() => {
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [measure])

  // 横幅（只读、外部变更、错误）出现或消失会改变头部高度，正文区随之变高变矮。
  // 真实浏览器里 ResizeObserver 会捕获这件事（见下面的 treeHeight），这里的窗口测量是它的
  // 兜底：jsdom 没有实现 ResizeObserver，measured 永远是 0，树若拿到 0 高度就一行都不渲染，
  // 依赖真实渲染的 App 测试会全灭。jsdom 里 getBoundingClientRect 恒为 0，头部高度会退化成
  // 0——不精确但安全（树只会偏高，不会消失）。
  useEffect(() => { measure() }, [measure, parseErrors, externalChange, error])

  // 实测优先，未测到（尚未 observe，或宿主没有 ResizeObserver）时退回估算值。
  // 宽度的估算值就是分隔条给这一栏定的 flex-basis，构造上等于它的真实宽度。
  const treeWidth = measured.width > 0 ? measured.width : left.width
  const treeHeight = measured.height > 0 ? measured.height : bodyHeight

  const openRoot = useCallback(async (path: string) => {
    try {
      const r: OpenResult = await bridge.request('workspace/open', { root: path })
      // open() 是否换了一个新 Session，只能靠根路径变没变推断——见 openedRootRef 的注释。
      const isSameWorkspace = r.root === openedRootRef.current
      openedRootRef.current = r.root
      setRoot(r.root)
      setTree(r.tree)
      setGroups(r.groups)
      setParseErrors(r.parseErrors)
      setSelection(EMPTY_SELECTION)
      setPending(null)
      // 换/重载工作区也是一次"重新决定选中谁"：在途的 spec/createNode 若在这之后落地，
      // 不能再把选中集拨到它那个属于上一份树的路径上去。
      selectionEpochRef.current += 1
      // 与上面那半条同源、但护的是另一半：在途的任何编辑落地时都不该再往界面上贴
      // 属于上一份工作区的树与脏标记，见 loadEpochRef。
      loadEpochRef.current += 1
      // 菜单与新建输入框里冻结的那个 parentPath 属于上一次载入的那棵树，新工作区里
      // 完全可能根本没有这条路径。整个收掉，不留半成品。
      setMenu(null)
      setNewNode(null)
      // 开关对齐契约里写的语言。这是 OpenResult.lang 存在的全部理由（api.ts 有推导）。
      setLang(r.lang)
      // 与切到目录时同理：在途的 file/read 必须作废，否则它晚到时会往一个已经不存在的
      // 上下文里写——成功路径看不出来，失败路径会在新工作区里弹出旧工作区的错误横幅
      contentReqRef.current += 1
      setContentPath(null)
      setContent(null)
      setDirty(false)
      setExternalChange(false)
      setError(null)
      // OpenResult 上没有 canUndo/canRedo：open() 必定清空撤销栈（Session.open），
      // 两值此刻恒为 false，UI 直接按 false 复位即可（api.ts EditResult 上的注释）。
      setCanUndo(false)
      setCanRedo(false)
      // viewMode 不在此列——它是显示偏好，不是"这次编辑的残留状态"，同一工作区
      // reload 后不该被悄悄重置（与 core 侧 Session.viewMode 的裁定对称）。
      if (!isSameWorkspace) setViewModeState('spec')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [bridge, setPending])

  useEffect(() => { void openRoot(initialRoot) }, [openRoot, initialRoot])

  useEffect(() => bridge.on('external-change', () => setExternalChange(true)), [bridge])

  /**
   * 不可编辑：契约解析失败，或当前处于「原始结构」视图。两者都会被 core 的
   * assertWritable() 拒绝写入（session.ts），UI 必须把编辑入口全部禁用，
   * 而不是让用户点了没反应——这里合并成一个闸门，驱动树的拖拽、注释面板、
   * 分组面板、保存/撤销/重做按钮共用同一条判据，不在多处各自重复一遍。
   */
  const readOnly = parseErrors !== null || viewMode === 'disk'

  /**
   * 语言开关。**一次点击分成两条互不相干的线**，这个分叉是本轮最容易接错的地方：
   *
   * 1. **界面文案的语言：无条件切。** 它是纯前端状态，不落盘、不经过 core。
   *    "用户看不懂界面"跟"契约此刻能不能写"是两回事——把它也塞进 readOnly 闸门，
   *    等于让一个只读英文的人在契约解析失败时永远卡在中文界面里出不去，而那正是
   *    他最需要读懂报错的时候。
   * 2. **契约 front-matter 里的 lang 字段：只在可写时写。** `spec/setLang` 走
   *    core 的 assertWritable()（session.ts），只读态下调用必然抛错。那个错跟用户
   *    刚做的事（换界面语言）毫无关系，弹到横幅上只会让人以为切语言失败了。
   *
   * 不在这里判断"是不是已经是这个语言了"：core 对传入相同语言是真正的空操作，
   * 不置脏、不进撤销栈（api.ts 的 spec/setLang 注释写明了这一条正是为双态控件留的），
   * UI 再判一遍就是把同一条规则实现两遍。
   */
  const handleSetLang = useCallback((next: Lang) => {
    setLang(next)
    if (readOnly) return
    const epoch = loadEpochRef.current
    void (async () => {
      try {
        const r = await bridge.request('spec/setLang', { lang: next })
        if (epoch !== loadEpochRef.current) return // 见 loadEpochRef
        setTree(r.tree)
        setGroups(r.groups)
        setDirty(r.dirty)
        setCanUndo(r.canUndo)
        setCanRedo(r.canRedo)
      } catch (e) {
        if (epoch !== loadEpochRef.current) return // 见 loadEpochRef
        setError(e instanceof Error ? e.message : String(e))
      }
    })()
  }, [bridge, readOnly])

  /**
   * 切进只读态（切到「原始结构」视图、或重载后契约解析失败）时，把菜单与新建输入框
   * 一起收掉。它们是写入口：留在屏幕上而所有按钮都灰着，用户只会以为界面卡了；
   * 更要紧的是新建输入框里那个冻结的 parentPath 此刻已经无处可去。
   *
   * 这也是「输入框提交」这个写入口真正的闸门——它一关，那条路径就不可达了；
   * submitNewNode 里那句 `if (readOnly) return` 是同一条规则的第二道，见那里的注释。
   */
  useEffect(() => {
    if (readOnly) {
      setMenu(null)
      setNewNode(null)
    }
  }, [readOnly])

  const switchViewMode = useCallback(async (mode: ViewMode) => {
    if (mode === viewMode) return // 已经在这个视图：空操作，别把它也发出去
    const epoch = loadEpochRef.current
    try {
      const r = await bridge.request('view/setMode', { mode })
      if (epoch !== loadEpochRef.current) return // 见 loadEpochRef
      setTree(r.tree)
      setViewModeState(r.mode)
    } catch (e) {
      if (epoch !== loadEpochRef.current) return // 见 loadEpochRef
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [bridge, viewMode])

  const handleUndo = useCallback(async () => {
    const epoch = loadEpochRef.current
    try {
      const r = await bridge.request('spec/undo', {})
      if (epoch !== loadEpochRef.current) return // 见 loadEpochRef
      setTree(r.tree)
      setGroups(r.groups)
      setDirty(r.dirty)
      setCanUndo(r.canUndo)
      setCanRedo(r.canRedo)
    } catch (e) {
      if (epoch !== loadEpochRef.current) return // 见 loadEpochRef
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [bridge])

  const handleRedo = useCallback(async () => {
    const epoch = loadEpochRef.current
    try {
      const r = await bridge.request('spec/redo', {})
      if (epoch !== loadEpochRef.current) return // 见 loadEpochRef
      setTree(r.tree)
      setGroups(r.groups)
      setDirty(r.dirty)
      setCanUndo(r.canUndo)
      setCanRedo(r.canRedo)
    } catch (e) {
      if (epoch !== loadEpochRef.current) return // 见 loadEpochRef
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [bridge])

  // 外部变更后点"重新载入"会丢弃尚未保存的改动，必须先确认。
  // window.confirm 在两个宿主里都可用，且失败安全：万一某个 webview 环境屏蔽了它，
  // 返回值是 falsy，重载会被取消，用户必须先保存——不存在悄悄丢数据的路径。
  const requestReload = useCallback(() => {
    if (dirty && !window.confirm(t('dialog.reloadConfirm'))) return
    void openRoot(root)
  }, [dirty, openRoot, root, t])

  const handleExpand = useCallback(async (path: string) => {
    const epoch = loadEpochRef.current
    try {
      const r = await bridge.request('tree/expand', { path })
      if (epoch !== loadEpochRef.current) return // 见 loadEpochRef
      setTree(r.tree)
    } catch (e) {
      if (epoch !== loadEpochRef.current) return // 见 loadEpochRef
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [bridge])

  const handleMove = useCallback(async (from: string, toParent: string, isDir: boolean) => {
    const epoch = loadEpochRef.current
    try {
      const r = await bridge.request('spec/move', { from, toParent, isDir })
      if (epoch !== loadEpochRef.current) return // 见 loadEpochRef
      setTree(r.tree)
      setGroups(r.groups)
      setDirty(r.dirty)
      setCanUndo(r.canUndo)
      setCanRedo(r.canRedo)
    } catch (e) {
      if (epoch !== loadEpochRef.current) return // 见 loadEpochRef
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [bridge])


  const loadContent = useCallback(async (path: string) => {
    const seq = ++contentReqRef.current
    setContentLoading(true)
    try {
      const r = await bridge.request('file/read', { path })
      if (seq !== contentReqRef.current) return
      setContent(r)
    } catch (e) {
      if (seq !== contentReqRef.current) return
      setContent(null)
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (seq === contentReqRef.current) setContentLoading(false)
    }
  }, [bridge])

  const handleSelect = useCallback((path: string, mods: ClickMods) => {
    if (tree === null) return
    // 用户亲手决定了"现在看的是谁"。在途的 spec/createNode 落地时据此放弃自动选中新
    // 节点——见 selectionEpochRef 的注释。放在最前面、连 lockedOut 那条分支也算：
    // 锁住成员集的那一下照样换了中间栏的预览，用户的注意力确实已经挪走了。
    selectionEpochRef.current += 1
    const p = pendingRef.current
    /**
     * 草稿未提交时，带修饰键的改选**不动本轮成员集**（见 PendingGroup.draft）。
     *
     * 普通单击刻意不锁：它本来就有"放弃多选"的语义，必然把选中集收成 1 项，分组面板
     * 随之卸载、草稿一起消失——这就是留给用户的那条出路，不需要新按钮。真实浏览器里
     * 这一下还会先让输入框失焦、把草稿提交出去（mousedown → blur → click），所以
     * "离开即丢弃"丢的是一份已经写出去的草稿，不是用户白打的字。
     */
    const lockedOut = p !== null && p.draft !== null && (mods.ctrl || mods.shift)
    if (!lockedOut) {
      // Shift 区间的顺序直接取 react-arborist 算好的可见行，不在外面复算一份：
      // 那份顺序同时受展开态、搜索过滤、以及"过滤态下目录一律默认展开"三者影响，
      // 外面复算已经错过两次，每次都把屏幕上没有的路径塞进选中集——而选中集会经
      // spec/setGroup 写进用户的 .folderspec.md（spec §5.3 的"所见即所选"）。
      const order = treeApiRef.current?.visibleNodes.map(n => n.id) ?? []
      // 扩选是在**面板上此刻那一份**的基础上扩，不是在尚未落地的 selection 上扩，
      // 否则收缩在途时 ctrl 加选会把刚被移除的成员一起带回来。
      // base 必须在 setPending(null) 之前取：setSelection 的更新函数要等到渲染时才跑，
      // 那时 pendingRef 早就被清空了。
      const base = p === null ? null : { selected: p.members, anchor: p.anchor }
      setPending(null)
      setSelection(prev => applyClick(base ?? prev, path, order, mods))
    }

    // 中间栏跟的是"最后点击的那个文件"（设计文档 §5.6），与选中集无关，
    // 所以锁住成员集的那一下照样换预览——否则点下去毫无反应，像是界面卡了
    const node = flatten(tree.children ?? []).get(path)
    if (!node) return
    setContentPath(path)
    if (node.isDir) {
      // 目录不读内容，中间栏改显子项统计（spec §5.6）。
      //
      // 下面三句是防御性的，**不是**用户可见行为，别按"这没测到就删了"处理：
      // ContentPane 碰到 isDir 会在读 content 之前就 return，所以陈旧内容在目录形态下
      // 结构上就看不见（已做单点变异验证，删掉 setContent(null) 没有任何用例会红）。
      // 保留的理由是另外两条：一是刚看过的文件正文可能是几 MB 的字符串，切走了就该放掉；
      // 二是维持"content 永远属于当前 contentPath"这条不变量，免得日后有人给目录形态
      // 加上一段会读 content 的渲染，凭空多出一个隔了两次点击才发作的错配。
      contentReqRef.current += 1
      setContent(null)
      setContentLoading(false)
    } else {
      void loadContent(path)
    }
  }, [tree, loadContent, setPending])

  /**
   * 界面上此刻显示的这一份选中集：有在途的乐观改动就是它，否则是上一次落地的那份。
   * 树的高亮、右栏的形态、分组面板的成员列表、扩选的基准——全都读这一个值，
   * 界面上不该存在第二种"选中了什么"的说法。
   */
  const shown: SelectionState = pending === null
    ? selection
    : { selected: pending.members, anchor: pending.anchor }

  // 面板一次只编辑一个节点的注释；多选时走的是分组那条写路径（spec/setGroup）。
  const selectedPath = shown.selected.length === 1 ? shown.selected[0] : null

  const handlePatch = useCallback(async (patch: PanelPatch) => {
    if (selectedPath === null || tree === null) return
    const node = flatten(tree.children ?? []).get(selectedPath)
    if (!node) return
    const epoch = loadEpochRef.current
    try {
      const r = await bridge.request('spec/annotate', { path: selectedPath, isDir: node.isDir, ...patch })
      if (epoch !== loadEpochRef.current) return // 见 loadEpochRef
      setTree(r.tree)
      setGroups(r.groups)
      setDirty(r.dirty)
      setCanUndo(r.canUndo)
      setCanRedo(r.canRedo)
    } catch (e) {
      if (epoch !== loadEpochRef.current) return // 见 loadEpochRef
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [bridge, selectedPath, tree])

  /** 成功时返回该分组**落地后**的 id（改名时就是新 id），失败返回 null */
  const sendSetGroup = useCallback(async (params: SetGroupParams): Promise<string | null> => {
    const epoch = loadEpochRef.current
    try {
      const r = await bridge.request('spec/setGroup', params)
      // 见 loadEpochRef。返回 null 不会误触 runGroupWrite 的"写失败要退回成员集"分支：
      // openRoot 已经 setPending(null)，那边的 `now === null` 一闸排在判 id 之前。
      if (epoch !== loadEpochRef.current) return null
      setTree(r.tree)
      setGroups(r.groups)
      setDirty(r.dirty)
      setCanUndo(r.canUndo)
      setCanRedo(r.canRedo)
      return r.id
    } catch (e) {
      if (epoch !== loadEpochRef.current) return null // 见 loadEpochRef
      setError(e instanceof Error ? e.message : String(e))
      return null
    }
  }, [bridge])

  /** 取当前正在雕琢的这一组；还没有就按此刻的选中集与分组开一轮新的编辑会话 */
  const takePending = useCallback(() => {
    const cur = pendingRef.current
    if (cur !== null) return cur
    const next: PendingGroup = {
      session: ++sessionRef.current,
      members: selection.selected,
      anchor: selection.anchor,
      groupId: matchingGroups(selection.selected, groups)[0]?.id ?? null,
      draft: null,
    }
    setPending(next)
    return next
  }, [selection.selected, selection.anchor, groups, setPending])

  /**
   * 用户在面板里改了某个字段。**第一次改就开一轮编辑**——草稿必须从诞生那一刻起就
   * 和"这一轮在编辑谁"绑在同一份状态里（见 PendingGroup.draft），而不是等到第一次
   * 写入才补记；等到那时，中间任何一次成员集变化都会把目标换掉而草稿浑然不觉。
   */
  const handleGroupDraft = useCallback((next: GroupDraft) => {
    const p = takePending()
    setPending({ ...p, draft: next })
  }, [takePending, setPending])

  /**
   * 分组的所有写入走同一条串行链。串行不只是为了落地顺序：两次写并发时，后发的那次
   * 带的是基于旧状态算出的成员集，先失败的那次又只能事后补救。排队之后每一步都能看到
   * 前一步的结果。
   *
   * 每一步过两道闸，判据都是"我依据的那轮编辑会话还在不在"：
   * - 开头一道，作废前一步失败之后排队的整段；
   * - **await 之后再一道**。宿主往返要 20–60ms，那期间用户的点击完全插得进来（已用真实
   *   core 探针实测）。少了这一道，落地回调会把用户在途做出的改选无声盖掉：右栏自己跳回
   *   分组面板、编辑目标被换回上一个分组，随后写的注释就落在错的分组上并覆盖它原有的注释。
   */
  const runGroupWrite = useCallback((
    build: (p: PendingGroup) => SetGroupParams | null,
    after?: () => void,
    /** 写失败时成员集要退回的那一份（省略 = 这一步没动成员集，不必退） */
    revert?: { members: string[]; anchor: string | null },
  ) => {
    const session = pendingRef.current?.session ?? -1
    chainRef.current = chainRef.current.then(async () => {
      const p = pendingRef.current
      if (p === null || p.session !== session) return
      const params = build(p)
      if (params !== null) {
        // 这一笔写出去的是**哪一份**草稿。落地后只清掉它，不清用户在宿主往返期间
        // 补进来的新草稿——一律清空等于把那半句话无声抹掉。草稿每次改都是新对象，
        // 按引用比就够，不必再造一个版本号（上一轮的代次号正是因为没人判得到而被删）。
        const submitted = p.draft
        const id = await sendSetGroup(params)
        const now = pendingRef.current
        if (now === null || now.session !== session) return
        if (id === null) {
          // 写失败：把这一步的乐观改动退回去（用户会看到被移除的成员回到列表上），
          // 但**草稿留着**——别让用户为一次写入失败白打一遍字，锁也跟着留着，
          // 他直接再失焦就是重试。换一个会话号，把排在后面、依据"这一步已经成功"
          // 算出来的步骤在开头那道闸口一起作废。
          setPending({
            ...now,
            session: ++sessionRef.current,
            members: revert ? revert.members : now.members,
            anchor: revert ? revert.anchor : now.anchor,
          })
          return
        }
        setPending({
          ...now,
          // core 可能把分组改了名，缓存的 id 必须跟着走，否则下一次写会打在一个
          // 不存在的分组上——那是一次静默的空操作，不会报错
          groupId: id,
          // 落地即清空草稿：显示随之回落到已经更新的 current，与落地结果一致，
          // 成员集也就此解锁。草稿若永不清空，"草稿存在期间锁定"等于永久锁定。
          draft: now.draft === submitted ? null : now.draft,
        })
      }
      after?.()
    }).catch(e => {
      // build/after 今天都抛不出来，但两条写路径已经合流到这一条链上：一旦日后有人往
      // 回调里放进会抛的代码，未捕获的 rejection 会让 chainRef 永久停在 rejected，
      // 此后**所有**分组写入都静默消失，还会留下 unhandled rejection。这里兜住，
      // 链条继续可用。（这一句目前没有用例能判到，是明知故留的防御，别按"没测到就删"处理。）
      setError(e instanceof Error ? e.message : String(e))
    })
  }, [sendSetGroup, setPending])

  const handleGroupSubmit = useCallback((sub: GroupSubmit) => {
    takePending()
    // 成员取 pending 而不是 selection：收缩在途时 selection 还是收缩前的那一份，
    // 拿它去提交改名或约束强度，会把刚移除的成员又写回契约
    runGroupWrite(p => {
      const target = p.groupId ?? sub.id
      /**
       * 还没有分组、注释又是空的：**这一笔别发**。
       *
       * core 的 setGroup 对空 text 走早退（spec-edit.ts 的
       * `if (text === undefined || text === '') { ... return }`）——对一个尚不存在的分组
       * 是一次什么都没改的空操作，**但它照样"落地成功"**。而"落地成功"在上面那条链里
       * 是有副作用的：它会清掉草稿、并把 core 顺手推导出的 id 记进 pending。于是
       *
       *   新建态下先选约束强度（或先填分组名）→ 停顿一个宿主往返 → 空操作落地
       *   → 草稿被清 → 下拉框弹回「（仅注释，不强制）」/ 名字框弹回空
       *   → 用户随后写的注释建出的分组，丢掉了他明明选过的强度、填过的名字
       *
       * 这是「发现 1」的第三次出现（前两次见 GroupPanel.test.tsx 里那段长注释）。
       * 收口放在这里而不是去改落地回调：判据与 core 的早退**同一条**——写出去也不会
       * 有任何变化的一笔，本来就不该占用一次往返。别改成 `p.groupId === null`：
       * 目标要取 `p.groupId ?? sub.id`，否则"把某个既有分组的注释清空 = 删除它"
       * 这条真实语义会被一起挡掉。
       */
      if (target === null && sub.text.trim() === '') return null
      return {
        id: target,
        members: p.members,
        name: sub.name,
        text: sub.text,
        severity: sub.severity,
      }
    })
  }, [takePending, runGroupWrite])

  // groups 走 ref 而不是依赖数组：这个回调会传给 SpecTree 的 onGroupClick，而那是
  // renderNode（每一行的组件类型）的依赖项——引用一变，所有可见行都会卸载重挂。
  // 每次编辑都换一次 groups，没必要为此把整棵可见树 churn 一遍。
  const groupsRef = useRef(groups)
  groupsRef.current = groups

  const handlePickGroup = useCallback((id: string) => {
    // 草稿未提交时色点点击不动本轮成员集，与树上的 ctrl/shift 改选同一条规则
    // （见 PendingGroup.draft）。它换的是整个选中集，不锁住就是 N2 的第三个入口。
    const p = pendingRef.current
    if (p !== null && p.draft !== null) return
    const g = groupsRef.current.find(x => x.id === id)
    if (!g) return
    // 与 handleSelect 同理：这一下同样是用户亲手决定"现在编辑的是谁"
    selectionEpochRef.current += 1
    setPending(null)
    setSelection({ selected: [...g.members], anchor: g.members[g.members.length - 1] ?? null })
  }, [setPending])

  /**
   * 用户从"同成员分组"选择器里挑了另一个（设计文档 §5.4.1）。
   *
   * 换编辑会话号，因为这是一次**重新决定编辑目标**：在途那笔写入是冲着旧分组去的，
   * 它落地后那句 `setPending({ ...now, groupId: id })` 会把目标又拨回旧分组，随后写的
   * 注释就盖到错的那个上。成员集不变——能出现在选择器里的本来就是同成员分组——所以沿用
   * 当前这一份，别拿 selection 重算（收缩在途时它还是收缩前的那一份）。
   */
  const handleEditGroup = useCallback((id: string) => {
    const p = pendingRef.current
    // 点的就是当前编辑目标：什么都别做。照旧自增会话号的话，在途那笔写入落地时的
    // `setPending({ ...now, groupId: id })` 会被闸掉，而那句正是"改名后把 groupId
    // 换成新 id"的地方。目标于是停在一个已被改名掉的旧 id 上，此后每次写入都打在一个
    // 不存在的分组上——core 会照着 name 新建一个重复分组，用户以为在编辑 parser，
    // 实际在反复造 g2 的副本。
    if (p !== null && p.groupId === id) return
    setPending({
      session: ++sessionRef.current,
      members: p?.members ?? selection.selected,
      anchor: p?.anchor ?? selection.anchor,
      groupId: id,
      // 换目标就丢草稿：框里那半句是写给上一个分组的，跟过去一失焦就盖掉新目标原有的
      // 注释。这里刻意**不**把新目标的值拍进草稿——拍进去就又是一份会陈旧的快照，
      // 显示也不会有空档：面板没碰过的字段实时跟着 current 走。
      draft: null,
    })
  }, [selection.selected, selection.anchor, setPending])

  const handleRemoveMember = useCallback((path: string) => {
    const p = takePending()
    if (!p.members.includes(path)) return
    const rest = p.members.filter(x => x !== path)
    // 锚点被移掉了就作废，别让后续 Shift 从一个已经不在选中集里的位置起算
    const anchor = p.anchor === path ? null : p.anchor
    // 乐观更新：成员立刻从面板上消失。写入随后排队发出，读的是同一份 pending——
    // "写进契约的成员集 == 提交那一刻面板上显示的那一份"由此成立，而不是靠两处各自维护。
    setPending({ ...p, members: rest, anchor })

    runGroupWrite(
      // 绑定到既有分组才需要写；新建态只是在调整选中集，还没有分组可写。
      // 省略 name/text/severity：core 把 undefined 当"不变"，这里只动成员。
      cur => cur.groupId === null ? null : { id: cur.groupId, members: rest },
      // 落地了才把这一份提交进 selection —— selection 是"上一次落地的那份"，
      // 也就是写失败时显示要退回去的地方
      () => setSelection({ selected: rest, anchor }),
      // 写失败要退回的正是这一步动手之前的那一份。取 p 而不是当时的 selection：
      // 前面若还有已落地的步骤，selection 已经等于 p.members；若前面那步失败了，
      // 这一步在闸口就被作废，根本轮不到回滚。
      { members: p.members, anchor: p.anchor },
    )
  }, [takePending, runGroupWrite, setPending])

  /** 树上某一行按了右键。目标（含新建的父目录、能不能取消声明）在这一刻算定并冻结。 */
  const handleNodeContextMenu = useCallback((path: string, x: number, y: number) => {
    if (tree === null) return
    const node = flatten(tree.children ?? []).get(path)
    if (!node) return
    // 右键是一次"重新开始一个动作"的手势：把上一个还开着的新建输入框收掉，
    // 屏幕上只留一个草稿。不这样的话两个浮层会叠在一起，而且用户很难看出
    // 待会儿按回车提交的到底是哪一个目标。
    setNewNode(null)
    setMenu({
      path,
      // 文件不能有子节点 → 落到它的父目录。完整理由见 ContextMenuTarget.parentPath。
      parentPath: node.isDir ? path : parentOf(path),
      // origin 是唯一能区分"契约里有没有它"的字段，见 ContextMenuTarget.declared。
      declared: node.origin !== 'actual-only',
      x,
      y,
    })
  }, [tree])

  /** 树的空白区域按了右键：目标是工作区根（用户拍板的语义）。 */
  const handlePaneContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setNewNode(null)
    // path: null —— 没有节点被点中，所以菜单不渲染「取消声明」（根节点本来也移不掉，
    // core 的 removeNode 对空路径直接抛"不能移除根节点"）。
    setMenu({ path: null, parentPath: '', declared: false, x: e.clientX, y: e.clientY })
  }, [])

  /** 顶栏「新建」按钮：与空白区域右键完全同一条路径，只是位置换到按钮下方。 */
  const handleToolbarNewNode = useCallback((x: number, y: number) => {
    setNewNode(null)
    setMenu({ path: null, parentPath: '', declared: false, x, y })
  }, [])

  /** 菜单里点了「新建目录/新建文件」：换成输入框，位置沿用菜单原来的位置。 */
  const openNewNodeDraft = useCallback((isDir: boolean) => {
    if (menu === null) return
    // parentPath 从菜单那一份**原样搬过来**，不重新按当前选中集算——冻结这一步是
    // 本轮时序安全的地基，见 ContextMenuTarget 顶部的注释。
    setNewNode({ id: ++newNodeIdRef.current, parentPath: menu.parentPath, isDir, x: menu.x, y: menu.y })
    setCreating(false)
    creatingRef.current = false
    setMenu(null)
  }, [menu])

  /**
   * 提交一条新声明。
   *
   * 失败时**输入框留着、名字留着**：三条会失败的路里有两条是用户能就地补救的
   * （名字非法 → 改一个字；同层已有同名 → 换个名字），关掉等于让他重打一遍。
   * 第三条（parentPath 落在懒加载边界之下）的报错原文写着"请先展开该节点再重试"，
   * 是可执行的，也该让他看着这句话再决定 Esc 还是换个地方建。
   */
  const submitNewNode = useCallback(async (rawName: string) => {
    const draft = newNode
    if (draft === null) return
    const name = rawName.trim()
    if (name === '') return
    // 只读闸门。今天这一句其实够不着——readOnly 一为真，上面那个 useEffect 就把
    // newNode 收掉了，输入框根本不在屏幕上。留着是因为它和「菜单项/顶栏按钮」那三处
    // 是同一条规则的四个入口，日后谁把关闭那条去掉（比如改成"只读时不关、只置灰"），
    // 这一句就是最后一道。别按"没测到就删"处理。
    if (readOnly) return
    // 同步的那道防重闸必须是 ref 不是 state：连按两次回车时，第二次调用闭包里的
    // `creating` 完全可能还是上一帧的 false。重复提交本身不会写坏契约（core 会以
    // "同层同名兄弟是重复声明"拒绝第二次），但那条报错对用户纯属噪声。
    if (creatingRef.current) return
    creatingRef.current = true
    setCreating(true)
    const epoch = selectionEpochRef.current
    const loadEpoch = loadEpochRef.current
    try {
      const r = await bridge.request('spec/createNode', {
        parentPath: draft.parentPath, name, isDir: draft.isDir,
      })
      // 这一道与下面那道 epoch 闸门是两件事：这里问的是"工作区还是不是同一次载入"
      // （见 loadEpochRef），下面那道问的是"用户有没有改选"。少了这一道，一笔在重载
      // 之后才回来的 createNode 会把上一份树连同那个新节点重新贴回屏幕、把脏标记与
      // 撤销按钮重新点亮，而 Session 那侧撤销栈早已清空。
      if (loadEpoch !== loadEpochRef.current) return
      setTree(r.tree)
      setGroups(r.groups)
      setDirty(r.dirty)
      setCanUndo(r.canUndo)
      setCanRedo(r.canRedo)
      setNewNode(null)
      // 选中新节点，让用户能紧接着写注释。**用 r.path，不自己拼 parentPath + name**：
      // 根路径是 '' 的拼接规则两边一旦不一致就会选中错的节点，这个字段正是 core 为此
      // 加的（api.ts 的 spec/createNode 注释）。
      // epoch 相等才拨：期间用户若已经点了别的节点，这一拨会把右栏拽走、连带清掉他
      // 正在写的注释，见 selectionEpochRef。
      if (epoch === selectionEpochRef.current) {
        setPending(null)
        setSelection({ selected: [r.path], anchor: r.path })
      }
    } catch (e) {
      // core 在输入边界拦下的那几条（反引号、"/"、"." / ".."）与 assertCreatableParent
      // 的三条，报错原文都写明了原因和出路，**原样显示**。吞掉它，用户只会看到点了
      // 没反应，然后转去手改 .folderspec.md——那才是真正会弄丢注释的路径。
      if (loadEpoch !== loadEpochRef.current) return // 见 loadEpochRef
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      // finally 不设闸门：这两句复位的是"这一笔 createNode 还在不在途"这个纯本地的
      // 按钮态，它与工作区换没换没有关系；跳过它会让新建按钮永远卡在禁用上。
      creatingRef.current = false
      setCreating(false)
    }
  }, [bridge, newNode, readOnly, setPending])

  /**
   * 取消一个节点的声明。**不删磁盘上的任何东西**——对磁盘上真实存在的节点，
   * 这一行取消之后依旧在树上，只是不再带任何标注（api.ts 的 spec/removeNode）。
   */
  const handleRemoveNode = useCallback(async (path: string) => {
    setMenu(null)
    if (readOnly) return
    const epoch = loadEpochRef.current
    // 点下「取消声明」那一刻树上有哪些路径。它和落地后那棵树的差集，就是这一次
    // 取消声明真正从屏幕上抹掉的那些行——见下面清理选中集那一段。
    const before = tree === null ? new Map<string, ViewNode>() : flatten(tree.children ?? [])
    try {
      const r = await bridge.request('spec/removeNode', { path })
      if (epoch !== loadEpochRef.current) return // 见 loadEpochRef
      setTree(r.tree)
      setGroups(r.groups)
      setDirty(r.dirty)
      setCanUndo(r.canUndo)
      setCanRedo(r.canRedo)

      /**
       * **选中集必须跟着树走。** 取消一个 spec-only 节点（契约里有、磁盘上没有）的
       * 声明之后，merge 让它整行从树上消失，而选中集不动的话那条路径就成了幽灵：
       * 右栏此刻退回空态（用户以为选中集空了）→ 接着 ctrl 点另一个节点，选中集变成
       * 两项，右栏跳出分组面板、标题写着「已选中 2 项」而树上只有一行高亮 → 一次失焦
       * 就把那条树上根本不存在的路径写进 members，用户只能靠分组面板里的 × 才发现。
       * 这与树上 Shift 区间坚持读 react-arborist 的 visibleNodes 是同一条理由：
       * 选中集会经 spec/setGroup 原样写进用户的 .folderspec.md（设计文档 §5.3 的
       * "所见即所选"），凡是屏幕上没有的东西都不许留在里面。
       *
       * 判据是"落地之后它还在不在树上"，**不是路径前缀**。两者不等价，各错一半：
       * - 只剔 path 自己：取消一个目录的声明会连带取消它嵌套的全部子声明（core 的
       *   removeNode 就是这么做的，它拒绝的只是"子节点自己带注释"那种），子路径
       *   同样会从树上消失，漏掉它们等于换个位置留幽灵。
       * - 按 `path + '/'` 前缀无脑剔：磁盘上真实存在的节点（origin 'both'）取消声明
       *   之后**行还在树上**，只是不再带标注——把它从选中集里剔掉，用户会看到自己
       *   刚右键的那一行还高亮着、右栏却空了。
       * 差集同时避开这两头，也天然放过"根本没在这棵已加载的树上出现过"的路径
       * （懒加载边界之下的分组成员）：它们不在 before 里，不算被这次操作抹掉。
       *
       * 剔干净之后选中集若空了，右栏就回到**空态**（AnnotationPanel 在 node 为 null
       * 时渲染的那句提示）——这正是"什么都没选中"本来的样子，不需要额外分支。
       * 锚点若也被剔掉就置 null：从一个已经不在树上的锚点拉 Shift 区间没有意义，
       * applyClick 见到 null 会退化成普通单击。
       */
      const after = flatten(r.tree.children ?? [])
      const gone = (p: string) => before.has(p) && !after.has(p)
      setSelection(prev => prev.selected.some(gone)
        ? {
          selected: prev.selected.filter(x => !gone(x)),
          anchor: prev.anchor !== null && gone(prev.anchor) ? null : prev.anchor,
        }
        : prev)
      // 分组面板那一份（pending）是"界面上此刻显示的选中集"的另一半真源，也是真正被
      // 提交出去的那一份，同样不能留幽灵。刻意**不**换 session 号：这不是一次"重新
      // 决定编辑目标"，在途那笔写入落地后仍要把 core 给的新 id 回填进来（少了那一步，
      // 改过名的分组会被反复新建成副本，见 runGroupWrite 里那段）。
      const cur = pendingRef.current
      if (cur !== null && cur.members.some(gone)) {
        const members = cur.members.filter(x => !gone(x))
        setPending(members.length === 0 ? null : {
          ...cur,
          members,
          anchor: cur.anchor !== null && gone(cur.anchor) ? null : cur.anchor,
        })
      }
    } catch (e) {
      // **这一条是本轮最要紧的错误显示。** 子树里有带注释/角色/模板/严重级别的后代时，
      // core 会拒绝（移除一个目录必然连带移除它嵌套的全部子节点，无条件级联等于一次
      // 点击丢掉多条已经写下的声明）。报错原文自带出路——"请先分别移除这些子节点自己
      // 的声明"——原样显示，别吞、别改写：吞掉它，用户会以为「取消声明」坏了，转而去
      // 用别的方式达到目的（手改文件），那才是真正丢东西的路径。
      if (epoch !== loadEpochRef.current) return // 见 loadEpochRef
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [bridge, readOnly, tree, setPending])

  const handleSave = useCallback(async () => {
    const epoch = loadEpochRef.current
    try {
      // 两个宿主的消息回调都不排队：这个 await 横跨落盘期间完全可能又落地一笔
      // spec/annotate/move/setGroup/deleteGroup，把 dirty 重新变 true——不能无
      // 条件复位，必须信 spec/save 自己回报的 r.dirty（api.ts SaveResult.dirty
      // 上有完整推导），否则界面会把一笔从未写盘的编辑显示成"已保存"。
      const r = await bridge.request('spec/save', {})
      if (epoch !== loadEpochRef.current) return // 见 loadEpochRef
      setDirty(r.dirty)
      setError(null)
    } catch (e) {
      if (epoch !== loadEpochRef.current) return // 见 loadEpochRef
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [bridge])

  const index = tree ? flatten(tree.children ?? []) : null
  const selectedNode = index && selectedPath !== null ? index.get(selectedPath) ?? null : null
  const contentNode = index && contentPath !== null ? index.get(contentPath) ?? null : null
  const groupsOfNode = selectedPath === null
    ? []
    : groups.filter(g => g.members.includes(selectedPath))

  return (
    <I18nContext.Provider value={i18n}>
      <div className="fs-shell">
        <div className="fs-header" ref={headerRef}>
          <Toolbar
            root={root}
            searchTerm={searchTerm}
            dirty={dirty}
            disabled={readOnly}
            viewMode={viewMode}
            canUndo={canUndo}
            canRedo={canRedo}
            lang={lang}
            onOpenRoot={p => void openRoot(p)}
            onSearch={setSearchTerm}
            onSave={() => void handleSave()}
            onSetViewMode={m => void switchViewMode(m)}
            onUndo={() => void handleUndo()}
            onRedo={() => void handleRedo()}
            onSetLang={handleSetLang}
            onNewNode={handleToolbarNewNode}
          />

          {parseErrors && (
            <div className="fs-banner" role="alert">
              {t('banner.parseErrorPrefix')}<strong>{t('banner.parseErrorReadOnly')}</strong>{t('banner.parseErrorSuffix')}
              <ul>
                {parseErrors.map(e => (
                  <li key={`${e.line}-${e.message}`}>{t('banner.parseErrorLine', { line: e.line })}{e.message}</li>
                ))}
              </ul>
            </div>
          )}

          {viewMode === 'disk' && (
            <div className="fs-banner" role="status">
              {t('banner.diskViewPrefix')}<strong>{t('banner.diskViewLabel')}</strong>{t('banner.diskViewSuffix')}
            </div>
          )}

          {externalChange && (
            <div className="fs-banner" role="status">
              {t('banner.externalChange')}
              <button type="button" onClick={requestReload}>{t('banner.reload')}</button>
            </div>
          )}

          {error && <div className="fs-banner" role="alert">{error}</div>}
        </div>

        <div className="fs-body">
          {/* 空白区域右键 = 在根下新建。挂在这一层而不是树本身：react-arborist 的
              虚拟化容器高度就是可视区高度，行不满时下方那片空白也在它里面，挂在外层
              才能连"最后一行以下"那片区域一起覆盖。行上的右键由 NodeRow 拦住冒泡。 */}
          <div
            className="fs-pane-tree" ref={treePaneRef} style={{ flexBasis: `${left.width}px` }}
            onContextMenu={handlePaneContextMenu}
          >
            {tree && (
              <SpecTree
                data={tree.children ?? []}
                selectedPaths={shown.selected}
                searchTerm={searchTerm}
                width={treeWidth}
                height={treeHeight}
                disabled={readOnly}
                onSelect={handleSelect}
                onExpand={path => void handleExpand(path)}
                onMove={(from, toParent, isDir) => void handleMove(from, toParent, isDir)}
                onGroupClick={handlePickGroup}
                onContextMenuNode={handleNodeContextMenu}
                apiRef={treeApiRef}
              />
            )}
          </div>

          <div className="fs-splitter" role="separator" aria-orientation="vertical"
            onPointerDown={left.onPointerDown} />

          <div className="fs-pane-content">
            <ContentPane node={contentNode} content={content} loading={contentLoading} />
          </div>

          <div className="fs-splitter" role="separator" aria-orientation="vertical"
            onPointerDown={right.onPointerDown} />

          <div className="fs-pane-panel" style={{ flexBasis: `${right.width}px` }}>
            {shown.selected.length >= 2 ? (
              <GroupPanel
                members={shown.selected}
                groups={groups}
                // 两个 `?? null` 都是**语义精确**的压缩，不是把两种状态揉成一种：草稿与
                // 绑定目标只可能存在于一轮编辑里（handleGroupDraft 一定先 takePending），
                // 没有轮次就必然两者皆无。面板也不再有任何按"有没有轮次"分岔的本地状态——
                // 那条按成员键重置草稿的规则连同它冻结的身份拷贝已经删掉了，草稿的生死
                // 全在上面这份 pending 里决定。
                currentGroupId={pending?.groupId ?? null}
                draft={pending?.draft ?? null}
                disabled={readOnly}
                onSubmit={handleGroupSubmit}
                onDraftChange={handleGroupDraft}
                onRemoveMember={handleRemoveMember}
                onEditGroup={handleEditGroup}
              />
            ) : (
              <AnnotationPanel
                node={selectedNode}
                disabled={readOnly}
                onChange={patch => void handlePatch(patch)}
                groupsOfNode={groupsOfNode}
                onPickGroup={handlePickGroup}
              />
            )}
          </div>
        </div>

        {/* 两个浮层放在 fs-shell 末尾、fs-body 之外：它们用 position: fixed 按视口坐标
            定位，谁做它们的父节点都不影响位置，但放在 body 里会被三栏的 overflow 裁掉。 */}
        {menu && (
          <ContextMenu
            target={menu}
            disabled={readOnly}
            onNew={openNewNodeDraft}
            onRemove={path => void handleRemoveNode(path)}
            onClose={() => setMenu(null)}
          />
        )}

        {newNode && (
          // key 必须是 draft.id：名字是 NewNodeDialog 自己的本地 state，换目标就得换
          // 组件实例，否则上一次没提交完的半个名字会留在框里跟着新目标写出去。
          <NewNodeDialog
            key={newNode.id}
            draft={newNode}
            disabled={readOnly}
            submitting={creating}
            onSubmit={name => void submitNewNode(name)}
            onCancel={() => setNewNode(null)}
          />
        )}
      </div>
    </I18nContext.Provider>
  )
}
