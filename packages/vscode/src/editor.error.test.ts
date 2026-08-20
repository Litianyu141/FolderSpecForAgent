import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import type { WireError } from '@folderspec/core'

/**
 * VSCode 宿主的错误回传：SpecError 必须带着 code/params 过 postMessage，
 * 而不是被压成一句 `e.message`。
 *
 * 为什么单开一个文件而不是并进 editor.test.ts：`vi.mock('vscode', …)` 是**整个文件**
 * 一份，editor.test.ts 里那份是空对象（它只测 shouldSwitchSession 这个纯函数，
 * 只需要模块能被 import 进来），撑不起 resolveCustomTextEditor 一次真实运行。
 * 也不并进 editor.dirty.test.ts：那个文件记的是 dirty 记账那条缺陷，与本轮无关。
 *
 * 替身按 editor.dirty.test.ts 的同款做法搭：只放 resolveCustomTextEditor 这一条
 * 路径真正会碰到的成员。这里不走 spec/save 分支，所以不需要 WorkspaceEdit。
 */
vi.mock('vscode', () => ({
  Uri: {
    joinPath: (base: { fsPath: string }, ...segs: string[]) => {
      const fsPath = [base.fsPath, ...segs].join('/')
      return { fsPath, toString: () => `fake://${fsPath}` }
    },
  },
  workspace: {
    getWorkspaceFolder: () => undefined,
    onDidChangeTextDocument: () => ({ dispose(): void {} }),
    fs: {
      readFile: async () => new TextEncoder().encode('<!doctype html><html><head></head><body></body></html>'),
    },
  },
}))

const { FolderSpecEditorProvider } = await import('./editor.js')

interface PostedMessage {
  id?: number
  ok?: boolean
  result?: unknown
  error?: WireError
}

const tempDirs: string[] = []
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(nodePath.join(tmpdir(), 'folderspec-vscode-err-'))
  tempDirs.push(dir)
  return dir
}

/** 撑起 resolveCustomTextEditor 一次运行所需要的最小 panel / document 替身 */
function makeHarness(fixtureRoot: string) {
  const posted: PostedMessage[] = []
  let receiveHandler: ((msg: unknown) => Promise<void>) | null = null

  const docPath = nodePath.join(fixtureRoot, '.folderspec.md')
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
      postMessage: (m: unknown) => { posted.push(m as PostedMessage) },
      onDidReceiveMessage: (cb: (msg: unknown) => Promise<void>) => {
        receiveHandler = cb
        return { dispose(): void {} }
      },
    },
    onDidDispose: () => {},
  }

  return {
    document,
    panel,
    posted,
    send: async (msg: { id: number; method: string; params: unknown }) => {
      await receiveHandler!(msg)
      const res = posted.find(m => m.id === msg.id)
      if (!res) throw new Error(`未收到 id=${msg.id} 的响应`)
      return res
    },
  }
}

describe('VSCode 宿主：错误按 WireError 回传', () => {
  it('SpecError 带着 code 与 params 过 postMessage，webview 才可能按语言翻译它', async () => {
    const fixtureRoot = await makeTempDir()
    const provider = new FolderSpecEditorProvider({ extensionUri: { fsPath: fixtureRoot }, subscriptions: [] } as never)
    const { document, panel, send } = makeHarness(fixtureRoot)

    await provider.resolveCustomTextEditor(document as never, panel as never, {} as never)
    await send({ id: 1, method: 'workspace/open', params: { root: fixtureRoot } })

    // 名字 ".." 在文件系统里有特殊含义，core 的 assertValidNodeName 会拒绝它
    const res = await send({ id: 2, method: 'spec/createNode', params: { parentPath: '', name: '..', isDir: true } })

    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe('name.reserved')
    // params 是**数据**（那个非法名字本身），不是渲染好的措辞——UI 拿它代进中文模板
    expect(res.error?.params).toEqual({ name: '..' })
    // message 仍然必填：不做翻译的消费者照旧有一句英文可读
    expect(res.error?.message).toContain('may not be named')
  })

  it('不是 SpecError 的失败只有一句 message，没有 code——那是我们自己的 bug，翻译它没有意义', async () => {
    const fixtureRoot = await makeTempDir()
    const provider = new FolderSpecEditorProvider({ extensionUri: { fsPath: fixtureRoot }, subscriptions: [] } as never)
    const { document, panel, send } = makeHarness(fixtureRoot)

    await provider.resolveCustomTextEditor(document as never, panel as never, {} as never)

    // Api 里根本没有这个方法名：只有调用方违约才可能触达，core 保持普通 Error
    const res = await send({ id: 1, method: 'no/such/method', params: {} })

    expect(res.ok).toBe(false)
    expect(res.error?.message).toContain('未知方法')
    expect(res.error?.code).toBeUndefined()
  })
})
