import * as assert from 'node:assert/strict'
import * as fsPromises from 'node:fs/promises'
import * as nodePath from 'node:path'
import * as vscode from 'vscode'

// 已知局限：完整走通 spec/save 需要从 webview 内部发消息，而 @vscode/test-electron
// 的 harness 无法驱动 webview 内的脚本。因此这里只能验证"自定义编辑器确实接管了、
// 文件没被破坏、UI 产物存在"，保存链路本身由 packages/vscode 的单元测试与
// editor.e2e.test.ts（用打桩的 vscode 模块加载真实打包产物）覆盖。
const EXTENSION_ID = 'folderspec.folderspec-vscode'

suite('FolderSpec 冒烟测试', () => {
  test('打开 .folderspec.md 时由自定义编辑器接管，且不会破坏文件内容', async () => {
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

    // 真正具有区分度的断言：当前活动的 tab 必须是 viewType 为 folderspec.editor 的
    // 自定义编辑器。如果 registerCustomEditorProvider 没注册成功、
    // resolveCustomTextEditor 内部抛了异常、或者 VSCode 因为某种原因回退成了普通文本
    // 编辑器，这里都会失败——而仅靠"文件内容没变"是测不出这些的。
    const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs)
    const custom = tabs.find(t => t.input instanceof vscode.TabInputCustom
      && (t.input as vscode.TabInputCustom).viewType === 'folderspec.editor')
    assert.ok(custom, '未找到 viewType 为 folderspec.editor 的自定义编辑器标签页')

    // 文档仍可被正常读取，内容未被破坏（这只证明"打开"本身无害，不证明"保存"能工作）
    const doc = await vscode.workspace.openTextDocument(specUri)
    assert.ok(doc.getText().includes('- `src/` — 初始注释'))

    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  })

  test('folderspec.open 命令已注册', async () => {
    const all = await vscode.commands.getCommands(true)
    assert.ok(all.includes('folderspec.open'))
  })

  test('UI 产物（media/ui/index.html）已随扩展一起打包', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID)
    assert.ok(ext, `未找到扩展 ${EXTENSION_ID}，无法定位其安装路径`)

    // 路径相对扩展自身的安装位置解析，而不是硬编码仓库相对路径——这里跑的是
    // extensionDevelopmentPath 指向的真实扩展目录，和 editor.ts 里
    // `Uri.joinPath(this.context.extensionUri, 'media', 'ui')` 用的是同一个根。
    const indexPath = nodePath.join(ext.extensionPath, 'media', 'ui', 'index.html')
    const html = await fsPromises.readFile(indexPath, 'utf8')
    assert.ok(
      /<script[^>]*src=/.test(html),
      `media/ui/index.html 存在但没找到 <script src=...> 引用；copy-ui.mjs 或 vite build 可能没有正确执行。内容开头：${html.slice(0, 200)}`,
    )
  })
})
