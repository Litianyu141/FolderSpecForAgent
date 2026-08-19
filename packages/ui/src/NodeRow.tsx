import type { NodeRendererProps } from 'react-arborist'
import type { ViewNode } from '@folderspec/core/api'
import { SEVERITY_BADGE, isAnnotated, nodeColorVar } from './colors.js'

export function NodeRow({ node, style, dragHandle }: NodeRendererProps<ViewNode>) {
  const d = node.data
  const color = nodeColorVar(d)
  const annotated = isAnnotated(d)

  return (
    <div
      ref={dragHandle}
      style={style}
      className="fs-row"
      data-selected={node.isSelected}
      data-origin={d.origin}
      data-annotated={annotated}
      onClick={() => { if (d.isDir) node.toggle() }}
    >
      <span className="fs-caret" aria-hidden="true">
        {d.isDir ? (node.isOpen ? '▾' : '▸') : ' '}
      </span>
      {d.severity ? <span className="fs-badge">{SEVERITY_BADGE[d.severity]}</span> : null}
      <span className="fs-name" style={color ? { color } : undefined}>
        {d.name}{d.isDir ? '/' : ''}
      </span>
      {d.truncated ? <span title={`子项过多，已截断显示`}>⋯</span> : null}
      {d.unreadable ? <span title={`无法读取该目录（通常是权限不足）`}>🚫</span> : null}
      {d.annotation ? <span className="fs-annotation">{d.annotation}</span> : null}
    </div>
  )
}
