import * as fs from 'node:fs'
import * as nodePath from 'node:path'
import * as os from 'node:os'
import { runTests } from '@vscode/test-electron'

async function main(): Promise<void> {
  const extensionDevelopmentPath = nodePath.resolve(__dirname, '../../')
  const extensionTestsPath = nodePath.resolve(__dirname, './suite/index')

  const workspace = nodePath.join(os.tmpdir(), 'folderspec-e2e')
  fs.mkdirSync(nodePath.join(workspace, 'src'), { recursive: true })

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [workspace, '--disable-extensions'],
  })
}

void main().catch((e: unknown) => {
  console.error('E2E 测试运行失败', e)
  process.exit(1)
})
