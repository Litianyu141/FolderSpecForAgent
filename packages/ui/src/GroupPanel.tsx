import { useEffect, useState } from 'react'
import type { Group, Severity } from '@folderspec/core/api'
import { SEVERITY_BADGE } from './colors.js'
import { matchingGroups } from './selection.js'

export interface GroupSubmit {
  id: string | null
  name: string
  text: string
  severity: Severity | null
}

export interface GroupPanelProps {
  members: string[]
  groups: Group[]
  disabled: boolean
  onSubmit(p: GroupSubmit): void
  onRemoveMember(path: string): void
}

/** 选中集的稳定键：排序后拼接。用它作为重置依赖，而不是 text/name —— 理由同
 *  AnnotationPanel：把 text 放进依赖，自己那次提交的回声会冲掉用户失焦后继续输入的内容。 */
const keyOf = (members: readonly string[]) => [...members].sort().join(' ')

export function GroupPanel({ members, groups, disabled, onSubmit, onRemoveMember }: GroupPanelProps) {
  const matches = matchingGroups(members, groups)
  const current = matches[0] ?? null

  const [name, setName] = useState('')
  const [text, setText] = useState('')

  useEffect(() => {
    setName(current?.id ?? '')
    setText(current?.text ?? '')
  }, [keyOf(members)])

  const submit = (over: Partial<GroupSubmit>) => {
    onSubmit({
      id: current?.id ?? null,
      name: name.trim(),
      text: text.trim(),
      severity: current?.severity ?? null,
      ...over,
    })
  }

  return (
    <div className="fs-panel">
      <h2 className="fs-panel-path">已选中 {members.length} 项</h2>

      {matches.length > 1 && (
        <p className="fs-panel-note">
          有 {matches.length} 个分组的成员完全相同，当前编辑的是 {current?.id}
        </p>
      )}

      <label className="fs-field">
        <span>分组名</span>
        <input
          aria-label="分组名" type="text" value={name} disabled={disabled}
          placeholder="留空则自动取名"
          onChange={e => setName(e.target.value)}
          onBlur={() => { if (name.trim() !== (current?.id ?? '')) submit({ name: name.trim() }) }}
        />
      </label>

      <label className="fs-field">
        <span>分组注释</span>
        <textarea
          aria-label="分组注释" rows={6} value={text} disabled={disabled}
          onChange={e => setText(e.target.value)}
          onBlur={() => { if (text.trim() !== (current?.text ?? '')) submit({ text: text.trim() }) }}
        />
      </label>

      <label className="fs-field">
        <span>约束强度</span>
        <select
          aria-label="约束强度" value={current?.severity ?? ''} disabled={disabled}
          onChange={e => submit({ severity: e.target.value === '' ? null : (e.target.value as Severity) })}
        >
          <option value="">（仅注释，不强制）</option>
          <option value="advisory">{SEVERITY_BADGE.advisory} advisory</option>
          <option value="warning">{SEVERITY_BADGE.warning} warning</option>
          <option value="error">{SEVERITY_BADGE.error} error</option>
        </select>
      </label>

      <ul className="fs-member-list">
        {members.map(m => (
          <li key={m}>
            <span className="fs-member-path">{m}</span>
            <button type="button" aria-label={`从选中集移除 ${m}`} disabled={disabled}
              onClick={() => onRemoveMember(m)}>×</button>
          </li>
        ))}
      </ul>
    </div>
  )
}
