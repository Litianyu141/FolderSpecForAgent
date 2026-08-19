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

  /** 测试专用：模拟连接被关闭（正常关闭或服务端挂掉之后的断连） */
  triggerClose(): void {
    this.dispatch('close', {})
  }

  /** 测试专用：模拟连接出错（比如连接被拒绝，服务端还没起来） */
  triggerError(): void {
    this.dispatch('error', {})
  }

  private dispatch(type: string, ev: { data?: string }): void {
    for (const cb of [...(this.listeners.get(type) ?? [])]) cb(ev)
  }
}

/** 把一个微任务 + 一个宏任务都放行，足够让 bridge 内部的 `await ready` 链跑完 */
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

/**
 * 给一个断言套上超时保护：实现有 bug 导致 promise 永远不 resolve/reject 时，
 * 用这个让测试在几十毫秒内失败，而不是拖到 vitest 默认的 5000ms 超时才失败。
 */
const withTimeout = <T,>(p: Promise<T>, ms = 200): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`等待 ${ms}ms 后仍未 settle——疑似挂起`)), ms)),
  ])

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
  delete (globalThis as { __folderspecToken?: string }).__folderspecToken
})

describe('一次性令牌', () => {
  it('宿主注入了 __folderspecToken 时，它必须被拼到 WebSocket URL 上', () => {
    // 服务端要求升级请求带上令牌（浏览器不对 WebSocket 施加同源策略，随机端口挡不住
    // 任何一个跨源页面）。不拼上去的话，UI 自己也连不上——这条用例同时是那条防线的
    // 客户端一半。
    ;(globalThis as { __folderspecToken?: string }).__folderspecToken = 'deadbeef'
    createWebSocketBridge('ws://x/')
    expect(FakeWebSocket.instances[0]!.url).toBe('ws://x/?token=deadbeef')
  })

  it('URL 本来就带查询参数时用 & 拼接', () => {
    ;(globalThis as { __folderspecToken?: string }).__folderspecToken = 'deadbeef'
    createWebSocketBridge('ws://x/?a=1')
    expect(FakeWebSocket.instances[0]!.url).toBe('ws://x/?a=1&token=deadbeef')
  })

  it('没有注入令牌时 URL 保持原样，由服务端去拒绝', () => {
    createWebSocketBridge('ws://x/')
    expect(FakeWebSocket.instances[0]!.url).toBe('ws://x/')
  })
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

  it('socket 关闭时所有 pending 请求被拒绝', async () => {
    const bridge = createWebSocketBridge('ws://x')
    const socket = FakeWebSocket.instances[0]!
    socket.triggerOpen()

    const promise = bridge.request('spec/save', {})
    await flush()
    expect(socket.sent).toHaveLength(1)

    socket.triggerClose()

    await expect(withTimeout(promise)).rejects.toThrow('与本地服务的连接已断开')
  })

  it('socket 出错时 ready 被拒绝，后续请求立即失败', async () => {
    const bridge = createWebSocketBridge('ws://x')
    const socket = FakeWebSocket.instances[0]!

    // 请求在 open 之前发出，此刻卡在内部的 `await ready` 上
    const inFlight = bridge.request('spec/save', {})

    socket.triggerError()

    await expect(withTimeout(inFlight)).rejects.toThrow('与本地服务的连接已断开')

    // socket 已经死了：之后再发的请求必须立刻拒绝，而不是排队等一个不会再来的 open
    await expect(withTimeout(bridge.request('spec/save', {}))).rejects.toThrow('与本地服务的连接已断开')
  })

  it('socket 正常打开后又关闭，之后新发起的请求依然会立即被拒绝', async () => {
    // 上一个用例里 ready 还没 resolve 就死了，所以内部 `await ready` 本身也会 reject，
    // 光靠这条路径盖不住 request() 顶部的 `closed` 检查。这里让 ready 先正常 resolve
    // （open 成功过），再关闭连接——此时 ready 已经 settle 成功，`await ready` 不会再
    // reject 任何东西，request() 顶部的 closed 标志是唯一还能拦住新请求的防线。
    const bridge = createWebSocketBridge('ws://x')
    const socket = FakeWebSocket.instances[0]!
    socket.triggerOpen()
    await flush()

    socket.triggerClose()

    await expect(withTimeout(bridge.request('spec/save', {}))).rejects.toThrow('与本地服务的连接已断开')
  })
})
