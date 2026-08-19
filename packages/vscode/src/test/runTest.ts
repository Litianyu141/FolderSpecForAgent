import * as fs from 'node:fs'
import * as nodePath from 'node:path'
import * as os from 'node:os'
import { runTests } from '@vscode/test-electron'

async function main(): Promise<void> {
  const extensionDevelopmentPath = nodePath.resolve(__dirname, '../../')
  const extensionTestsPath = nodePath.resolve(__dirname, './suite/index')

  // 每次运行都用一个唯一目录（而不是固定的 folderspec-e2e），这样上一次失败运行
  // 残留的 .folderspec.md 不会让下一次运行意外地通过或失败。
  const workspace = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'folderspec-e2e-'))
  // 给 fixture 一个真实存在、有内容的子目录，让工作区看起来像一个真正的小仓库，
  // 而不是一个空文件夹。
  fs.mkdirSync(nodePath.join(workspace, 'src'), { recursive: true })
  fs.writeFileSync(
    nodePath.join(workspace, 'src', 'index.ts'),
    'export const hello = "folderspec e2e fixture"\n',
  )

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [workspace, '--disable-extensions'],
    })
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
}

void main().catch((e: unknown) => {
  console.error('E2E 测试运行失败', e)
  process.exit(1)
})
