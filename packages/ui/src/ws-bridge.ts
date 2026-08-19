import type { Api, ApiMethod, Bridge, BridgeEvent } from '@folderspec/core/api'

/** 浏览器宿主用的 Bridge：走同源 WebSocket */
export function createWebSocketBridge(url: string): Bridge {
  const socket = new WebSocket(url)
  const ready = new Promise<void>(resolve => socket.addEventListener('open', () => resolve(), { once: true }))
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()
  const listeners = new Map<BridgeEvent, Set<(p: unknown) => void>>()
  let nextId = 1

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
