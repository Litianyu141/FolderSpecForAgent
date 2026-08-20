import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * 复现评审指出的窄路径（session.ts 的 save()）：save() 内部是"raw() → await
 * fs.writeFile → savedRevision = 此刻的 revision"。两个宿主的消息回调都不排队
 * （cli/src/server.ts 的 `socket.on('message', async ...)`、vscode/src/editor.ts 的
 * `onDidReceiveMessage`），若一笔新的 spec/annotate 恰好落在那段 await 里，
 * this.revision 已经被它推进；修复前的写法在 await 结束后直接读"此刻的
 * this.revision"去记账，会把这笔从未落盘的新编辑也算作"已保存"——脏标记假熄灭，
 * 用户以为存好了、关窗即丢，正是本工具唯一要严防的那种伤害。
 *
 * 这里用 vi.mock 卡住 fs.writeFile，在它还没返回时同步插入一次 annotate()，
 * 精确复现"消息回调不排队，编辑落在 await 期间"这个真实触发条件——不是随便找个
 * 地方 setTimeout，而是让 save() 真的挂在它自己的 await 上时去改 revision。
 *
 * 只替换 writeFile，其余 fs/promises 函数走 importOriginal 的真实实现：
 * Session.open() 仍需要真的扫真实目录、读真实文件。
 */
const state = vi.hoisted(() => ({
  gate: null as Promise<void> | null,
}))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (state.gate) await state.gate
      return actual.writeFile(...args)
    },
  }
})

const fs = await import('node:fs/promises')
const os = await import('node:os')
const nodePath = await import('node:path')
const { Session } = await import('./session.js')

let root: string

beforeEach(async () => {
  state.gate = null
  root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'folderspec-save-race-'))
})

afterEach(async () => {
  state.gate = null
  await fs.rm(root, { recursive: true, force: true })
})

describe('save() 的 await fs.writeFile 期间落地一笔新编辑', () => {
  it('保存完成后 dirty 仍为 true——不能把没写进磁盘的那一版标记成已保存', async () => {
    const s = new Session(root)
    await s.open()
    s.annotate({ path: 'a', isDir: false, annotation: '第一版' })

    let release!: () => void
    state.gate = new Promise<void>(resolve => { release = resolve })

    const savePromise = s.save()
    // save() 内部的 rawForSave() 是纯同步调用，此刻已经跑完、捕获了那一刻的
    // revision；执行流卡在 await fs.writeFile 里——这正是两个宿主的消息回调
    // 都不排队时，一笔新消息真正会插进来的那个窗口。
    s.annotate({ path: 'a', isDir: false, annotation: '第二版——保存期间落地，从未写盘' })

    release()
    await savePromise

    // 磁盘上写的是"第一版"；内存里当前是"第二版"——两者不一致，dirty 必须是 true。
    expect(s.isDirty()).toBe(true)
  })
})
