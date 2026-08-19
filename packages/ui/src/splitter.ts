import { useCallback, useState } from 'react'

export function nextWidth(
  startWidth: number, delta: number, side: 'left' | 'right', min: number, max: number,
): number {
  const raw = side === 'left' ? startWidth + delta : startWidth - delta
  return Math.min(max, Math.max(min, raw))
}

export interface SplitterOptions {
  initial: number
  min: number
  max: number
  /** 分隔条在被调节的那一栏的哪一侧：'left' 表示这一栏在分隔条左边（右拖变宽） */
  side: 'left' | 'right'
}

export function useSplitter({ initial, min, max, side }: SplitterOptions) {
  const [width, setWidth] = useState(initial)

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = width
    const el = e.currentTarget
    // jsdom 没有 setPointerCapture；可选链让测试环境不必打桩
    el.setPointerCapture?.(e.pointerId)

    const move = (ev: Event) => {
      setWidth(nextWidth(startWidth, (ev as MouseEvent).clientX - startX, side, min, max))
    }
    const up = () => {
      el.releasePointerCapture?.(e.pointerId)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }, [width, min, max, side])

  return { width, onPointerDown }
}
