import type { NodeRendererProps } from 'react-arborist'
import type { ViewNode } from '@folderspec/core/api'
import type { ClickMods } from './selection.js'
import { SEVERITY_BADGE, isAnnotated, nodeColorVar } from './colors.js'
import { FileIcon, iconKindFor } from './FileIcon.js'
import { useT } from './i18n.js'

export interface NodeRowExtraProps {
  onGroupClick?: (id: string) => void
  /**
   * 多选态的真源。不读 react-arborist 自己的 node.isSelected——
   * 那是它内部单选模型的产物，多选决策已经搬到外部的 SelectionState（见 selection.ts）。
   * 可选是为了不破坏既有测试里不传这个 prop 的调用方，此时退回 node.isSelected。
   */
  selectedPaths?: string[]
  onRowClick?: (path: string, mods: ClickMods) => void
  /** 右键：上层据此弹出节点操作菜单。坐标是视口坐标（clientX/clientY），菜单用 fixed 定位 */
  onRowContextMenu?: (path: string, x: number, y: number) => void
}

export function NodeRow(
  {
    node, style, dragHandle, onGroupClick, selectedPaths, onRowClick, onRowContextMenu,
  }: NodeRendererProps<ViewNode> & NodeRowExtraProps,
) {
  const d = node.data
  const color = nodeColorVar(d)
  const annotated = isAnnotated(d)
  const t = useT()
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
        const mods = { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey }
        // 带修饰键的点击是在扩选，不折叠/展开目录。两个理由：
        // 一是 shift 点一个目录本意是把选区延伸到它，顺手折叠本身就是意外行为；
        // 二是 toggle 之后 react-arborist 的 visibleNodes 要等下一次渲染才重算
        // （TreeApi.update），事件处理器里读到的仍是折叠前的顺序，区间会把随之从屏幕上
        // 消失的子项一并选进去——而选中集会被写进用户的契约文件（spec §5.3）。
        if (d.isDir && !mods.shift && !mods.ctrl) node.toggle()
        onRowClick?.(d.path, mods)
      }}
      onContextMenu={e => {
        e.preventDefault() // 换掉浏览器自带的菜单，那一份对这棵树毫无意义
        // 必须拦住冒泡：树栏那一层挂着"空白处右键 = 在根下新建"。让它冒过去的话，
        // 点在节点上会先设一次目标、再被空白那条覆盖成根，右键点谁都等于点了空白。
        e.stopPropagation()
        // 刻意**不**顺手把这一行选中。右键选中是文件管理器的习惯，但这里的选中集
        // 同时是分组的写入源（spec/setGroup 会把它写进契约，见 §5.3），一次右键把
        // 三项的多选收成一项、或者撞上分组草稿未提交时的成员锁，都是用户没要过的
        // 副作用。菜单顶部直接写出目标路径，不需要靠高亮来指认。
        onRowContextMenu?.(d.path, e.clientX, e.clientY)
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
      {d.truncated ? <span title={t('nodeRow.truncated')}>⋯</span> : null}
      {d.unreadable ? <span title={t('nodeRow.unreadableDir')}>🚫</span> : null}
      {/* d.annotation 是用户写的注释，数据，永远不经过 t()——见 i18n.ts 顶部那段边界说明 */}
      {d.annotation ? <span className="fs-annotation">{d.annotation}</span> : null}
      {(d.groups ?? []).map(g => (
        <button
          key={g} type="button" className="fs-group-dot"
          title={t('nodeRow.groupDotTitle', { group: g })}
          aria-label={t('nodeRow.groupDotAriaLabel', { group: g })}
          onClick={e => { e.stopPropagation(); onGroupClick?.(g) }}
        />
      ))}
    </div>
  )
}
