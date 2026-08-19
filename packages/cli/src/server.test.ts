import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import WebSocket from 'ws'
import { startServer } from './server.js'
import type { ServerHandle } from './server.js'
import { SPEC_FILENAME } from '@folderspec/core'

let repo: string
let uiDir: string
let server: ServerHandle

const rpc = (ws: WebSocket, id: number, method: string, params: unknown) =>
  new Promise<{ ok: boolean; result?: unknown; error?: string }>((resolve, reject) => {
    const onMessage = (raw: WebSocket.RawData) => {
      const msg = JSON.parse(String(raw))
      if (msg.id !== id) return
      ws.off('message', onMessage)
      resolve(msg)
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ id, method, params }), err => { if (err) reject(err) })
  })

beforeAll(async () => {
  repo = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'folderspec-cli-'))
  await fs.mkdir(nodePath.join(repo, 'src'), { recursive: true })
  uiDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'folderspec-ui-'))
  await fs.writeFile(
    nodePath.join(uiDir, 'index.html'),
    '<!doctype html><html><head></head><body><p>ui</p></body></html>',
  )
  server = await startServer({ root: repo, uiDir })
})

afterAll(async () => {
  await server.close()
  await fs.rm(repo, { recursive: true, force: true })
  await fs.rm(uiDir, { recursive: true, force: true })
})

describe('startServer', () => {
  it('监听在一个可用端口上', () => {
    expect(server.port).toBeGreaterThan(0)
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/`)
  })

  it('提供 index.html', async () => {
    const res = await fetch(server.url)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('ui')
  })

  it('把注入脚本插进 index.html', async () => {
    const html = await (await fetch(server.url)).text()
    expect(html).toContain('__folderspecRoot')
  })

  it('拒绝跳出 uiDir 的路径穿越', async () => {
    // 必须用百分号编码：裸的 ../ 会被 fetch 在发出前归一化掉，测不到守卫
    const res = await fetch(`${server.url}%2e%2e%2f%2e%2e%2fetc%2fpasswd`)
    expect(res.status).toBe(404)
  })

  it('通过 WebSocket 响应 RPC 请求', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`)
    await new Promise(r => ws.once('open', r))
    try {
      const opened = await rpc(ws, 1, 'workspace/open', { root: repo })
      expect(opened.ok).toBe(true)
      expect((opened.result as { rootName: string }).rootName).toBe(nodePath.basename(repo))
    } finally {
      ws.close()
    }
  })

  it('走完整的注释与保存链路', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`)
    await new Promise(r => ws.once('open', r))
    try {
      await rpc(ws, 1, 'workspace/open', { root: repo })
      const edited = await rpc(ws, 2, 'spec/annotate', { path: 'src', isDir: true, annotation: '核心源码' })
      expect(edited.ok).toBe(true)
      const saved = await rpc(ws, 3, 'spec/save', {})
      expect(saved.ok).toBe(true)
      const text = await fs.readFile(nodePath.join(repo, SPEC_FILENAME), 'utf8')
      expect(text).toContain('- `src/` — 核心源码')
    } finally {
      ws.close()
    }
  })

  it('用不同的 root 再次 open 会切换到新工作区', async () => {
    const other = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'folderspec-other-'))
    await fs.mkdir(nodePath.join(other, 'lib'), { recursive: true })
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`)
    await new Promise(r => ws.once('open', r))
    try {
      await rpc(ws, 1, 'workspace/open', { root: repo })
      const opened = await rpc(ws, 2, 'workspace/open', { root: other })
      expect(opened.ok).toBe(true)
      const result = opened.result as { root: string; tree: { children?: Array<{ name: string }> } }
      expect(result.root).toBe(other)
      expect(result.tree.children?.map(c => c.name)).toEqual(['lib'])
    } finally {
      ws.close()
      await fs.rm(other, { recursive: true, force: true })
    }
  })

  it('把错误作为 ok:false 回传而不是断开连接', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`)
    await new Promise(r => ws.once('open', r))
    try {
      const res = await rpc(ws, 1, 'no/such/method', {})
      expect(res.ok).toBe(false)
      expect(res.error).toContain('未知方法')
      expect(ws.readyState).toBe(WebSocket.OPEN)
    } finally {
      ws.close()
    }
  })
})
