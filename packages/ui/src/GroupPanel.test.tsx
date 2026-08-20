import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { GroupPanel } from './GroupPanel.js'
import type { Group } from '@folderspec/core/api'

const G: Group[] = [{ id: 'parse', members: ['src/a.ts', 'src/b.ts'], text: '解析层', severity: 'warning' }]
const noop = { onSubmit: vi.fn(), onRemoveMember: vi.fn(), onEditGroup: vi.fn() }

describe('GroupPanel', () => {
  it('显示成员数量与成员列表', () => {
    render(<GroupPanel members={['src/a.ts', 'src/b.ts']} groups={[]} disabled={false} {...noop} />)
    expect(screen.getByText(/已选中 2 项/)).toBeTruthy()
    expect(screen.getByText('src/a.ts')).toBeTruthy()
  })

  it('选中集等于既有分组时回填名字与注释', () => {
    render(<GroupPanel members={['src/b.ts', 'src/a.ts']} groups={G} disabled={false} {...noop} />)
    expect((screen.getByLabelText('分组名') as HTMLInputElement).value).toBe('parse')
    expect((screen.getByLabelText('分组注释') as HTMLTextAreaElement).value).toBe('解析层')
    expect((screen.getByLabelText('约束强度') as HTMLSelectElement).value).toBe('warning')
  })

  it('选中集不等于任何分组时是新建形态，注释为空', () => {
    render(<GroupPanel members={['src/a.ts', 'src/c.ts']} groups={G} disabled={false} {...noop} />)
    expect((screen.getByLabelText('分组注释') as HTMLTextAreaElement).value).toBe('')
  })

  it('注释失焦时提交，新建时 id 为 null', () => {
    const onSubmit = vi.fn()
    render(<GroupPanel members={['src/a.ts', 'src/c.ts']} groups={G} disabled={false}
      onSubmit={onSubmit} onRemoveMember={vi.fn()} onEditGroup={vi.fn()} />)
    const ta = screen.getByLabelText('分组注释')
    fireEvent.change(ta, { target: { value: '新分组' } })
    fireEvent.blur(ta)
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ id: null, text: '新分组' }))
  })

  it('编辑既有分组时提交带上其 id', () => {
    const onSubmit = vi.fn()
    render(<GroupPanel members={['src/a.ts', 'src/b.ts']} groups={G} disabled={false}
      onSubmit={onSubmit} onRemoveMember={vi.fn()} onEditGroup={vi.fn()} />)
    const ta = screen.getByLabelText('分组注释')
    fireEvent.change(ta, { target: { value: '改过的' } })
    fireEvent.blur(ta)
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ id: 'parse', text: '改过的' }))
  })

  it('内容未变时不提交', () => {
    const onSubmit = vi.fn()
    render(<GroupPanel members={['src/a.ts', 'src/b.ts']} groups={G} disabled={false}
      onSubmit={onSubmit} onRemoveMember={vi.fn()} onEditGroup={vi.fn()} />)
    fireEvent.blur(screen.getByLabelText('分组注释'))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('点击成员上的移除按钮上报该成员路径', () => {
    const onRemoveMember = vi.fn()
    render(<GroupPanel members={['src/a.ts', 'src/b.ts']} groups={[]} disabled={false}
      onSubmit={vi.fn()} onRemoveMember={onRemoveMember} onEditGroup={vi.fn()} />)
    fireEvent.click(screen.getByLabelText('从选中集移除 src/a.ts'))
    expect(onRemoveMember).toHaveBeenCalledWith('src/a.ts')
  })

  it('多个分组成员集相同时给出提示', () => {
    const two: Group[] = [
      { id: 'g1', members: ['x'], text: 'a' },
      { id: 'g2', members: ['x'], text: 'b' },
    ]
    render(<GroupPanel members={['x']} groups={two} disabled={false} {...noop} />)
    expect(screen.getByText(/有 2 个分组的成员完全相同/)).toBeTruthy()
  })

  // 上一条只断言"有提示"，没断言"只有一个匹配分组时没有提示"——两者是同一个条件
  // 判断的两侧，任何一侧独立缺失都测不出回归（例如把 matches.length > 1 误改成 >= 1）。
  it('只有一个分组匹配时不显示多分组提示', () => {
    render(<GroupPanel members={['src/b.ts', 'src/a.ts']} groups={G} disabled={false} {...noop} />)
    expect(screen.queryByText(/个分组的成员完全相同/)).toBeNull()
  })

  it('只读模式下全部控件禁用', () => {
    render(<GroupPanel members={['x']} groups={[]} disabled={true} {...noop} />)
    expect((screen.getByLabelText('分组注释') as HTMLTextAreaElement).disabled).toBe(true)
    expect((screen.getByLabelText('分组名') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText('约束强度') as HTMLSelectElement).disabled).toBe(true)
  })

  it('切换选中集时重置为新集合的内容', () => {
    const { rerender } = render(
      <GroupPanel members={['src/a.ts', 'src/b.ts']} groups={G} disabled={false} {...noop} />)
    rerender(<GroupPanel members={['src/a.ts', 'src/c.ts']} groups={G} disabled={false} {...noop} />)
    expect((screen.getByLabelText('分组注释') as HTMLTextAreaElement).value).toBe('')
  })

  // 回归用例：members 是父组件每次渲染都新建的数组，引用永远不同。重置 effect 的依赖
  // 必须用内容键（keyOf）而不是数组本身——否则父组件因无关状态变化重渲染时，即便选中集
  // 内容没变，effect 也会重新触发，把用户正在编辑但还没失焦的内容冲掉。这正是
  // AnnotationPanel 那次"回声冲掉输入"事故的同类问题，用同一种夹具复现：先输入，
  // 再用内容相同、引用不同的新数组触发父组件重渲染，断言输入没有被冲掉。
  it('members 引用变化但内容不变时不冲掉正在编辑的内容', () => {
    const { rerender } = render(
      <GroupPanel members={['src/a.ts', 'src/b.ts']} groups={G} disabled={false} {...noop} />)
    const ta = screen.getByLabelText('分组注释')
    fireEvent.change(ta, { target: { value: '正在输入还没失焦' } })
    // 内容与首次渲染相同，但每次都是新的数组字面量——引用不同
    rerender(<GroupPanel members={['src/a.ts', 'src/b.ts']} groups={G} disabled={false} {...noop} />)
    expect((ta as HTMLTextAreaElement).value).toBe('正在输入还没失焦')
  })

  // 下面两条守的是"编辑目标由上层给定"这条约定。移除成员是乐观更新：members 立刻变少，
  // groups 要等宿主往返 20–60ms 才更新。那一帧里 matchingGroups 必然失配成新建形态，
  // 重置 effect 随即把用户的分组名与注释清成空串；空串一提交，core 的「清空 text 即删除」
  // 就把分组连同注释一起抹掉——本项目唯一那条红线。
  it('绑定了 round.groupId 时，成员集与它不再相等也仍然编辑它', () => {
    render(<GroupPanel members={['src/a.ts']} groups={G} round={{ groupId: 'parse' }}
      disabled={false} {...noop} />)
    expect((screen.getByLabelText('分组名') as HTMLInputElement).value).toBe('parse')
    expect((screen.getByLabelText('分组注释') as HTMLTextAreaElement).value).toBe('解析层')
    expect((screen.getByLabelText('约束强度') as HTMLSelectElement).value).toBe('warning')
  })

  it('round.groupId 指向一个已不存在的分组时，退回按成员集判定', () => {
    // 注释被清空后 core 会把分组删掉，上层缓存的 id 从此指不到东西。
    // 这时不能卡在一个空壳上，否则选中集明明等于另一个分组也回填不出来。
    render(<GroupPanel members={['src/a.ts', 'src/b.ts']} groups={G} round={{ groupId: '已经没了' }}
      disabled={false} {...noop} />)
    expect((screen.getByLabelText('分组注释') as HTMLTextAreaElement).value).toBe('解析层')
  })

  // ── 重置的触发条件：编辑目标真的换了，而不是成员集变了 ────────────────────
  //
  // 字段过去是 current 的快照，由一个按 keyOf(members) 重置的 effect 重拍。而成员集会因为
  // 用户自己的编辑动作（收缩正在编辑的这一组）而变，那一拍拍到的是宿主还没返回的旧值；
  // 成员键此后不再变化、effect 不再重跑，陈旧值就留在框里等下一次失焦写回契约。

  it('编辑目标没换、只是成员集少了一个时，用户写的注释不被还原成旧值', () => {
    const rest = { groups: G, round: { groupId: 'parse' }, disabled: false, ...noop }
    const { rerender } = render(<GroupPanel members={['src/a.ts', 'src/b.ts']} {...rest} />)
    const ta = screen.getByLabelText('分组注释')
    fireEvent.change(ta, { target: { value: '用户新写的一大段注释' } })

    // 收缩落地前的那一帧：members 已经少了一个，groups 还是旧的
    rerender(<GroupPanel members={['src/a.ts']} {...rest} />)

    expect((ta as HTMLTextAreaElement).value).toBe('用户新写的一大段注释')
  })

  // 新建态（轮次开着但还没有分组）同样不能重置。这一格里 round.groupId 是 null，
  // 和"根本还没有轮次"在旧的 `currentGroupId?: string | null` 编码下长得一模一样——
  // 正因如此 round 必须是个对象，把"有没有这一轮"这个事实本身带过来。
  it('新建态下写了一半注释再移除成员，写的内容不被清掉', () => {
    const rest = { groups: G, round: { groupId: null }, disabled: false, ...noop }
    const { rerender } = render(
      <GroupPanel members={['src/a.ts', 'src/c.ts', 'README.md']} {...rest} />)
    const ta = screen.getByLabelText('分组注释')
    fireEvent.change(ta, { target: { value: '写了一半' } })

    rerender(<GroupPanel members={['src/a.ts', 'src/c.ts']} {...rest} />)

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
      members: ['src/a.ts', 'src/b.ts'], round: { groupId: 'parse' }, disabled: false,
      onSubmit, onRemoveMember: vi.fn(), onEditGroup: vi.fn(),
    }
    const { rerender } = render(<GroupPanel groups={BEFORE} {...rest} />)
    // 上一笔写入落地，强度到了契约里；用户这一轮从没碰过这个选择框
    rerender(<GroupPanel groups={AFTER} {...rest} />)

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
    render(<GroupPanel members={['src/a.ts', 'src/c.ts']} groups={G} disabled={false}
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
      <GroupPanel members={['src/a.ts', 'src/c.ts']} groups={G} disabled={false} {...noop} />)
    fireEvent.change(screen.getByLabelText('约束强度'), { target: { value: 'error' } })
    // 那次 submit 在 core 侧是空操作，groups 原样回来 —— 面板照样要记得用户选了什么
    rerender(<GroupPanel members={['src/a.ts', 'src/c.ts']} groups={G} disabled={false} {...noop} />)
    expect((screen.getByLabelText('约束强度') as HTMLSelectElement).value).toBe('error')
  })

  it('改约束强度立即提交，并带上当前分组的 id 与已有注释', () => {
    const onSubmit = vi.fn()
    render(<GroupPanel members={['src/a.ts', 'src/b.ts']} groups={G} disabled={false}
      onSubmit={onSubmit} onRemoveMember={vi.fn()} onEditGroup={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('约束强度'), { target: { value: 'advisory' } })
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'parse', text: '解析层', severity: 'advisory' }))
  })

  it('把约束强度改回"不强制"时提交 null，而不是空串', () => {
    const onSubmit = vi.fn()
    render(<GroupPanel members={['src/a.ts', 'src/b.ts']} groups={G} disabled={false}
      onSubmit={onSubmit} onRemoveMember={vi.fn()} onEditGroup={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('约束强度'), { target: { value: '' } })
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ id: 'parse', severity: null }))
  })

  it('切换选中集时约束强度与名字、注释一起重置', () => {
    const { rerender } = render(
      <GroupPanel members={['src/a.ts', 'src/b.ts']} groups={G} disabled={false} {...noop} />)
    expect((screen.getByLabelText('约束强度') as HTMLSelectElement).value).toBe('warning')
    rerender(<GroupPanel members={['src/a.ts', 'src/c.ts']} groups={G} disabled={false} {...noop} />)
    expect((screen.getByLabelText('约束强度') as HTMLSelectElement).value).toBe('')
  })

  // 分组注释那条守卫有用例（"内容未变时不提交"），分组名这条一直没有。两条是同一个约定
  // 的两半：失焦不等于修改过，任何一半失守都会在用户只是切走焦点时白发一次写入。
  it('分组名未变时失焦不提交', () => {
    const onSubmit = vi.fn()
    render(<GroupPanel members={['src/a.ts', 'src/b.ts']} groups={G} disabled={false}
      onSubmit={onSubmit} onRemoveMember={vi.fn()} onEditGroup={vi.fn()} />)
    fireEvent.blur(screen.getByLabelText('分组名'))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('分组名改过之后失焦才提交', () => {
    const onSubmit = vi.fn()
    render(<GroupPanel members={['src/a.ts', 'src/b.ts']} groups={G} disabled={false}
      onSubmit={onSubmit} onRemoveMember={vi.fn()} onEditGroup={vi.fn()} />)
    const input = screen.getByLabelText('分组名')
    fireEvent.change(input, { target: { value: 'parser' } })
    fireEvent.blur(input)
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ id: 'parse', name: 'parser' }))
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
    render(<GroupPanel members={['x', 'y']} groups={TWO} disabled={false} {...noop} />)
    expect(screen.getByRole('button', { name: '改为编辑分组 g1' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '改为编辑分组 g2' })).toBeTruthy()
  })

  it('点击另一个同成员分组，把它的 id 上抛给上层', () => {
    const onEditGroup = vi.fn()
    render(<GroupPanel members={['x', 'y']} groups={TWO} disabled={false}
      onSubmit={vi.fn()} onRemoveMember={vi.fn()} onEditGroup={onEditGroup} />)
    fireEvent.click(screen.getByRole('button', { name: '改为编辑分组 g2' }))
    expect(onEditGroup).toHaveBeenCalledWith('g2')
  })

  // 切换目标必须**同时**把三个字段换成新目标的内容。只上抛 id 而不换字段的话，用户看着
  // g2 的标题、编辑的是 g1 遗留在框里的文字，一失焦就把 g1 的注释盖到 g2 上——本项目
  // 唯一那条红线（弄丢人写的注释）。
  //
  // "换字段"的做法是**丢掉草稿**、让字段跟着上层回流的新目标走，而不是把新目标的值拍进
  // 草稿——拍进去就又多一份会陈旧的快照（见 GroupPanel 里 pick 的注释）。上层是同步回流的
  // （App.handleEditGroup 的 setPending 与这里的 setState 同一批渲染），显示不会有空档；
  // 那一半由 App.test 的「同成员的两个分组：点选择器切到第二个」在真实接线上盯着。
  it('切到另一个同成员分组时，三个字段立刻换成它的内容', () => {
    const onEditGroup = vi.fn()
    const rest = {
      members: ['x', 'y'], groups: TWO, disabled: false,
      onSubmit: vi.fn(), onRemoveMember: vi.fn(), onEditGroup,
    }
    const { rerender } = render(<GroupPanel round={{ groupId: 'g1' }} {...rest} />)
    expect((screen.getByLabelText('分组注释') as HTMLTextAreaElement).value).toBe('第一个')

    fireEvent.click(screen.getByRole('button', { name: '改为编辑分组 g2' }))
    expect(onEditGroup).toHaveBeenCalledWith('g2')
    rerender(<GroupPanel round={{ groupId: 'g2' }} {...rest} />)

    expect((screen.getByLabelText('分组名') as HTMLInputElement).value).toBe('g2')
    expect((screen.getByLabelText('分组注释') as HTMLTextAreaElement).value).toBe('第二个')
    expect((screen.getByLabelText('约束强度') as HTMLSelectElement).value).toBe('')
  })

  // 切走时框里那些**还没失焦**的字必须一起丢掉。留着的话，用户看着 g2 的标题、框里是
  // 写给 g1 的半句话，一失焦就把它盖到 g2 原有的注释上——本项目唯一那条红线。
  it('在 g1 的框里写了字、还没失焦就切到 g2，那些字不会落到 g2 头上', () => {
    const onSubmit = vi.fn()
    const rest = {
      members: ['x', 'y'], groups: TWO, disabled: false,
      onSubmit, onRemoveMember: vi.fn(), onEditGroup: vi.fn(),
    }
    const { rerender } = render(<GroupPanel round={{ groupId: 'g1' }} {...rest} />)
    fireEvent.change(screen.getByLabelText('分组注释'), { target: { value: '本来要写给 g1 的' } })

    fireEvent.click(screen.getByRole('button', { name: '改为编辑分组 g2' }))
    rerender(<GroupPanel round={{ groupId: 'g2' }} {...rest} />)

    expect((screen.getByLabelText('分组注释') as HTMLTextAreaElement).value).toBe('第二个')
    fireEvent.blur(screen.getByLabelText('分组注释'))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  // 切过去之后**不留快照**：用户在 g2 上写了注释、写入还在途时再点一下选择器里的 g2，
  // 若 pick 把当时的值拍进草稿，拍到的就是落地前的旧文字，下一次失焦把它写回去——
  // 与"收缩成员"那条红线同一个根因，只是触发动作换成了点选择器。
  it('切过去之后分组内容在宿主侧变了，面板跟着变，不会把旧文字写回去', () => {
    const onSubmit = vi.fn()
    const rest = {
      members: ['x', 'y'], disabled: false,
      onSubmit, onRemoveMember: vi.fn(), onEditGroup: vi.fn(),
    }
    const { rerender } = render(<GroupPanel groups={TWO} round={{ groupId: 'g1' }} {...rest} />)
    fireEvent.click(screen.getByRole('button', { name: '改为编辑分组 g2' }))
    rerender(<GroupPanel groups={TWO} round={{ groupId: 'g2' }} {...rest} />)
    expect((screen.getByLabelText('分组注释') as HTMLTextAreaElement).value).toBe('第二个')

    const LANDED: Group[] = [TWO[0], { ...TWO[1], text: '落地后的文字' }]
    rerender(<GroupPanel groups={LANDED} round={{ groupId: 'g2' }} {...rest} />)

    expect((screen.getByLabelText('分组注释') as HTMLTextAreaElement).value).toBe('落地后的文字')
    fireEvent.blur(screen.getByLabelText('分组注释'))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('只有一个分组匹配时不列出选择器', () => {
    render(<GroupPanel members={['src/b.ts', 'src/a.ts']} groups={G} disabled={false} {...noop} />)
    expect(screen.queryByRole('button', { name: /^改为编辑分组/ })).toBeNull()
  })

  it('只读模式下分组选择器一并禁用', () => {
    render(<GroupPanel members={['x', 'y']} groups={TWO} disabled={true} {...noop} />)
    expect((screen.getByRole('button', { name: '改为编辑分组 g2' }) as HTMLButtonElement).disabled)
      .toBe(true)
  })
})
