import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  Bridge, FileReadResult, Group, OpenResult, ParseError, SetGroupParams, ViewNode,
} from '@folderspec/core/api'
import { SpecTree, flatten, matchesSearch } from './Tree.js'
import { AnnotationPanel } from './AnnotationPanel.js'
import type { PanelPatch } from './AnnotationPanel.js'
import { ContentPane } from './ContentPane.js'
import { GroupPanel } from './GroupPanel.js'
import type { GroupSubmit } from './GroupPanel.js'
import { applyClick, matchingGroups, visibleOrderOf } from './selection.js'
import type { ClickMods, SelectionState } from './selection.js'
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
  // react-arborist 的展开态存在它自己的 store 里，外面读不到；这里按它的 onToggle 通知镜像一份，
  // 只为算出 Shift 区间要用的"当前可见顺序"。切换工作区时不清空：react-arborist 自己也不会
  // 因为换了 data 就折叠，清掉反而会让两边不一致（残留的路径在新树里查不到，无害）。
  const [openPaths, setOpenPaths] = useState<ReadonlySet<string>>(() => new Set())
  const [contentPath, setContentPath] = useState<string | null>(null)
  const [content, setContent] = useState<FileReadResult | null>(null)
  const [contentLoading, setContentLoading] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [dirty, setDirty] = useState(false)
  const [externalChange, setExternalChange] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [bodyHeight, setBodyHeight] = useState(600)

  const headerRef = useRef<HTMLDivElement>(null)

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
    // 搜索词必须参与：过滤生效时树上只剩命中的那几行，而 Shift 区间的结果会经
    // spec/setGroup 写进用户的 .folderspec.md。按未过滤的顺序算，落进契约文件的
    // 成员里就会有用户从没在屏幕上见过的路径（spec §5.3 的"所见即所选"）。
    const order = visibleOrderOf(
      tree.children ?? [],
      p => openPaths.has(p),
      searchTerm === '' ? undefined : n => matchesSearch(n, searchTerm),
    )
    setSelection(prev => applyClick(prev, path, order, mods))

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
  }, [tree, openPaths, searchTerm, loadContent])

  const handleToggle = useCallback((path: string) => {
    setOpenPaths(prev => {
      const next = new Set(prev)
      if (!next.delete(path)) next.add(path)
      return next
    })
  }, [])

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

  const sendSetGroup = useCallback(async (params: SetGroupParams) => {
    try {
      const r = await bridge.request('spec/setGroup', params)
      setTree(r.tree)
      setGroups(r.groups)
      setDirty(r.dirty)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
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
    setSelection({ selected: [...g.members], anchor: g.members[g.members.length - 1] ?? null })
  }, [])

  const handleRemoveMember = useCallback((path: string) => {
    const rest = selection.selected.filter(p => p !== path)
    // 面板正编辑某个既有分组时，"移除成员"必须真的把那个分组缩小。只改选中集的话，
    // 成员集与该分组不再相等，matchingGroups 当场失配，下一次失焦提交就走 id: null
    // 新建了一个分组——用户看着在编辑 g1，实际分叉出了第二个，g1 原封不动。
    // 省略 name/text/severity：core 把 undefined 当"不变"，这里只动成员。
    const current = matchingGroups(selection.selected, groups)[0]
    if (current) void sendSetGroup({ id: current.id, members: rest })
    setSelection(prev => ({
      selected: rest,
      // 锚点被移掉了就作废，别让后续 Shift 从一个已经不在选中集里的位置起算
      anchor: prev.anchor === path ? null : prev.anchor,
    }))
  }, [sendSetGroup, selection.selected, groups])

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
              onToggle={handleToggle}
              onGroupClick={handlePickGroup}
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
