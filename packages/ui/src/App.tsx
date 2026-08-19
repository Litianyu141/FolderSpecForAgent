import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  Bridge, FileReadResult, Group, OpenResult, ParseError, SetGroupParams, ViewNode,
} from '@folderspec/core/api'
import { SpecTree, flatten } from './Tree.js'
import { AnnotationPanel } from './AnnotationPanel.js'
import type { PanelPatch } from './AnnotationPanel.js'
import { ContentPane } from './ContentPane.js'
import { GroupPanel } from './GroupPanel.js'
import type { GroupSubmit } from './GroupPanel.js'
import { applyClick, matchingGroups } from './selection.js'
import type { ClickMods, SelectionState } from './selection.js'
import type { TreeApi } from 'react-arborist'
import { useSplitter } from './splitter.js'
import { useElementSize } from './useElementSize.js'
import { Toolbar } from './Toolbar.js'

export interface AppProps {
  bridge: Bridge
  initialRoot: string
}

const EMPTY_SELECTION: SelectionState = { selected: [], anchor: null }

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

  const headerRef = useRef<HTMLDivElement>(null)
  const treeApiRef = useRef<TreeApi<ViewNode> | undefined>(undefined)

  /**
   * 当前正在雕琢的这一组：成员集，以及它绑定到哪个既有分组（null = 还没落地成分组）。
   * 分组的每一次写入都以它为准，而不是各自去读渲染时的 selection / groups 快照。
   *
   * 三件事逼出了这个 ref，它们其实是同一个机制的三面：
   *
   * 1. 收缩是"发请求 + 改选中集"两步。中间那一帧若让 GroupPanel 看到"成员少了、groups
   *    还没更新"，matchingGroups 会失配、current 变 null，它按成员键重置的 effect 就把
   *    用户的分组名与注释清成空串；等响应回来 current 虽恢复，成员键却不再变化、effect
   *    不再重跑，字段停在空。那个空串随下一次提交写回，而 core 把"text 为空"当成删除该
   *    分组——用户写的注释就此消失，正踩在本项目唯一那条红线上。所以选中集要等响应落地、
   *    与 groups 同批更新。
   * 2. 既然选中集要等，连续两次点击就不能各自从渲染快照出发，否则第二次会把第一次移掉的
   *    成员又加回去。**新建态同样如此**，所以这里无论有没有绑定分组都要记。
   * 3. 改名会让 core 把分组 rename 成新 id。缓存的旧 id 从此指向一个不存在的分组，而
   *    core 在 id 找不到时走的是「清空 text 即删除」的早退分支——对不存在的分组是空操作，
   *    **照样返回成功**。界面收缩了，契约纹丝不动，且没有任何提示。所以每次写成功后都要
   *    用 EditResult.id 把它刷新一遍（那正是改名后的新 id）。
   *
   * 任何"重新决定编辑目标"的路径（选行、点分组入口、换工作区）都要把它清空。
   */
  const pendingRef = useRef<{ members: string[]; groupId: string | null } | null>(null)
  const chainRef = useRef<Promise<void>>(Promise.resolve())

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
      setRoot(r.root)
      setTree(r.tree)
      setGroups(r.groups)
      setParseErrors(r.parseErrors)
      setSelection(EMPTY_SELECTION)
      pendingRef.current = null
      // 与切到目录时同理：在途的 file/read 必须作废，否则它晚到时会往一个已经不存在的
      // 上下文里写——成功路径看不出来，失败路径会在新工作区里弹出旧工作区的错误横幅
      contentReqRef.current += 1
      setContentPath(null)
      setContent(null)
      setDirty(false)
      setExternalChange(false)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [bridge])

  useEffect(() => { void openRoot(initialRoot) }, [openRoot, initialRoot])

  useEffect(() => bridge.on('external-change', () => setExternalChange(true)), [bridge])

  const readOnly = parseErrors !== null

  // 外部变更后点"重新载入"会丢弃尚未保存的改动，必须先确认。
  // window.confirm 在两个宿主里都可用，且失败安全：万一某个 webview 环境屏蔽了它，
  // 返回值是 falsy，重载会被取消，用户必须先保存——不存在悄悄丢数据的路径。
  const requestReload = useCallback(() => {
    if (dirty && !window.confirm('有未保存的改动，重新载入会丢弃它们。确定要继续吗？')) return
    void openRoot(root)
  }, [dirty, openRoot, root])

  const handleExpand = useCallback(async (path: string) => {
    try {
      const r = await bridge.request('tree/expand', { path })
      setTree(r.tree)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [bridge])

  const handleMove = useCallback(async (from: string, toParent: string, isDir: boolean) => {
    try {
      const r = await bridge.request('spec/move', { from, toParent, isDir })
      setTree(r.tree)
      setGroups(r.groups)
      setDirty(r.dirty)
    } catch (e) {
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
    // Shift 区间的顺序直接取 react-arborist 算好的可见行，不在外面复算一份：
    // 那份顺序同时受展开态、搜索过滤、以及"过滤态下目录一律默认展开"三者影响，
    // 外面复算已经错过两次，每次都把屏幕上没有的路径塞进选中集——而选中集会经
    // spec/setGroup 写进用户的 .folderspec.md（spec §5.3 的"所见即所选"）。
    const order = treeApiRef.current?.visibleNodes.map(n => n.id) ?? []
    setSelection(prev => applyClick(prev, path, order, mods))
    pendingRef.current = null

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
  }, [tree, loadContent])

  // 面板一次只编辑一个节点的注释；多选时走的是分组那条写路径（spec/setGroup）。
  const selectedPath = selection.selected.length === 1 ? selection.selected[0] : null

  const handlePatch = useCallback(async (patch: PanelPatch) => {
    if (selectedPath === null || tree === null) return
    const node = flatten(tree.children ?? []).get(selectedPath)
    if (!node) return
    try {
      const r = await bridge.request('spec/annotate', { path: selectedPath, isDir: node.isDir, ...patch })
      setTree(r.tree)
      setGroups(r.groups)
      setDirty(r.dirty)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [bridge, selectedPath, tree])

  /** 成功时返回该分组**落地后**的 id（改名时就是新 id），失败返回 null */
  const sendSetGroup = useCallback(async (params: SetGroupParams): Promise<string | null> => {
    try {
      const r = await bridge.request('spec/setGroup', params)
      setTree(r.tree)
      setGroups(r.groups)
      setDirty(r.dirty)
      return r.id
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return null
    }
  }, [bridge])

  /** 取当前正在雕琢的这一组；还没有就按此刻的选中集与分组建立一份 */
  const takePending = useCallback(() => {
    if (pendingRef.current === null) {
      pendingRef.current = {
        members: selection.selected,
        groupId: matchingGroups(selection.selected, groups)[0]?.id ?? null,
      }
    }
    return pendingRef.current
  }, [selection.selected, groups])

  /**
   * 分组的所有写入走同一条串行链。串行不只是为了落地顺序：两次写并发时，后发的那次
   * 带的是基于旧状态算出的成员集，先失败的那次又只能事后补救。排队之后每一步都能看到
   * 前一步的结果，失败也能靠代次号把后面整段作废。
   */
  const runGroupWrite = useCallback((
    build: (p: { members: string[]; groupId: string | null }) => SetGroupParams | null,
    after?: () => void,
  ) => {
    chainRef.current = chainRef.current.then(async () => {
      // 排在链条后面的每一步都在这里过闸：pending 被置空就说明它依据的前提没了
      // （前一步写失败，或用户已经改选了别的东西），整步作废。
      // 排队的步骤都在相邻的微任务里依次跑完，用户点击插不进来，所以这一道就够了。
      const p = pendingRef.current
      if (p === null) return
      const params = build(p)
      if (params !== null) {
        const id = await sendSetGroup(params)
        if (id === null) {
          // 写失败：置空 pending，排在后面的步骤会在上面那道闸口一起作废，
          // 下一次点击重新建立编辑目标。不动选中集——报了失败，界面就得继续与契约一致。
          pendingRef.current = null
          return
        }
        // core 可能把分组改了名，缓存的 id 必须跟着走，否则下一次写会打在一个
        // 不存在的分组上——那是一次静默的空操作，不会报错
        if (pendingRef.current !== null) pendingRef.current.groupId = id
      }
      after?.()
    })
  }, [sendSetGroup])

  const handleGroupSubmit = useCallback((sub: GroupSubmit) => {
    takePending()
    // 成员取 pending 而不是 selection：收缩在途时 selection 还是收缩前的那一份，
    // 拿它去提交改名或约束强度，会把刚移除的成员又写回契约
    runGroupWrite(p => ({
      id: p.groupId ?? sub.id,
      members: p.members,
      name: sub.name,
      text: sub.text,
      severity: sub.severity,
    }))
  }, [takePending, runGroupWrite])

  // groups 走 ref 而不是依赖数组：这个回调会传给 SpecTree 的 onGroupClick，而那是
  // renderNode（每一行的组件类型）的依赖项——引用一变，所有可见行都会卸载重挂。
  // 每次编辑都换一次 groups，没必要为此把整棵可见树 churn 一遍。
  const groupsRef = useRef(groups)
  groupsRef.current = groups

  const handlePickGroup = useCallback((id: string) => {
    const g = groupsRef.current.find(x => x.id === id)
    if (!g) return
    pendingRef.current = null
    setSelection({ selected: [...g.members], anchor: g.members[g.members.length - 1] ?? null })
  }, [])

  const handleRemoveMember = useCallback((path: string) => {
    const p = takePending()
    if (!p.members.includes(path)) return
    const rest = p.members.filter(x => x !== path)
    pendingRef.current = { members: rest, groupId: p.groupId }
    const anchorGone = selection.anchor === path

    runGroupWrite(
      // 绑定到既有分组才需要写；新建态只是在调整选中集，还没有分组可写。
      // 省略 name/text/severity：core 把 undefined 当"不变"，这里只动成员。
      cur => cur.groupId === null ? null : { id: cur.groupId, members: rest },
      () => setSelection(prev => ({
        selected: rest,
        // 锚点被移掉了就作废，别让后续 Shift 从一个已经不在选中集里的位置起算
        anchor: anchorGone ? null : prev.anchor,
      })),
    )
  }, [takePending, runGroupWrite, selection.anchor])

  const handleSave = useCallback(async () => {
    try {
      await bridge.request('spec/save', {})
      setDirty(false)
      setError(null)
    } catch (e) {
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
    <div className="fs-shell">
      <div className="fs-header" ref={headerRef}>
        <Toolbar
          root={root}
          searchTerm={searchTerm}
          dirty={dirty}
          disabled={readOnly}
          onOpenRoot={p => void openRoot(p)}
          onSearch={setSearchTerm}
          onSave={() => void handleSave()}
        />

        {parseErrors && (
          <div className="fs-banner" role="alert">
            契约文件解析失败，当前为<strong>只读模式</strong>。已保留你的原文件未做任何改动，请修复后重新载入。
            <ul>
              {parseErrors.map(e => <li key={`${e.line}-${e.message}`}>第 {e.line} 行：{e.message}</li>)}
            </ul>
          </div>
        )}

        {externalChange && (
          <div className="fs-banner" role="status">
            契约文件已在外部修改。
            <button type="button" onClick={requestReload}>重新载入</button>
          </div>
        )}

        {error && <div className="fs-banner" role="alert">{error}</div>}
      </div>

      <div className="fs-body">
        <div className="fs-pane-tree" ref={treePaneRef} style={{ flexBasis: `${left.width}px` }}>
          {tree && (
            <SpecTree
              data={tree.children ?? []}
              selectedPaths={selection.selected}
              searchTerm={searchTerm}
              width={treeWidth}
              height={treeHeight}
              disabled={readOnly}
              onSelect={handleSelect}
              onExpand={path => void handleExpand(path)}
              onMove={(from, toParent, isDir) => void handleMove(from, toParent, isDir)}
              onGroupClick={handlePickGroup}
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
          {selection.selected.length >= 2 ? (
            <GroupPanel
              members={selection.selected}
              groups={groups}
              disabled={readOnly}
              onSubmit={handleGroupSubmit}
              onRemoveMember={handleRemoveMember}
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
    </div>
  )
}
