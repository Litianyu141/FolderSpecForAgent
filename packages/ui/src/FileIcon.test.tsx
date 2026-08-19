import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { FileIcon, iconKindFor } from './FileIcon.js'

describe('iconKindFor', () => {
  it('目录按开合状态区分', () => {
    expect(iconKindFor('src', true, false)).toBe('folder')
    expect(iconKindFor('src', true, true)).toBe('folder-open')
  })

  it('按扩展名归类，忽略大小写', () => {
    expect(iconKindFor('a.TS', false, false)).toBe('ts')
    expect(iconKindFor('a.tsx', false, false)).toBe('ts')
    expect(iconKindFor('a.js', false, false)).toBe('js')
    expect(iconKindFor('a.json', false, false)).toBe('json')
    expect(iconKindFor('a.md', false, false)).toBe('md')
    expect(iconKindFor('a.yaml', false, false)).toBe('yaml')
    expect(iconKindFor('a.yml', false, false)).toBe('yaml')
    expect(iconKindFor('a.png', false, false)).toBe('image')
  })

  it('按整名归类的特例', () => {
    expect(iconKindFor('.gitignore', false, false)).toBe('git')
    expect(iconKindFor('pnpm-lock.yaml', false, false)).toBe('lock')
  })

  it('未知扩展名回退到通用文件', () => {
    expect(iconKindFor('a.zzz', false, false)).toBe('file')
    expect(iconKindFor('LICENSE', false, false)).toBe('file')
  })
})

describe('FileIcon', () => {
  it('渲染出一个带 aria-hidden 的 svg', () => {
    const { container } = render(<FileIcon kind="ts" />)
    const svg = container.querySelector('svg')
    expect(svg).toBeTruthy()
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
  })

  it('每一种 kind 都能渲染，不落空', () => {
    for (const k of ['folder','folder-open','ts','js','json','md','yaml','css','html','py','rs','go','sh','toml','lock','image','git','file'] as const) {
      const { container } = render(<FileIcon kind={k} />)
      expect(container.querySelector('svg'), `kind=${k} 没渲染出 svg`).toBeTruthy()
    }
  })
})
