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
})
