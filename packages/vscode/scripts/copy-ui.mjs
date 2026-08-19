import { cp, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const from = resolve(here, '../../ui/dist')
const to = resolve(here, '../media/ui')
await mkdir(dirname(to), { recursive: true })
await cp(from, to, { recursive: true })
console.log(`已复制 UI 产物：${from} → ${to}`)
