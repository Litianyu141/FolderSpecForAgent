import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const from = resolve(here, '../../ui/dist')
const to = resolve(here, '../media/ui')
// 先整个删掉再复制：vite 的产物文件名带内容哈希（index-<hash>.js），每次内容一变就是
// 一个新文件名，而 cp 只添不删——历次构建的旧产物会无限堆积在这里。它们既不被
// index.html 引用、也永远不会被加载，却会原样进入分发物：修这条之前 .vsix 里躺着
// 15 个 bundle 只用得上 2 个，cli 的 dist 更是攒到了 38 个 / 7.4MB。
// 目标目录整个是构建产物，删掉没有任何可丢的东西。
await rm(to, { recursive: true, force: true })
await mkdir(dirname(to), { recursive: true })
await cp(from, to, { recursive: true })
console.log(`已复制 UI 产物：${from} → ${to}`)
