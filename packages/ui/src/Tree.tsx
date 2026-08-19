import { useCallback } from 'react'
import { Tree } from 'react-arborist'
import type { NodeRendererProps } from 'react-arborist'
import type { ViewNode } from '@folderspec/core/api'
import { NodeRow } from './NodeRow.js'

export interface TreeProps {
  data: ViewNode[]
  selectedPath: string | null
  searchTerm: string
  width: number
  height: number
  disabled: boolean
  onSelect(path: string, node: ViewNode): void
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
  const { data, selectedPath, searchTerm, width, height, disabled, onSelect, onExpand, onMove, onGroupClick } = props
  // react-arborist 以子渲染器的引用作为身份，每次渲染换一个新函数会让整棵树重挂载，
  // 选中态与展开态全部丢失，所以必须用 useCallback 稳定这个引用。
  const renderNode = useCallback(
    (p: NodeRendererProps<ViewNode>) => <NodeRow {...p} onGroupClick={onGroupClick} />,
    [onGroupClick],
  )
  return (
    <Tree<ViewNode>
      data={data}
      selection={selectedPath ?? undefined}
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
      onSelect={nodes => { const n = nodes[0]; if (n) onSelect(n.data.path, n.data) }}
    >
      {renderNode}
    </Tree>
  )
}
