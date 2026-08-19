import * as nodePath from 'node:path'
import { glob } from 'glob'
import Mocha from 'mocha'

export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 60_000 })
  const testsRoot = __dirname
  const files = await glob('**/*.test.js', { cwd: testsRoot })
  if (files.length === 0) {
    throw new Error(`未在 ${testsRoot} 下找到任何 *.test.js，测试套件不能静默通过 0 个测试`)
  }
  for (const f of files) {
    mocha.addFile(nodePath.resolve(testsRoot, f))
  }
  await new Promise<void>((resolve, reject) => {
    mocha.run(failures => (failures > 0 ? reject(new Error(`${failures} 个测试失败`)) : resolve()))
  })
}
