import { useEffect, useRef, useState } from 'react'

export interface Size { width: number; height: number }

/**
 * 用 ResizeObserver 实测容器尺寸。
 * jsdom 没有实现 ResizeObserver，此时回退到传入值——测试环境依赖树能真实渲染出行，
 * 尺寸为 0 会让依赖真实渲染的 App 测试全部失效。观察到 0 尺寸时同样保留回退值。
 */
// 返回类型写 RefObject<T> 而不是 RefObject<T | null>：两者的 current 都是 T | null，结构完全
// 一样，但 TS 对同一个泛型接口走的是型变判定而非结构判定，RefObject<T | null> 会被判成不能赋给
// JSX ref 需要的 RefObject<T>，逼每个调用方在 ref={} 上写一次断言。内部仍是可空的 useRef。
export function useElementSize<T extends HTMLElement>(fallback: Size): [React.RefObject<T>, Size] {
  const ref = useRef<T | null>(null)
  const [size, setSize] = useState<Size>(fallback)

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    // ResizeObserver 必须无条件创建：单测里 renderHook 不渲染任何 JSX，ref 永远不会
    // 挂到真实 DOM 节点上，如果在此处按 `!ref.current` 提前 return，观察者对象根本不会
    // 被构造，测试里用来断言"回调已注册"的钩子就永远拿不到实例。真实场景下 ref 已经在
    // commit 阶段（早于这个被动 effect）绑定好了，所以 observe() 依然会按预期生效。
    const ro = new ResizeObserver(entries => {
      const r = entries[0]?.contentRect
      if (!r) return
      if (r.width > 0 && r.height > 0) setSize({ width: r.width, height: r.height })
    })
    if (ref.current) ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])

  return [ref, size]
}
