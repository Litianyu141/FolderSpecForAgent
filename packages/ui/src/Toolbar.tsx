import { useEffect, useState } from 'react'
import type { ViewMode } from '@folderspec/core/api'

export interface ToolbarProps {
  root: string
  searchTerm: string
  dirty: boolean
  /** 当前是否不可编辑（只读态：契约解析失败，或「原始结构」视图）。同时管保存/撤销/重做三个按钮。 */
  disabled: boolean
  viewMode: ViewMode
  canUndo: boolean
  canRedo: boolean
  onOpenRoot(path: string): void
  onSearch(term: string): void
  onSave(): void
  onSetViewMode(mode: ViewMode): void
  onUndo(): void
  onRedo(): void
}

export function Toolbar({
  root, searchTerm, dirty, disabled, viewMode, canUndo, canRedo,
  onOpenRoot, onSearch, onSave, onSetViewMode, onUndo, onRedo,
}: ToolbarProps) {
  const [draft, setDraft] = useState(root)
  useEffect(() => { setDraft(root) }, [root])

  return (
    <div className="fs-toolbar">
      <input
        aria-label="工作区路径"
        type="text"
        value={draft}
        placeholder="工作区路径"
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') onOpenRoot(draft) }}
      />
      <button type="button" onClick={() => onOpenRoot(draft)}>载入</button>

      {/* 分段控件而非下拉：判据是"来回对比时一眼能看出当前在哪个视图"，下拉框收起来
          之后当前值不在视野里，来回切换还得先点开才知道切没切成功。
          两个按钮全程可点（包括点当前已激活的那个——上层会把它当空操作短路掉），
          不用 disabled 属性表达"当前态"：那是禁用语义，会被误读成"这个视图进不去"。 */}
      <div className="fs-viewmode" role="group" aria-label="结构视图">
        <button
          type="button" aria-pressed={viewMode === 'spec'}
          className={viewMode === 'spec' ? 'fs-viewmode-active' : undefined}
          onClick={() => onSetViewMode('spec')}
        >
          我的结构
        </button>
        <button
          type="button" aria-pressed={viewMode === 'disk'}
          className={viewMode === 'disk' ? 'fs-viewmode-active' : undefined}
          onClick={() => onSetViewMode('disk')}
        >
          原始结构
        </button>
      </div>

      <input
        aria-label="搜索"
        type="search"
        value={searchTerm}
        placeholder="按名称或注释筛选"
        onChange={e => onSearch(e.target.value)}
      />

      {/* 禁用条件必须是 canUndo && 可编辑，不能只判 canUndo：core 的 canUndo 只表示
          "栈非空"，故意不重复实现只读判断（见 EditResult.canUndo 上的注释）。
          "可编辑"就是这里的 disabled 取反——与保存按钮同一个闸门，disk 视图或契约
          解析失败时一并禁用，否则点下去会撞上 core 的 assertWritable() 报错。 */}
      <button type="button" disabled={disabled || !canUndo} onClick={onUndo}>撤销</button>
      <button type="button" disabled={disabled || !canRedo} onClick={onRedo}>重做</button>

      <button type="button" disabled={disabled || !dirty} onClick={onSave}>
        保存{dirty ? <span aria-hidden="true"> •</span> : null}
      </button>
    </div>
  )
}
