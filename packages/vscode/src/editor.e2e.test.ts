import { describe, it, expect, afterEach } from 'vitest'
import { build as esbuildBuild } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import Module from 'node:module'
import { emptySpec, serializeSpec, SPEC_FILENAME } from '@folderspec/core'

/**
 * 这是 Finding 1 的回归测试：VSCode 宿主曾经在几乎每次打开时都会丢弃刚初始化好的
 * 正确 Session，换成一个 root 完全无关的错误 Session——一旦用户在错误的树上保存，
 * session.raw() 吐出的近乎空契约会经 WorkspaceEdit 原样盖到用户真实的 .folderspec.md
 * 上。这类 bug 只在"真实打包产物 + 真实消息时序"下才会现形：source-level 单测
 * （editor.test.ts 里的 shouldSwitchSession）只保证纯函数本身逻辑对，不能保证它真的
 * 被接到了消息处理链路上、也不能保证 esbuild 打包不会把什么东西搞坏。所以这里复用
 * task-16 报告里验证过的技术——用 esbuild 把 src/extension.ts 打成和真实 build 完全
 * 一样的单文件 CJS bundle，用 Module._load 给外部的 'vscode' 打桩（VSCode 扩展宿主
 * 就是这样把这个模块注入进去的），require() 这个真实 bundle，跑通 activate() 拿到
 * 真正的 FolderSpecEditorProvider，对一个磁盘上真实存在、带真实 .folderspec.md 的
 * fixture 工作区跑 resolveCustomTextEditor()，再送一条和 bug 现场完全一样的
 * workspace/open 消息（root: '.'，模拟"根注入这一层防线万一失效"的场景），断言
 * session 仍然是 fixture 工作区的那个，而不是被换成了跑测试的这个进程的 cwd。
 */

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(nodePath.join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** 和 package.json 的 build 脚本完全一样的打包命令，只是输出到临时目录 */
async function bundleExtension(): Promise<string> {
  const here = nodePath.dirname(fileURLToPath(import.meta.url))
  const outDir = await makeTempDir('folderspec-vscode-bundle-')
  const outfile = nodePath.join(outDir, 'extension.js')
  await esbuildBuild({
    entryPoints: [nodePath.join(here, 'extension.ts')],
    bundle: true,
    outfile,
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
  })
  return outfile
}

interface PostedMessage {
  id?: number
  ok?: boolean
  result?: { root?: string; hasSpec?: boolean }
  error?: string
}

interface CustomTextEditorProviderLike {
  resolveCustomTextEditor(doc: unknown, panel: unknown, token: unknown): Promise<void>
}

/** 跨 fakeModule 的闭包与测试主体共享的可变状态——比一堆 getter/setter 更直白 */
interface FakeVscodeState {
  provider: CustomTextEditorProviderLike | null
  receiveHandler: ((msg: unknown) => Promise<void>) | null
  posted: PostedMessage[]
}

/** 一个刚好够撑起 resolveCustomTextEditor 跑完一次 workspace/open 往返的最小 vscode 替身 */
function makeFakeVscodeModule(fixtureRoot: string, state: FakeVscodeState): Record<string, unknown> {
  return {
    Uri: {
      joinPath: (base: { fsPath: string }, ...segs: string[]) => {
        const fsPath = nodePath.join(base.fsPath, ...segs)
        return { fsPath, toString: () => `fake://${fsPath}` }
      },
    },
    WorkspaceEdit: class {
      replace(): void {}
    },
    Range: class {
      constructor(readonly start: unknown, readonly end: unknown) {}
    },
    window: {
      registerCustomEditorProvider: (_viewType: string, provider: CustomTextEditorProviderLike) => {
        state.provider = provider
        return { dispose(): void {} }
      },
      showErrorMessage: () => {},
      showInformationMessage: async () => undefined,
    },
    workspace: {
      workspaceFolders: [],
      // 这一步就是真实场景里"resolveCustomTextEditor 算出了正确 root"——
      // Finding 1 的要害在于算对了之后又被第一条消息给换掉。
      getWorkspaceFolder: () => ({ uri: { fsPath: fixtureRoot } }),
      onDidChangeTextDocument: () => ({ dispose(): void {} }),
      fs: {
        readFile: async () => new TextEncoder().encode('<!doctype html><html><head></head><body></body></html>'),
        stat: async () => { throw new Error('未使用') },
        writeFile: async () => {},
      },
      applyEdit: async () => true,
    },
    commands: {
      registerCommand: () => ({ dispose(): void {} }),
      executeCommand: async () => {},
    },
  }
}

/** 用真实 Node Module 机制给 'vscode' 打桩——和 VSCode 扩展宿主注入这个模块的方式一致 */
async function requireBundleWithFakeVscode(bundlePath: string, fakeModule: unknown): Promise<{ activate(ctx: unknown): void }> {
  const ModuleCtor = Module as unknown as {
    _resolveFilename: (request: string, ...rest: unknown[]) => string
    _load: (request: string, ...rest: unknown[]) => unknown
  }
  const origResolve = ModuleCtor._resolveFilename
  const origLoad = ModuleCtor._load
  ModuleCtor._resolveFilename = function (this: unknown, request: string, ...rest: unknown[]) {
    if (request === 'vscode') return 'vscode'
    return origResolve.apply(this, [request, ...rest])
  }
  ModuleCtor._load = function (this: unknown, request: string, ...rest: unknown[]) {
    if (request === 'vscode') return fakeModule
    return origLoad.apply(this, [request, ...rest])
  }
  try {
    const req = createRequire(import.meta.url)
    return req(bundlePath) as { activate(ctx: unknown): void }
  } finally {
    ModuleCtor._resolveFilename = origResolve
    ModuleCtor._load = origLoad
  }
}

describe('端到端回归：真实 bundle 中 workspace/open 携带占位根 "." 时不得偷换 Session', () => {
  it('resolveCustomTextEditor 算出的正确 fixture root 在处理完 workspace/open(root: ".") 后依然不变', async () => {
    const fixtureRoot = await makeTempDir('folderspec-fixture-')
    await writeFile(nodePath.join(fixtureRoot, SPEC_FILENAME), serializeSpec(emptySpec()), 'utf8')

    const bundlePath = await bundleExtension()

    const state: FakeVscodeState = { provider: null, receiveHandler: null, posted: [] }
    const fakeModule = makeFakeVscodeModule(fixtureRoot, state)
    const ext = await requireBundleWithFakeVscode(bundlePath, fakeModule)

    const context = { subscriptions: [], extensionUri: { fsPath: fixtureRoot } }
    ext.activate(context)

    expect(state.provider).toBeTruthy()

    const docPath = nodePath.join(fixtureRoot, SPEC_FILENAME)
    const document = {
      uri: { toString: () => `fake://${docPath}`, fsPath: docPath },
      getText: () => '',
      positionAt: () => ({}),
      save: async () => true,
    }
    const panel = {
      webview: {
        options: undefined as unknown,
        html: '',
        asWebviewUri: (uri: { toString(): string }) => ({ toString: () => `fake-webview://${uri.toString()}` }),
        cspSource: 'fake-webview:',
        postMessage: (m: unknown) => { state.posted.push(m as PostedMessage) },
        onDidReceiveMessage: (cb: (msg: unknown) => Promise<void>) => {
          state.receiveHandler = cb
          return { dispose(): void {} }
        },
      },
      onDidDispose: () => {},
    }

    await state.provider!.resolveCustomTextEditor(document, panel, {})

    expect(state.receiveHandler).toBeTruthy()

    // 和真实 bug 现场一样的一条消息：UI 没拿到注入的 root，退回了占位默认值 '.'
    await state.receiveHandler!({ id: 1, method: 'workspace/open', params: { root: '.' } })

    const response = state.posted.find(m => m.id === 1)
    expect(response?.ok).toBe(true)
    // 关键断言：root 必须还是 fixture 工作区，而不是被换成了这条测试进程自己的 cwd
    // （bug 复现时这里会变成 process.cwd()，hasSpec 也会因为那里没有 .folderspec.md 而是 false）
    expect(response?.result?.root).toBe(fixtureRoot)
    expect(response?.result?.hasSpec).toBe(true)
  })
})
