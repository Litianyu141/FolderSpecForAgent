import type { Api, ApiMethod, Bridge, BridgeEvent } from '@folderspec/core/api'

interface VsCodeApi {
  postMessage(msg: unknown): void
}

declare function acquireVsCodeApi(): VsCodeApi

/** VSCode webview 宿主用的 Bridge：走 postMessage */
export function createVscodeBridge(): Bridge {
  const vscode = acquireVsCodeApi()
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()
  const listeners = new Map<BridgeEvent, Set<(p: unknown) => void>>()
  let nextId = 1

  window.addEventListener('message', ev => {
    const msg = ev.data as { id?: number; ok?: boolean; result?: unknown; error?: string; event?: string; payload?: unknown }
    if (typeof msg.event === 'string') {
      for (const cb of listeners.get(msg.event as BridgeEvent) ?? []) cb(msg.payload)
      return
    }
    if (typeof msg.id !== 'number') return
    const slot = pending.get(msg.id)
    if (!slot) return
    pending.delete(msg.id)
    if (msg.ok) slot.resolve(msg.result)
    else slot.reject(new Error(msg.error ?? '未知错误'))
  })

  return {
    request<K extends ApiMethod>(method: K, params: Api[K]['params']): Promise<Api[K]['result']> {
      const id = nextId++
      return new Promise<Api[K]['result']>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
        vscode.postMessage({ id, method, params })
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
