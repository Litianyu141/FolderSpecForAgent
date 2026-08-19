import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { GroupPanel } from './GroupPanel.js'
import type { Group } from '@folderspec/core/api'

const G: Group[] = [{ id: 'parse', members: ['src/a.ts', 'src/b.ts'], text: '解析层', severity: 'warning' }]
const noop = { onSubmit: vi.fn(), onRemoveMember: vi.fn() }

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
      onSubmit={onSubmit} onRemoveMember={vi.fn()} />)
    const ta = screen.getByLabelText('分组注释')
    fireEvent.change(ta, { target: { value: '新分组' } })
    fireEvent.blur(ta)
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ id: null, text: '新分组' }))
  })

  it('编辑既有分组时提交带上其 id', () => {
    const onSubmit = vi.fn()
    render(<GroupPanel members={['src/a.ts', 'src/b.ts']} groups={G} disabled={false}
      onSubmit={onSubmit} onRemoveMember={vi.fn()} />)
    const ta = screen.getByLabelText('分组注释')
    fireEvent.change(ta, { target: { value: '改过的' } })
    fireEvent.blur(ta)
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ id: 'parse', text: '改过的' }))
  })

  it('内容未变时不提交', () => {
    const onSubmit = vi.fn()
    render(<GroupPanel members={['src/a.ts', 'src/b.ts']} groups={G} disabled={false}
      onSubmit={onSubmit} onRemoveMember={vi.fn()} />)
    fireEvent.blur(screen.getByLabelText('分组注释'))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('点击成员上的移除按钮上报该成员路径', () => {
    const onRemoveMember = vi.fn()
    render(<GroupPanel members={['src/a.ts', 'src/b.ts']} groups={[]} disabled={false}
      onSubmit={vi.fn()} onRemoveMember={onRemoveMember} />)
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
})
