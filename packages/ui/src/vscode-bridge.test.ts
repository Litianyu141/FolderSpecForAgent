import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createVscodeBridge } from './vscode-bridge.js'

/**
 * ui 包不能依赖任何 Node 内建模块（它跑在浏览器 / webview 里），所以这里的替身必须是
 * 纯浏览器形状的对象——没有 vscode 模块，只有 postMessage，和真实 VSCode webview
 * 注入给页面的 `acquireVsCodeApi()` 暴露的接口完全一致。事件从宿主传回 UI 是通过
 * `window` 上的原生 `message` 事件，所以这里直接用 `window.dispatchEvent` 派发。
 */
class FakeVsCodeApi {
  readonly posted: unknown[] = []
  postMessage(msg: unknown): void {
    this.posted.push(msg)
  }
}

/** 给一个断言套上超时保护，防止实现挂起时测试拖到默认超时才失败 */
const withTimeout = <T,>(p: Promise<T>, ms = 200): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`等待 ${ms}ms 后仍未 settle——疑似挂起`)), ms)),
  ])

const postToWindow = (data: unknown): void => {
  window.dispatchEvent(new MessageEvent('message', { data }))
}

let fakeApi: FakeVsCodeApi
let hadOriginalAcquire: boolean
let originalAcquire: unknown

beforeEach(() => {
  hadOriginalAcquire = 'acquireVsCodeApi' in globalThis
  originalAcquire = (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi
  fakeApi = new FakeVsCodeApi()
  ;(globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => fakeApi
})

afterEach(() => {
  if (hadOriginalAcquire) {
    ;(globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = originalAcquire
  } else {
    delete (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi
  }
})

describe('createVscodeBridge', () => {
  it('请求在宿主回应 ok:true 后 resolve 成对应的 result', async () => {
    const bridge = createVscodeBridge()

    const promise = bridge.request('spec/save', {})
    expect(fakeApi.posted).toHaveLength(1)
    const sentMsg = fakeApi.posted[0] as { id: number; method: string }
    expect(sentMsg.method).toBe('spec/save')

    postToWindow({ id: sentMsg.id, ok: true, result: { written: true } })

    await expect(promise).resolves.toEqual({ written: true })
  })

  it('请求在宿主回应 ok:false 后 reject，错误信息来自宿主', async () => {
    const bridge = createVscodeBridge()

    const promise = bridge.request('spec/save', {})
    const sentMsg = fakeApi.posted[0] as { id: number }

    postToWindow({ id: sentMsg.id, ok: false, error: '写入失败' })

    await expect(promise).rejects.toThrow('写入失败')
  })

  it('事件只送达订阅了该事件的监听器', () => {
    const bridge = createVscodeBridge()

    const specChanged: unknown[] = []
    const scanProgress: unknown[] = []
    bridge.on('spec-changed', p => specChanged.push(p))
    bridge.on('scan-progress', p => scanProgress.push(p))

    postToWindow({ event: 'spec-changed', payload: { dirty: true } })

    expect(specChanged).toEqual([{ dirty: true }])
    expect(scanProgress).toEqual([])
  })

  it('on 返回的取消函数能真正取消订阅', () => {
    const bridge = createVscodeBridge()

    let count = 0
    const off = bridge.on('spec-changed', () => {
      count++
    })

    postToWindow({ event: 'spec-changed', payload: undefined })
    expect(count).toBe(1)

    off()
    postToWindow({ event: 'spec-changed', payload: undefined })
    expect(count).toBe(1)
  })

  it('没有匹配 pending id 的消息被忽略而不是抛出', async () => {
    const bridge = createVscodeBridge()

    const promise = bridge.request('spec/save', {})
    const sentMsg = fakeApi.posted[0] as { id: number }

    // 一条不认识的 id：不应该抛异常，也不应该影响后面真正匹配的响应
    expect(() => postToWindow({ id: sentMsg.id + 999, ok: true, result: { written: true } })).not.toThrow()

    postToWindow({ id: sentMsg.id, ok: true, result: { written: true } })

    await expect(withTimeout(promise)).resolves.toEqual({ written: true })
  })
})
