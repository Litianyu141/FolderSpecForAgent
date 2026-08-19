import { Tree } from 'react-arborist'
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

export function SpecTree(props: TreeProps) {
  const { data, selectedPath, searchTerm, width, height, disabled, onSelect, onExpand, onMove } = props
  return (
    <Tree<ViewNode>
      data={data}
      selection={selectedPath ?? undefined}
      idAccessor="path"
      childrenAccessor="children"
      openByDefault={false}
      width={width}
      height={height}
      indent={16}
      rowHeight={24}
      searchTerm={searchTerm}
      searchMatch={(node, term) => matchesSearch(node.data, term)}
      disableDrag={disabled}
      disableDrop={({ parentNode }) => disabled || !parentNode.data.isDir}
      onMove={makeMoveHandler(data, onMove)}
      onToggle={id => { const n = flatten(data).get(id); if (n?.isDir && n.children === undefined) onExpand(id) }}
      onSelect={nodes => { const n = nodes[0]; if (n) onSelect(n.data.path, n.data) }}
    >
      {NodeRow}
    </Tree>
  )
}
