import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { GroupPanel } from './GroupPanel.js'
import type { GroupDraft, GroupPanelProps } from './GroupPanel.js'
import type { Group } from '@folderspec/core/api'

const G: Group[] = [{ id: 'parse', members: ['src/a.ts', 'src/b.ts'], text: '解析层', severity: 'warning' }]
const noop = { onSubmit: vi.fn(), onRemoveMember: vi.fn(), onEditGroup: vi.fn() }

/**
 * 草稿由上层持有（见 GroupPanelProps.draft），面板自己没有任何本地字段状态。
 * 这个壳只做上层职责里最基本的那一件：把 onDraftChange 交上来的草稿存住再传回去。
 *
 * 它**故意**不做 App 的另外三件事——落地后清空、切换目标时清空、锁定期间挡掉改选。
 * 那三件是接线层面的规则，桩里复刻一份只会多一处会与 App 漂移的地方；它们由
 * App.test.tsx 在真实接线上盯着（「写入落地后草稿清空」「在 g1 的框里写了字…」等）。
 */
function Harness(
  { draft: initial = null, ...props }:
    Omit<GroupPanelProps, 'draft' | 'onDraftChange'> & { draft?: GroupDraft | null },
) {
  const [draft, setDraft] = useState<GroupDraft | null>(initial)
  return <GroupPanel {...props} draft={draft} onDraftChange={setDraft} />
}

describe('GroupPanel', () => {
  it('显示成员数量与成员列表', () => {
    render(<Harness members={['src/a.ts', 'src/b.ts']} groups={[]} disabled={false} {...noop} />)
    expect(screen.getByText(/已选中 2 项/)).toBeTruthy()
    expect(screen.getByText('src/a.ts')).toBeTruthy()
  })

  // 回归动机：成员列表原先直接浮在「约束强度」下拉框下面，没有任何标题，用户在真实界面里
  // 反馈"不知道那几行是什么"。标题必须用 role=group 与列表本身关联（而不只是视觉上挨着），
  // 这样屏幕阅读器和这条用例都能验证"标题确实说的是这份列表"，不是碰巧相邻的两段文字。
  it('成员列表有标题，且与列表本身关联', () => {
    render(<Harness members={['src/a.ts', 'src/b.ts']} groups={[]} disabled={false} {...noop} />)
    const group = screen.getByRole('group', { name: /成员/ })
    expect(within(group).getByText('src/a.ts')).toBeTruthy()
    expect(within(group).getByText('src/b.ts')).toBeTruthy()
  })

  it('选中集等于既有分组时回填名字与注释', () => {
    render(<Harness members={['src/b.ts', 'src/a.ts']} groups={G} disabled={false} {...noop} />)
    expect((screen.getByLabelText('分组名') as HTMLInputElement).value).toBe('parse')
    expect((screen.getByLabelText('分组注释') as HTMLTextAreaElement).value).toBe('解析层')
    expect((screen.getByLabelText('约束强度') as HTMLSelectElement).value).toBe('warning')
  })

  it('选中集不等于任何分组时是新建形态，注释为空', () => {
    render(<Harness members={['src/a.ts', 'src/c.ts']} groups={G} disabled={false} {...noop} />)
    expect((screen.getByLabelText('分组注释') as HTMLTextAreaElement).value).toBe('')
  })

  it('注释失焦时提交，新建时 id 为 null', () => {
    const onSubmit = vi.fn()
    render(<Harness members={['src/a.ts', 'src/c.ts']} groups={G} disabled={false}
      onSubmit={onSubmit} onRemoveMember={vi.fn()} onEditGroup={vi.fn()} />)
    const ta = screen.getByLabelText('分组注释')
    fireEvent.change(ta, { target: { value: '新分组' } })
    fireEvent.blur(ta)
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ id: null, text: '新分组' }))
  })

  it('编辑既有分组时提交带上其 id', () => {
    const onSubmit = vi.fn()
    render(<Harness members={['src/a.ts', 'src/b.ts']} groups={G} disabled={false}
      onSubmit={onSubmit} onRemoveMember={vi.fn()} onEditGroup={vi.fn()} />)
    const ta = screen.getByLabelText('分组注释')
    fireEvent.change(ta, { target: { value: '改过的' } })
    fireEvent.blur(ta)
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ id: 'parse', text: '改过的' }))
  })

  it('内容未变时不提交', () => {
    const onSubmit = vi.fn()
    render(<Harness members={['src/a.ts', 'src/b.ts']} groups={G} disabled={false}
      onSubmit={onSubmit} onRemoveMember={vi.fn()} onEditGroup={vi.fn()} />)
    fireEvent.blur(screen.getByLabelText('分组注释'))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('点击成员上的移除按钮上报该成员路径', () => {
    const onRemoveMember = vi.fn()
    render(<Harness members={['src/a.ts', 'src/b.ts']} groups={[]} disabled={false}
      onSubmit={vi.fn()} onRemoveMember={onRemoveMember} onEditGroup={onRemoveMember} />)
    fireEvent.click(screen.getByLabelText('从选中集移除 src/a.ts'))
    expect(onRemoveMember).toHaveBeenCalledWith('src/a.ts')
  })

  it('多个分组成员集相同时给出提示', () => {
    const two: Group[] = [
      { id: 'g1', members: ['x'], text: 'a' },
      { id: 'g2', members: ['x'], text: 'b' },
    ]
    render(<Harness members={['x']} groups={two} disabled={false} {...noop} />)
    expect(screen.getByText(/有 2 个分组的成员完全相同/)).toBeTruthy()
  })

  // 上一条只断言"有提示"，没断言"只有一个匹配分组时没有提示"——两者是同一个条件
  // 判断的两侧，任何一侧独立缺失都测不出回归（例如把 matches.length > 1 误改成 >= 1）。
  it('只有一个分组匹配时不显示多分组提示', () => {
    render(<Harness members={['src/b.ts', 'src/a.ts']} groups={G} disabled={false} {...noop} />)
    expect(screen.queryByText(/个分组的成员完全相同/)).toBeNull()
  })

  it('只读模式下全部控件禁用', () => {
    render(<Harness members={['x', 'y']} groups={[]} disabled={true} {...noop} />)
    expect((screen.getByLabelText('分组注释') as HTMLTextAreaElement).disabled).toBe(true)
    expect((screen.getByLabelText('分组名') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText('约束强度') as HTMLSelectElement).disabled).toBe(true)
    // × 也在其中：只读的理由是契约文件解析失败，此时任何写入都不该发得出去
    expect((screen.getByLabelText('从选中集移除 x') as HTMLButtonElement).disabled).toBe(true)
  })

  it('切换选中集时重置为新集合的内容', () => {
    const { rerender } = render(
      <Harness members={['src/a.ts', 'src/b.ts']} groups={G} disabled={false} {...noop} />)
    rerender(<Harness members={['src/a.ts', 'src/c.ts']} groups={G} disabled={false} {...noop} />)
    expect((screen.getByLabelText('分组注释') as HTMLTextAreaElement).value).toBe('')
  })

  // 回归用例：members 是父组件每次渲染都新建的数组，引用永远不同。面板绝不能因为
  // "父组件因无关状态变化重渲染"就把用户正在编辑、还没失焦的内容冲掉。这正是
  // AnnotationPanel 那次"回声冲掉输入"事故的同类问题，用同一种夹具复现：先输入，
  // 再用内容相同、引用不同的新数组触发父组件重渲染，断言输入没有被冲掉。
  it('members 引用变化但内容不变时不冲掉正在编辑的内容', () => {
    const { rerender } = render(
      <Harness members={['src/a.ts', 'src/b.ts']} groups={G} disabled={false} {...noop} />)
    const ta = screen.getByLabelText('分组注释')
    fireEvent.change(ta, { target: { value: '正在输入还没失焦' } })
    // 内容与首次渲染相同，但每次都是新的数组字面量——引用不同
    rerender(<Harness members={['src/a.ts', 'src/b.ts']} groups={G} disabled={false} {...noop} />)
    expect((ta as HTMLTextAreaElement).value).toBe('正在输入还没失焦')
  })

  // 下面两条守的是"编辑目标由上层给定"这条约定。移除成员是乐观更新：members 立刻变少，
  // groups 要等宿主往返 20–60ms 才更新。那一帧里 matchingGroups 必然失配成新建形态，
  // 面板若自己猜目标就会把用户的分组名与注释清成空串；空串一提交，core 的
  // 「清空 text 即删除」就把分组连同注释一起抹掉——本项目唯一那条红线。
  it('绑定了 currentGroupId 时，成员集与它不再相等也仍然编辑它', () => {
    render(<Harness members={['src/a.ts']} groups={G} currentGroupId="parse"
      disabled={false} {...noop} />)
    expect((screen.getByLabelText('分组名') as HTMLInputElement).value).toBe('parse')
    expect((screen.getByLabelText('分组注释') as HTMLTextAreaElement).value).toBe('解析层')
    expect((screen.getByLabelText('约束强度') as HTMLSelectElement).value).toBe('warning')
  })

  it('currentGroupId 指向一个已不存在的分组时，退回按成员集判定', () => {
    // 注释被清空后 core 会把分组删掉，上层缓存的 id 从此指不到东西。
    // 这时不能卡在一个空壳上，否则选中集明明等于另一个分组也回填不出来。
    render(<Harness members={['src/a.ts', 'src/b.ts']} groups={G} currentGroupId="已经没了"
      disabled={false} {...noop} />)
    expect((screen.getByLabelText('分组注释') as HTMLTextAreaElement).value).toBe('解析层')
  })

  // ── 面板对成员集变化不做任何自作主张的重置 ────────────────────────────────
  //
  // 字段过去是 current 的快照，由一个按 keyOf(members) 重置的 effect 重新拍照。而成员集
  // 会因为用户自己的编辑动作（收缩这一组）而变，那一拍拍到的是宿主还没返回的旧值；成员键
  // 此后不再变化、effect 不再重跑，陈旧值就留在框里等下一次失焦写回契约。
  //
  // 那条重置规则连同它冻结的身份拷贝（targetKey）已经删掉了：草稿现在归上层所有，
  // 与"这一轮在编辑谁"同属一份状态，谁该丢掉它只有上层说了算。**别把重置加回面板里**
  // ——面板看不到"轮次"，它做的任何猜测都会在乐观更新那一帧猜错。

  it('编辑目标没换、只是成员集少了一个时，用户写的注释不被还原成旧值', () => {
    const rest = { groups: G, currentGroupId: 'parse', disabled: false, ...noop }
    const { rerender } = render(<Harness members={['src/a.ts', 'src/b.ts']} {...rest} />)
    const ta = screen.getByLabelText('分组注释')
    fireEvent.change(ta, { target: { value: '用户新写的一大段注释' } })

    // 收缩落地前的那一帧：members 已经少了一个，groups 还是旧的
    rerender(<Harness members={['src/a.ts']} {...rest} />)

    expect((ta as HTMLTextAreaElement).value).toBe('用户新写的一大段注释')
  })

  // 新建态（还没有分组落地）同样不能重置。这一格里 currentGroupId 是 null，而它与
  // "根本还没有轮次"在面板看来长得一模一样——面板正因如此**不该**拿它做任何分岔判断。
  it('新建态下写了一半注释再移除成员，写的内容不被清掉', () => {
    const rest = { groups: G, currentGroupId: null, disabled: false, ...noop }
    const { rerender } = render(
      <Harness members={['src/a.ts', 'src/c.ts', 'README.md']} {...rest} />)
    const ta = screen.getByLabelText('分组注释')
    fireEvent.change(ta, { target: { value: '写了一半' } })

    rerender(<Harness members={['src/a.ts', 'src/c.ts']} {...rest} />)

    expect((ta as HTMLTextAreaElement).value).toBe('写了一半')
  })

  // 提交时不得对用户本次没碰过的字段断言一个值：没碰过就该回落到 current 的**当前**值。
  // severity 那条缺陷的收口正在这里——它没碰过时的本地值是空串，翻译出来是 null，
  // 撞上 spec-edit.ts 的 `delete existing.severity`，把用户设好的强度删掉。
  it('用户没碰过的字段，提交时带的是 current 的当前值而不是陈旧快照', () => {
    const onSubmit = vi.fn()
    const BEFORE: Group[] = [{ id: 'parse', members: ['src/a.ts', 'src/b.ts'], text: '解析层' }]
    const AFTER: Group[] = [{ ...BEFORE[0], severity: 'error' }]
    const rest = {
      members: ['src/a.ts', 'src/b.ts'], currentGroupId: 'parse', disabled: false,
      onSubmit, onRemoveMember: vi.fn(), onEditGroup: vi.fn(),
    }
    const { rerender } = render(<Harness groups={BEFORE} {...rest} />)
    // 上一笔写入落地，强度到了契约里；用户这一轮从没碰过这个选择框
    rerender(<Harness groups={AFTER} {...rest} />)

    const ta = screen.getByLabelText('分组注释')
    fireEvent.change(ta, { target: { value: '改一句' } })
    fireEvent.blur(ta)

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ text: '改一句', severity: 'error' }))
  })

  // ── 约束强度：新建形态下的丢弃（发现 1）──────────────────────────────────
  //
  // 三个字段里只有约束强度曾经没有本地 state，value 直接读 current?.severity。而
  // 「选中 ≥2 项、分组还没落地」这一格里 current 恒为 null，于是用户先定强度、再写注释时：
  //   1. 选 error → submit 带着空 text 发出 → core 的「清空 text 即删除」把它当空操作
  //      （spec-edit.ts），分组没建出来 → 重渲染时 select 被 React 复位回"（仅注释，不强制）"
  //   2. 写完注释失焦 → submit 里 severity 取 current?.severity = null → 分组建出来了，没强度
  // 用户的一次显式输入被丢掉，只留下一次几乎看不见的视觉回弹。这正踩在 session.ts:19-24
  // 那条上：静默改写或丢弃用户的输入，比报错更糟。
  //
  // 触达路径是这个功能的**第一次交互**——只要用户的操作顺序是「先定强度、再写注释」。
  // 之所以 12 轮任务评审都没抓到：改之前这里 14 条用例，没有一条断言过 severity 被提交。

  it('新建形态下先选约束强度再写注释，建组时带上那个强度', () => {
    const onSubmit = vi.fn()
    render(<Harness members={['src/a.ts', 'src/c.ts']} groups={G} disabled={false}
      onSubmit={onSubmit} onRemoveMember={vi.fn()} onEditGroup={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('约束强度'), { target: { value: 'error' } })
    const ta = screen.getByLabelText('分组注释')
    fireEvent.change(ta, { target: { value: '新分组' } })
    fireEvent.blur(ta)

    // 真正把分组建出来的是这一次（带 text 的那次）。它必须捎上先前选好的强度，
    // 否则用户选的 error 就永远落不进契约。
    expect(onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: null, text: '新分组', severity: 'error' }))
  })

  it('新建形态下选过的约束强度不会被重渲染复位', () => {
    const { rerender } = render(
      <Harness members={['src/a.ts', 'src/c.ts']} groups={G} disabled={false} {...noop} />)
    fireEvent.change(screen.getByLabelText('约束强度'), { target: { value: 'error' } })
    // 那次 submit 在 core 侧是空操作，groups 原样回来 —— 面板照样要记得用户选了什么
    rerender(<Harness members={['src/a.ts', 'src/c.ts']} groups={G} disabled={false} {...noop} />)
    expect((screen.getByLabelText('约束强度') as HTMLSelectElement).value).toBe('error')
  })

  it('改约束强度立即提交，并带上当前分组的 id 与已有注释', () => {
    const onSubmit = vi.fn()
    render(<Harness members={['src/a.ts', 'src/b.ts']} groups={G} disabled={false}
      onSubmit={onSubmit} onRemoveMember={vi.fn()} onEditGroup={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('约束强度'), { target: { value: 'advisory' } })
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'parse', text: '解析层', severity: 'advisory' }))
  })

  it('把约束强度改回"不强制"时提交 null，而不是空串', () => {
    const onSubmit = vi.fn()
    render(<Harness members={['src/a.ts', 'src/b.ts']} groups={G} disabled={false}
      onSubmit={onSubmit} onRemoveMember={vi.fn()} onEditGroup={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('约束强度'), { target: { value: '' } })
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ id: 'parse', severity: null }))
  })

  it('切换选中集时约束强度与名字、注释一起重置', () => {
    const { rerender } = render(
      <Harness members={['src/a.ts', 'src/b.ts']} groups={G} disabled={false} {...noop} />)
    expect((screen.getByLabelText('约束强度') as HTMLSelectElement).value).toBe('warning')
    rerender(<Harness members={['src/a.ts', 'src/c.ts']} groups={G} disabled={false} {...noop} />)
    expect((screen.getByLabelText('约束强度') as HTMLSelectElement).value).toBe('')
  })

  // 分组注释那条守卫有用例（"内容未变时不提交"），分组名这条一直没有。两条是同一个约定
  // 的两半：失焦不等于修改过，任何一半失守都会在用户只是切走焦点时白发一次写入。
  it('分组名未变时失焦不提交', () => {
    const onSubmit = vi.fn()
    render(<Harness members={['src/a.ts', 'src/b.ts']} groups={G} disabled={false}
      onSubmit={onSubmit} onRemoveMember={vi.fn()} onEditGroup={vi.fn()} />)
    fireEvent.blur(screen.getByLabelText('分组名'))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('分组名改过之后失焦才提交', () => {
    const onSubmit = vi.fn()
    render(<Harness members={['src/a.ts', 'src/b.ts']} groups={G} disabled={false}
      onSubmit={onSubmit} onRemoveMember={vi.fn()} onEditGroup={vi.fn()} />)
    const input = screen.getByLabelText('分组名')
    fireEvent.change(input, { target: { value: 'parser' } })
    fireEvent.blur(input)
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ id: 'parse', name: 'parser' }))
  })

  // ── 草稿活着时成员集锁定 ──────────────────────────────────────────────────
  //
  // 两条 Critical 的共同触发条件都是"草稿还活着时成员集变了"：变完编辑目标就换了人，
  // 而草稿还是写给上一个目标的，一次失焦就盖掉新目标原有的注释——本项目唯一那条红线。
  // 面板这一半是把 × 置灰；树上的 ctrl/shift 改选与色点点击由 App 一并挡掉。

  it('有未提交的草稿时，成员的 × 禁用', () => {
    // 这一组直接渲染 GroupPanel 而不套 Harness：draft 由上层给定是这几条的**前提**，
    // 套上壳反而会让 rerender 改不动它（壳的 state 只在挂载时取一次初值）。
    render(<GroupPanel members={['src/a.ts', 'src/b.ts']} groups={G} draft={{ text: '写了一半' }}
      disabled={false} onDraftChange={vi.fn()} {...noop} />)
    expect((screen.getByLabelText('从选中集移除 src/a.ts') as HTMLButtonElement).disabled).toBe(true)
  })

  // 只把按钮置灰而标题照旧写着"点击 × 移出选中集"，等于界面自己在说谎：用户点了没反应，
  // 屏幕上没有任何一处说得清为什么。判据就是这一条——一眼能看出它为什么点不动。
  it('锁定态下成员列表的标题换成能解释当前状态的说法，并给出怎么解锁', () => {
    const rest = {
      members: ['src/a.ts', 'src/b.ts'], groups: G, disabled: false,
      onDraftChange: vi.fn(), ...noop,
    }
    const { rerender } = render(<GroupPanel draft={null} {...rest} />)
    expect(screen.getByRole('group', { name: /点击 × 移出选中集/ })).toBeTruthy()
    expect(screen.queryByText(/编辑尚未提交/)).toBeNull()

    rerender(<GroupPanel draft={{ text: '写了一半' }} {...rest} />)
    expect(screen.getByRole('group', { name: /已锁定/ })).toBeTruthy()
    expect(screen.getByText(/编辑尚未提交/)).toBeTruthy()
  })

  // 提示条曾经写着"点树上其他节点则放弃这次编辑"，而真实行为是那一下先失焦、把草稿
  // **提交**出去（App.test 的「先提交、再离开本轮」用 userEvent 实证）。用户照那句话去
  // "放弃"，得到的是把当前分组原有的注释覆盖掉——与"按钮置灰而标题照旧"同一类问题，
  // 只是换了个控件：界面不能许诺一个不存在的动作。
  it('锁定态的提示说的是"离开即提交"，不许诺一个不存在的放弃入口', () => {
    render(<GroupPanel members={['src/a.ts', 'src/b.ts']} groups={G} draft={{ text: '写了一半' }}
      disabled={false} onDraftChange={vi.fn()} {...noop} />)
    const hint = screen.getByText(/编辑尚未提交/).textContent ?? ''
    expect(hint).toMatch(/即提交/)
    expect(hint).not.toMatch(/放弃这次编辑/)
  })

  it('用户一开始输入，× 就跟着锁上', () => {
    render(<Harness members={['src/a.ts', 'src/b.ts']} groups={G} disabled={false} {...noop} />)
    expect((screen.getByLabelText('从选中集移除 src/a.ts') as HTMLButtonElement).disabled).toBe(false)

    fireEvent.change(screen.getByLabelText('分组注释'), { target: { value: '写了一半' } })

    expect((screen.getByLabelText('从选中集移除 src/a.ts') as HTMLButtonElement).disabled).toBe(true)
  })

  // 草稿是"用户改了什么"的合并结果，不是"最后改的那一个字段"。逐字段覆盖掉的话，
  // 先定强度再写注释时强度会被抹掉——那正是发现 1 的形状，只是搬了个家。
  it('改第二个字段时，第一个字段的草稿一起带上去', () => {
    const onDraftChange = vi.fn()
    render(<GroupPanel members={['x', 'y']} groups={[]} draft={{ severity: 'error' }}
      disabled={false} onDraftChange={onDraftChange} {...noop} />)
    fireEvent.change(screen.getByLabelText('分组注释'), { target: { value: '一句话' } })
    expect(onDraftChange).toHaveBeenCalledWith({ severity: 'error', text: '一句话' })
  })

  // ── 同成员分组的选择器（发现 2 / 设计文档 §5.4.1）────────────────────────
  //
  // §5.4.1：「若有多个分组的成员集完全相同，**面板顶部列出这几个供选择**，默认取文件中
  // 靠前的那个」。此前只做了后半句：提示写着"有 N 个分组的成员完全相同"，current 恒取
  // matches[0]，没有任何切换入口。§5.5 的色点也够不着——同成员的两个分组，点哪个色点得到
  // 的选中集都一样。后果是这类分组里的第二个，用户只能靠"先清空第一个的注释把它删掉"
  // 这种反直觉动作才碰得到。

  const TWO: Group[] = [
    { id: 'g1', members: ['x', 'y'], text: '第一个', severity: 'warning' },
    { id: 'g2', members: ['y', 'x'], text: '第二个' },
  ]

  it('多个分组成员集相同时把它们逐个列出来', () => {
    render(<Harness members={['x', 'y']} groups={TWO} disabled={false} {...noop} />)
    expect(screen.getByRole('button', { name: '改为编辑分组 g1' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '改为编辑分组 g2' })).toBeTruthy()
  })

  it('点击另一个同成员分组，把它的 id 上抛给上层', () => {
    const onEditGroup = vi.fn()
    render(<Harness members={['x', 'y']} groups={TWO} disabled={false}
      onSubmit={vi.fn()} onRemoveMember={vi.fn()} onEditGroup={onEditGroup} />)
    fireEvent.click(screen.getByRole('button', { name: '改为编辑分组 g2' }))
    expect(onEditGroup).toHaveBeenCalledWith('g2')
  })

  // 切换目标必须**同时**把三个字段换成新目标的内容。只上抛 id 而不换字段的话，用户看着
  // g2 的标题、编辑的是 g1 遗留在框里的文字，一失焦就把 g1 的注释盖到 g2 上——本项目
  // 唯一那条红线。
  //
  // "换字段"的做法是让上层**丢掉草稿**、字段跟着回流的新目标走，而不是把新目标的值拍进
  // 草稿——拍进去就又多一份会陈旧的快照。上层是同步回流的（App.handleEditGroup 的
  // setPending 与这一次点击同一批渲染），显示不会有空档；那一半连同"框里那半句会不会
  // 落到 g2 头上"由 App.test 在真实接线上盯着。
  it('切到另一个同成员分组时，三个字段立刻换成它的内容', () => {
    const onEditGroup = vi.fn()
    const rest = {
      members: ['x', 'y'], groups: TWO, disabled: false,
      onSubmit: vi.fn(), onRemoveMember: vi.fn(), onEditGroup,
    }
    const { rerender } = render(<Harness currentGroupId="g1" {...rest} />)
    expect((screen.getByLabelText('分组注释') as HTMLTextAreaElement).value).toBe('第一个')

    fireEvent.click(screen.getByRole('button', { name: '改为编辑分组 g2' }))
    expect(onEditGroup).toHaveBeenCalledWith('g2')
    rerender(<Harness currentGroupId="g2" {...rest} />)

    expect((screen.getByLabelText('分组名') as HTMLInputElement).value).toBe('g2')
    expect((screen.getByLabelText('分组注释') as HTMLTextAreaElement).value).toBe('第二个')
    expect((screen.getByLabelText('约束强度') as HTMLSelectElement).value).toBe('')
  })

  // 切过去之后**不留快照**：用户在 g2 上写了注释、写入还在途时再点一下选择器里的 g2，
  // 若面板把当时的值拍进草稿，拍到的就是落地前的旧文字，下一次失焦把它写回去——
  // 与"收缩成员"那条红线同一个根因，只是触发动作换成了点选择器。
  it('切过去之后分组内容在宿主侧变了，面板跟着变，不会把旧文字写回去', () => {
    const onSubmit = vi.fn()
    const rest = {
      members: ['x', 'y'], disabled: false,
      onSubmit, onRemoveMember: vi.fn(), onEditGroup: vi.fn(),
    }
    const { rerender } = render(<Harness groups={TWO} currentGroupId="g1" {...rest} />)
    fireEvent.click(screen.getByRole('button', { name: '改为编辑分组 g2' }))
    rerender(<Harness groups={TWO} currentGroupId="g2" {...rest} />)
    expect((screen.getByLabelText('分组注释') as HTMLTextAreaElement).value).toBe('第二个')

    const LANDED: Group[] = [TWO[0], { ...TWO[1], text: '落地后的文字' }]
    rerender(<Harness groups={LANDED} currentGroupId="g2" {...rest} />)

    expect((screen.getByLabelText('分组注释') as HTMLTextAreaElement).value).toBe('落地后的文字')
    fireEvent.blur(screen.getByLabelText('分组注释'))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('只有一个分组匹配时不列出选择器', () => {
    render(<Harness members={['src/b.ts', 'src/a.ts']} groups={G} disabled={false} {...noop} />)
    expect(screen.queryByRole('button', { name: /^改为编辑分组/ })).toBeNull()
  })

  it('只读模式下分组选择器一并禁用', () => {
    render(<Harness members={['x', 'y']} groups={TWO} disabled={true} {...noop} />)
    expect((screen.getByRole('button', { name: '改为编辑分组 g2' }) as HTMLButtonElement).disabled)
      .toBe(true)
  })
})
