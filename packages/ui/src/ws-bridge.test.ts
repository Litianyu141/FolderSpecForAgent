import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createWebSocketBridge } from './ws-bridge.js'

/**
 * ui 包不能依赖任何 Node 内建模块（它跑在浏览器里），所以这里的替身必须是纯浏览器形状的
 * 对象——没有 EventEmitter，没有 'ws' 包，只有 addEventListener/removeEventListener/send，
 * 和真实 WebSocket 暴露给 ws-bridge.ts 的接口完全一致。
 */
type FakeListener = (ev: { data?: string }) => void

class FakeWebSocket {
  static instances: FakeWebSocket[] = []

  readonly url: string
  readonly sent: string[] = []
  private readonly listeners = new Map<string, Set<FakeListener>>()

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, cb: FakeListener, opts?: { once?: boolean }): void {
    const set = this.listeners.get(type) ?? new Set()
    const wrapped: FakeListener = opts?.once
      ? ev => {
          this.removeEventListener(type, wrapped)
          cb(ev)
        }
      : cb
    set.add(wrapped)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, cb: FakeListener): void {
    this.listeners.get(type)?.delete(cb)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  /** 测试专用：模拟服务端把连接打开 */
  triggerOpen(): void {
    this.dispatch('open', {})
  }

  /** 测试专用：模拟服务端推来一条消息 */
  triggerMessage(payload: unknown): void {
    this.dispatch('message', { data: JSON.stringify(payload) })
  }

  private dispatch(type: string, ev: { data?: string }): void {
    for (const cb of [...(this.listeners.get(type) ?? [])]) cb(ev)
  }
}

/** 把一个微任务 + 一个宏任务都放行，足够让 bridge 内部的 `await ready` 链跑完 */
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

let hadOriginalWebSocket = false
let originalWebSocket: typeof WebSocket | undefined

beforeEach(() => {
  hadOriginalWebSocket = 'WebSocket' in globalThis
  originalWebSocket = globalThis.WebSocket
  FakeWebSocket.instances.length = 0
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
})

afterEach(() => {
  if (hadOriginalWebSocket) {
    globalThis.WebSocket = originalWebSocket as typeof WebSocket
  } else {
    delete (globalThis as { WebSocket?: unknown }).WebSocket
  }
})

describe('createWebSocketBridge', () => {
  it('请求在收到服务端 ok:true 响应后 resolve 成对应的 result', async () => {
    const bridge = createWebSocketBridge('ws://x')
    const socket = FakeWebSocket.instances[0]!
    socket.triggerOpen()

    const promise = bridge.request('spec/save', {})
    await flush()

    expect(socket.sent).toHaveLength(1)
    const sentMsg = JSON.parse(socket.sent[0]) as { id: number; method: string }
    expect(sentMsg.method).toBe('spec/save')

    socket.triggerMessage({ id: sentMsg.id, ok: true, result: { written: true } })

    await expect(promise).resolves.toEqual({ written: true })
  })

  it('请求在收到服务端 ok:false 响应后 reject，错误信息来自服务端', async () => {
    const bridge = createWebSocketBridge('ws://x')
    const socket = FakeWebSocket.instances[0]!
    socket.triggerOpen()

    const promise = bridge.request('spec/save', {})
    await flush()
    const sentMsg = JSON.parse(socket.sent[0]) as { id: number }

    socket.triggerMessage({ id: sentMsg.id, ok: false, error: '写入失败' })

    await expect(promise).rejects.toThrow('写入失败')
  })

  it('事件只送达订阅了该事件的监听器', () => {
    const bridge = createWebSocketBridge('ws://x')
    const socket = FakeWebSocket.instances[0]!

    const specChanged: unknown[] = []
    const scanProgress: unknown[] = []
    bridge.on('spec-changed', p => specChanged.push(p))
    bridge.on('scan-progress', p => scanProgress.push(p))

    socket.triggerMessage({ event: 'spec-changed', payload: { dirty: true } })

    expect(specChanged).toEqual([{ dirty: true }])
    expect(scanProgress).toEqual([])
  })

  it('on 返回的取消函数能真正取消订阅', () => {
    const bridge = createWebSocketBridge('ws://x')
    const socket = FakeWebSocket.instances[0]!

    let count = 0
    const off = bridge.on('spec-changed', () => {
      count++
    })

    socket.triggerMessage({ event: 'spec-changed', payload: undefined })
    expect(count).toBe(1)

    off()
    socket.triggerMessage({ event: 'spec-changed', payload: undefined })
    expect(count).toBe(1)
  })

  it('socket 打开前发出的请求会排队，打开后才真正发送', async () => {
    const bridge = createWebSocketBridge('ws://x')
    const socket = FakeWebSocket.instances[0]!

    const promise = bridge.request('spec/save', {})
    await flush()
    expect(socket.sent).toHaveLength(0)

    socket.triggerOpen()
    await flush()

    expect(socket.sent).toHaveLength(1)
    const sentMsg = JSON.parse(socket.sent[0]) as { id: number }
    socket.triggerMessage({ id: sentMsg.id, ok: true, result: { written: true } })

    await expect(promise).resolves.toEqual({ written: true })
  })
})
