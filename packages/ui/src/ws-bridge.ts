import type { Api, ApiMethod, Bridge, BridgeEvent } from '@folderspec/core/api'

const CONNECTION_LOST_MESSAGE = '与本地服务的连接已断开，请重新启动 folderspec'

/**
 * 把本次启动的一次性令牌拼到 WebSocket URL 上。
 *
 * 浏览器不对 WebSocket 施加同源策略，所以服务端要求升级请求带上令牌（见 CLI 的
 * server.ts）。令牌由宿主注入在同一份 HTML 里（window.__folderspecToken），跨源页面
 * 读不到它。VSCode 宿主走的是另一个 Bridge，不会经过这里，因此令牌缺失时保持原样
 * 发出——由服务端拒绝，而不是在这里静默换一种行为。
 */
function withToken(url: string): string {
  const token = (globalThis as { __folderspecToken?: string }).__folderspecToken
  if (!token) return url
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
}

/** 浏览器宿主用的 Bridge：走同源 WebSocket */
export function createWebSocketBridge(url: string): Bridge {
  const socket = new WebSocket(withToken(url))
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()
  const listeners = new Map<BridgeEvent, Set<(p: unknown) => void>>()
  let nextId = 1
  // socket 死亡（close/error）之后，任何新请求都必须立刻拒绝，而不是排队等一个
  // 再也不会到来的 open——那会让调用方永远挂起，且没有任何提示（Finding 2）。
  let closed = false

  let readyResolve!: () => void
  let readyReject!: (e: Error) => void
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })
  // 如果 socket 在任何人 await 它之前就出错/关闭，这里会产生一个没人处理的 rejection；
  // 各次 request() 内部的 `await ready` 仍然各自能观察到同一次 reject，互不影响。
  ready.catch(() => {})

  /** socket 关闭或出错：拒绝所有在途请求、拒绝尚未 resolve 的 ready、之后的请求立即失败 */
  const failAll = (): void => {
    if (closed) return
    closed = true
    readyReject(new Error(CONNECTION_LOST_MESSAGE))
    for (const slot of pending.values()) slot.reject(new Error(CONNECTION_LOST_MESSAGE))
    pending.clear()
  }

  socket.addEventListener('open', () => readyResolve(), { once: true })
  socket.addEventListener('close', () => failAll())
  socket.addEventListener('error', () => failAll())

  socket.addEventListener('message', ev => {
    const msg = JSON.parse(String(ev.data))
    if (typeof msg.event === 'string') {
      for (const cb of listeners.get(msg.event as BridgeEvent) ?? []) cb(msg.payload)
      return
    }
    const slot = pending.get(msg.id)
    if (!slot) return
    pending.delete(msg.id)
    if (msg.ok) slot.resolve(msg.result)
    else slot.reject(new Error(msg.error))
  })

  return {
    async request<K extends ApiMethod>(method: K, params: Api[K]['params']): Promise<Api[K]['result']> {
      if (closed) throw new Error(CONNECTION_LOST_MESSAGE)
      await ready
      const id = nextId++
      return new Promise<Api[K]['result']>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
    on(event, cb) {
      const set = listeners.get(event) ?? new Set()
      set.add(cb)
      listeners.set(event, set)
      return () => set.delete(cb)
    },
  }
}
