import * as vscode from 'vscode'
import { emptySpec, serializeSpec, SPEC_FILENAME } from '@folderspec/core'
import { FolderSpecEditorProvider, VIEW_TYPE } from './editor.js'

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      VIEW_TYPE,
      new FolderSpecEditorProvider(context),
      { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false },
    ),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('folderspec.open', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0]
      if (!folder) {
        void vscode.window.showErrorMessage('FolderSpec：请先打开一个工作区文件夹。')
        return
      }
      const uri = vscode.Uri.joinPath(folder.uri, SPEC_FILENAME)

      let exists = true
      try {
        await vscode.workspace.fs.stat(uri)
      } catch {
        exists = false
      }

      if (!exists) {
        const choice = await vscode.window.showInformationMessage(
          `本工作区还没有 ${SPEC_FILENAME}，是否创建？`,
          { modal: true },
          '创建',
        )
        if (choice !== '创建') return
        await vscode.workspace.fs.writeFile(
          uri,
          new TextEncoder().encode(serializeSpec(emptySpec())),
        )
      }

      await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE)
    }),
  )
}

export function deactivate(): void {
  // 无需清理：全部资源都挂在 context.subscriptions 上
}
