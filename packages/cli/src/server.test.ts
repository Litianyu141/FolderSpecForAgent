import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import WebSocket from 'ws'
import { startServer, isAuthorizedUpgrade } from './server.js'
import type { ServerHandle } from './server.js'
import { SPEC_FILENAME } from '@folderspec/core'

let repo: string
let uiDir: string
let server: ServerHandle

/** 握手必须带上本次启动的一次性令牌，否则会被 403 掉（见 server.ts 的 isAuthorizedUpgrade） */
const wsUrl = (): string => `ws://127.0.0.1:${server.port}/?token=${server.token}`

/** 打开一条连接并等它握手完成；握手被拒时把 'error' 变成一个 reject */
const connect = (url: string, opts?: { origin?: string }): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const ws = opts?.origin
      ? new WebSocket(url, { headers: { Origin: opts.origin } })
      : new WebSocket(url)
    ws.once('open', () => resolve(ws))
    ws.once('error', e => reject(e))
  })

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
    const ws = await connect(wsUrl())
    try {
      const opened = await rpc(ws, 1, 'workspace/open', { root: repo })
      expect(opened.ok).toBe(true)
      expect((opened.result as { rootName: string }).rootName).toBe(nodePath.basename(repo))
    } finally {
      ws.close()
    }
  })

  it('走完整的注释与保存链路', async () => {
    const ws = await connect(wsUrl())
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
    const ws = await connect(wsUrl())
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
    const ws = await connect(wsUrl())
    try {
      const res = await rpc(ws, 1, 'no/such/method', {})
      expect(res.ok).toBe(false)
      expect(res.error).toContain('未知方法')
      expect(ws.readyState).toBe(WebSocket.OPEN)
    } finally {
      ws.close()
    }
  })

  it('畸形的百分号编码不会让进程崩溃', async () => {
    // %E0%80%80 语法上是合法的百分号转义（三个合法的十六进制对），但解码后不是合法的
    // UTF-8 字节序列——decodeURIComponent 会抛出 URIError。fetch 不会在发出前拒绝它，
    // 因为转义本身语法合法，问题只在服务端解码这一步暴露。
    const res = await fetch(`${server.url}%E0%80%80`)
    expect([400, 404]).toContain(res.status)

    // 崩溃的旧实现会让 http.Server 所在的整个 Node 进程带着未处理的 rejection 退出；
    // 用第二个正常请求验证进程（以及这个 server 实例）还活着。
    const followUp = await fetch(server.url)
    expect(followUp.status).toBe(200)
    expect(await followUp.text()).toContain('ui')
  })
})

describe('WebSocket 端点的鉴权（浏览器不对 WebSocket 施加同源策略）', () => {
  it('不带令牌的连接被拒绝——否则用户开着的任何一个网页都能说完整的 RPC 协议', async () => {
    // 复现审查者做过的事：一个跨源页面连上 ws://127.0.0.1:<port>/，调 workspace/open
    // 打开任意目录、枚举它、往里写 .folderspec.md。随机端口不是防线，几秒就能扫完。
    await expect(connect(`ws://127.0.0.1:${server.port}/`)).rejects.toThrow(/403/)
  })

  it('令牌错误的连接同样被拒绝', async () => {
    const wrong = 'f'.repeat(64)
    await expect(connect(`ws://127.0.0.1:${server.port}/?token=${wrong}`)).rejects.toThrow(/403/)
  })

  it('带正确令牌的连接被接受，并能正常说 RPC', async () => {
    const ws = await connect(wsUrl())
    try {
      const opened = await rpc(ws, 1, 'workspace/open', { root: repo })
      expect(opened.ok).toBe(true)
    } finally {
      ws.close()
    }
  })

  it('令牌正确但 Origin 是第三方站点时被拒绝', async () => {
    // 浏览器如实带上 Origin 且页面无法伪造它。所以一个带着别人家 Origin 的升级请求
    // 必然来自第三方页面——哪怕它不知从哪儿弄到了令牌，这一层也要挡住。
    await expect(connect(wsUrl(), { origin: 'https://evil.example' })).rejects.toThrow(/403/)
  })

  it('Origin 是本机自家页面时放行', async () => {
    const ws = await connect(wsUrl(), { origin: `http://127.0.0.1:${server.port}` })
    ws.close()
    const ws2 = await connect(wsUrl(), { origin: `http://localhost:${server.port}` })
    ws2.close()
  })

  it('index.html 里注入了令牌，UI 才拿得到它', async () => {
    const html = await (await fetch(server.url)).text()
    expect(html).toContain('__folderspecToken')
    expect(html).toContain(server.token)
  })
})

describe('isAuthorizedUpgrade', () => {
  const token = 'a'.repeat(64)
  const base = { token, port: 4321 }

  it('没有 token 查询参数时拒绝', () => {
    expect(isAuthorizedUpgrade({ ...base, url: '/', origin: undefined })).toBe(false)
  })

  it('token 正确且没有 Origin（非浏览器客户端）时放行', () => {
    expect(isAuthorizedUpgrade({ ...base, url: `/?token=${token}`, origin: undefined })).toBe(true)
  })

  it('token 只是前缀时拒绝——不能用长度不等的比较蒙混过去', () => {
    expect(isAuthorizedUpgrade({ ...base, url: `/?token=${'a'.repeat(63)}`, origin: undefined })).toBe(false)
  })

  it('Origin 是自家两种写法之一时放行，其余一律拒绝', () => {
    const url = `/?token=${token}`
    expect(isAuthorizedUpgrade({ ...base, url, origin: 'http://127.0.0.1:4321' })).toBe(true)
    expect(isAuthorizedUpgrade({ ...base, url, origin: 'http://localhost:4321' })).toBe(true)
    expect(isAuthorizedUpgrade({ ...base, url, origin: 'http://127.0.0.1:9999' })).toBe(false)
    expect(isAuthorizedUpgrade({ ...base, url, origin: 'https://evil.example' })).toBe(false)
    // 别被前缀骗了：这是 evil.example 的子路径，不是本机
    expect(isAuthorizedUpgrade({ ...base, url, origin: 'http://127.0.0.1:4321.evil.example' })).toBe(false)
  })
})

describe('超大 WebSocket 帧', () => {
  it('超过 maxPayload 的一帧只杀死这条连接，进程与服务器都必须活着', async () => {
    // ws 在超限时会在 socket 上 emit('error')。EventEmitter 的规矩是没有 'error'
    // 监听器就直接抛——一个跨源页面发一行 `ws.send('a'.repeat(2e8))` 就能撂倒整个
    // CLI 进程，连同内存里所有尚未保存的标注。
    //
    // 关于"进程还活着"这条断言怎么写：**不能**只靠"后续 fetch 还能 200"。
    // vitest 的 worker 自己装了 process 级的 uncaughtException 处理器，所以在测试
    // 环境里这个异常不会真的把进程带走，用例照样全绿——那样的用例检测不出它要测的
    // 那个 bug（实测确认过）。真实的 CLI 进程没有任何这样的处理器。因此这里直接盯住
    // 信号本身：只要 uncaughtException 被 emit 过一次，生产环境里进程就已经死了。
    const uncaught: unknown[] = []
    const onUncaught = (e: unknown): void => { uncaught.push(e) }
    process.on('uncaughtException', onUncaught)

    try {
      const ws = await connect(wsUrl())
      const closed = new Promise<void>(resolve => ws.once('close', () => resolve()))
      ws.on('error', () => {}) // 客户端这边也会收到断连，别让它变成未捕获异常
      ws.send('a'.repeat(5 * 1024 * 1024))
      await closed
      // 给可能晚一拍才冒到 process 上的异常留一个 tick
      await new Promise(resolve => setImmediate(resolve))
    } finally {
      process.off('uncaughtException', onUncaught)
    }

    expect(
      uncaught.map(e => (e instanceof Error ? e.message : String(e))),
      '服务端收到超大帧后抛出了未捕获异常；真实 CLI 进程里没有任何处理器，这一下就是整个会话连同未保存的标注一起没了',
    ).toEqual([])

    // 服务器（以及承载它的进程）还在
    const followUp = await fetch(server.url)
    expect(followUp.status).toBe(200)
    expect(await followUp.text()).toContain('ui')

    // 而且还能再开一条正常连接说 RPC
    const again = await connect(wsUrl())
    try {
      expect((await rpc(again, 1, 'workspace/open', { root: repo })).ok).toBe(true)
    } finally {
      again.close()
    }
  })
})

describe('注入进内联 <script> 的值必须转义 "<"', () => {
  it('工作区路径字面量含 "</script>" 时不能提前闭合 script 标签', async () => {
    // 这是个真实可创建的路径：目录 `a<` 里套一个目录 `script>`，拼起来就含有
    // 字面量 "</script>"。JSON.stringify 不转义 '/'，所以不额外处理 '<' 的话，
    // 注入的这段脚本会在这里被 HTML 分词器截断，后面的内容变成新的元素。
    // CLI 这边一条 CSP 都没有（既无响应头也无 meta），注入的脚本会真的执行。
    const outer = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'folderspec-xss-'))
    const evilRoot = nodePath.join(outer, 'a<', 'script>')
    await fs.mkdir(evilRoot, { recursive: true })

    const evil = await startServer({ root: evilRoot, uiDir })
    try {
      const html = await (await fetch(evil.url)).text()
      const script = html.slice(html.indexOf('<script>') + '<script>'.length, html.indexOf('</script>'))

      // 路径确实被注进去了……
      expect(script).toContain('__folderspecRoot')
      expect(script).toContain('a\\u003c/script>')
      // ……但脚本体内不能出现任何字面量 '<'，否则标签就被提前闭合了
      expect(script).not.toContain('<')
      // 整份文档里 <script> 与 </script> 必须一一对应：多出来的就是被注入的那个
      expect((html.match(/<script/g) ?? []).length).toBe((html.match(/<\/script>/g) ?? []).length)
      expect((html.match(/<script/g) ?? []).length).toBe(1)
    } finally {
      await evil.close()
      await fs.rm(outer, { recursive: true, force: true })
    }
  })

  it('令牌也走同一条转义路径', async () => {
    const html = await (await fetch(server.url)).text()
    const script = html.slice(html.indexOf('<script>') + '<script>'.length, html.indexOf('</script>'))
    expect(script).toContain('__folderspecToken')
    // 令牌是十六进制，天然不含 '<'；这条断言盯的是"它和 root 走的是同一个转义函数"——
    // 脚本体里一个字面量 '<' 都不许有。
    expect(script).not.toContain('<')
  })
})
