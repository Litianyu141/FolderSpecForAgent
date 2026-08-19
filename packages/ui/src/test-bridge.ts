import type { Api, ApiMethod, Bridge, BridgeEvent } from '@folderspec/core/api'

type Handlers = { [K in ApiMethod]?: (params: Api[K]['params']) => Api[K]['result'] }

/** 测试用 Bridge：不碰文件系统，按脚本回应并记录全部调用 */
export class FakeBridge implements Bridge {
  readonly calls: Array<{ method: ApiMethod; params: unknown }> = []
  private listeners = new Map<BridgeEvent, Set<(p: unknown) => void>>()

  constructor(private handlers: Handlers = {}) {}

  async request<K extends ApiMethod>(method: K, params: Api[K]['params']): Promise<Api[K]['result']> {
    this.calls.push({ method, params })
    const handler = this.handlers[method] as ((p: Api[K]['params']) => Api[K]['result']) | undefined
    if (!handler) throw new Error(`FakeBridge 未配置方法 "${method}"`)
    return handler(params)
  }

  /** 事后改写某个方法的回应；用来在测试里让指定的一次调用失败，验证错误落到横幅上 */
  setHandler<K extends ApiMethod>(method: K, fn: (params: Api[K]['params']) => Api[K]['result']): void {
    // 与 request() 同款断言：K 是泛型时 TS 无法把 Handlers[K] 收窄到这一个方法的签名
    this.handlers[method] = fn as Handlers[K]
  }

  on(event: BridgeEvent, cb: (payload: unknown) => void): () => void {
    const set = this.listeners.get(event) ?? new Set()
    set.add(cb)
    this.listeners.set(event, set)
    return () => set.delete(cb)
  }

  emit(event: BridgeEvent, payload: unknown): void {
    for (const cb of this.listeners.get(event) ?? []) cb(payload)
  }

  lastCall(method: ApiMethod): unknown {
    for (let i = this.calls.length - 1; i >= 0; i--) {
      if (this.calls[i].method === method) return this.calls[i].params
    }
    return undefined
  }
}
