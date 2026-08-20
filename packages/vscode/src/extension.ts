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
        void vscode.window.showErrorMessage('FolderSpec: open a workspace folder first.')
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
          `This workspace has no ${SPEC_FILENAME} yet. Create one?`,
          { modal: true },
          'Create',
        )
        if (choice !== 'Create') return
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
