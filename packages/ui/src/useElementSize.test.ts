import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useElementSize } from './useElementSize.js'

const FALLBACK = { width: 800, height: 600 }
const original = globalThis.ResizeObserver

afterEach(() => { globalThis.ResizeObserver = original })

describe('useElementSize', () => {
  it('没有 ResizeObserver 时回退到给定值，且非零', () => {
    // @ts-expect-error 故意移除
    delete globalThis.ResizeObserver
    const { result } = renderHook(() => useElementSize<HTMLDivElement>(FALLBACK))
    expect(result.current[1]).toEqual(FALLBACK)
    expect(result.current[1].width).toBeGreaterThan(0)
    expect(result.current[1].height).toBeGreaterThan(0)
  })

  it('有 ResizeObserver 时用观察到的尺寸', () => {
    let cb: ResizeObserverCallback | null = null
    globalThis.ResizeObserver = class {
      constructor(c: ResizeObserverCallback) { cb = c }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver

    const { result, rerender } = renderHook(() => useElementSize<HTMLDivElement>(FALLBACK))
    expect(cb).not.toBeNull()
    // 直接调用 ResizeObserver 回调会在 React 受控流程之外触发 setState，
    // 包一层 act() 才能消掉 "not wrapped in act" 警告（本仓库其余测试同样这么做，见 App.test.tsx）。
    act(() => { cb!([{ contentRect: { width: 321, height: 654 } } as ResizeObserverEntry], {} as ResizeObserver) })
    rerender()
    expect(result.current[1]).toEqual({ width: 321, height: 654 })
  })

  it('观察到 0 尺寸时保留回退值', () => {
    let cb: ResizeObserverCallback | null = null
    globalThis.ResizeObserver = class {
      constructor(c: ResizeObserverCallback) { cb = c }
      observe() {}; unobserve() {}; disconnect() {}
    } as unknown as typeof ResizeObserver
    const { result, rerender } = renderHook(() => useElementSize<HTMLDivElement>(FALLBACK))
    act(() => { cb!([{ contentRect: { width: 0, height: 0 } } as ResizeObserverEntry], {} as ResizeObserver) })
    rerender()
    expect(result.current[1]).toEqual(FALLBACK)
  })
})
