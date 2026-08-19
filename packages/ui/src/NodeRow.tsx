import type { NodeRendererProps } from 'react-arborist'
import type { ViewNode } from '@folderspec/core/api'
import type { ClickMods } from './selection.js'
import { SEVERITY_BADGE, isAnnotated, nodeColorVar } from './colors.js'
import { FileIcon, iconKindFor } from './FileIcon.js'

export interface NodeRowExtraProps {
  onGroupClick?: (id: string) => void
  /**
   * 多选态的真源。不读 react-arborist 自己的 node.isSelected——
   * 那是它内部单选模型的产物，多选决策已经搬到外部的 SelectionState（见 selection.ts）。
   * 可选是为了不破坏既有测试里不传这个 prop 的调用方，此时退回 node.isSelected。
   */
  selectedPaths?: string[]
  onRowClick?: (path: string, mods: ClickMods) => void
}

export function NodeRow(
  { node, style, dragHandle, onGroupClick, selectedPaths, onRowClick }: NodeRendererProps<ViewNode> & NodeRowExtraProps,
) {
  const d = node.data
  const color = nodeColorVar(d)
  const annotated = isAnnotated(d)
  const selected = selectedPaths ? selectedPaths.includes(d.path) : node.isSelected
  // paddingLeft 是 react-arborist 表达层级的方式；这里换成可见的引导线，所以要摘掉它
  const { paddingLeft: _drop, ...rest } = (style ?? {}) as { paddingLeft?: unknown }

  return (
    <div
      ref={dragHandle}
      style={rest as React.CSSProperties}
      className="fs-row"
      data-selected={selected}
      data-origin={d.origin}
      data-annotated={annotated}
      onClick={e => {
        if (d.isDir) node.toggle()
        onRowClick?.(d.path, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey })
      }}
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
