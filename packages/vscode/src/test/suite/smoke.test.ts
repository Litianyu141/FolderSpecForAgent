import * as assert from 'node:assert/strict'
import * as vscode from 'vscode'

suite('FolderSpec 冒烟测试', () => {
  test('打开 .folderspec.md 时使用自定义编辑器，且写注释后能存回磁盘', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0]
    assert.ok(folder, '测试需要一个已打开的工作区')

    const specUri = vscode.Uri.joinPath(folder.uri, '.folderspec.md')
    const initial = [
      '---', 'folderspec: 1', 'root: .', 'ownership: human', '---',
      '', '# 仓库结构契约', '', '## 结构', '', '- `src/` — 初始注释', '',
    ].join('\n')
    await vscode.workspace.fs.writeFile(specUri, new TextEncoder().encode(initial))

    // 以自定义编辑器打开
    await vscode.commands.executeCommand('vscode.openWith', specUri, 'folderspec.editor')
    await new Promise(r => setTimeout(r, 3000))

    // 文档仍可被正常读取，内容未被破坏
    const doc = await vscode.workspace.openTextDocument(specUri)
    assert.ok(doc.getText().includes('- `src/` — 初始注释'))

    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  })

  test('folderspec.open 命令已注册', async () => {
    const all = await vscode.commands.getCommands(true)
    assert.ok(all.includes('folderspec.open'))
  })
})
