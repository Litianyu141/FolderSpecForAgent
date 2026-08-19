import type { NodeRendererProps } from 'react-arborist'
import type { ViewNode } from '@folderspec/core/api'
import { SEVERITY_BADGE, isAnnotated, nodeColorVar } from './colors.js'
import { FileIcon, iconKindFor } from './FileIcon.js'

export function NodeRow(
  { node, style, dragHandle, onGroupClick }: NodeRendererProps<ViewNode> & { onGroupClick?: (id: string) => void },
) {
  const d = node.data
  const color = nodeColorVar(d)
  const annotated = isAnnotated(d)
  // paddingLeft 是 react-arborist 表达层级的方式；这里换成可见的引导线，所以要摘掉它
  const { paddingLeft: _drop, ...rest } = (style ?? {}) as { paddingLeft?: unknown }

  return (
    <div
      ref={dragHandle}
      style={rest as React.CSSProperties}
      className="fs-row"
      data-selected={node.isSelected}
      data-origin={d.origin}
      data-annotated={annotated}
      onClick={() => { if (d.isDir) node.toggle() }}
    >
      {Array.from({ length: node.level }, (_, i) => (
        <span key={i} className="fs-indent-guide" aria-hidden="true" />
      ))}
      <span className="fs-caret" aria-hidden="true">
        {d.isDir ? (node.isOpen ? '▾' : '▸') : ''}
      </span>
      <span className="fs-icon"><FileIcon kind={iconKindFor(d.name, d.isDir, node.isOpen)} /></span>
      {d.severity ? <span className="fs-badge">{SEVERITY_BADGE[d.severity]}</span> : null}
      <span className="fs-name" style={color ? { color } : undefined}>
        {d.name}{d.isDir ? '/' : ''}
      </span>
      {d.truncated ? <span title={`子项过多，已截断显示`}>⋯</span> : null}
      {d.unreadable ? <span title={`无法读取该目录（通常是权限不足）`}>🚫</span> : null}
      {d.annotation ? <span className="fs-annotation">{d.annotation}</span> : null}
      {(d.groups ?? []).map(g => (
        <button
          key={g} type="button" className="fs-group-dot"
          title={`属于分组 ${g}`} aria-label={`选中分组 ${g} 的全部成员`}
          onClick={e => { e.stopPropagation(); onGroupClick?.(g) }}
        />
      ))}
    </div>
  )
}
