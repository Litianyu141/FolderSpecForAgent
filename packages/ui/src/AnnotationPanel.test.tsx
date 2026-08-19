import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AnnotationPanel } from './AnnotationPanel.js'
import type { Group, ViewNode } from '@folderspec/core/api'

const node = (over: Partial<ViewNode> = {}): ViewNode =>
  ({ name: 'core', path: 'src/core', isDir: true, origin: 'both', ...over })

describe('AnnotationPanel', () => {
  it('未选中节点时给出提示', () => {
    render(<AnnotationPanel node={null} disabled={false} onChange={vi.fn()}
      groupsOfNode={[]} onPickGroup={vi.fn()} />)
    expect(screen.getByText('在左侧选中一个文件或目录')).toBeTruthy()
  })

  it('显示选中节点的路径', () => {
    render(<AnnotationPanel node={node()} disabled={false} onChange={vi.fn()}
      groupsOfNode={[]} onPickGroup={vi.fn()} />)
    expect(screen.getByText('src/core')).toBeTruthy()
  })

  it('回填已有的注释、role 与 severity', () => {
    render(<AnnotationPanel
      node={node({ annotation: '内核', role: 'core-engine', severity: 'error' })}
      disabled={false} onChange={vi.fn()} groupsOfNode={[]} onPickGroup={vi.fn()} />)
    expect((screen.getByLabelText('注释') as HTMLTextAreaElement).value).toBe('内核')
    expect((screen.getByLabelText('语义角色') as HTMLInputElement).value).toBe('core-engine')
    expect((screen.getByLabelText('约束强度') as HTMLSelectElement).value).toBe('error')
  })

  it('注释失焦时提交', () => {
    const onChange = vi.fn()
    render(<AnnotationPanel node={node()} disabled={false} onChange={onChange}
      groupsOfNode={[]} onPickGroup={vi.fn()} />)
    const ta = screen.getByLabelText('注释')
    fireEvent.change(ta, { target: { value: '文件系统扫描层' } })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.blur(ta)
    expect(onChange).toHaveBeenCalledWith({ annotation: '文件系统扫描层' })
  })

  it('清空注释时提交 null', () => {
    const onChange = vi.fn()
    render(<AnnotationPanel node={node({ annotation: '旧的' })} disabled={false} onChange={onChange}
      groupsOfNode={[]} onPickGroup={vi.fn()} />)
    const ta = screen.getByLabelText('注释')
    fireEvent.change(ta, { target: { value: '' } })
    fireEvent.blur(ta)
    expect(onChange).toHaveBeenCalledWith({ annotation: null })
  })

  it('内容没变时不提交', () => {
    const onChange = vi.fn()
    render(<AnnotationPanel node={node({ annotation: '内核' })} disabled={false} onChange={onChange}
      groupsOfNode={[]} onPickGroup={vi.fn()} />)
    fireEvent.blur(screen.getByLabelText('注释'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('切换 severity 立即提交', () => {
    const onChange = vi.fn()
    render(<AnnotationPanel node={node()} disabled={false} onChange={onChange}
      groupsOfNode={[]} onPickGroup={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('约束强度'), { target: { value: 'warning' } })
    expect(onChange).toHaveBeenCalledWith({ severity: 'warning' })
  })

  it('severity 选空值时提交 null', () => {
    const onChange = vi.fn()
    render(<AnnotationPanel node={node({ severity: 'error' })} disabled={false} onChange={onChange}
      groupsOfNode={[]} onPickGroup={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('约束强度'), { target: { value: '' } })
    expect(onChange).toHaveBeenCalledWith({ severity: null })
  })

  it('切换选中节点时重置为新节点的内容', () => {
    const { rerender } = render(
      <AnnotationPanel node={node({ annotation: 'A' })} disabled={false} onChange={vi.fn()}
        groupsOfNode={[]} onPickGroup={vi.fn()} />)
    rerender(
      <AnnotationPanel node={node({ path: 'src/ui', annotation: 'B' })} disabled={false} onChange={vi.fn()}
        groupsOfNode={[]} onPickGroup={vi.fn()} />)
    expect((screen.getByLabelText('注释') as HTMLTextAreaElement).value).toBe('B')
  })

  it('失焦提交后继续输入，往返返回时不覆盖新输入的内容', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <AnnotationPanel node={node({ annotation: '' })} disabled={false} onChange={onChange}
        groupsOfNode={[]} onPickGroup={vi.fn()} />)
    const ta = screen.getByLabelText('注释')
    fireEvent.change(ta, { target: { value: 'hello' } })
    fireEvent.blur(ta)
    fireEvent.change(ta, { target: { value: 'hello world' } })
    rerender(
      <AnnotationPanel node={node({ annotation: 'hello' })} disabled={false} onChange={onChange}
        groupsOfNode={[]} onPickGroup={vi.fn()} />)
    expect((ta as HTMLTextAreaElement).value).toBe('hello world')
  })

  it('切换到字段值相同但路径不同的节点时仍然更新', () => {
    const { rerender } = render(
      <AnnotationPanel node={node({ path: 'src/a', annotation: '内核', role: 'x' })} disabled={false} onChange={vi.fn()}
        groupsOfNode={[]} onPickGroup={vi.fn()} />)
    rerender(
      <AnnotationPanel node={node({ path: 'src/b', annotation: '内核', role: 'y' })} disabled={false} onChange={vi.fn()}
        groupsOfNode={[]} onPickGroup={vi.fn()} />)
    expect((screen.getByLabelText('语义角色') as HTMLInputElement).value).toBe('y')
  })

  it('只读模式下全部控件禁用', () => {
    render(<AnnotationPanel node={node()} disabled={true} onChange={vi.fn()}
      groupsOfNode={[]} onPickGroup={vi.fn()} />)
    expect((screen.getByLabelText('注释') as HTMLTextAreaElement).disabled).toBe(true)
    expect((screen.getByLabelText('语义角色') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText('约束强度') as HTMLSelectElement).disabled).toBe(true)
  })

  it('底部列出该节点所属的分组', () => {
    const g: Group[] = [{ id: 'parse', members: ['src/core'], text: '解析层' }]
    render(<AnnotationPanel node={node()} disabled={false} onChange={vi.fn()}
      groupsOfNode={g} onPickGroup={vi.fn()} />)
    expect(screen.getByText('parse')).toBeTruthy()
    expect(screen.getByText(/解析层/)).toBeTruthy()
  })

  it('点击所属分组时上报其 id', () => {
    const onPickGroup = vi.fn()
    const g: Group[] = [{ id: 'parse', members: ['src/core'], text: '解析层' }]
    render(<AnnotationPanel node={node()} disabled={false} onChange={vi.fn()}
      groupsOfNode={g} onPickGroup={onPickGroup} />)
    fireEvent.click(screen.getByText('parse'))
    expect(onPickGroup).toHaveBeenCalledWith('parse')
  })

  it('不属于任何分组时不显示该区块', () => {
    render(<AnnotationPanel node={node()} disabled={false} onChange={vi.fn()}
      groupsOfNode={[]} onPickGroup={vi.fn()} />)
    expect(screen.queryByText('所属分组')).toBeNull()
  })
})
