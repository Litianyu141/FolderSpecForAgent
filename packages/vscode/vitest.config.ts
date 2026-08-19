import { defineConfig } from 'vitest/config'

// src/test/** 是 @vscode/test-electron 的 Mocha E2E 套件（`pnpm test:e2e`），运行在真实
// VSCode 扩展宿主里，会 import 'vscode'——vitest 环境下没有这个模块，必须排除，否则
// `pnpm test` 会把它当普通单测收集进来并因解析 'vscode' 失败而炸。
export default defineConfig({ test: { include: ['src/**/*.test.ts'], exclude: ['src/test/**'] } })
