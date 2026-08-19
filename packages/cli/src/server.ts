import * as http from 'node:http'
import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'
import { WebSocketServer } from 'ws'
import { Session } from '@folderspec/core'
import type { ApiMethod } from '@folderspec/core'
import type { RpcRequest, RpcResponse } from './protocol.js'

export interface ServerHandle {
  port: number
  url: string
  close(): Promise<void>
}

export interface ServerOpts {
  root: string
  uiDir: string
  port?: number
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

export async function startServer(opts: ServerOpts): Promise<ServerHandle> {
  let session = new Session(nodePath.resolve(opts.root))
  const uiDir = nodePath.resolve(opts.uiDir)

  const server = http.createServer((req, res) => {
    // 双保险的外层：即便 serveStatic 自己的 try/catch 有遗漏，也不能让异常逃逸成
    // 未处理的 rejection——http.createServer 的回调不是 async，没人在等它。
    serveStatic(req, res, uiDir, opts.root).catch(() => {
      if (!res.headersSent) res.writeHead(500).end('internal error')
      else res.end()
    })
  })

  const wss = new WebSocketServer({ server })
  wss.on('connection', socket => {
    socket.on('message', async raw => {
      let req: RpcRequest
      try {
        req = JSON.parse(String(raw)) as RpcRequest
      } catch {
        return
      }
      let response: RpcResponse
      try {
        // 切换工作区 = 换一个 Session。Session 自己不处理换根。
        if (req.method === 'workspace/open') {
          const wanted = nodePath.resolve((req.params as { root?: string }).root ?? session.root)
          if (wanted !== session.root) session = new Session(wanted)
        }
        const result = await session.handle(req.method as ApiMethod, req.params as never)
        response = { id: req.id, ok: true, result }
      } catch (e) {
        response = { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) }
      }
      socket.send(JSON.stringify(response))
    })
  })

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') resolve(addr.port)
      else reject(new Error('无法确定监听端口'))
    })
  })

  return {
    port,
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>(resolve => {
        wss.close(() => server.close(() => resolve()))
      }),
  }
}

async function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  uiDir: string,
  root: string,
): Promise<void> {
  try {
    const rawPath = (req.url ?? '/').split('?')[0]
    // decodeURIComponent 在语法合法但字节序列非法（比如 %E0%80%80）时会抛出 URIError；
    // 一次这样的请求不能撂倒整个进程，所以整段处理都在下面的 catch 之内。
    const rel = rawPath === '/' ? 'index.html' : decodeURIComponent(rawPath.replace(/^\/+/, ''))
    const abs = nodePath.resolve(uiDir, rel)

    // 路径穿越防护：解析后必须仍在 uiDir 之内
    if (abs !== uiDir && !abs.startsWith(uiDir + nodePath.sep)) {
      res.writeHead(404).end('not found')
      return
    }

    let body: Buffer
    try {
      body = await fs.readFile(abs)
    } catch {
      res.writeHead(404).end('not found')
      return
    }

    const ext = nodePath.extname(abs)
    if (ext === '.html') {
      const injected = String(body).replace(
        '</head>',
        `<script>window.__folderspecRoot=${JSON.stringify(root)};</script></head>`,
      )
      res.writeHead(200, { 'content-type': MIME['.html'] }).end(injected)
      return
    }

    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' }).end(body)
  } catch {
    // 未预料的错误（典型例子：非法的 %XX 转义触发的 URIError）必须变成一个 400 响应，
    // 绝不能重新抛出——这里没有 await 它的调用者，抛出就会变成未处理的 rejection 并
    // 杀死整个 CLI 进程（服务器只绑定 127.0.0.1，但同源策略挡不住一个简单 GET 的发出，
    // 用户开着的任何一个网页都能借此杀死本地会话，丢光尚未保存的编辑）。
    if (!res.headersSent) res.writeHead(400).end('bad request')
    else res.end()
  }
}
