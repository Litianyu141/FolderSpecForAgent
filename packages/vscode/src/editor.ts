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
          // 不直接写盘：走 WorkspaceEdit，让 VSCode 的脏标记、Ctrl+S 与撤销栈正常工作
          applyingOwnEdit = true
          try {
            const edit = new vscode.WorkspaceEdit()
            const whole = new vscode.Range(
              document.positionAt(0),
              document.positionAt(document.getText().length),
            )
            edit.replace(document.uri, whole, session.raw())
            await vscode.workspace.applyEdit(edit)
            await document.save()
          } finally {
            applyingOwnEdit = false
          }
          result = { written: true }
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
