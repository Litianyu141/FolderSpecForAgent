import { useId, useState } from 'react'
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
 * 上层已经开启的一轮分组编辑。
 *
 * 是个对象而不是一个裸的 id，因为**"有没有轮次"本身就是信息**：`null`（还没有轮次）
 * 与 `{ groupId: null }`（轮次开着，只是还没有分组——新建态）在面板里走的是两条路，
 * 一旦被 `pending?.groupId ?? null` 这类写法压成同一个 null，下面那条重置规则就再也
 * 分不清"用户换了选中集"和"用户在收缩自己正编辑的这一组"。别把它压回一个 id。
 */
export interface EditRound {
  /** 这一轮绑定的分组 id；null = 轮次已开始但还没有分组落地（新建态） */
  groupId: string | null
}

export interface GroupPanelProps {
  members: string[]
  groups: Group[]
  /**
   * 上层已经定下的编辑轮次（null / 省略 = 还没有轮次，编辑目标由成员集自行判定）。
   *
   * 移除成员是乐观更新：members 立刻变少，而 groups 要等宿主往返 20–60ms 才更新。那一帧里
   * matchingGroups 必然失配成"新建形态"，面板若自己猜目标就会猜成"这是另一组东西"，把
   * 用户的分组名与注释清掉；那个空串一提交，core 的「清空 text 即删除」就把分组连同注释
   * 一起抹掉——本项目唯一那条红线。所以"在编辑哪个分组"由上层给定，面板不去猜。
   */
  round?: EditRound | null
  disabled: boolean
  onSubmit(p: GroupSubmit): void
  onRemoveMember(path: string): void
  /**
   * `round` 的反方向：用户从"同成员分组"选择器里挑了另一个，把它上抛给上层
   * （设计文档 §5.4.1「面板顶部列出这几个供选择」）。面板不自己改编辑目标——理由同上：
   * 目标由上层那一份 pending 独占，两处各记一份必然发散。
   */
  onEditGroup(id: string): void
}

/** 选中集的稳定键：排序后拼接。 */
const keyOf = (members: readonly string[]) => [...members].sort().join(' ')

export function GroupPanel(
  { members, groups, round, disabled, onSubmit, onRemoveMember, onEditGroup }: GroupPanelProps,
) {
  // 成员列表原先没有标题，用户反馈"不知道那几行是什么"。用 aria-labelledby 把标题与
  // 列表本身关联（而不只是视觉上挨着），组件可能同屏出现多份（理论上），id 不能写死。
  const memberListHeadingId = useId()

  const matches = matchingGroups(members, groups)
  // 上层指定的目标优先；它指向一个已经不存在的分组（比如注释被清空后 core 把它删了）
  // 时退回按成员集判定，不至于卡在一个空壳上
  const boundId = round?.groupId ?? null
  const bound = boundId === null ? null : groups.find(g => g.id === boundId) ?? null
  const current = bound ?? matches[0] ?? null

  /**
   * 三个字段都是**草稿**：`undefined` 表示"这一轮编辑里用户还没碰过它"。
   *
   * 它们曾经是 current 的**快照**（`useState('')` + 一个把 current 的值拍进来的 effect），
   * 那是本项目唯一那条红线上摔得最重的一次。快照一旦在"宿主还没返回"的那一帧被重拍，
   * 拍到的就是旧值，而此后没有任何东西会再把它拍新：
   *
   *   写注释 → 点某个成员的 ×（mousedown 使输入框失焦，写入派发）→ click 使 members 收缩
   *   → 重置 effect 跑，此刻 current 仍是旧的 → 文本框被还原成旧注释
   *   → 此后**仅需一次失焦、无需任何输入**，陈旧的 text 与 current.text 不同，
   *     旧文本就被写回契约，用户刚写的一大段没了。
   *
   * 改成草稿之后，没碰过的字段**实时跟着 current 走**，面板里不再存在任何"旧值的副本"。
   * 于是：重置最坏也只是让显示回落到 current 的当前值，绝不可能复活一个陈旧值；提交时
   * 也永远不会对用户没碰过的字段断言一个陈旧快照或空值（severity 那条的根因正是空串
   * 被翻译成 null，撞上 spec-edit.ts 的 `delete existing.severity`）。
   *
   * 别把它们改回"初值取 current"的写法——那等于把快照请回来。
   */
  const [draftName, setDraftName] = useState<string | undefined>(undefined)
  const [draftText, setDraftText] = useState<string | undefined>(undefined)
  // 空串代表"（仅注释，不强制）"，提交时再翻译回 null —— DOM 的 select 没有 null 值。
  // 它与 undefined 是两回事：空串是用户**显式选了**不强制，undefined 是没碰过。
  const [draftSeverity, setDraftSeverity] = useState<Severity | '' | undefined>(undefined)

  const name = draftName ?? current?.id ?? ''
  const text = draftText ?? current?.text ?? ''
  const severity = draftSeverity ?? current?.severity ?? ''

  const dropDrafts = () => {
    setDraftName(undefined)
    setDraftText(undefined)
    setDraftSeverity(undefined)
  }

  /**
   * 重置的触发条件：**编辑目标真的换了**，而不是"成员集变了"。
   *
   * 这两件事过去被当成同一件，那正是上面那条红线的根因——成员集会因为用户自己的编辑动作
   * （收缩正在编辑的这一组）而变，此时编辑目标一步没动。
   *
   * 判据只有一条：`round == null` 才说明"没有正在进行的编辑轮次"，这时成员集就是编辑
   * 目标的全部身份，它一变就是用户在树上换了选中集，草稿必须丢掉。App 的每一条导航路径
   * （handleSelect / handlePickGroup / openRoot）都会先把 pending 清空，所以换目标必然
   * 经过 round == null 这一态；反过来，轮次开着时成员集怎么变都是同一个目标，绝不重置。
   *
   * 写成渲染期的状态调整而不是 useEffect，是为了不让那一帧的旧草稿先渲染出来又被清掉
   * （React 官方给"prop 变了要重置 state"的写法）。条件收敛，不会循环。
   */
  const [targetKey, setTargetKey] = useState(() => keyOf(members))
  const nextKey = round == null ? keyOf(members) : targetKey
  if (nextKey !== targetKey) {
    setTargetKey(nextKey)
    dropDrafts()
  }

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

  /**
   * 切到另一个同成员分组：丢掉草稿，让三个字段跟着新目标走。
   *
   * 这里刻意**不**把新目标的值拍进草稿。拍进去就又是一份快照：用户在 g2 上写了注释、
   * 写入还在途时再点一下选择器里的 g2，快照拍到的是落地前的旧文字，下一次失焦就把它
   * 写回去——和上面那条红线一模一样，只是触发动作换成了点选择器。
   *
   * 显示不会有空档：onEditGroup 会同步改上层的 pending，与这里的 setState 同一批渲染。
   */
  const pick = (g: Group) => {
    dropDrafts()
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
          onChange={e => setDraftName(e.target.value)}
          onBlur={() => { if (name.trim() !== (current?.id ?? '')) submit({ name: name.trim() }) }}
        />
      </label>

      <label className="fs-field">
        <span>分组注释</span>
        <textarea
          aria-label="分组注释" rows={6} value={text} disabled={disabled}
          onChange={e => setDraftText(e.target.value)}
          onBlur={() => { if (text.trim() !== (current?.text ?? '')) submit({ text: text.trim() }) }}
        />
      </label>

      <label className="fs-field">
        <span>约束强度</span>
        <select
          aria-label="约束强度" value={severity} disabled={disabled}
          onChange={e => {
            const next = e.target.value === '' ? '' : (e.target.value as Severity)
            setDraftSeverity(next)
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
        <span className="fs-field-label" id={memberListHeadingId}>成员（点击 × 移出选中集）</span>
        <ul className="fs-member-list" role="group" aria-labelledby={memberListHeadingId}>
          {members.map(m => (
            <li key={m}>
              <span className="fs-member-path">{m}</span>
              <button type="button" aria-label={`从选中集移除 ${m}`} disabled={disabled}
                onClick={() => onRemoveMember(m)}>×</button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
