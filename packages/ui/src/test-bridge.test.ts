import { describe, it, expect } from 'vitest'
import { FakeBridge } from './test-bridge.js'
import type { BridgeEvent, ViewNode } from '@folderspec/core/api'

const SPEC_CHANGED: BridgeEvent = 'spec-changed'
const SCAN_PROGRESS: BridgeEvent = 'scan-progress'
const EXTERNAL_CHANGE: BridgeEvent = 'external-change'

const view = (over: Partial<ViewNode> = {}): ViewNode =>
  ({ name: 'x', path: 'x', isDir: false, origin: 'actual-only', ...over })

describe('FakeBridge', () => {
  it('request 返回配置的结果并记录调用', async () => {
    const bridge = new FakeBridge({
      'spec/save': () => ({ written: true }),
    })

    const result = await bridge.request('spec/save', {})

    expect(result).toEqual({ written: true })
    expect(bridge.calls).toEqual([{ method: 'spec/save', params: {} }])
  })

  it('未配置的方法返回被拒绝的 Promise 而非同步抛出', async () => {
    const bridge = new FakeBridge()

    let threwSynchronously = false
    let promise!: Promise<unknown>
    try {
      promise = bridge.request('tree/get', {})
    } catch {
      threwSynchronously = true
    }

    // 调用本身必须立即返回一个 Promise，不能同步抛出——App 依赖这一点来 await 每次调用。
    expect(threwSynchronously).toBe(false)
    expect(promise).toBeInstanceOf(Promise)

    await expect(promise).rejects.toThrow(/未配置/)
  })

  it('被拒绝的调用仍然记录在 calls 里', async () => {
    const bridge = new FakeBridge()

    await expect(bridge.request('tree/get', {})).rejects.toThrow(/未配置/)

    expect(bridge.calls).toEqual([{ method: 'tree/get', params: {} }])
  })

  it('on 返回的函数能真正取消订阅', () => {
    const bridge = new FakeBridge()
    let count = 0
    const off = bridge.on(SPEC_CHANGED, () => {
      count++
    })

    bridge.emit(SPEC_CHANGED, undefined)
    expect(count).toBe(1)

    off()
    bridge.emit(SPEC_CHANGED, undefined)
    expect(count).toBe(1)
  })

  it('emit 只到达该事件的监听器', () => {
    const bridge = new FakeBridge()
    let specChanged = 0
    let scanProgress = 0
    let externalChange = 0

    bridge.on(SPEC_CHANGED, () => {
      specChanged++
    })
    bridge.on(SCAN_PROGRESS, () => {
      scanProgress++
    })
    bridge.on(EXTERNAL_CHANGE, () => {
      externalChange++
    })

    bridge.emit(SCAN_PROGRESS, undefined)

    expect(specChanged).toBe(0)
    expect(scanProgress).toBe(1)
    expect(externalChange).toBe(0)
  })

  it('setHandler 覆盖已有方法的回应，可用来让某个方法抛错', async () => {
    const bridge = new FakeBridge({ 'spec/save': () => ({ written: true }) })

    bridge.setHandler('spec/save', () => { throw new Error('写盘炸了') })

    // 抛出必须落成拒绝的 Promise，而不是同步抛出——App 的 try/catch 包的是 await
    await expect(bridge.request('spec/save', {})).rejects.toThrow('写盘炸了')
  })

  it('setHandler 也能给构造时未配置的方法补上回应', async () => {
    const bridge = new FakeBridge()

    bridge.setHandler('spec/raw', () => ({ markdown: '# x' }))

    expect(await bridge.request('spec/raw', {})).toEqual({ markdown: '# x' })
  })

  it('lastCall 返回该方法最近一次的 params，没有调用过时返回 undefined', async () => {
    const bridge = new FakeBridge({
      'tree/expand': ({ path }) => ({ tree: view({ path }) }),
    })

    await bridge.request('tree/expand', { path: 'a' })
    await bridge.request('tree/expand', { path: 'b' })

    expect(bridge.lastCall('tree/expand')).toEqual({ path: 'b' })
    expect(bridge.lastCall('spec/save')).toBeUndefined()
  })
})
