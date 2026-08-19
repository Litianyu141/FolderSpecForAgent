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

  // 绝大多数真实文件都以 \n 结尾（包括这个仓库里的每一个源文件）。
  // 不剥掉末尾换行会多渲染一行，行号比真实末行大 1——直接违反「行号绝对可靠」这条取舍的初衷。
  it('末尾单个换行不多渲染一行，行号止于真实末行', () => {
    render(<ContentPane node={file()} content={{ kind: 'text', text: 'a\nb\nc\n' }} loading={false} />)
    const lines = document.querySelectorAll('.fs-code-line')
    expect(lines).toHaveLength(3)
    expect(document.querySelectorAll('.fs-line-no')[2].textContent).toBe('3')
  })

  // 只剥一个末尾换行：文件以两个换行结尾时，最后那一行是真实的空行内容，不能被当成"末尾换行"一并吞掉。
  it('末尾两个换行时，最后一个空行是真实内容，应当保留', () => {
    render(<ContentPane node={file()} content={{ kind: 'text', text: 'a\nb\n\n' }} loading={false} />)
    const lines = document.querySelectorAll('.fs-code-line')
    expect(lines).toHaveLength(3)
    expect(document.querySelectorAll('.fs-line-no')[2].textContent).toBe('3')
    expect(lines[2].querySelector('.fs-code-text')?.textContent).toBe('')
  })

  // 注意：不能断言 textContent 不含 '\r'——dangerouslySetInnerHTML 走浏览器/jsdom 的
  // HTML 输入流预处理，裸露的 \r 在解析阶段就会被规范化成 \n（HTML Standard §13.2.3.1），
  // 断言"不含 \r"对任何实现都恒真，测不出问题。真正的症状是残留的 \r 被转换成内嵌 \n，
  // 使单行文本变成 "a\n" 这种带换行的脏内容，所以这里改成逐行精确比对内容。
  it('CRLF 文本行数正确，且每行内容精确等于去掉 \\r 后的那一行', () => {
    render(<ContentPane node={file()} content={{ kind: 'text', text: 'a\r\nb\r\nc\r\n' }} loading={false} />)
    const lines = document.querySelectorAll('.fs-code-line')
    expect(lines).toHaveLength(3)
    const texts = Array.from(lines).map((l) => l.querySelector('.fs-code-text')?.textContent)
    expect(texts).toEqual(['a', 'b', 'c'])
  })

  it('空字符串渲染为 1 行空内容', () => {
    render(<ContentPane node={file()} content={{ kind: 'text', text: '' }} loading={false} />)
    const lines = document.querySelectorAll('.fs-code-line')
    expect(lines).toHaveLength(1)
    expect(document.querySelectorAll('.fs-line-no')[0].textContent).toBe('1')
  })

  it('单行无换行渲染为 1 行', () => {
    render(<ContentPane node={file()} content={{ kind: 'text', text: 'a' }} loading={false} />)
    expect(document.querySelectorAll('.fs-code-line')).toHaveLength(1)
  })
})
