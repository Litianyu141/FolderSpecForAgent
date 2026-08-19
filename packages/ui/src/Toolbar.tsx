import { useEffect, useState } from 'react'

export interface ToolbarProps {
  root: string
  searchTerm: string
  dirty: boolean
  disabled: boolean
  onOpenRoot(path: string): void
  onSearch(term: string): void
  onSave(): void
}

export function Toolbar({ root, searchTerm, dirty, disabled, onOpenRoot, onSearch, onSave }: ToolbarProps) {
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
      <input
        aria-label="搜索"
        type="search"
        value={searchTerm}
        placeholder="按名称或注释筛选"
        onChange={e => onSearch(e.target.value)}
      />
      <button type="button" disabled={disabled || !dirty} onClick={onSave}>
        保存{dirty ? <span aria-hidden="true"> •</span> : null}
      </button>
    </div>
  )
}
