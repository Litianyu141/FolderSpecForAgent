import { useCallback, useEffect, useRef, useState } from 'react'
import type { Bridge, OpenResult, ParseError, ViewNode } from '@folderspec/core/api'
import { SpecTree, flatten } from './Tree.js'
import { AnnotationPanel } from './AnnotationPanel.js'
import type { PanelPatch } from './AnnotationPanel.js'
import { Toolbar } from './Toolbar.js'

export interface AppProps {
  bridge: Bridge
  initialRoot: string
}

// 必须与 styles.css 里 .fs-right 的 flex-basis 保持一致
const PANEL_WIDTH = 320

export function App({ bridge, initialRoot }: AppProps) {
  const [root, setRoot] = useState(initialRoot)
  const [tree, setTree] = useState<ViewNode | null>(null)
  const [parseErrors, setParseErrors] = useState<ParseError[] | null>(null)
  // 多选决策逻辑（applyClick/visibleOrderOf）已在 selection.ts 就绪，
  // 但把它接进 App 级状态需要拿到 react-arborist 的实时展开态，属于后续任务的接线范围；
  // 这里先保持既有的单选行为：普通点击选中一个，数组长度恒为 0 或 1。
  const [selectedPaths, setSelectedPaths] = useState<string[]>([])
  const [searchTerm, setSearchTerm] = useState('')
  const [dirty, setDirty] = useState(false)
  const [externalChange, setExternalChange] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [size, setSize] = useState({ width: 600, height: 600 })

  const headerRef = useRef<HTMLDivElement>(null)

  const measure = useCallback(() => {
    const headerHeight = headerRef.current?.getBoundingClientRect().height ?? 0
    setSize({
      width: Math.max(240, window.innerWidth - PANEL_WIDTH),
      height: Math.max(200, window.innerHeight - headerHeight),
    })
  }, [])

  useEffect(() => {
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [measure])

  // 横幅（只读、外部变更、错误）出现或消失会改变头部高度，必须重新测量。
  // jsdom 不做布局，getBoundingClientRect 恒为 0，这里会退化成只用 innerHeight ——
  // 不理想但不会出错，测试因此仍然能拿到非零的树高度；真实浏览器里则是精确值。
  // 正因为这个退化是"安全但不精确"，不要为了在 jsdom 里也测出精确值就换成
  // ResizeObserver —— jsdom 没有实现它，一换测试就会全灭。
  useEffect(() => { measure() }, [measure, parseErrors, externalChange, error])

  const openRoot = useCallback(async (path: string) => {
    try {
      const r: OpenResult = await bridge.request('workspace/open', { root: path })
      setRoot(r.root)
      setTree(r.tree)
      setParseErrors(r.parseErrors)
      setSelectedPaths([])
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
      setDirty(r.dirty)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [bridge])

  // 面板一次只编辑一个节点的注释；多选后共享一条分组注释是另一条写路径（spec/setGroup，
  // 由 App 级多选状态接线后才会用上），这里取首个选中项，与改动前的单选行为等价。
  const selectedPath = selectedPaths[0] ?? null

  const handlePatch = useCallback(async (patch: PanelPatch) => {
    if (selectedPath === null || tree === null) return
    const node = flatten(tree.children ?? []).get(selectedPath)
    if (!node) return
    try {
      const r = await bridge.request('spec/annotate', { path: selectedPath, isDir: node.isDir, ...patch })
      setTree(r.tree)
      setDirty(r.dirty)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [bridge, selectedPath, tree])

  const handleSave = useCallback(async () => {
    try {
      await bridge.request('spec/save', {})
      setDirty(false)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [bridge])

  const selectedNode = tree && selectedPath !== null
    ? flatten(tree.children ?? []).get(selectedPath) ?? null
    : null

  return (
    <div className="fs-layout">
      <div className="fs-left">
        <div ref={headerRef}>
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

        {tree && (
          <SpecTree
            data={tree.children ?? []}
            selectedPaths={selectedPaths}
            searchTerm={searchTerm}
            width={size.width}
            height={size.height}
            disabled={readOnly}
            // mods（shift/ctrl）暂未使用：多选决策（applyClick）接入 App 状态是后续任务，
            // 这里先保持单选——普通点击、shift 点击、ctrl 点击目前都只选中被点的这一项。
            onSelect={path => setSelectedPaths([path])}
            onExpand={path => void handleExpand(path)}
            onMove={(from, toParent, isDir) => void handleMove(from, toParent, isDir)}
          />
        )}
      </div>

      <div className="fs-right">
        <AnnotationPanel
          node={selectedNode}
          disabled={readOnly}
          onChange={patch => void handlePatch(patch)}
          // ViewNode 只带分组 id（merge 的反查索引），没有 text/severity；
          // 取全量 Group 列表需要新的 Api 往返，和分组面板本身一样属于多选状态
          // 接线的后续任务范围，这里先留空，不在此提前假装能展示分组注释。
          groupsOfNode={[]}
          onPickGroup={() => {}}
        />
      </div>
    </div>
  )
}
