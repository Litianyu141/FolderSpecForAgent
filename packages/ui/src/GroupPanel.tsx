import { useId } from 'react'
import type { Group, Severity } from '@folderspec/core/api'
import { SEVERITY_BADGE } from './colors.js'
import { matchingGroups } from './selection.js'

export interface GroupSubmit {
  id: string | null
  name: string
  text: string
  severity: Severity | null
}

/**
 * 用户在面板里改了、但还没提交的那一份。字段 `undefined` = 这一轮里他没碰过它。
 *
 * **它由上层（App）持有，不在这个组件里。** 这不是分层洁癖，是两条 Critical 的收口：
 * 草稿必须和"它是写给谁的"存在同一份状态里，否则成员集一变、编辑目标跟着换，草稿却
 * 原地不动，下一次失焦就把它写到另一个分组头上，把那个分组原有的注释覆盖掉——本项目
 * 唯一那条红线。放在上层之后，"草稿"与"这一轮在编辑谁"是同一个对象的两个字段，
 * 想让它们分家得先把那个对象拆了。
 *
 * 面板对草稿只有一个动作：**往上抛用户改了什么**。清空草稿（落地后、切换目标时、
 * 离开本轮时）全部是上层的决定，面板不参与——两处都能清就必然发散。
 */
export interface GroupDraft {
  name?: string
  text?: string
  /** 空串 = 用户**显式**选了"不强制"，与 undefined（没碰过）是两回事 */
  severity?: Severity | ''
}

export interface GroupPanelProps {
  members: string[]
  groups: Group[]
  /**
   * 上层已经定下的编辑目标（null / 省略 = 由成员集自行判定）。
   *
   * 移除成员是乐观更新：members 立刻变少，而 groups 要等宿主往返 20–60ms 才更新。那一帧里
   * matchingGroups 必然失配成"新建形态"，面板若自己猜目标就会猜成"这是另一组东西"。
   * 所以"在编辑哪个分组"由上层给定，面板不去猜。
   */
  currentGroupId?: string | null
  /**
   * 本轮尚未提交的草稿（null / 省略 = 没有草稿，三个字段实时跟着 current 走）。
   *
   * **非 null 时成员集锁定**：× 按钮置灰，上层同时把树上的 ctrl/shift 改选与色点点击
   * 一并挡掉。这两件事是同一条规则的两半，任何一半失守，草稿就会活到编辑目标换掉之后。
   */
  draft?: GroupDraft | null
  disabled: boolean
  onSubmit(p: GroupSubmit): void
  /** 用户改了某个字段：把合并后的整份草稿交给上层，由它决定这一轮在编辑谁 */
  onDraftChange(next: GroupDraft): void
  onRemoveMember(path: string): void
  /**
   * `currentGroupId` 的反方向：用户从"同成员分组"选择器里挑了另一个，把它上抛给上层
   * （设计文档 §5.4.1「面板顶部列出这几个供选择」）。面板不自己改编辑目标——理由同上：
   * 目标由上层那一份 pending 独占，两处各记一份必然发散。
   */
  onEditGroup(id: string): void
}

export function GroupPanel(
  {
    members, groups, currentGroupId, draft, disabled,
    onSubmit, onDraftChange, onRemoveMember, onEditGroup,
  }: GroupPanelProps,
) {
  // 成员列表原先没有标题，用户反馈"不知道那几行是什么"。用 aria-labelledby 把标题与
  // 列表本身关联（而不只是视觉上挨着），组件可能同屏出现多份（理论上），id 不能写死。
  const memberListHeadingId = useId()

  const matches = matchingGroups(members, groups)
  // 上层指定的目标优先；它指向一个已经不存在的分组（比如注释被清空后 core 把它删了）
  // 时退回按成员集判定，不至于卡在一个空壳上
  const boundId = currentGroupId ?? null
  const bound = boundId === null ? null : groups.find(g => g.id === boundId) ?? null
  const current = bound ?? matches[0] ?? null

  /**
   * 三个字段的显示值：草稿里有就用草稿的，没碰过的**实时跟着 current 走**。
   *
   * 它们曾经是 current 的**快照**（`useState('')` + 一个把 current 的值拍进来的 effect），
   * 那是本项目唯一那条红线上摔得最重的一次。快照一旦在"宿主还没返回"的那一帧被重拍，
   * 拍到的就是旧值，而此后没有任何东西会再把它拍新，下一次失焦就把旧文字写回契约。
   *
   * 别把它们改回"初值取 current"的写法——那等于把快照请回来。
   */
  const name = draft?.name ?? current?.id ?? ''
  const text = draft?.text ?? current?.text ?? ''
  const severity = draft?.severity ?? current?.severity ?? ''

  /**
   * 有未提交的草稿 ⇒ 本轮成员集锁定。
   *
   * 两条 Critical 的共同触发条件都是"草稿还活着时成员集变了"：变完编辑目标就换了人，
   * 而草稿还是写给上一个目标的，一次失焦就盖掉新目标原有的注释。锁住即整类消失。
   *
   * **不要给它加"聪明一点"的例外**（比如"只有新建态才锁""移除后还相等就放行"）：
   * 每一个例外都是一条要靠人记住的规则，而这块状态机已经连续四轮出现"修好当轮、
   * 在别处引入新缺陷"。出路是普通单击（见上层 handleSelect），不是例外。
   */
  const locked = draft != null

  const submit = (over: Partial<GroupSubmit>) => {
    onSubmit({
      id: current?.id ?? null,
      // 三个值都已经过 `?? current`，用户没碰过的字段带的就是 current 的**当前**值，
      // 不是某个时刻的快照，也不是空值
      name: name.trim(),
      text: text.trim(),
      severity: severity === '' ? null : severity,
      ...over,
    })
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
                  onClick={() => onEditGroup(g.id)}
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
          onChange={e => onDraftChange({ ...draft, name: e.target.value })}
          onBlur={() => { if (name.trim() !== (current?.id ?? '')) submit({ name: name.trim() }) }}
        />
      </label>

      <label className="fs-field">
        <span>分组注释</span>
        <textarea
          aria-label="分组注释" rows={6} value={text} disabled={disabled}
          onChange={e => onDraftChange({ ...draft, text: e.target.value })}
          onBlur={() => { if (text.trim() !== (current?.text ?? '')) submit({ text: text.trim() }) }}
        />
      </label>

      <label className="fs-field">
        <span>约束强度</span>
        <select
          aria-label="约束强度" value={severity} disabled={disabled}
          onChange={e => {
            const next = e.target.value === '' ? '' : (e.target.value as Severity)
            onDraftChange({ ...draft, severity: next })
            submit({ severity: next === '' ? null : next })
          }}
        >
          <option value="">（仅注释，不强制）</option>
          <option value="advisory">{SEVERITY_BADGE.advisory} advisory</option>
          <option value="warning">{SEVERITY_BADGE.warning} warning</option>
          <option value="error">{SEVERITY_BADGE.error} error</option>
        </select>
      </label>

      <div className="fs-member-list-wrap">
        {/* 标题在锁定态下换说法：判据是"用户点了 × 没反应时，能一眼明白为什么"。
            只把按钮置灰而标题照旧写着"点击 × 移出选中集"，等于界面自己在说谎。 */}
        <span className="fs-field-label" id={memberListHeadingId}>
          {locked ? '成员（编辑中已锁定）' : '成员（点击 × 移出选中集）'}
        </span>
        {locked && (
          <p className="fs-lock-hint">
            编辑尚未提交，成员暂不可增减。点输入框以外任意处即提交；点树上其他节点则放弃这次编辑。
          </p>
        )}
        <ul className="fs-member-list" role="group" aria-labelledby={memberListHeadingId}>
          {members.map(m => (
            <li key={m}>
              <span className="fs-member-path">{m}</span>
              <button type="button" aria-label={`从选中集移除 ${m}`} disabled={disabled || locked}
                title={locked ? '编辑尚未提交，成员暂不可增减' : undefined}
                onClick={() => onRemoveMember(m)}>×</button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
