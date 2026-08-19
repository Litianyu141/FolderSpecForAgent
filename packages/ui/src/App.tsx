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
   * 收缩既有分组时"正在编辑哪个分组 + 它最新的成员集"。
   *
   * 两件事逼出了这个 ref。其一：收缩是"发请求 + 改选中集"两步，中间那一帧若让
   * GroupPanel 看到"成员少了、groups 还没更新"，matchingGroups 会失配、current 变 null，
   * 它按成员键重置的 effect 就把用户的分组名与注释清成空串；等响应回来 current 虽然
   * 恢复，成员键却不再变化、effect 不再重跑，字段就停在空。那个空串会随下一次提交
   * （改一下约束强度就够）写回契约，而 core 把"text 为空"当成删除该分组——用户写的
   * 注释就此消失，正踩在本项目唯一那条红线上。所以选中集要等响应落地后与 groups
   * 同批更新，面板永远看不到那个中间态。
   * 其二：既然选中集要等，连续两次点击就不能各自从渲染快照出发，否则第二次会把第一次
   * 移掉的成员又加回去。基准一律从这里取。
   *
   * 任何"重新决定编辑目标"的路径（选行、点分组入口、换工作区）都要把它清空。
   */
  const shrinkRef = useRef<{ id: string; members: string[] } | null>(null)
  const shrinkChainRef = useRef<Promise<void>>(Promise.resolve())

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
      shrinkRef.current = null
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

  // 读文件请求的序号。宿主对每条消息各起一个异步任务、彼此不排队（cli/src/server.ts），
  // 于是先发的大文件可以晚于后发的小文件到达。没有这道闸门，晚到的旧响应会盖掉新内容，
  // 而路径头与高亮语言取自 contentPath（已经是新的那个）——界面上就是"路径写着 B、
  // 内容是 A"。切到目录时也要自增，让在途的读取作废。
  const contentReqRef = useRef(0)

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
    shrinkRef.current = null

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

  /** 返回是否写成功——收缩成员时要靠它决定选中集该不该跟着变 */
  const sendSetGroup = useCallback(async (params: SetGroupParams): Promise<boolean> => {
    try {
      const r = await bridge.request('spec/setGroup', params)
      setTree(r.tree)
      setGroups(r.groups)
      setDirty(r.dirty)
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return false
    }
  }, [bridge])

  const handleGroupSubmit = useCallback((p: GroupSubmit) => {
    void sendSetGroup({
      id: p.id,
      members: selection.selected,
      name: p.name,
      text: p.text,
      severity: p.severity,
    })
  }, [sendSetGroup, selection.selected])

  // groups 走 ref 而不是依赖数组：这个回调会传给 SpecTree 的 onGroupClick，而那是
  // renderNode（每一行的组件类型）的依赖项——引用一变，所有可见行都会卸载重挂。
  // 每次编辑都换一次 groups，没必要为此把整棵可见树 churn 一遍。
  const groupsRef = useRef(groups)
  groupsRef.current = groups

  const handlePickGroup = useCallback((id: string) => {
    const g = groupsRef.current.find(x => x.id === id)
    if (!g) return
    shrinkRef.current = null
    setSelection({ selected: [...g.members], anchor: g.members[g.members.length - 1] ?? null })
  }, [])

  const handleRemoveMember = useCallback((path: string) => {
    const base = shrinkRef.current?.members ?? selection.selected
    if (!base.includes(path)) return
    const rest = base.filter(p => p !== path)
    // 编辑目标一旦定下就记在 shrinkRef 里，不再靠"成员集恰好相等"重新判定：收缩在途时
    // 成员集与 groups 本来就对不上，重新判定必然失配。
    const id = shrinkRef.current?.id ?? matchingGroups(base, groups)[0]?.id ?? null
    if (id !== null) shrinkRef.current = { id, members: rest }
    const anchorGone = selection.anchor === path

    // 串起来跑，不并发：两次移除若同时在途，落地顺序不保证，契约里可能停在先发的那一份。
    shrinkChainRef.current = shrinkChainRef.current.then(async () => {
      // 省略 name/text/severity：core 把 undefined 当"不变"，这里只动成员
      if (id !== null && !(await sendSetGroup({ id, members: rest }))) {
        // 写失败就不动选中集，界面继续与契约一致；下一次点击重新判定编辑目标
        shrinkRef.current = null
        return
      }
      setSelection(prev => ({
        selected: rest,
        // 锚点被移掉了就作废，别让后续 Shift 从一个已经不在选中集里的位置起算
        anchor: anchorGone ? null : prev.anchor,
      }))
    })
  }, [sendSetGroup, selection, groups])

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
