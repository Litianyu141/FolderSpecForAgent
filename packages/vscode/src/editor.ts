import * as vscode from 'vscode'
import * as nodePath from 'node:path'
import { randomBytes } from 'node:crypto'
import { Session } from '@folderspec/core'
import type { ApiMethod } from '@folderspec/core'
import { buildWebviewHtml } from './webview-html.js'

export const VIEW_TYPE = 'folderspec.editor'

/**
 * 只有当请求的 root 是**绝对路径**且与当前不同，才换一个 Session。
 *
 * UI 侧的 App 用 `window.__folderspecRoot ?? '.'` 当 initialRoot 的占位默认值——
 * CLI 宿主一直往返回的 HTML 里注入真实 root（server.ts），VSCode 宿主现在也在
 * webview-html.ts 里做了同样的注入（见其 root 选项）。但两层防线缺一不可：万一
 * 注入因为某种原因没生效（CSP 拦截、竞态、未来重构漏掉），UI 送上来的第一条
 * workspace/open 消息就会带着字面量 '.'。相对路径绝不能拿去 resolve——resolve('.')
 * 解析基准是**扩展宿主进程自己的 cwd**，跟 vscode.workspace.getWorkspaceFolder()
 * 算出来的真实工作区毫无关系。一旦被当真，正确初始化好的 Session 会被换成一个
 * 根本不对的目录；用户在错误的树上做的标注一旦点保存，session.raw() 吐出的近乎
 * 空契约会经 WorkspaceEdit 原样盖到用户真实的 .folderspec.md 上——这正是这个项目
 * 存在的意义所要防止的那种事故。
 */
export function shouldSwitchSession(currentRoot: string, wanted: string | undefined): string | null {
  if (!wanted || !nodePath.isAbsolute(wanted)) return null
  const resolved = nodePath.resolve(wanted)
  return resolved === currentRoot ? null : resolved
}

export class FolderSpecEditorProvider implements vscode.CustomTextEditorProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const root = workspaceRootFor(document.uri)
    let session = new Session(root)

    const uiRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'ui')
    panel.webview.options = { enableScripts: true, localResourceRoots: [uiRoot] }

    const indexHtml = new TextDecoder().decode(
      await vscode.workspace.fs.readFile(vscode.Uri.joinPath(uiRoot, 'index.html')),
    )
    panel.webview.html = buildWebviewHtml({
      indexHtml,
      assetBase: panel.webview.asWebviewUri(uiRoot).toString(),
      cspSource: panel.webview.cspSource,
      nonce: randomBytes(16).toString('base64'),
      root,
    })

    // 我们自己发起的编辑不应该被当成外部变更
    let applyingOwnEdit = false

    const changeSub = vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.uri.toString() !== document.uri.toString()) return
      if (applyingOwnEdit) return
      void panel.webview.postMessage({ event: 'external-change', payload: {} })
    })

    const messageSub = panel.webview.onDidReceiveMessage(async (msg: { id: number; method: ApiMethod; params: unknown }) => {
      try {
        // 切换工作区 = 换一个 Session（VSCode 端一般只会重开同一个根）
        if (msg.method === 'workspace/open') {
          const wanted = (msg.params as { root?: string }).root
          const next = shouldSwitchSession(session.root, wanted)
          if (next) {
            session = new Session(next)
          }
        }
        let result: unknown
        if (msg.method === 'spec/save') {
          // 不直接写盘：走 WorkspaceEdit，让 VSCode 的脏标记、Ctrl+S 与撤销栈正常工作。
          // 下面横跨两个 await；期间若又收到一条把 session 换掉的 workspace/open，
          // 后面 markSaved() 必须仍然记到"真正被写盘的那个 Session"身上，而不是
          // 记到新换上来的、跟这次写入毫无关系的会话——所以先钉死引用，不要再读
          // 外层那个可变的 session 变量。
          const savingSession = session
          applyingOwnEdit = true
          try {
            // text 与 revision 必须来自同一次 rawForSave() 调用，不能分开读——
            // 下面横跨 WorkspaceEdit + document.save() 两个 await（后者会跑 save
            // participants，窗口可能有几百毫秒），消息回调又不排队，这段时间完全
            // 可能又处理一条把 session revision 推进的新消息。如果这里是"先调
            // raw() 拿文本，回头调用 markSaved() 时再读一次 session 当下的
            // revision"，两次读取之间可能已经隔着一次新编辑，读到的 revision 会比
            // 实际写盘的文本新——markSaved() 就会把没写进磁盘的那一版误标成已
            // 保存，dirty 假熄灭。rawForSave() 把两者绑成一次调用的返回值，这里
            // 不需要（也不能）自己另外去读 session 的状态。
            const { text, revision } = savingSession.rawForSave()
            const edit = new vscode.WorkspaceEdit()
            const whole = new vscode.Range(
              document.positionAt(0),
              document.positionAt(document.getText().length),
            )
            edit.replace(document.uri, whole, text)
            await vscode.workspace.applyEdit(edit)
            await document.save()
            // 这条写路径完全绕开 Session.save()（那个方法自己 fs.writeFile），
            // 磁盘上现在是哪个版本 Session 自己不知道要翻页——不补这一句，
            // dirty 会在首次编辑后再也灭不掉（哪怕撤销回了刚保存的那一步）。
            // markSaved() 只改内存里的编号，不产生新的写路径；传入的 revision
            // 必须是上面 rawForSave() 给出的那个，不是"此刻"的 session.revision。
            savingSession.markSaved(revision)
          } finally {
            applyingOwnEdit = false
          }
          // 上面两个 await（WorkspaceEdit + document.save()）期间，消息回调不排队，
          // 完全可能又处理了一条把 savingSession.revision 推进的新编辑——isDirty()
          // 此刻会如实算出 true（对应的正是 markSaved 只追平了 rawForSave() 捕获的
          // 那个旧 revision）。webview 侧的 UI 必须转达这个值，不能自己假定保存
          // 一定让脏标记熄灭（api.ts SaveResult.dirty 上有完整推导）。
          result = { written: true, dirty: savingSession.isDirty() }
        } else {
          result = await session.handle(msg.method, msg.params as never)
        }
        void panel.webview.postMessage({ id: msg.id, ok: true, result })
      } catch (e) {
        void panel.webview.postMessage({
          id: msg.id,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    })

    panel.onDidDispose(() => {
      changeSub.dispose()
      messageSub.dispose()
    })
  }
}

function workspaceRootFor(uri: vscode.Uri): string {
  const folder = vscode.workspace.getWorkspaceFolder(uri)
  return folder ? folder.uri.fsPath : nodePath.dirname(uri.fsPath)
}
