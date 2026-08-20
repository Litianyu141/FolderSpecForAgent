import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'

/**
 * 这是「真缺陷」的回归测试：VSCode 宿主的 spec/save 分支不走 Session.save()，
 * 自己用 WorkspaceEdit 把 session.raw() 写进文档；Session 撤销栈引入之后
 * dirty 语义从"有没有编辑过"升级成"revision 是否等于 savedRevision"，而这条
 * 写路径从不推进 savedRevision——保存成功之后，只要再有一次编辑，dirty 就再
 * 也回不到 false，哪怕撤销回了恰好保存过的那一步。
 *
 * 用 vi.mock('vscode', ...) 撑起一个轻量替身，而不是像 editor.e2e.test.ts 那样
 * 用 esbuild 打包再 require——这里只关心"消息处理链路里 dirty 记账对不对"，不
 * 涉及打包产物本身，vi.mock 已经够用且更快。用 vi.hoisted 声明的可变状态记录
 * WorkspaceEdit 实际收到的文本，用来确认"写盘"这一步真的发生过。
 */

const state = vi.hoisted(() => ({
  writtenTexts: [] as string[],
  applyEditCalls: 0,
  documentSaveCalls: 0,
}))

vi.mock('vscode', () => ({
  Uri: {
    joinPath: (base: { fsPath: string }, ...segs: string[]) => {
      const fsPath = [base.fsPath, ...segs].join('/')
      return { fsPath, toString: () => `fake://${fsPath}` }
    },
  },
  WorkspaceEdit: class {
    replace(_uri: unknown, _range: unknown, newText: string): void {
      state.writtenTexts.push(newText)
    }
  },
  Range: class {
    constructor(readonly start: unknown, readonly end: unknown) {}
  },
  workspace: {
    getWorkspaceFolder: () => undefined,
    onDidChangeTextDocument: () => ({ dispose(): void {} }),
    fs: {
      readFile: async () => new TextEncoder().encode('<!doctype html><html><head></head><body></body></html>'),
    },
    applyEdit: async () => {
      state.applyEditCalls += 1
      return true
    },
  },
}))

const { FolderSpecEditorProvider } = await import('./editor.js')

interface PostedMessage {
  id?: number
  ok?: boolean
  result?: { dirty?: boolean; written?: boolean }
  error?: string
}

const tempDirs: string[] = []
afterEach(async () => {
  state.writtenTexts = []
  state.applyEditCalls = 0
  state.documentSaveCalls = 0
  await Promise.all(tempDirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(nodePath.join(tmpdir(), 'folderspec-vscode-dirty-'))
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
    save: async () => {
      state.documentSaveCalls += 1
      return true
    },
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

describe('VSCode 宿主：spec/save 走 WorkspaceEdit 之后 dirty 记账要跟得上', () => {
  it('保存后撤销回到保存时的状态，dirty 必须熄灭', async () => {
    const fixtureRoot = await makeTempDir()
    const provider = new FolderSpecEditorProvider({ extensionUri: { fsPath: fixtureRoot }, subscriptions: [] } as never)
    const { document, panel, send } = makeHarness(fixtureRoot)

    await provider.resolveCustomTextEditor(document as never, panel as never, {} as never)

    await send({ id: 1, method: 'workspace/open', params: { root: fixtureRoot } })

    // 第一次编辑：revision 前进到 R1
    await send({ id: 2, method: 'spec/annotate', params: { path: 'a', isDir: false, annotation: '第一次' } })

    // 保存：VSCode 宿主自己的 WorkspaceEdit 写入路径，不经过 Session.save()
    const saveResp = await send({ id: 3, method: 'spec/save', params: {} })
    expect(saveResp.ok).toBe(true)
    expect(saveResp.result?.written).toBe(true)
    // 保存期间没有任何并发编辑插进来：dirty 必须如实回报 false，而不是留空让
    // webview 端的 UI 去猜（api.ts SaveResult.dirty 上有完整推导）。
    expect(saveResp.result?.dirty).toBe(false)
    // 写入路径确实被触发了——否则下面的断言就算通过也证明不了 markSaved 生效
    expect(state.writtenTexts.length).toBe(1)
    expect(state.applyEditCalls).toBe(1)
    expect(state.documentSaveCalls).toBe(1)

    // 第二次编辑：revision 前进到 R2，此时理应 dirty
    const secondEdit = await send({ id: 4, method: 'spec/annotate', params: { path: 'a', isDir: false, annotation: '第二次' } })
    expect(secondEdit.result?.dirty).toBe(true)

    // 撤销第二次编辑，回到"保存时那一刻"的状态（revision = R1）——
    // 这正是保存成功之后磁盘上的内容，dirty 必须归零。
    // 缺陷现场：savedRevision 卡在 open() 时的 R0，这里会读到 true。
    const undoResp = await send({ id: 5, method: 'spec/undo', params: {} })
    expect(undoResp.result?.dirty).toBe(false)
  })
})
