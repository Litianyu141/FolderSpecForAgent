import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { Session, SPEC_FILENAME } from './session.js'
import { parseSpec } from './parse/index.js'
import type { Spec, ViewNode } from './types.js'

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

  it('契约文件存在但读不出来（EACCES）时进入只读模式，绝不当成"没有文件"覆盖掉', async () => {
    // root 能读任何文件，chmod 0200 对它不起作用——这条用例在 root 下会假绿。
    // 宁可响亮地失败，也不要静默 skip 掉一条守护"三个月标注"的用例。
    expect(
      process.getuid?.(),
      '这条用例必须以非 root 身份运行：root 无视文件权限位，chmod 0o200 造不出 EACCES，用例会假绿',
    ).not.toBe(0)

    const specPath = nodePath.join(root, SPEC_FILENAME)
    const original = [
      '---', 'folderspec: 1', 'root: .', 'ownership: human', '---',
      '', '# 已有契约', '', '## 结构', '', '- `src/` — 攒了三个月的注释', '',
    ].join('\n')
    await fs.writeFile(specPath, original)
    await fs.chmod(specPath, 0o200) // 只写不可读

    try {
      const s = new Session(root)
      const r = await s.open()

      // 读失败必须与解析失败同款：只读模式 + 说得清是哪个文件、什么 errno
      expect(r.parseErrors).not.toBeNull()
      expect(r.parseErrors!.map(e => e.message).join('')).toContain('EACCES')
      expect(r.parseErrors!.map(e => e.message).join('')).toContain(specPath)
      // 文件确实在那儿，只是读不出来——不能报告成"没有契约文件"
      expect(r.hasSpec).toBe(true)

      await expect(s.save()).rejects.toThrow('只读模式')
      expect(() => s.annotate({ path: 'src', isDir: true, annotation: 'x' })).toThrow('只读模式')
    } finally {
      await fs.chmod(specPath, 0o600)
    }

    // 最要紧的一条：磁盘上的字节一个都不能变
    expect(await fs.readFile(specPath, 'utf8')).toBe(original)
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

  // 复现用户报告的 bug：把 `.claude/commands` 拖了一下之后它就从界面上消失了——
  // 磁盘上文件还在、契约里也还声明着它，但 move() 无条件把 from 塞进 hidden，
  // 而拖回同一个父级时新旧路径相同，merge 在 actual 侧和 spec 侧会把它双双跳过。
  it('拖回原父级时节点不会从视图中消失', async () => {
    await fs.mkdir(nodePath.join(root, 'a/b'), { recursive: true })
    const s = new Session(root)
    await s.open()
    expect(find(s.tree(), 'a/b')).not.toBeNull() // 拖拽前：可见

    const r = s.move({ from: 'a/b', toParent: 'a', isDir: true })
    expect(find(r.tree, 'a/b')).not.toBeNull() // 拖回原父级后：仍然可见
  })

  it('移动到不同父级时旧位置仍然隐藏', async () => {
    await fs.mkdir(nodePath.join(root, 'a/b'), { recursive: true })
    const s = new Session(root)
    await s.open()
    const r = s.move({ from: 'a/b', toParent: 'c', isDir: true })
    expect(find(r.tree, 'a/b')).toBeNull()
    expect(find(r.tree, 'c/b')?.origin).toBe('spec-only')
  })

  // 相邻场景：先把节点拖到别的父级（旧位置 a/b 被记进 hidden），
  // 再把它从新位置拖回原父级。第二次 move() 的 from 是当前视图路径 'c/b'，
  // 不是磁盘上的真实路径 'a/b'；如果只管"新增 hidden"而不管"归还时撤销 hidden"，
  // 'a/b' 会一直留在 hidden 里——即使契约又把节点声明回了 a/b，
  // merge 仍然会在 actual 侧和 spec 侧同时把 a/b 跳过，节点第二次消失。
  it('先拖到新父级再拖回原父级，节点同样不会消失', async () => {
    await fs.mkdir(nodePath.join(root, 'a/b'), { recursive: true })
    const s = new Session(root)
    await s.open()

    s.move({ from: 'a/b', toParent: 'c', isDir: true })
    const r = s.move({ from: 'c/b', toParent: 'a', isDir: true })

    expect(find(r.tree, 'a/b')).not.toBeNull()
    expect(find(r.tree, 'c/b')).toBeNull()
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

describe('序列化自校验（两个宿主共用的写入闸门）', () => {
  /**
   * 闸门必须长在 raw() 上，不能只长在 save() 上。
   *
   * CLI 宿主走 save() 落盘；VSCode 宿主走 session.raw() + WorkspaceEdit 落盘
   * （editor.ts 的 'spec/save' 分支），压根不经过 save()。闸门只放在 save() 里，
   * 等于项目一半的写入没有任何校验。
   *
   * 这里刻意绕过 annotate() 的入参校验直接往内存 spec 里塞一个含反引号的节点名：
   * 被测的正是"万一坏数据从别的门进来了，落盘前这道闸门还在不在"。TypeScript 的
   * private 只在编译期存在，运行时可以直接够到这个字段。
   */
  const injectBadNode = (s: Session): void => {
    const internal = s as unknown as { spec: Spec }
    internal.spec.nodes.push({ name: 'we`ird', isDir: true, children: [] })
  }

  it('spec 里含反引号节点名时 raw() 抛错，而不是吐出一份解析不回来的契约', async () => {
    const s = new Session(root)
    await s.open()
    injectBadNode(s)
    expect(() => s.raw()).toThrow('自校验失败')
  })

  it('同样的情况下 save() 一个字节都不写', async () => {
    const specPath = nodePath.join(root, SPEC_FILENAME)
    const original = [
      '---', 'folderspec: 1', 'root: .', 'ownership: human', '---',
      '', '# 已有契约', '', '## 结构', '', '- `src/` — 人类写的注释', '',
    ].join('\n')
    await fs.writeFile(specPath, original)

    const s = new Session(root)
    await s.open()
    injectBadNode(s)

    await expect(s.save()).rejects.toThrow('自校验失败')
    expect(await fs.readFile(specPath, 'utf8')).toBe(original)
  })

  it('handle("spec/raw") 也走同一道闸门——VSCode 宿主的 WorkspaceEdit 取的就是它', async () => {
    const s = new Session(root)
    await s.open()
    injectBadNode(s)
    await expect(s.handle('spec/raw', {})).rejects.toThrow('自校验失败')
  })
})

describe('节点名可表示性（当前格式无法转义反引号与换行）', () => {
  it('annotate 的路径含反引号时抛错，且报错点名这条路径', async () => {
    const s = new Session(root)
    await s.open()
    expect(() => s.annotate({ path: 'src/we`ird', isDir: true, annotation: 'x' }))
      .toThrow('src/we`ird')
  })

  it('annotate 的路径含换行时同样被拒绝', async () => {
    const s = new Session(root)
    await s.open()
    expect(() => s.annotate({ path: 'src/a\nb', isDir: true, annotation: 'x' }))
      .toThrow('反引号或换行')
  })

  it('move 的源路径与目标父路径都要过这道校验', async () => {
    const s = new Session(root)
    await s.open()
    expect(() => s.move({ from: 'we`ird', toParent: 'src', isDir: true })).toThrow('we`ird')
    expect(() => s.move({ from: 'README.md', toParent: 'ba`d', isDir: false })).toThrow('ba`d')
  })

  it('拒绝之后 spec 保持干净：save() 仍然正常写盘', async () => {
    const s = new Session(root)
    await s.open()
    expect(() => s.annotate({ path: 'we`ird', isDir: true, annotation: 'x' })).toThrow()
    s.annotate({ path: 'src', isDir: true, annotation: '正常注释' })
    await s.save()
    const text = await fs.readFile(nodePath.join(root, SPEC_FILENAME), 'utf8')
    expect(parseSpec(text).ok).toBe(true)
    expect(text).toContain('- `src/` — 正常注释')
  })
})

describe('Session 的分组与文件读取', () => {
  it('setGroup 新建分组并返回自动 id', async () => {
    const s = new Session(root); await s.open()
    const r = s.setGroup({ id: null, members: ['src/core', 'src/deep'], text: '两个子目录' })
    expect(r.id).toBe('src')
    expect(r.dirty).toBe(true)
  })

  it('setGroup 透传 name，改名后返回新 id', async () => {
    const s = new Session(root); await s.open()
    const { id } = s.setGroup({ id: null, members: ['src'], text: 't' })
    const r = s.setGroup({ id, members: ['src'], name: '解析层' })
    expect(r.id).toBe('解析层')
  })

  it('setGroup 会把注释里的换行归一化为空格', async () => {
    const s = new Session(root); await s.open()
    s.setGroup({ id: null, members: ['src'], text: '一行\n二行' })
    expect(s.raw()).toContain('一行 二行')
  })

  it('deleteGroup 删除分组', async () => {
    const s = new Session(root); await s.open()
    const { id } = s.setGroup({ id: null, members: ['src'], text: 't' })
    s.deleteGroup(id)
    expect(s.raw()).not.toContain('## 分组')
  })

  it('只读模式下 setGroup 抛错', async () => {
    await fs.writeFile(nodePath.join(root, SPEC_FILENAME), '不是合法的契约文件\n')
    const s = new Session(root); await s.open()
    expect(() => s.setGroup({ id: null, members: ['src'], text: 't' })).toThrow('只读模式')
  })

  it('只读模式下仍可读取文件内容', async () => {
    await fs.writeFile(nodePath.join(root, SPEC_FILENAME), '不是合法的契约文件\n')
    await fs.writeFile(nodePath.join(root, 'README.md'), 'hello')
    const s = new Session(root); await s.open()
    expect(await s.readFile('README.md')).toEqual({ kind: 'text', text: 'hello' })
  })

  it('未 open 时 readFile 抛错', async () => {
    await expect(new Session(root).readFile('README.md')).rejects.toThrow('会话尚未打开')
  })

  it('readFile 拒绝越界路径', async () => {
    const s = new Session(root); await s.open()
    await expect(s.readFile('../../../etc/passwd')).rejects.toThrow(/不得包含 "\.\." 段/)
  })

  it('open 返回当前契约的全部分组', async () => {
    const s = new Session(root); await s.open()
    s.setGroup({ id: null, members: ['src/core', 'src/deep'], text: '两个子目录' })
    const r = await s.open()
    expect(r.groups).toEqual([])   // open 会重读磁盘，未保存的编辑不该出现
  })

  it('setGroup 的返回值里带上更新后的分组', async () => {
    const s = new Session(root); await s.open()
    const r = s.setGroup({ id: null, members: ['src/core', 'src/deep'], text: '两个子目录' })
    expect(r.groups).toHaveLength(1)
    expect(r.groups[0]).toMatchObject({ id: 'src', text: '两个子目录' })
  })

  it('交出去的是拷贝，改它不会污染 Spec', async () => {
    const s = new Session(root); await s.open()
    const r = s.setGroup({ id: null, members: ['src'], text: 't' })
    r.groups[0].text = '被外部改了'
    expect(s.raw()).toContain('t')
    expect(s.raw()).not.toContain('被外部改了')
  })

  it('annotate 的返回值也带 groups', async () => {
    const s = new Session(root); await s.open()
    s.setGroup({ id: null, members: ['src'], text: 't' })
    const r = s.annotate({ path: 'src', isDir: true, annotation: '注释' })
    expect(r.groups).toHaveLength(1)
  })

  it('handle 能分发全部三个新方法', async () => {
    const s = new Session(root); await s.open()
    // members 是单个顶层路径（无公共父目录），deriveGroupId 按既有规则回退为 'group'
    // （见 spec-edit.test.ts「成员都在根下时回退为 group」）；这里只关心 handle() 的分发。
    const g = await s.handle('spec/setGroup', { id: null, members: ['src'], text: 't' })
    expect((g as { id: string }).id).toBe('group')
    await s.handle('spec/deleteGroup', { id: 'group' })
    const f = await s.handle('file/read', { path: 'README.md' })
    expect((f as { kind: string }).kind).toBeDefined()
  })
})

describe('Session 的视图模式（原始结构 / 我的结构）', () => {
  it('默认是 spec 视图：树按契约里的结构合成', async () => {
    const s = new Session(root)
    await s.open()
    s.annotate({ path: 'src', isDir: true, annotation: '核心源码' })
    expect(find(s.tree(), 'src')?.annotation).toBe('核心源码')
  })

  it('setViewMode("disk") 后契约里的结构性重排不再生效：新位置消失，只按磁盘建树', async () => {
    await fs.mkdir(nodePath.join(root, 'examples/foo'), { recursive: true })
    const s = new Session(root)
    await s.open()
    s.move({ from: 'examples/foo', toParent: 'src/cases', isDir: true })
    // spec 视图：新位置可见（spec-only）——既有行为，先确认夹具本身有效
    expect(find(s.tree(), 'src/cases/foo')?.origin).toBe('spec-only')

    const r = s.setViewMode('disk')
    expect(r.mode).toBe('disk')
    expect(find(r.tree, 'src/cases/foo')).toBeNull() // 磁盘上根本没有这个路径
  })

  // 规则 2 的回归测试：必须真的触发一次拖拽（hidden 里真的记了一条旧位置），
  // 否则"忽略不忽略 hidden"这条判断在这条用例里没有任何区分力。
  it('规则2回归：disk 视图必须忽略 hidden——拖走的节点旧位置在磁盘视图里重新出现', async () => {
    await fs.mkdir(nodePath.join(root, 'examples/foo'), { recursive: true })
    const s = new Session(root)
    await s.open()
    expect(find(s.tree(), 'examples/foo')).not.toBeNull() // 拖拽前：可见

    s.move({ from: 'examples/foo', toParent: 'src/cases', isDir: true })
    // spec 视图：旧位置被 hidden 吞掉——先确认这条 hidden 真的生效了，
    // 否则下面 disk 视图"仍然可见"的断言即使实现忘了忽略 hidden 也会通过。
    expect(find(s.tree(), 'examples/foo')).toBeNull()

    const r = s.setViewMode('disk')
    expect(find(r.tree, 'examples/foo')).not.toBeNull()
    expect(find(r.tree, 'examples/foo')?.origin).toBe('actual-only')
  })

  // 规则 3 的强化回归：分组色点跟不跟着节点走，靠的是 spec-edit.ts 的 moveNode()
  // 内部调 rewriteGroupMembers 把 Group.members 里的旧路径重写成新路径——这条行为
  // 依赖另一个文件里的逻辑，比"未移动节点按路径显示分组"更值得单独钉一条测试。
  // 夹具必须真的把节点放进一个分组、再真的用 Session.move() 移动它，
  // 否则"移动后消失"这个判断没有意义（先用两条对照断言确认这两件事都发生了）。
  it('规则3强化：节点被移动后，旧路径在 disk 视图里不再带分组色点', async () => {
    await fs.mkdir(nodePath.join(root, 'examples/foo'), { recursive: true })
    const s = new Session(root)
    await s.open()

    const { id } = s.setGroup({ id: null, members: ['examples/foo'], text: '案例分组' })
    // 对照 1：确认夹具真的把节点放进了分组
    expect(find(s.tree(), 'examples/foo')?.groups).toEqual([id])

    s.move({ from: 'examples/foo', toParent: 'src/cases', isDir: true })

    // 对照 2：分组没有被误删，只是随节点一起被重新指向了新路径
    // （spec 视图里新位置是 spec-only，依旧带着 groups）——排除"分组整个消失"
    // 这种会让下面的断言空转的可能。
    expect(find(s.tree(), 'src/cases/foo')?.groups).toEqual([id])

    const r = s.setViewMode('disk')
    const foo = find(r.tree, 'examples/foo')
    expect(foo?.origin).toBe('actual-only')
    expect(foo?.groups).toBeUndefined()
  })

  it('切回 spec 视图后 hidden 重新生效', async () => {
    await fs.mkdir(nodePath.join(root, 'examples/foo'), { recursive: true })
    const s = new Session(root)
    await s.open()
    s.move({ from: 'examples/foo', toParent: 'src/cases', isDir: true })
    s.setViewMode('disk')

    const r = s.setViewMode('spec')
    expect(r.mode).toBe('spec')
    expect(find(r.tree, 'examples/foo')).toBeNull()
    expect(find(r.tree, 'src/cases/foo')?.origin).toBe('spec-only')
  })

  it('切换视图是纯显示操作：不产生写入、不置 dirty', async () => {
    const s = new Session(root)
    await s.open()
    expect(s.isDirty()).toBe(false)
    s.setViewMode('disk')
    expect(s.isDirty()).toBe(false)
    s.setViewMode('spec')
    expect(s.isDirty()).toBe(false)
  })

  // 规则 4 的回归测试：闸门必须长在 assertWritable() 上——annotate/move/setGroup/
  // deleteGroup/raw/save 全部经过它，两个宿主也都经过它，UI 不可能绕过去。
  it('规则4回归：disk 视图下所有写操作被拒绝，错误信息说明处于原始结构视图', async () => {
    const s = new Session(root)
    await s.open()
    s.setViewMode('disk')

    expect(() => s.annotate({ path: 'src', isDir: true, annotation: 'x' })).toThrow('原始结构')
    expect(() => s.move({ from: 'README.md', toParent: 'src', isDir: false })).toThrow('原始结构')
    expect(() => s.setGroup({ id: null, members: ['src'], text: 't' })).toThrow('原始结构')
    expect(() => s.deleteGroup('whatever')).toThrow('原始结构')
    expect(() => s.raw()).toThrow('原始结构')
    await expect(s.save()).rejects.toThrow('原始结构')
  })

  it('规则4：错误信息里带上如何退出只读状态的提示', async () => {
    const s = new Session(root)
    await s.open()
    s.setViewMode('disk')
    expect(() => s.annotate({ path: 'src', isDir: true, annotation: 'x' })).toThrow(/切回|退出/)
  })

  it('切回 spec 视图后写入恢复正常', async () => {
    const s = new Session(root)
    await s.open()
    s.setViewMode('disk')
    s.setViewMode('spec')
    const r = s.annotate({ path: 'src', isDir: true, annotation: '正常' })
    expect(r.dirty).toBe(true)
  })

  it('未 open 时 setViewMode 抛错，而不是静默接受', () => {
    const s = new Session(root)
    expect(() => s.setViewMode('disk')).toThrow('尚未打开')
  })

  it('handle("view/setMode") 分发正确，且后续写操作经同一 Session 被同样拦下', async () => {
    const s = new Session(root)
    await s.open()
    const r = await s.handle('view/setMode', { mode: 'disk' })
    expect((r as { mode: string }).mode).toBe('disk')
    await expect(s.handle('spec/annotate', { path: 'src', isDir: true, annotation: 'x' }))
      .rejects.toThrow('原始结构')
  })

  // viewMode 是用户的显示偏好，不是某次编辑的残留状态（与 hidden 不同类：hidden 在
  // open() 里显式 clear()，viewMode 故意不跟着重置）。旁边"隐藏状态是临时的：同一个
  // Session reload() 后旧位置重新出现"那条测试钉住了 hidden 该清空；这里补上对称的
  // 一条，钉住 viewMode 不该被清空——否则外部触发的一次后台 reload（比如检测到磁盘
  // 文件被 Agent 改了）会把用户正看着的「原始结构」视图悄悄切回「我的结构」。
  //
  // 必须复用同一个 Session 实例调用 reload()：换一个新 Session 的话它的 viewMode
  // 天生就是默认值 'spec'，测试对"open() 里有没有偷偷重置 viewMode"没有任何区分力
  // ——这与上面 hidden 那条测试选择复用同一实例的理由完全一样。
  //
  // 用两条独立信号确认 viewMode 真的还是 'disk'：树的形状（契约里已落盘的新位置
  // 依旧不出现）与写入闸门（disk 视图下应继续被拦下）——只要 viewMode 被悄悄重置，
  // 这两条会同时失效，不依赖其中任何一条本身的巧合。
  it('viewMode 不随 reload() 重置：同一个 Session reload() 后仍保持切换前选的视图', async () => {
    await fs.mkdir(nodePath.join(root, 'examples/foo'), { recursive: true })
    const s = new Session(root)
    await s.open()
    s.move({ from: 'examples/foo', toParent: 'src/cases', isDir: true })
    await s.save() // 落盘，保证 reload 后契约里仍然是"已移动"的状态

    s.setViewMode('disk')
    expect(find(s.tree(), 'src/cases/foo')).toBeNull() // 切换生效：先做一次对照

    const r = await s.reload()

    // 信号 1：树仍按磁盘建树
    expect(find(r.tree, 'src/cases/foo')).toBeNull()
    expect(find(r.tree, 'examples/foo')?.origin).toBe('actual-only')
    // 信号 2：写入仍被拦下
    expect(() => s.annotate({ path: 'src', isDir: true, annotation: 'x' })).toThrow('原始结构')
  })
})

// ---------------------------------------------------------------------------
// 撤销 / 重做
//
// CLAUDE.md 里「不需要 undo 栈、dry-run、回滚」那一句说的是**另一个问题**：本工具
// 永不改动磁盘上的文件，因此没有"操作把仓库弄坏了要回滚"这回事。这里的撤销栈解决的
// 是手滑——拖错了位置、注释写串了行，要能一步退回来。它只作用于内存里的 Spec 与
// hidden，一样一个字节都不写磁盘，只读铁律没有被动摇。
// 看到 CLAUDE.md 那句话时别顺手把这一整块删掉。
// ---------------------------------------------------------------------------
describe('Session 的撤销/重做', () => {
  it('撤销一次注释编辑：注释回到编辑前', async () => {
    const s = new Session(root); await s.open()
    s.annotate({ path: 'src', isDir: true, annotation: '核心源码' })
    const r = s.undo()
    expect(find(r.tree, 'src')?.annotation).toBeUndefined()
    expect(r.canUndo).toBe(false)
    expect(r.canRedo).toBe(true)
  })

  it('重做把撤销掉的编辑放回来', async () => {
    const s = new Session(root); await s.open()
    s.annotate({ path: 'src', isDir: true, annotation: '核心源码' })
    s.undo()
    const r = s.redo()
    expect(find(r.tree, 'src')?.annotation).toBe('核心源码')
    expect(r.canUndo).toBe(true)
    expect(r.canRedo).toBe(false)
  })

  it('连续两次编辑逐步退回，两份快照互不串味', async () => {
    const s = new Session(root); await s.open()
    s.annotate({ path: 'src', isDir: true, annotation: '一' })
    s.annotate({ path: 'src', isDir: true, annotation: '二' })
    expect(find(s.undo().tree, 'src')?.annotation).toBe('一')
    expect(find(s.undo().tree, 'src')?.annotation).toBeUndefined()
  })

  it('四个写操作的返回值都带上 canUndo / canRedo', async () => {
    const s = new Session(root); await s.open()
    expect(s.annotate({ path: 'src', isDir: true, annotation: 'a' }))
      .toMatchObject({ canUndo: true, canRedo: false })
    expect(s.move({ from: 'README.md', toParent: 'src', isDir: false }))
      .toMatchObject({ canUndo: true, canRedo: false })
    // members 是单个顶层路径（无公共父目录），deriveGroupId 按既有规则回退为 'group'
    expect(s.setGroup({ id: null, members: ['src'], text: 't' }))
      .toMatchObject({ canUndo: true, canRedo: false })
    expect(s.deleteGroup('group')).toMatchObject({ canUndo: true, canRedo: false })
  })

  it('setGroup 可撤销', async () => {
    const s = new Session(root); await s.open()
    s.setGroup({ id: null, members: ['src/core', 'src/deep'], text: '一体的两个目录' })
    expect(s.raw()).toContain('一体的两个目录')
    const r = s.undo()
    expect(r.groups).toEqual([])
    expect(s.raw()).not.toContain('一体的两个目录')
  })

  it('deleteGroup 可撤销：删错的分组连说明一起回来', async () => {
    const s = new Session(root); await s.open()
    const { id } = s.setGroup({ id: null, members: ['src/core', 'src/deep'], text: '不该被删的说明' })
    s.deleteGroup(id)
    expect(s.raw()).not.toContain('不该被删的说明')
    const r = s.undo()
    expect(r.groups).toHaveLength(1)
    expect(r.groups[0].text).toBe('不该被删的说明')
  })

  // 回归：撤销一次拖拽，必须连 hidden 里那条「旧位置」一起撤掉。只还原 Spec 的话，
  // 契约里节点已经回到旧位置、而旧位置又被 hidden 挡着，节点在**两个位置都不显示**
  // ——正是 v1 里「`.claude/command` 拖一下就整个不见了」那个缺陷的形状。
  it('回归：撤销拖拽后旧位置重新出现（hidden 必须一并还原）', async () => {
    await fs.mkdir(nodePath.join(root, 'examples/foo'), { recursive: true })
    const s = new Session(root); await s.open()
    s.move({ from: 'examples/foo', toParent: 'src/cases', isDir: true })
    // 先确认这次拖拽真的往 hidden 里记了一条，否则下面的断言没有区分力
    expect(find(s.tree(), 'examples/foo')).toBeNull()
    expect(find(s.tree(), 'src/cases/foo')?.origin).toBe('spec-only')

    const r = s.undo()
    expect(find(r.tree, 'examples/foo')?.origin).toBe('actual-only')
    expect(find(r.tree, 'src/cases/foo')).toBeNull()
  })

  // 回归：快照存的必须是**当时那一份** hidden 的副本。存空集、或直接存引用（后续
  // move 会就地改掉同一个 Set），都会让"撤销第二次拖拽"顺手把第一次拖拽的隐藏
  // 一起弄丢或弄错。上一条用例里第一次拖拽前 hidden 本来就是空的，判不出这个区别。
  it('回归：撤销第二次拖拽时，第一次拖拽的旧位置仍然藏着', async () => {
    await fs.mkdir(nodePath.join(root, 'examples/foo'), { recursive: true })
    await fs.mkdir(nodePath.join(root, 'examples/bar'), { recursive: true })
    const s = new Session(root); await s.open()
    s.move({ from: 'examples/foo', toParent: 'src/cases', isDir: true })
    s.move({ from: 'examples/bar', toParent: 'src/cases', isDir: true })

    const r = s.undo()
    expect(find(r.tree, 'examples/bar')?.origin).toBe('actual-only')  // 第二次拖拽退回了
    expect(find(r.tree, 'src/cases/bar')).toBeNull()
    expect(find(r.tree, 'examples/foo')).toBeNull()                   // 第一次拖拽仍然生效
    expect(find(r.tree, 'src/cases/foo')?.origin).toBe('spec-only')
  })

  it('重做一次拖拽：旧位置重新藏起来，新位置重新出现', async () => {
    await fs.mkdir(nodePath.join(root, 'examples/foo'), { recursive: true })
    const s = new Session(root); await s.open()
    s.move({ from: 'examples/foo', toParent: 'src/cases', isDir: true })
    // 先确认撤销确实把旧位置放了出来，否则下面"又不见了"的断言恒真
    expect(find(s.undo().tree, 'examples/foo')).not.toBeNull()

    const r = s.redo()
    expect(find(r.tree, 'examples/foo')).toBeNull()
    expect(find(r.tree, 'src/cases/foo')?.origin).toBe('spec-only')
  })

  it('拖拽重写过的分组成员路径，撤销后也回到原路径', async () => {
    await fs.mkdir(nodePath.join(root, 'examples/foo'), { recursive: true })
    const s = new Session(root); await s.open()
    s.setGroup({ id: null, members: ['examples/foo'], text: '一组' })
    const m = s.move({ from: 'examples/foo', toParent: 'src/cases', isDir: true })
    expect(m.groups[0].members).toEqual(['src/cases/foo'])   // 确认拖拽真的改写了成员
    expect(s.undo().groups[0].members).toEqual(['examples/foo'])
  })

  it('新的编辑清空重做栈', async () => {
    const s = new Session(root); await s.open()
    s.annotate({ path: 'src', isDir: true, annotation: '一' })
    s.annotate({ path: 'src', isDir: true, annotation: '二' })
    expect(s.undo().canRedo).toBe(true)

    const r = s.annotate({ path: 'src', isDir: true, annotation: '三' })
    expect(r.canRedo).toBe(false)
    expect(find(s.redo().tree, 'src')?.annotation).toBe('三')  // redo 退化成空操作
  })

  it('栈空时 undo 是空操作：既不抛错，也不会把已经读进来的契约清掉', async () => {
    await fs.writeFile(nodePath.join(root, SPEC_FILENAME), [
      '---', 'folderspec: 1', 'root: .', 'ownership: human', '---',
      '', '# 已有契约', '', '## 结构', '', '- `src/` — 人类写的注释', '',
    ].join('\n'))
    const s = new Session(root); await s.open()

    const r = s.undo()
    expect(r.canUndo).toBe(false)
    expect(r.canRedo).toBe(false)
    expect(r.dirty).toBe(false)
    expect(find(r.tree, 'src')?.annotation).toBe('人类写的注释')
    expect(find(s.redo().tree, 'src')?.annotation).toBe('人类写的注释')
  })

  // 上限刻意写死 50，不从实现里 import 常量：跟着实现走的期望值等于没有期望值——
  // 把上限改成 100 时这条用例照样绿，它就不再证明"到顶会丢掉最旧的一步"。
  it('撤销栈上限 50：第 51 次编辑之后，最早那一步再也退不回去', async () => {
    const s = new Session(root); await s.open()
    for (let i = 1; i <= 51; i++) s.annotate({ path: 'src', isDir: true, annotation: `注释${i}` })

    for (let i = 0; i < 50; i++) s.undo()
    const r = s.undo()   // 第 51 次撤销：栈已空，空操作
    expect(r.canUndo).toBe(false)
    expect(find(r.tree, 'src')?.annotation).toBe('注释1')  // 不是 undefined：打开时那一步已被丢弃
  })

  it('open() 清空撤销与重做栈——历史与 hidden 同类，永不跨越一次重载', async () => {
    const s = new Session(root); await s.open()
    s.annotate({ path: 'src', isDir: true, annotation: '未保存' })
    s.undo()
    await s.open()
    const r = s.undo()
    expect(r.canUndo).toBe(false)
    expect(r.canRedo).toBe(false)
  })

  it('撤销与重做一个字节都不写磁盘', async () => {
    const specPath = nodePath.join(root, SPEC_FILENAME)
    const original = [
      '---', 'folderspec: 1', 'root: .', 'ownership: human', '---',
      '', '# 已有契约', '', '## 结构', '', '- `src/` — 人类写的注释', '',
    ].join('\n')
    await fs.writeFile(specPath, original)

    const s = new Session(root); await s.open()
    s.annotate({ path: 'src', isDir: true, annotation: '改过了' })
    s.undo(); s.redo(); s.undo()
    expect(await fs.readFile(specPath, 'utf8')).toBe(original)
  })

  it('撤销的是契约上的编辑，不是"看过哪些目录"：已展开的目录不会被退回未扫描', async () => {
    const s = new Session(root); await s.open()
    s.annotate({ path: 'src', isDir: true, annotation: 'x' })
    expect(find(s.tree(), 'src/deep')?.children).toBeUndefined()  // 先确认它确实还没扫
    await s.expand('src/deep')
    expect(find(s.tree(), 'src/deep/deeper')).not.toBeNull()

    const r = s.undo()
    expect(find(r.tree, 'src/deep/deeper')).not.toBeNull()
  })

  it('撤销回到打开时的状态后 dirty 归零，重做之后重新变脏', async () => {
    const s = new Session(root); await s.open()
    expect(s.isDirty()).toBe(false)
    s.annotate({ path: 'src', isDir: true, annotation: 'x' })
    expect(s.isDirty()).toBe(true)

    expect(s.undo().dirty).toBe(false)
    expect(s.isDirty()).toBe(false)
    expect(s.redo().dirty).toBe(true)
    expect(s.isDirty()).toBe(true)
  })

  it('保存之后再编辑再撤销，回到的正是磁盘上那一份，dirty 归零', async () => {
    const s = new Session(root); await s.open()
    s.annotate({ path: 'src', isDir: true, annotation: '第一版' })
    await s.save()
    s.annotate({ path: 'src', isDir: true, annotation: '第二版' })
    expect(s.isDirty()).toBe(true)
    expect(s.undo().dirty).toBe(false)
  })

  // 回归：dirty 不是一个能随快照一起存取的布尔量。保存可以发生在**撤销点之后**，
  // 那一刻更早的那些快照相对磁盘反而变脏了。照搬"存下编辑前的 dirty、撤销时还原"
  // 会在这里答错：编辑前 dirty 是 false，可撤销回去之后磁盘上已经是编辑后的内容。
  it('回归：编辑→保存→撤销，内存与磁盘不再一致，dirty 必须为 true', async () => {
    const s = new Session(root); await s.open()
    s.annotate({ path: 'src', isDir: true, annotation: '已写盘的那一版' })
    await s.save()
    expect(s.isDirty()).toBe(false)

    expect(s.undo().dirty).toBe(true)
    expect(s.isDirty()).toBe(true)
    expect(s.redo().dirty).toBe(false)   // 重做回到已写盘的那一版，又一致了
  })

  it('未 open 时 undo / redo 抛错，而不是静默接受', () => {
    const s = new Session(root)
    expect(() => s.undo()).toThrow('尚未打开')
    expect(() => s.redo()).toThrow('尚未打开')
  })

  it('只读模式（契约解析失败）下 undo / redo 被拒绝', async () => {
    await fs.writeFile(nodePath.join(root, SPEC_FILENAME), '不是合法的契约文件\n')
    const s = new Session(root); await s.open()
    expect(() => s.undo()).toThrow('只读模式')
    expect(() => s.redo()).toThrow('只读模式')
  })

  // 撤销/重做改的就是 this.spec，它就是写操作。disk 视图里的树本来就不按契约合成，
  // 撤销一次拖拽在那个视图上什么都看不出来——用户会以为没生效而连按，一整轮编辑
  // 被悄悄退光。闸门只能有一处，就是 assertWritable()。
  it('disk 视图下 undo / redo 被拦下，错误信息说明处于原始结构视图', async () => {
    const s = new Session(root); await s.open()
    s.annotate({ path: 'src', isDir: true, annotation: '一' })
    s.annotate({ path: 'src', isDir: true, annotation: '二' })
    s.undo()   // 两个栈都非空，闸门一旦缺失这两次调用就真的会生效
    s.setViewMode('disk')

    expect(() => s.undo()).toThrow('原始结构')
    expect(() => s.redo()).toThrow('原始结构')
  })

  it('handle 能分发 spec/undo 与 spec/redo', async () => {
    const s = new Session(root); await s.open()
    s.annotate({ path: 'src', isDir: true, annotation: '核心源码' })

    const u = await s.handle('spec/undo', {})
    expect(u.canRedo).toBe(true)
    expect(find(u.tree, 'src')?.annotation).toBeUndefined()

    const r = await s.handle('spec/redo', {})
    expect(find(r.tree, 'src')?.annotation).toBe('核心源码')
    expect(r.canUndo).toBe(true)
  })
})
