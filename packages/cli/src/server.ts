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
    void serveStatic(req, res, uiDir, opts.root)
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
  const rawPath = (req.url ?? '/').split('?')[0]
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
}
