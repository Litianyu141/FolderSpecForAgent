import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { nextWidth, useSplitter } from './splitter.js'

describe('nextWidth', () => {
  it('左栏：向右拖变宽', () => {
    expect(nextWidth(260, 40, 'left', 160, 600)).toBe(300)
  })

  it('右栏：向右拖变窄', () => {
    expect(nextWidth(320, 40, 'right', 220, 600)).toBe(280)
  })

  it('下界夹紧', () => {
    expect(nextWidth(260, -500, 'left', 160, 600)).toBe(160)
  })

  it('上界夹紧', () => {
    expect(nextWidth(260, 5000, 'left', 160, 600)).toBe(600)
  })

  it('零位移原地不动', () => {
    expect(nextWidth(260, 0, 'left', 160, 600)).toBe(260)
  })
})

describe('useSplitter', () => {
  it('按下并移动指针后宽度跟随，抬起后停止跟随', () => {
    const { result } = renderHook(() => useSplitter({ initial: 260, min: 160, max: 600, side: 'left' }))
    expect(result.current.width).toBe(260)

    const el = document.createElement('div')
    document.body.appendChild(el)

    act(() => {
      result.current.onPointerDown({
        clientX: 100, pointerId: 1, currentTarget: el, preventDefault: () => {},
      } as unknown as React.PointerEvent<HTMLElement>)
    })

    // jsdom 没有 PointerEvent 构造器，但 addEventListener 按事件名匹配，
    // 用 MouseEvent 发一个名为 pointermove 的事件即可命中监听器。
    act(() => { el.dispatchEvent(new MouseEvent('pointermove', { clientX: 150 })) })
    expect(result.current.width).toBe(310)

    act(() => { el.dispatchEvent(new MouseEvent('pointerup', {})) })
    act(() => { el.dispatchEvent(new MouseEvent('pointermove', { clientX: 400 })) })
    expect(result.current.width).toBe(310)
  })
})
