import { cp, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 把 ui 的构建产物复制进 cli 的 dist，避免运行时依赖包解析
const here = dirname(fileURLToPath(import.meta.url))
const from = resolve(here, '../../ui/dist')
const to = resolve(here, '../dist/ui')
await mkdir(dirname(to), { recursive: true })
await cp(from, to, { recursive: true })
console.log(`已复制 UI 产物：${from} → ${to}`)
