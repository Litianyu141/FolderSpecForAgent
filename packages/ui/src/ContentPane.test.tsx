import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ContentPane } from './ContentPane.js'
import type { ViewNode } from '@folderspec/core/api'

const file = (name = 'a.ts', path = 'src/a.ts'): ViewNode =>
  ({ name, path, isDir: false, origin: 'both' })
const dir = (): ViewNode =>
  ({ name: 'src', path: 'src', isDir: true, origin: 'both', children: [file(), file('b.ts', 'src/b.ts')] })

describe('ContentPane', () => {
  it('未选中任何节点时给出提示', () => {
    render(<ContentPane node={null} content={null} loading={false} />)
    expect(screen.getByText('在左侧选中一个文件查看内容')).toBeTruthy()
  })

  it('加载中显示加载态', () => {
    render(<ContentPane node={file()} content={null} loading={true} />)
    expect(screen.getByText('读取中…')).toBeTruthy()
  })

  it('文本文件渲染行号与内容', () => {
    render(<ContentPane node={file()} content={{ kind: 'text', text: 'a\nb\nc' }} loading={false} />)
    expect(screen.getByText('src/a.ts')).toBeTruthy()
    const lines = document.querySelectorAll('.fs-code-line')
    expect(lines).toHaveLength(3)
    expect(document.querySelectorAll('.fs-line-no')[2].textContent).toBe('3')
  })

  it('二进制文件不渲染内容，给出说明', () => {
    render(<ContentPane node={file('x.png', 'x.png')} content={{ kind: 'binary' }} loading={false} />)
    expect(screen.getByText(/二进制文件/)).toBeTruthy()
    expect(document.querySelectorAll('.fs-code-line')).toHaveLength(0)
  })

  it('超大文件显示体积且不渲染内容', () => {
    render(<ContentPane node={file()} content={{ kind: 'too-large', size: 2_000_000 }} loading={false} />)
    expect(screen.getByText(/超过预览上限/)).toBeTruthy()
    expect(document.querySelectorAll('.fs-code-line')).toHaveLength(0)
  })

  it('读取失败时显示原因', () => {
    render(<ContentPane node={file()} content={{ kind: 'unreadable', reason: 'EACCES' }} loading={false} />)
    expect(screen.getByText(/EACCES/)).toBeTruthy()
  })

  it('目录显示子项统计而非内容', () => {
    render(<ContentPane node={dir()} content={null} loading={false} />)
    expect(screen.getByText(/共 2 项/)).toBeTruthy()
  })

  it('尚未展开的目录不谎报为空', () => {
    const unscanned: ViewNode = { name: 'src', path: 'src', isDir: true, origin: 'both' }
    render(<ContentPane node={unscanned} content={null} loading={false} />)
    expect(screen.getByText(/尚未展开/)).toBeTruthy()
  })
})
