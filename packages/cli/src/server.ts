import * as http from 'node:http'
import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { Session } from '@folderspec/core'
import type { ApiMethod } from '@folderspec/core'
import type { RpcRequest, RpcResponse } from './protocol.js'

export interface ServerHandle {
  port: number
  url: string
  /** 本次启动专用的一次性令牌；WebSocket 升级必须带上它 */
  token: string
  close(): Promise<void>
}

/**
 * 一帧的上限。没有上限时，一个 `ws.send('a'.repeat(2e8))` 就能把本地进程撑爆内存；
 * 有上限但没有 'error' 监听器，ws 抛出的超限错误会经 EventEmitter 变成未捕获异常，
 * 同样杀掉进程（连同所有尚未保存的标注）。两件事必须一起做。
 */
const MAX_WS_PAYLOAD = 4 * 1024 * 1024

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

  // 浏览器**不**对 WebSocket 施加同源策略：用户在 folderspec 运行期间打开的任何一个
  // 网页都能连上 ws://127.0.0.1:<port>/ 并说完整的 RPC 协议——枚举任意目录、往任意
  // 目录写 .folderspec.md。随机端口不是防线，几秒钟就能扫完。所以每次启动生成一个
  // 一次性令牌，注入进自家页面（跨源页面读不到这段 HTML：CORS 不让它读响应体），
  // 并要求升级请求原样带上。
  const token = randomBytes(32).toString('hex')
  let boundPort = 0

  const server = http.createServer((req, res) => {
    // 双保险的外层：即便 serveStatic 自己的 try/catch 有遗漏，也不能让异常逃逸成
    // 未处理的 rejection——http.createServer 的回调不是 async，没人在等它。
    serveStatic(req, res, uiDir, opts.root, token).catch(() => {
      if (!res.headersSent) res.writeHead(500).end('internal error')
      else res.end()
    })
  })

  // noServer + 手动 handleUpgrade：只有这样才能在握手完成**之前**拒绝一次升级。
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD })

  server.on('upgrade', (req, socket, head) => {
    // 被 destroy 掉的 socket 之后仍可能吐出 ECONNRESET；没人听就是未捕获异常。
    socket.on('error', () => {})
    if (!isAuthorizedUpgrade({ url: req.url, origin: req.headers.origin, token, port: boundPort })) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
  })

  // ws 在超出 maxPayload、收到畸形帧等情况下会在 socket 上 emit('error')。
  // EventEmitter 的规矩是：'error' 没有监听器就直接抛。一个跨源页面发一帧超大数据
  // 就能撂倒整个进程——和这个文件下面 serveStatic 里那条注释描述的是同一个洞，
  // 只不过那条守的是 HTTP 路径，WebSocket 这条当时是敞开的。
  wss.on('error', () => {})
  wss.on('connection', socket => {
    socket.on('error', () => {
      // 单条连接出错就让它自己死；进程必须活着，未保存的标注都在内存里。
      socket.terminate()
    })
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
  boundPort = port

  return {
    port,
    token,
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>(resolve => {
        // 还开着的 WebSocket 会让 server.close() 一直等下去（连带把测试进程挂住）。
        // 这是个本地只读工具，关就是关，没有需要优雅排空的在途写操作。
        for (const client of wss.clients) client.terminate()
        wss.close(() => server.close(() => resolve()))
      }),
  }
}

/**
 * 注入到内联 <script> 里的值必须额外转义 '<'。
 *
 * JSON.stringify 不转义 '/'，所以一个字面量含 "</script>" 的工作区路径会**提前闭合**
 * 这个 script 标签，后面的内容作为新的 HTML 解析——等于任意脚本注入。CLI 这边一条
 * CSP 都没有（既无响应头也无 meta），注入的脚本会真的执行，而且执行在一个正握着
 * RPC socket 的页面里。转义 '<' 就够堵死这条路：\u003c 在 JS 字符串里等价，
 * 但 HTML 分词器再也看不到 '<'。
 */
function jsonForScript(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c')
}

/**
 * 升级请求是否放行。两层互相独立，挡的是不同的攻击者：
 *
 * 1. 令牌：跨源页面读不到我们注入令牌的那段 HTML（CORS 挡住响应体），因此拿不到它。
 *    256 位随机、一次连接一次猜测，暴力不可行。非浏览器客户端也靠这一层。
 * 2. Origin：浏览器会如实带上 Origin 且页面无法伪造它，所以一个带着**别人家** Origin
 *    的升级请求必然来自第三方页面，直接拒。没有 Origin 头的是非浏览器客户端
 *    （curl、测试、未来的 MCP 客户端），由令牌那一层负责。
 */
export function isAuthorizedUpgrade(opts: {
  url: string | undefined
  origin: string | undefined
  token: string
  port: number
}): boolean {
  const { url, origin, token, port } = opts

  if (origin !== undefined && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
    return false
  }

  let provided: string | null = null
  try {
    provided = new URL(url ?? '/', 'http://127.0.0.1').searchParams.get('token')
  } catch {
    return false
  }
  if (provided === null) return false

  const a = Buffer.from(provided)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

async function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  uiDir: string,
  root: string,
  token: string,
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
      // 用函数替换而非字符串替换：字符串替换会展开 $&、$`、$'、$$，
      // 把 jsonForScript 刚转义掉的 '<' 又放回去，重新打开 </script> 突破口。
      const injected = String(body).replace(
        '</head>',
        () => `<script>window.__folderspecRoot=${jsonForScript(root)};`
          + `window.__folderspecToken=${jsonForScript(token)};</script></head>`,
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
