import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { Session, SPEC_FILENAME } from './session.js'
import { parseSpec } from './parse/index.js'
import type { ViewNode } from './types.js'

let root: string

const find = (n: ViewNode, path: string): ViewNode | null => {
  if (n.path === path) return n
  for (const c of n.children ?? []) {
    const hit = find(c, path)
    if (hit) return hit
  }
  return null
}

beforeEach(async () => {
  root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'folderspec-session-'))
  await fs.mkdir(nodePath.join(root, 'src/core'), { recursive: true })
  await fs.mkdir(nodePath.join(root, 'src/deep/deeper'), { recursive: true })
  await fs.writeFile(nodePath.join(root, 'README.md'), '')
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('Session.open', () => {
  it('无契约文件时以空 spec 打开', async () => {
    const s = new Session(root)
    const r = await s.open()
    expect(r.hasSpec).toBe(false)
    expect(r.parseErrors).toBeNull()
    expect(r.specPath).toBe(nodePath.join(root, SPEC_FILENAME))
    expect(find(r.tree, 'src')?.origin).toBe('actual-only')
  })

  it('读取已存在的契约文件并合成注释', async () => {
    await fs.writeFile(nodePath.join(root, SPEC_FILENAME), [
      '---', 'folderspec: 1', 'root: .', 'ownership: human', '---',
      '', '# T', '', '## 结构', '', '- `src/` — 核心源码', '',
    ].join('\n'))
    const r = await new Session(root).open()
    expect(r.hasSpec).toBe(true)
    expect(find(r.tree, 'src')?.annotation).toBe('核心源码')
    expect(find(r.tree, 'src')?.origin).toBe('both')
  })

  it('契约文件解析失败时进入只读模式，不清空数据，树仍反映真实磁盘内容', async () => {
    await fs.writeFile(nodePath.join(root, SPEC_FILENAME), '不是合法的契约文件\n')
    const s = new Session(root)
    const r = await s.open()
    expect(r.parseErrors).not.toBeNull()
    expect(r.parseErrors![0].line).toBe(1)
    // 解析失败不等于"什么都没有"：磁盘上真实存在的 src 目录必须仍然出现在树里，
    // 只是不会带上（读不出来的）契约注释。
    expect(find(r.tree, 'src')).not.toBeNull()
    expect(find(r.tree, 'src')?.origin).toBe('actual-only')
    expect(() => s.annotate({ path: 'src', isDir: true, annotation: 'x' })).toThrow('只读模式')
    await expect(s.save()).rejects.toThrow('只读模式')
  })

  it('契约文件解析失败时 raw() 也抛错，绝不能返回空契约掩盖用户原文件', async () => {
    await fs.writeFile(nodePath.join(root, SPEC_FILENAME), '不是合法的契约文件\n')
    const s = new Session(root)
    await s.open()
    expect(() => s.raw()).toThrow('只读模式')
  })
})

describe('Session 未 open 时的防御性检查', () => {
  it('save 在未 open 时抛错，且绝不覆盖磁盘上已有的契约文件', async () => {
    const original = [
      '---', 'folderspec: 1', 'root: .', 'ownership: human', '---',
      '', '# 已有契约', '', '## 结构', '', '- `src/` — 人类写的注释', '',
    ].join('\n')
    await fs.writeFile(nodePath.join(root, SPEC_FILENAME), original)

    const s = new Session(root)
    await expect(s.save()).rejects.toThrow('尚未打开')

    const after = await fs.readFile(nodePath.join(root, SPEC_FILENAME), 'utf8')
    expect(after).toBe(original)
  })

  it('tree 在未 open 时抛错，而不是返回一棵看似合理实则为空的假树', () => {
    const s = new Session(root)
    expect(() => s.tree()).toThrow('尚未打开')
  })
})

describe('Session 编辑与保存', () => {
  it('写注释后树上立即可见，且标记为 dirty', async () => {
    const s = new Session(root)
    await s.open()
    const r = s.annotate({ path: 'src', isDir: true, annotation: '核心源码', role: 'source-root' })
    expect(r.dirty).toBe(true)
    expect(find(r.tree, 'src')?.annotation).toBe('核心源码')
    expect(find(r.tree, 'src')?.role).toBe('source-root')
  })

  it('save 把契约写到磁盘且内容可被重新解析', async () => {
    const s = new Session(root)
    await s.open()
    s.annotate({ path: 'src/core', isDir: true, annotation: '内核' })
    const { written } = await s.save()
    expect(written).toBe(true)

    const text = await fs.readFile(nodePath.join(root, SPEC_FILENAME), 'utf8')
    const back = parseSpec(text)
    expect(back.ok).toBe(true)
    expect(text).toContain('- `core/` — 内核')
  })

  it('save 之后 dirty 复位', async () => {
    const s = new Session(root)
    await s.open()
    s.annotate({ path: 'src', isDir: true, annotation: 'x' })
    await s.save()
    expect(s.isDirty()).toBe(false)
  })

  it('save 只写契约文件，不碰任何其他路径', async () => {
    const before = (await fs.readdir(root)).sort()
    const s = new Session(root)
    await s.open()
    s.annotate({ path: 'src', isDir: true, annotation: 'x' })
    await s.save()
    const after = (await fs.readdir(root)).sort()
    expect(after).toEqual([...before, SPEC_FILENAME].sort())
  })

  it('拖拽后旧位置在当次会话中隐藏，新位置出现', async () => {
    await fs.mkdir(nodePath.join(root, 'examples/foo'), { recursive: true })
    const s = new Session(root)
    await s.open()
    const r = s.move({ from: 'examples/foo', toParent: 'src/cases', isDir: true })
    expect(find(r.tree, 'examples/foo')).toBeNull()
    expect(find(r.tree, 'src/cases/foo')?.origin).toBe('spec-only')
  })

  it('隐藏状态是临时的：同一个 Session reload() 后旧位置重新出现', async () => {
    await fs.mkdir(nodePath.join(root, 'examples/foo'), { recursive: true })
    const s = new Session(root)
    await s.open()
    s.move({ from: 'examples/foo', toParent: 'src/cases', isDir: true })
    await s.save()

    // 关键：复用同一个 s 实例调用 reload()，而不是 new 一个新 Session。
    // hidden 是这个实例的私有状态；只有复用同一个实例，"reload 之后 hidden 被清空"
    // 这件事才有机会被测出来——换一个新实例的话，它的 hidden 天生就是空的，
    // 测试对 open() 里有没有 this.hidden.clear() 完全没有区分力。
    const r = await s.reload()
    expect(find(r.tree, 'examples/foo')?.origin).toBe('actual-only')
    expect(find(r.tree, 'src/cases/foo')?.origin).toBe('spec-only')
  })
})

describe('Session 输入校验', () => {
  it('注释里的换行被归一化为空格，写盘后仍可解析', async () => {
    const s = new Session(root)
    await s.open()
    const r = s.annotate({ path: 'src', isDir: true, annotation: '一行\n二行' })
    expect(find(r.tree, 'src')?.annotation).toBe('一行 二行')

    const { written } = await s.save()
    expect(written).toBe(true)
    const text = await fs.readFile(nodePath.join(root, SPEC_FILENAME), 'utf8')
    expect(parseSpec(text).ok).toBe(true)
  })

  it('role 中含 "]" 时被拒绝，报错信息点名字段', async () => {
    const s = new Session(root)
    await s.open()
    expect(() => s.annotate({ path: 'src', isDir: true, role: 'a]b' })).toThrow('role')
  })

  it('role 中含反引号时也被拒绝', async () => {
    const s = new Session(root)
    await s.open()
    expect(() => s.annotate({ path: 'src', isDir: true, role: 'a`b' })).toThrow('role')
  })

  it('template 中含空白字符时被拒绝，报错信息点名字段', async () => {
    const s = new Session(root)
    await s.open()
    expect(() => s.annotate({ path: 'src', isDir: true, template: 'a b' })).toThrow('template')
  })
})

describe('Session.expand', () => {
  it('展开后原本 undefined 的子层被填充', async () => {
    const s = new Session(root)
    const r0 = await s.open()
    expect(find(r0.tree, 'src/deep')?.children).toBeUndefined()
    const tree = await s.expand('src/deep')
    expect(find(tree, 'src/deep/deeper')).not.toBeNull()
  })

  it('展开把 unscanned 的 spec 节点重新解析为 spec-only', async () => {
    const s = new Session(root)
    await s.open()
    s.annotate({ path: 'src/deep/ghost', isDir: true, annotation: '不存在' })
    expect(find(s.tree(), 'src/deep/ghost')?.origin).toBe('unscanned')
    const tree = await s.expand('src/deep')
    expect(find(tree, 'src/deep/ghost')?.origin).toBe('spec-only')
  })
})

describe('Session.handle', () => {
  it('按方法名分发，供两个宿主复用', async () => {
    const s = new Session(root)
    const opened = await s.handle('workspace/open', { root })
    expect((opened as { hasSpec: boolean }).hasSpec).toBe(false)
    const annotated = await s.handle('spec/annotate', { path: 'src', isDir: true, annotation: 'x' })
    expect((annotated as { dirty: boolean }).dirty).toBe(true)
  })

  it('未知方法名抛错', async () => {
    const s = new Session(root)
    await expect(s.handle('nope' as never, {} as never)).rejects.toThrow('未知方法')
  })

  it('handle() 能正确分发全部 7 个 Api 方法', async () => {
    const s = new Session(root)

    const opened = await s.handle('workspace/open', { root })
    expect((opened as { hasSpec: boolean }).hasSpec).toBe(false)

    const got = await s.handle('tree/get', {})
    expect((got as { tree: ViewNode }).tree.path).toBe('')

    const expanded = await s.handle('tree/expand', { path: 'src/deep' })
    expect(find((expanded as { tree: ViewNode }).tree, 'src/deep/deeper')).not.toBeNull()

    const annotated = await s.handle('spec/annotate', { path: 'src', isDir: true, annotation: 'x' })
    expect((annotated as { dirty: boolean }).dirty).toBe(true)
    expect(find((annotated as { tree: ViewNode }).tree, 'src')?.annotation).toBe('x')

    const moved = await s.handle('spec/move', { from: 'README.md', toParent: 'src', isDir: false })
    expect(find((moved as { tree: ViewNode }).tree, 'README.md')).toBeNull()
    expect(find((moved as { tree: ViewNode }).tree, 'src/README.md')).not.toBeNull()

    const raw = await s.handle('spec/raw', {})
    expect((raw as { markdown: string }).markdown).toContain('- `src/` — x')

    const saved = await s.handle('spec/save', {})
    expect((saved as { written: boolean }).written).toBe(true)
  })
})
