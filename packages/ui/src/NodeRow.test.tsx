import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { NodeRow } from './NodeRow.js'
import type { ViewNode } from '@folderspec/core/api'

const make = (over: Partial<ViewNode> = {}): ViewNode =>
  ({ name: 'walk.ts', path: 'src/walk.ts', isDir: false, origin: 'actual-only', ...over })

const renderRow = (
  data: ViewNode,
  opts: {
    selected?: boolean
    open?: boolean
    level?: number
    toggle?: () => void
    onGroupClick?: (id: string) => void
  } = {},
) => {
  const node = {
    data,
    isSelected: opts.selected ?? false,
    isOpen: opts.open ?? false,
    isLeaf: !data.isDir,
    level: opts.level ?? 0,
    toggle: opts.toggle ?? vi.fn(),
  }
  return render(
    <NodeRow
      node={node as never}
      style={{}}
      dragHandle={undefined}
      tree={{} as never}
      preview={false}
      onGroupClick={opts.onGroupClick}
    />,
  )
}

describe('NodeRow', () => {
  it('显示节点名', () => {
    renderRow(make())
    expect(screen.getByText('walk.ts')).toBeTruthy()
  })

  it('目录名带尾斜杠', () => {
    renderRow(make({ name: 'src', path: 'src', isDir: true }))
    expect(screen.getByText('src/')).toBeTruthy()
  })

  it('git 状态映射到颜色变量', () => {
    const { container } = renderRow(make({ gitState: 'modified' }))
    const name = container.querySelector('.fs-name') as HTMLElement
    expect(name.style.color).toContain('--fs-git-modified')
  })

  it('已标注节点带 data-annotated 标记', () => {
    const { container } = renderRow(make({ annotation: '遍历入口' }))
    expect(container.querySelector('.fs-row')?.getAttribute('data-annotated')).toBe('true')
  })

  it('未标注节点不带该标记', () => {
    const { container } = renderRow(make())
    expect(container.querySelector('.fs-row')?.getAttribute('data-annotated')).toBe('false')
  })

  it('显示 severity 徽标', () => {
    renderRow(make({ severity: 'error', annotation: 'x' }))
    expect(screen.getByText('🔴')).toBeTruthy()
  })

  it('spec-only 节点带 data-origin 供 CSS 画虚线', () => {
    const { container } = renderRow(make({ origin: 'spec-only' }))
    expect(container.querySelector('.fs-row')?.getAttribute('data-origin')).toBe('spec-only')
  })

  it('行内显示注释摘要', () => {
    renderRow(make({ annotation: '并行遍历入口' }))
    expect(screen.getByText('并行遍历入口')).toBeTruthy()
  })

  it('截断的目录显示提示', () => {
    renderRow(make({ name: 'big', path: 'big', isDir: true, truncated: true }))
    expect(screen.getByTitle(/已截断/)).toBeTruthy()
  })

  it('不可读目录显示提示', () => {
    renderRow(make({ name: 'secret', path: 'secret', isDir: true, unreadable: true }))
    expect(screen.getByTitle(/无法读取/)).toBeTruthy()
  })

  it('渲染文件图标', () => {
    const { container } = renderRow(make({ name: 'a.ts', path: 'a.ts' }))
    expect(container.querySelector('.fs-icon svg')).toBeTruthy()
  })

  it('属于分组时渲染分组色点，数量与分组数一致', () => {
    const { container } = renderRow(make({ groups: ['g1', 'g2'] }))
    expect(container.querySelectorAll('.fs-group-dot')).toHaveLength(2)
  })

  it('不属于任何分组时没有色点', () => {
    const { container } = renderRow(make())
    expect(container.querySelectorAll('.fs-group-dot')).toHaveLength(0)
  })

  it('点击色点上报该分组 id，且不触发整行的展开', () => {
    // 必须是目录节点：整行 onClick 只在 d.isDir 时才调用 node.toggle()，
    // 用文件节点做这个断言时 toggle 永远不会被调用，测试会在 stopPropagation
    // 被删掉时也保持绿色——测不出它本该防住的回归。
    const onGroupClick = vi.fn()
    const toggle = vi.fn()
    const { container } = renderRow(
      make({ name: 'src', path: 'src', isDir: true, groups: ['g1'] }),
      { onGroupClick, toggle },
    )
    fireEvent.click(container.querySelector('.fs-group-dot')!)
    expect(onGroupClick).toHaveBeenCalledWith('g1')
    expect(toggle).not.toHaveBeenCalled()
  })

  it('缩进引导线的条数等于层级', () => {
    const { container } = renderRow(make(), { level: 3 })
    expect(container.querySelectorAll('.fs-indent-guide')).toHaveLength(3)
  })

  it('根层级没有引导线', () => {
    const { container } = renderRow(make(), { level: 0 })
    expect(container.querySelectorAll('.fs-indent-guide')).toHaveLength(0)
  })
})
