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
  /**
   * 上层已经定下的编辑目标（null / 省略 = 由成员集自行判定）。
   *
   * 移除成员是乐观更新：members 立刻变少，而 groups 要等宿主往返 20–60ms 才更新。那一帧里
   * matchingGroups 必然失配成"新建形态"，按成员键重置的 effect 随即把用户的分组名与注释
   * 清成空串；等 groups 回来 current 虽恢复，成员键却不再变化、effect 不再重跑，字段停在空。
   * 那个空串一提交，core 的「清空 text 即删除」就把分组连同注释一起抹掉——本项目唯一那条
   * 红线。所以"在编辑哪个分组"由上层给定，面板不去猜。
   */
  currentGroupId?: string | null
  disabled: boolean
  onSubmit(p: GroupSubmit): void
  onRemoveMember(path: string): void
  /**
   * `currentGroupId` 的反方向：用户从"同成员分组"选择器里挑了另一个，把它上抛给上层
   * （设计文档 §5.4.1「面板顶部列出这几个供选择」）。面板不自己改编辑目标——理由同上：
   * 目标由上层那一份 pending 独占，两处各记一份必然发散。
   */
  onEditGroup(id: string): void
}

/** 选中集的稳定键：排序后拼接。用它作为重置依赖，而不是 text/name —— 理由同
 *  AnnotationPanel：把 text 放进依赖，自己那次提交的回声会冲掉用户失焦后继续输入的内容。 */
const keyOf = (members: readonly string[]) => [...members].sort().join(' ')

export function GroupPanel(
  { members, groups, currentGroupId, disabled, onSubmit, onRemoveMember, onEditGroup }: GroupPanelProps,
) {
  const matches = matchingGroups(members, groups)
  // 上层指定的目标优先；它指向一个已经不存在的分组（比如注释被清空后 core 把它删了）
  // 时退回按成员集判定，不至于卡在一个空壳上
  const bound = currentGroupId == null ? null : groups.find(g => g.id === currentGroupId) ?? null
  const current = bound ?? matches[0] ?? null

  const [name, setName] = useState('')
  const [text, setText] = useState('')
  /**
   * 约束强度也要有本地 state，理由和 name/text 不同，得单说。
   *
   * 它曾经是唯一一个直接读 `current?.severity` 的受控 select。而"选中 ≥2 项、分组还没
   * 落地"这一格里 `current` 恒为 null，于是用户**先定强度、再写注释**时：那次 submit 带着
   * 空 text 发出，被 core 的「清空 text 即删除」当成空操作（spec-edit.ts）——分组没建出来，
   * select 随即被 React 复位；等注释失焦真把分组建出来，severity 取的又是 current 上的 null。
   * 用户那一次显式输入就这么没了，只留下一次几乎看不见的视觉回弹。
   * 静默丢弃用户的输入比报错更糟（session.ts 开头那条），所以这里必须自己记住。
   *
   * 空串代表"（仅注释，不强制）"，提交时再翻译回 null —— DOM 的 select 没有 null 值。
   */
  const [severity, setSeverity] = useState<Severity | ''>('')

  useEffect(() => {
    setName(current?.id ?? '')
    setText(current?.text ?? '')
    setSeverity(current?.severity ?? '')
  }, [keyOf(members)])

  const submit = (over: Partial<GroupSubmit>) => {
    onSubmit({
      id: current?.id ?? null,
      name: name.trim(),
      text: text.trim(),
      severity: severity === '' ? null : severity,
      ...over,
    })
  }

  /**
   * 切到另一个同成员分组：三个字段必须**当场**换成新目标的内容。
   *
   * 只上抛 id 而不换字段的话，用户看着 g2 的标题、编辑的却是 g1 遗留在框里的文字，
   * 一失焦就把 g1 的注释盖到 g2 上——本项目唯一那条红线。
   *
   * 重置刻意写在这个明确的点击动作里，而**不是**把 current 加进上面那个 effect 的依赖：
   * 那样一来，宿主往返落地引起的 current 变化（改名后 id 会变）也会触发重置，把用户正在
   * 输入、还没失焦的内容冲掉——AnnotationPanel 那次"回声冲掉输入"的同类事故。
   */
  const pick = (g: Group) => {
    setName(g.id)
    setText(g.text)
    setSeverity(g.severity ?? '')
    onEditGroup(g.id)
  }

  return (
    <div className="fs-panel">
      <h2 className="fs-panel-path">已选中 {members.length} 项</h2>

      {matches.length > 1 && (
        <div className="fs-panel-note">
          有 {matches.length} 个分组的成员完全相同，当前编辑的是 {current?.id}
          <ul className="fs-group-choices">
            {matches.map(g => (
              <li key={g.id}>
                <button
                  type="button" className="fs-group-link" disabled={disabled}
                  aria-label={`改为编辑分组 ${g.id}`}
                  aria-current={g.id === current?.id}
                  onClick={() => pick(g)}
                >{g.id}</button>
              </li>
            ))}
          </ul>
        </div>
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
          aria-label="约束强度" value={severity} disabled={disabled}
          onChange={e => {
            const next = e.target.value === '' ? '' : (e.target.value as Severity)
            setSeverity(next)
            submit({ severity: next === '' ? null : next })
          }}
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
