import * as vscode from 'vscode'
import * as nodePath from 'node:path'
import { randomBytes } from 'node:crypto'
import { Session } from '@folderspec/core'
import type { ApiMethod } from '@folderspec/core'
import { buildWebviewHtml } from './webview-html.js'

export const VIEW_TYPE = 'folderspec.editor'

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
          if (wanted && nodePath.resolve(wanted) !== session.root) {
            session = new Session(nodePath.resolve(wanted))
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
