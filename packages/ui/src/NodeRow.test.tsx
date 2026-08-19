import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { NodeRow } from './NodeRow.js'
import type { ViewNode } from '@folderspec/core/api'

const make = (over: Partial<ViewNode> = {}): ViewNode =>
  ({ name: 'walk.ts', path: 'src/walk.ts', isDir: false, origin: 'actual-only', ...over })

const renderRow = (data: ViewNode, opts: { selected?: boolean; open?: boolean } = {}) => {
  const node = {
    data,
    isSelected: opts.selected ?? false,
    isOpen: opts.open ?? false,
    isLeaf: !data.isDir,
    toggle: vi.fn(),
  }
  return render(
    <NodeRow
      node={node as never}
      style={{}}
      dragHandle={undefined}
      tree={{} as never}
      preview={false}
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
})
