import { useCallback, useRef } from 'react'
import { Tree } from 'react-arborist'
import type { NodeRendererProps } from 'react-arborist'
import type { ViewNode } from '@folderspec/core/api'
import type { ClickMods } from './selection.js'
import { NodeRow } from './NodeRow.js'

export interface TreeProps {
  data: ViewNode[]
  selectedPaths: string[]
  searchTerm: string
  width: number
  height: number
  disabled: boolean
  onSelect(path: string, mods: ClickMods): void
  onExpand(path: string): void
  onMove(from: string, toParent: string, isDir: boolean): void
  onGroupClick?: (id: string) => void
}

export function flatten(nodes: ViewNode[]): Map<string, ViewNode> {
  const map = new Map<string, ViewNode>()
  const visit = (list: ViewNode[]) => {
    for (const n of list) {
      map.set(n.path, n)
      if (n.children) visit(n.children)
    }
  }
  visit(nodes)
  return map
}

/** 把 react-arborist 的 onMove 回调翻译成本项目的 move 语义 */
export function makeMoveHandler(
  data: ViewNode[],
  onMove: (from: string, toParent: string, isDir: boolean) => void,
) {
  return ({ dragIds, parentId }: { dragIds: string[]; parentId: string | null }) => {
    const index = flatten(data)
    for (const id of dragIds) {
      const node = index.get(id)
      if (!node) continue
      onMove(id, parentId ?? '', node.isDir)
    }
  }
}

export function matchesSearch(node: ViewNode, term: string): boolean {
  if (term === '') return true
  const t = term.toLowerCase()
  return node.name.toLowerCase().includes(t) || (node.annotation ?? '').toLowerCase().includes(t)
}

/**
 * react-arborist 在放到顶层时传进来的是一个合成根节点，它的 data 只有 { id }，
 * 没有 isDir 字段。所以这里必须用严格的 === false：只有确知目标是文件才禁止放入，
 * 否则 undefined 会被 ! 判成"不是目录"，把"拖到工作区根"整个功能悄悄禁掉。
 */
export function makeDisableDrop(disabled: boolean) {
  return ({ parentNode }: { parentNode: { data: { isDir?: boolean } } }) =>
    disabled || parentNode.data.isDir === false
}

export function SpecTree(props: TreeProps) {
  const { data, selectedPaths, searchTerm, width, height, disabled, onSelect, onExpand, onMove, onGroupClick } = props

  // selectedPaths/onSelect 几乎每次点击都变。react-arborist 把 renderNode（下面的
  // useCallback 返回值）当成子行的组件类型使用——引用一变就是"换了个组件"，会把整棵树
  // 卸载重挂，折叠状态与选中态全部丢失。所以这两样"新鲜但高频变化"的值不能进依赖数组，
  // 改用 ref 把最新值带进这个身份稳定的闭包，行渲染时读 .current 即可，不影响 useCallback 的引用。
  const selectedPathsRef = useRef(selectedPaths)
  selectedPathsRef.current = selectedPaths
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect

  const renderNode = useCallback(
    (p: NodeRendererProps<ViewNode>) => (
      <NodeRow
        {...p}
        onGroupClick={onGroupClick}
        selectedPaths={selectedPathsRef.current}
        onRowClick={(path, mods) => onSelectRef.current(path, mods)}
      />
    ),
    [onGroupClick],
  )
  return (
    <Tree<ViewNode>
      data={data}
      // react-arborist 的 selection 只接受单个 id，多选态的真源是 selectedPaths、
      // 由 NodeRow 自行渲染 data-selected；这里传最后一个仅用于它自己的焦点/可访问性记录。
      selection={selectedPaths[selectedPaths.length - 1] ?? undefined}
      idAccessor="path"
      childrenAccessor="children"
      openByDefault={false}
      width={width}
      height={height}
      indent={8}
      rowHeight={22}
      searchTerm={searchTerm}
      searchMatch={(node, term) => matchesSearch(node.data, term)}
      disableDrag={disabled}
      disableDrop={makeDisableDrop(disabled)}
      onMove={makeMoveHandler(data, onMove)}
      onToggle={id => { const n = flatten(data).get(id); if (n?.isDir && n.children === undefined) onExpand(id) }}
    >
      {renderNode}
    </Tree>
  )
}
