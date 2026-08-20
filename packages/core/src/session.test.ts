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

// OpenResult.lang 回归：UI 靠这个字段给语言开关设初态，三种载入结局各自钉一条，
// 逐条对应 api.ts OpenResult.lang 字段注释里枚举的三种情形。
describe('OpenResult.lang', () => {
  it('解析成功且契约写着 lang: en 时，lang 是 en', async () => {
    await fs.writeFile(nodePath.join(root, SPEC_FILENAME), [
      '---', 'folderspec: 1', 'root: .', 'ownership: human', 'lang: en', '---',
      '', '# T', '', '## Structure', '', '',
    ].join('\n'))
    const r = await new Session(root).open()
    expect(r.lang).toBe('en')
  })

  it('没有契约文件（hasSpec === false）时，lang 是默认值 zh，不是 undefined', async () => {
    const r = await new Session(root).open()
    expect(r.hasSpec).toBe(false)
    expect(r.lang).toBe('zh')
  })

  // 解析失败时不嗅探原始字节里"看起来"是哪种语言，老实给默认值——即便文件里其实
  // 全是英文，也不去猜。这条钉住的是"给默认值而不是给一个可能读错的值"这个取向：
  // 用一份内容明显是英文、但格式非法（缺 '## 结构'/'## Structure' 小节标题）的文件
  // 来证明"即便嗅探起来会像 en"，本实现也不做这种猜测。
  it('解析失败时，lang 是默认值 zh，不是从原始字节里嗅探出来的值', async () => {
    await fs.writeFile(nodePath.join(root, SPEC_FILENAME), [
      '---', 'folderspec: 1', 'root: .', 'ownership: human', 'lang: en', '---',
      '', '# English Contract', '', 'this file is not a legal folderspec body',
    ].join('\n'))
    const s = new Session(root)
    const r = await s.open()
    expect(r.parseErrors).not.toBeNull() // 先确认它真的走了解析失败分支，否则下面的断言没有区分力
    expect(r.lang).toBe('zh')
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

describe('Session.createNode（在契约里声明一个尚不存在的节点）', () => {
  it('新建的节点写进树里，以 spec-only 呈现，且置脏；返回值带上新节点的路径', async () => {
    const s = new Session(root); await s.open()
    const r = s.createNode({ parentPath: '', name: 'docs', isDir: true })
    expect(r.path).toBe('docs')
    expect(r.dirty).toBe(true)
    expect(find(r.tree, 'docs')).toMatchObject({ origin: 'spec-only', isDir: true })
  })

  it('父级链条不存在时按需补齐——整条链在树上都呈现为 spec-only', async () => {
    const s = new Session(root); await s.open()
    const r = s.createNode({ parentPath: 'brand/new', name: 'leaf.ts', isDir: false })
    expect(r.path).toBe('brand/new/leaf.ts')
    expect(find(r.tree, 'brand')?.origin).toBe('spec-only')
    expect(find(r.tree, 'brand/new')?.origin).toBe('spec-only')
    expect(find(r.tree, 'brand/new/leaf.ts')).toMatchObject({ origin: 'spec-only', isDir: false })
  })

  it('在磁盘上已存在的目录下新建节点：父目录仍是 both，新节点是 spec-only', async () => {
    const s = new Session(root); await s.open()
    const r = s.createNode({ parentPath: 'src', name: 'cases', isDir: true })
    expect(find(r.tree, 'src')?.origin).toBe('both')
    expect(find(r.tree, 'src/cases')?.origin).toBe('spec-only')
  })

  it('拒绝空名', async () => {
    const s = new Session(root); await s.open()
    expect(() => s.createNode({ parentPath: '', name: '', isDir: true })).toThrow('名字不能为空')
  })

  it('拒绝含 "/" 的名字——这个参数位是单个路径段，不是路径', async () => {
    const s = new Session(root); await s.open()
    expect(() => s.createNode({ parentPath: '', name: 'a/b', isDir: true })).toThrow('"/"')
  })

  it('拒绝含反引号的名字', async () => {
    const s = new Session(root); await s.open()
    expect(() => s.createNode({ parentPath: '', name: 'we`ird', isDir: true })).toThrow('反引号')
  })

  it('拒绝含换行的名字', async () => {
    const s = new Session(root); await s.open()
    expect(() => s.createNode({ parentPath: '', name: 'a\nb', isDir: true })).toThrow('反引号或换行')
  })

  it('拒绝 "." 与 ".."：在文件系统里有特殊含义', async () => {
    const s = new Session(root); await s.open()
    expect(() => s.createNode({ parentPath: '', name: '.', isDir: true })).toThrow('名字不能是')
    expect(() => s.createNode({ parentPath: '', name: '..', isDir: true })).toThrow('名字不能是')
  })

  it('parentPath 含反引号时同样被拒绝', async () => {
    const s = new Session(root); await s.open()
    expect(() => s.createNode({ parentPath: 'we`ird', name: 'x', isDir: true })).toThrow('反引号')
  })

  // Important #2 回归：parentPath 是多段路径，assertRepresentablePath 只挡反引号/
  // 换行，挡不住 ".." 这种能把声明写出仓库之外的段。契约的消费者是真的会 mkdir
  // 的 Agent——写进一行 `- \`../\`\n  - \`etc/\`` 就是亲手给它下了一条越界指令，
  // 即便本工具自己从不写盘。逐段跑 assertValidNodeName，与 name 参数共用同一套
  // 校验规则（含 "." / ".." 的检查）。
  it('parentPath 中间任意一段是 ".." 时被拒绝——不能借这个参数位把声明写到仓库之外', async () => {
    const s = new Session(root); await s.open()
    expect(() => s.createNode({ parentPath: '../etc', name: 'passwd', isDir: false })).toThrow('..')
    expect(() => s.createNode({ parentPath: 'a/../b', name: 'x', isDir: true })).toThrow('..')
  })

  // Important #3 回归：ensure() 会在 spec 侧把路径中间的文件节点强行升级成目录
  // （setAnnotation 那条"穿过文件叶子会被升级成目录"用例展示的正是这个能力），
  // 但 merge() 对"磁盘和契约都有"的节点只信磁盘（fromActual 用 a.kind==='dir'，
  // 不看 spec 那份 isDir）——parentPath 一旦是磁盘上真实存在的文件，createNode
  // 能成功、raw() 自校验也能通过，写进契约的却是一行 UI 永远选不中、用户永远
  // 看不见也删不掉的声明。必须在这里就直接拒绝，不能指望 UI 不给这个入口。
  it('parentPath 在磁盘上是真实文件时被拒绝——ensure() 会把它悄悄升级成目录，但 merge 只信磁盘，新节点将永远不可见', async () => {
    const s = new Session(root); await s.open()
    expect(() => s.createNode({ parentPath: 'README.md', name: 'child.md', isDir: false }))
      .toThrow('文件')
  })

  // parentPath 是 spec 里已经声明为文件的叶子（不是磁盘上的文件）时同样拒绝：
  // 不能因为一次"新建子项"的副作用，就悄悄把用户之前"这是个文件"的声明改写成目录。
  it('parentPath 在契约里被声明为文件叶子时同样被拒绝', async () => {
    const s = new Session(root); await s.open()
    s.createNode({ parentPath: '', name: 'notes.txt', isDir: false })
    expect(() => s.createNode({ parentPath: 'notes.txt', name: 'child.md', isDir: false }))
      .toThrow('文件')
  })

  it('校验失败不产生副作用：不置脏、不写进树里、不进撤销栈', async () => {
    const s = new Session(root); await s.open()
    const before = s.tree()
    expect(() => s.createNode({ parentPath: '', name: '', isDir: true })).toThrow()
    expect(s.isDirty()).toBe(false)
    // 直接比对失败前后的整棵树，而不是通过 s.undo() 的返回值判断：undo() 是
    // "先 pop 再返回"，哪怕栈里恰好有一条被误提交的记录，pop 完之后 canUndo
    // 依然会是 false，看不出区别（这正是这条用例原来那个断言不承重的原因，
    // 已在 add-node-core-report.md 里记录并做过变异实证）。
    expect(s.tree()).toEqual(before)
  })

  it('拒绝同层重名', async () => {
    const s = new Session(root); await s.open()
    s.createNode({ parentPath: '', name: 'docs', isDir: true })
    expect(() => s.createNode({ parentPath: '', name: 'docs', isDir: true })).toThrow('docs')
  })

  it('重名被拒绝后不产生副作用：只需一次撤销就能回到创建前的状态', async () => {
    const s = new Session(root); await s.open()
    s.createNode({ parentPath: '', name: 'docs', isDir: true })
    expect(() => s.createNode({ parentPath: '', name: 'docs', isDir: true })).toThrow()
    const r = s.undo()
    expect(find(r.tree, 'docs')).toBeNull()
    // 只有一次真正的编辑进了栈；如果被拒绝的那次也 commit 了，这里撤销一次之后
    // canUndo 仍会是 true（栈里还有一条本不该存在的记录）
    expect(r.canUndo).toBe(false)
  })

  it('只读模式（disk 视图）下 createNode 抛错', async () => {
    const s = new Session(root); await s.open()
    s.setViewMode('disk')
    expect(() => s.createNode({ parentPath: '', name: 'docs', isDir: true })).toThrow('原始结构')
  })

  it('handle("spec/createNode") 分发正确', async () => {
    const s = new Session(root); await s.open()
    const r = await s.handle('spec/createNode', { parentPath: '', name: 'docs', isDir: true })
    expect((r as { path: string }).path).toBe('docs')
    expect(find((r as { tree: ViewNode }).tree, 'docs')?.origin).toBe('spec-only')
  })

  it('进撤销栈：canUndo 变 true，撤销后新节点从树上消失、dirty 归零，重做后回来', async () => {
    const s = new Session(root); await s.open()
    expect(s.isDirty()).toBe(false)
    const r = s.createNode({ parentPath: '', name: 'docs', isDir: true })
    expect(r.canUndo).toBe(true)
    expect(r.dirty).toBe(true)

    const u = s.undo()
    expect(find(u.tree, 'docs')).toBeNull()
    expect(u.dirty).toBe(false)

    const red = s.redo()
    expect(find(red.tree, 'docs')?.origin).toBe('spec-only')
    expect(red.dirty).toBe(true)
  })

  // 端到端护栏：新增节点之后 raw() 必须能成功——这条直接守着「别把会话弄成永远
  // 存不了盘」（save() 与 spec/raw 共用同一道 serialize→parse 自校验闸门）。
  it('createNode 之后 raw() 能成功序列化并自校验', async () => {
    const s = new Session(root); await s.open()
    s.createNode({ parentPath: 'src', name: '新目录', isDir: true })
    expect(() => s.raw()).not.toThrow()
    expect(s.raw()).toContain('新目录')
  })

  it('createNode 之后 save() 落盘，重新 open() 仍能看到这个节点', async () => {
    const s = new Session(root); await s.open()
    s.createNode({ parentPath: '', name: 'templates', isDir: true })
    await s.save()

    const s2 = new Session(root)
    const r = await s2.open()
    expect(find(r.tree, 'templates')?.origin).toBe('spec-only')
  })

  // 序列 D（Critical 修复的核心场景，比 A/B/C 更重）：声明 → save 落盘 → 全新
  // Session 重开（不再是同一份内存里的 Spec，是重新 parseSpec() 出来的一份）→
  // 写注释 → 清空 → save。旧版本这里会把已经写进用户 .folderspec.md 文件的那
  // 一行删掉、再回写覆盖磁盘——不再是"内存里的临时状态没保住"，而是工具主动
  // 弄丢用户已经保存过的内容，直接违反"spec-only 节点永远保留、永不自动删除"。
  // 必须用真实文件系统 + 两个独立 Session 才能证明这条修复真的挡住了它。
  it('序列 D：声明 → save → 新 Session 重开 → 写注释 → 清空 → save，磁盘上的声明必须还在', async () => {
    const specPath = nodePath.join(root, SPEC_FILENAME)

    const s1 = new Session(root); await s1.open()
    s1.createNode({ parentPath: 'src', name: 'cases', isDir: true })
    await s1.save()
    expect(await fs.readFile(specPath, 'utf8')).toContain('`cases/`')

    const s2 = new Session(root); await s2.open()
    s2.annotate({ path: 'src/cases', isDir: true, annotation: '测试用例目录' })
    s2.annotate({ path: 'src/cases', isDir: true, annotation: null })
    await s2.save()

    const onDisk = await fs.readFile(specPath, 'utf8')
    expect(onDisk).toContain('`cases/`')
  })
})

// 旁路 2：assertCreatableParent 受懒加载深度限制。DEFAULT_DEPTH=2 时，
// root→depth1(src)→depth2(src/deep) 都会被扫描，但 depth2 节点自己的 children
// （depth3）不会——src/deep 的下一层内容此刻在 ActualNode 树里根本不存在任何条目，
// 不是"扫过了、没找到"。旧实现的 findActual 对"没扫到"和"确实没有"给出同一个 null，
// assertCreatableParent 于是会在 parentPath 落在这个边界之下时完全跳过磁盘冲突检查。
describe('Session.createNode 懒加载边界（旁路 2）', () => {
  // 关键夹具：src/deep/leaf.txt 必须是真实存在、但深度超过 DEFAULT_DEPTH 的文件——
  // 只有这样"findActual 返回 null"的原因才是"没扫到"而不是"路径本来就不存在"，
  // 否则这条用例即使实现完全没做懒加载区分也会通过（上一轮复审专门点过这个坑）。
  it('parentPath 落在懒加载边界之下（未扫描）时拒绝，不能悄悄放行', async () => {
    await fs.writeFile(nodePath.join(root, 'src/deep/leaf.txt'), '')
    const s = new Session(root); await s.open()
    // 先证明它确实没被扫到：src/deep 本身在树上可见（depth2），但它的子项还不可见。
    expect(find(s.tree(), 'src/deep')).not.toBeNull()
    expect(find(s.tree(), 'src/deep/leaf.txt')).toBeNull()
    expect(() => s.createNode({ parentPath: 'src/deep/leaf.txt', name: 'child.md', isDir: false }))
      .toThrow('尚未扫描')
  })

  // 对照组，防止过度拦截：'brand/new' 落在已扫描范围内（root.children 已知，
  // 里面确实没有 'brand'），这是"确实没有"，不是"没扫到"，必须继续放行——
  // 这条本来就有覆盖（538 行"父级链条不存在时按需补齐"），这里单独钉一次
  // 区分力，证明"未扫描才拒"这条判据没有连带误伤"扫描范围内的全新路径"。
  it('对照：parentPath 在已扫描范围内确实不存在时仍然放行', async () => {
    const s = new Session(root); await s.open()
    expect(() => s.createNode({ parentPath: 'brand/new', name: 'leaf.ts', isDir: false })).not.toThrow()
  })

  // 端到端复现上一轮复审记录的失效链条：旧实现里这一串操作会让 child.md 写进
  // raw()、随后 expand 一揭穿磁盘真相（leaf.txt 是文件）就从树上永久消失。
  // 修复之后第一步就该被挡下，链条根本走不到"消失"那一步。
  it('回归：即便先侥幸放行，expand 之后也不该让新声明从树上消失——这里改成在源头直接拒绝', async () => {
    await fs.writeFile(nodePath.join(root, 'src/deep/leaf.txt'), '')
    const s = new Session(root); await s.open()
    expect(() => s.createNode({ parentPath: 'src/deep/leaf.txt', name: 'child.md', isDir: false })).toThrow()
    // 被拒绝的调用不该产生任何副作用
    expect(s.isDirty()).toBe(false)
    expect(s.raw()).not.toContain('child.md')
  })
})

describe('Session.removeNode（撤销节点声明——只影响契约，不碰磁盘）', () => {
  it('移除一个叶子声明，raw() 里不再出现它的注释', async () => {
    const s = new Session(root); await s.open()
    s.annotate({ path: 'README.md', isDir: false, annotation: '说明文档' })
    const r = s.removeNode('README.md')
    expect(r.dirty).toBe(true)
    expect(find(r.tree, 'README.md')?.annotation).toBeUndefined()
    expect(s.raw()).not.toContain('说明文档')
  })

  it('spec-only 节点被移除后彻底从树上消失', async () => {
    const s = new Session(root); await s.open()
    const created = s.createNode({ parentPath: '', name: 'docs', isDir: true })
    expect(find(created.tree, 'docs')?.origin).toBe('spec-only')
    const r = s.removeNode('docs')
    expect(find(r.tree, 'docs')).toBeNull()
  })

  // 语义问题 3：只是撤销契约里的声明，不是删磁盘文件——磁盘上真实存在的 src 目录
  // 移除声明后仍会出现在树上（merge 按磁盘扫描结果把它物化成 actual-only），
  // 只是不再带任何标注，与本工具"只写 .folderspec.md 一个文件"这条铁律一致。
  it('origin both 节点移除声明后仍出现在树上，只是不再带标注——磁盘上的目录纹丝不动', async () => {
    const s = new Session(root); await s.open()
    s.annotate({ path: 'src', isDir: true, annotation: '核心源码' })
    const r = s.removeNode('src')
    const node = find(r.tree, 'src')
    expect(node).not.toBeNull()
    expect(node?.origin).toBe('actual-only')
    expect(node?.annotation).toBeUndefined()
    // 磁盘上的目录确实还在——不是树只是没刷新
    expect((await fs.stat(nodePath.join(root, 'src'))).isDirectory()).toBe(true)
  })

  it('路径不存在时是空操作，树的形状不变——但与 deleteGroup 对不存在 id 的既有行为一致，仍会置脏、进撤销栈', async () => {
    const s = new Session(root); await s.open()
    expect(s.isDirty()).toBe(false)
    const before = s.tree()
    const r = s.removeNode('does/not/exist')
    expect(r.tree).toEqual(before)
    expect(r.dirty).toBe(true)
    expect(r.canUndo).toBe(true)
  })

  // 红线：子树里有用户内容时拒绝，且 Session 的内存状态（spec 与撤销栈）必须
  // 一个字节都不被这次失败的调用碰过——不能只看"抛没抛错"，还要看抛错之后
  // 契约本身真的原封不动。
  it('红线：子树里有用户内容时拒绝，raw() 与撤销栈都不受影响', async () => {
    const s = new Session(root); await s.open()
    s.annotate({ path: 'src/core', isDir: true, annotation: '重要的核心模块说明' })
    const beforeRaw = s.raw()

    expect(() => s.removeNode('src')).toThrow()

    expect(s.raw()).toBe(beforeRaw)
    expect(find(s.tree(), 'src/core')?.annotation).toBe('重要的核心模块说明')
    // 失败的调用不该往撤销栈里塞一条什么都没变的记录
    expect(s.undo().canUndo).toBe(false)
  })

  it('只读模式（disk 视图）下 removeNode 抛错', async () => {
    const s = new Session(root); await s.open()
    s.annotate({ path: 'src', isDir: true, annotation: 'x' })
    s.setViewMode('disk')
    expect(() => s.removeNode('src')).toThrow('原始结构')
  })

  it('可撤销：删错的节点连注释一起回来', async () => {
    const s = new Session(root); await s.open()
    s.annotate({ path: 'src', isDir: true, annotation: '不该被删的说明' })
    s.removeNode('src')
    expect(s.raw()).not.toContain('不该被删的说明')
    const r = s.undo()
    expect(find(r.tree, 'src')?.annotation).toBe('不该被删的说明')
  })

  it('handle("spec/removeNode") 分发正确', async () => {
    const s = new Session(root); await s.open()
    s.annotate({ path: 'src', isDir: true, annotation: 'x' })
    const r = await s.handle('spec/removeNode', { path: 'src' })
    expect((r as { dirty: boolean }).dirty).toBe(true)
    expect(find((r as { tree: ViewNode }).tree, 'src')?.annotation).toBeUndefined()
  })

  // 端到端护栏：移除节点之后 raw() 必须仍然成功——这条直接守着「别把会话弄成永远
  // 存不了盘」（save() 与 spec/raw 共用同一道 serialize→parse 自校验闸门）。
  it('移除节点之后 raw() 能成功序列化并自校验，其余标注不受影响', async () => {
    const s = new Session(root); await s.open()
    s.annotate({ path: 'src', isDir: true, annotation: '待移除' })
    s.annotate({ path: 'README.md', isDir: false, annotation: '保留这条' })
    s.removeNode('src')
    expect(() => s.raw()).not.toThrow()
    expect(s.raw()).not.toContain('待移除')
    expect(s.raw()).toContain('保留这条')
  })

  it('移除节点之后 save() 落盘，重新 open() 也看不到这条声明', async () => {
    const s = new Session(root); await s.open()
    s.annotate({ path: 'README.md', isDir: false, annotation: '会被撤销的声明' })
    await s.save()
    s.removeNode('README.md')
    await s.save()

    const s2 = new Session(root)
    const r = await s2.open()
    expect(find(r.tree, 'README.md')?.annotation).toBeUndefined()
  })
})

describe('Session.setLang（切换展示语言：样板文字未改过才跟着换，走既有写路径闸门）', () => {
  it('无契约文件时以 zh 打开，raw() 不带 lang 字段', async () => {
    const s = new Session(root); await s.open()
    expect(s.raw()).not.toContain('lang:')
  })

  it('open 时读取 front-matter 里的 lang: en', async () => {
    await fs.writeFile(nodePath.join(root, SPEC_FILENAME), [
      '---', 'folderspec: 1', 'root: .', 'ownership: human', 'lang: en', '---',
      '', '# Repository Structure Contract', '', '## Structure', '',
    ].join('\n'))
    const s = new Session(root); await s.open()
    expect(s.raw()).toContain('lang: en')
  })

  it('切换到 en：未改过的默认标题与导言跟着换，且置脏', async () => {
    const s = new Session(root); await s.open()
    expect(s.isDirty()).toBe(false)
    const r = s.setLang('en')
    expect(r.dirty).toBe(true)
    expect(s.raw()).toContain('lang: en')
    expect(s.raw()).toContain('# Repository Structure Contract')
    expect(s.raw()).toContain('## Structure')
  })

  it('用户手改过标题时，切换语言不动它——契约文件里标题不是默认文案', async () => {
    await fs.writeFile(nodePath.join(root, SPEC_FILENAME), [
      '---', 'folderspec: 1', 'root: .', 'ownership: human', '---',
      '', '# 我自己起的标题', '', '## 结构', '',
    ].join('\n'))
    const s = new Session(root); await s.open()
    s.setLang('en')
    expect(s.raw()).toContain('我自己起的标题')
    expect(s.raw()).not.toContain('Repository Structure Contract')
    // 章节标题不是用户内容，仍然按新语言输出
    expect(s.raw()).toContain('## Structure')
  })

  it('切换语言进撤销栈：canUndo 变 true，撤销后语言与文案都回到切换前、dirty 归零，重做后回来', async () => {
    const s = new Session(root); await s.open()
    const r = s.setLang('en')
    expect(r.canUndo).toBe(true)

    const u = s.undo()
    expect(u.dirty).toBe(false)
    expect(s.raw()).not.toContain('lang: en')
    expect(s.raw()).toContain('## 结构')

    const red = s.redo()
    expect(red.dirty).toBe(true)
    expect(s.raw()).toContain('lang: en')
  })

  it('只读模式（契约解析失败）下 setLang 抛错', async () => {
    await fs.writeFile(nodePath.join(root, SPEC_FILENAME), '不是合法的契约文件\n')
    const s = new Session(root); await s.open()
    expect(() => s.setLang('en')).toThrow('只读模式')
  })

  it('disk 视图下 setLang 抛错', async () => {
    const s = new Session(root); await s.open()
    s.setViewMode('disk')
    expect(() => s.setLang('en')).toThrow('原始结构')
  })

  it('未 open 时 setLang 抛错', () => {
    const s = new Session(root)
    expect(() => s.setLang('en')).toThrow('尚未打开')
  })

  it('handle("spec/setLang") 分发正确', async () => {
    const s = new Session(root); await s.open()
    const r = await s.handle('spec/setLang', { lang: 'en' })
    expect((r as { dirty: boolean }).dirty).toBe(true)
  })

  // 端到端护栏：切完语言后 raw() 必须仍然成功——直接守着「别把会话弄成永远存不了盘」，
  // 与 createNode 那条同名护栏（本文件上方）共用同一道 serialize→parse 自校验闸门。
  it('setLang 之后 raw() 仍能成功序列化并自校验', async () => {
    const s = new Session(root); await s.open()
    s.setLang('en')
    expect(() => s.raw()).not.toThrow()
  })

  it('save() 落盘后重新 open()，lang 与切换后的文案都保留', async () => {
    const s = new Session(root); await s.open()
    s.setLang('en')
    await s.save()

    const s2 = new Session(root)
    await s2.open()
    expect(s2.raw()).toContain('lang: en')
    expect(s2.raw()).toContain('Repository Structure Contract')
  })

  // 语言切换控件在大多数双态 UI 里当前选中项常驻可点（不像文本框，"再输一遍原值"
  // 需要用户主动动作）——点一下自己已经在的语言是很容易被误触的操作，不该有可观测
  // 副作用。setLang 是纯函数级别真正的恒等变换（lang === spec.lang 时 from/to 是
  // 同一份 LANG_DEFAULTS 条目，title/preamble 逐字不变），Session 这一层必须把这份
  // "什么都没变"如实传递下去，而不是照抄其他四个写方法"无条件 commitEdit"的套路——
  // 那套路对它们成立是因为传相同的值本来就需要用户主动重新输入一遍，触发概率和
  // 后果都不一样。
  it('setLang 传入与当前相同的语言：不置脏、不进撤销栈（真正的空操作）', async () => {
    const s = new Session(root); await s.open()
    expect(s.isDirty()).toBe(false)
    const before = s.raw()

    const r = s.setLang('zh') // 新会话默认就是 zh
    expect(r.dirty).toBe(false)
    expect(r.canUndo).toBe(false)
    expect(s.isDirty()).toBe(false)
    expect(s.raw()).toBe(before)
  })

  it('先切到 en 再传 en：第二次调用是空操作，不再多吃一格撤销栈', async () => {
    const s = new Session(root); await s.open()
    s.setLang('en')
    expect(s.undo).toBeDefined()

    const afterFirst = s.raw()
    const r = s.setLang('en') // 已经是 en，再传一次
    expect(r.dirty).toBe(true) // 第一次切换的脏标记还在，这条断言确认第二次调用没有"清掉"它
    expect(r.canUndo).toBe(true)
    expect(s.raw()).toBe(afterFirst)

    // 撤销栈只应该有第一次切换那一格：撤一次就应该回到 zh，而不是先撤出一个"en→en"空动作
    const u = s.undo()
    expect(u.dirty).toBe(false)
    expect(s.raw()).not.toContain('lang: en')
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
    expect(() => s.createNode({ parentPath: '', name: 'docs', isDir: true })).toThrow('原始结构')
    expect(() => s.removeNode('src')).toThrow('原始结构')
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

// markSaved 供不走 save() 的宿主（VSCode：自己用 WorkspaceEdit 写盘，见
// packages/vscode/src/editor.ts 的 spec/save 分支）在写入成功后补记"磁盘现在是
// 哪个版本"。它只改内存里的 savedRevision，效果等价于 save() 末尾那一行，
// 但自己不碰文件系统——不然就是新开了一条写路径，违反只读铁律。
//
// markSaved 现在要求调用方传入 revision，而不是自己去读"此刻的 this.revision"：
// 见 rawForSave() 与 markSaved() 上的注释——两者之间横跨的 await 期间完全可能
// 插进来一笔新编辑，读"此刻"会把没写盘的那版误标成已保存。下面的用例统一用
// rawForSave().revision 模拟宿主"刚生成要落盘的文本时"拿到的那个值。
describe('Session.markSaved', () => {
  it('把 savedRevision 追平调用方传入的 revision，dirty 归零，但不落盘', async () => {
    const specPath = nodePath.join(root, SPEC_FILENAME)
    const s = new Session(root); await s.open()
    s.annotate({ path: 'src', isDir: true, annotation: '只在内存里' })
    expect(s.isDirty()).toBe(true)

    const { revision } = s.rawForSave()
    s.markSaved(revision)
    expect(s.isDirty()).toBe(false)
    await expect(fs.access(specPath)).rejects.toThrow() // 从未创建过契约文件——它真的没写盘
  })

  // 镜像"保存之后再编辑再撤销"那条 save() 回归用例：markSaved 必须提供完全相同的
  // 记账语义，撤销栈才能在 VSCode 宿主里正确回到"已保存"状态。
  it('markSaved 之后再编辑再撤销，回到的正是标记过的那一份，dirty 归零', async () => {
    const s = new Session(root); await s.open()
    s.annotate({ path: 'src', isDir: true, annotation: '第一版' })
    s.markSaved(s.rawForSave().revision)
    s.annotate({ path: 'src', isDir: true, annotation: '第二版' })
    expect(s.isDirty()).toBe(true)

    expect(s.undo().dirty).toBe(false)
  })

  it('未 open 时调用会报错，与其它方法共用同一道 assertOpened 闸门', () => {
    const s = new Session(root)
    expect(() => s.markSaved(0)).toThrow('尚未打开')
  })

  // 上面几条用例都是"拿到 revision 之后立刻调用 markSaved"，不落盘期间毫无编辑，
  // this.revision 与传入的 revision 天然相等——就算 markSaved 内部悄悄改回读
  // "此刻的 this.revision"，这几条一句都不会变红，等于什么都没守住。这里补上
  // 真正的窄路径：rawForSave() 之后、markSaved() 之前插入一次新编辑，模拟宿主
  // 落盘那几个 await（VSCode 是 WorkspaceEdit + document.save()，消息回调不排队）
  // 期间又处理了一条把 revision 推进的消息。
  it('rawForSave() 之后、markSaved() 之前如果又落地一笔编辑，dirty 仍为 true', async () => {
    const s = new Session(root); await s.open()
    s.annotate({ path: 'src', isDir: true, annotation: '第一版' })
    const { revision } = s.rawForSave() // 宿主"刚生成要落盘的文本"那一刻拿到的值

    s.annotate({ path: 'src', isDir: true, annotation: '第二版——落盘期间落地，从未写盘' })

    s.markSaved(revision) // 宿主这时才确认"刚才那份文本"真的写盘成功了
    expect(s.isDirty()).toBe(true) // 第二版从未落盘，脏标记不能熄灭
  })

  // 刻意不挂 assertWritable()：调用它的前提是宿主刚用 rawForSave() 生成的内容
  // 已经真实写盘成功，而 rawForSave() 内部已经做过 assertWritable() 检查——那
  // 一刻状态确实可写。VSCode 的写入路径中间隔着两个 await（WorkspaceEdit →
  // document.save()），如果这里再挂一次 assertWritable()，中途一旦切到「原始
  // 结构」视图，会把一次已经真实写盘成功的保存上报成失败、savedRevision 却还是
  // 没追上去——比现在要修的 bug 更糟。这里只做记账，不判断"现在能不能编辑"。
  //
  // rawForSave() 必须在切视图**之前**调用：它内部走 raw() → assertWritable()，
  // 「原始结构」视图下会抛错——这也如实反映了真实宿主的调用顺序：先在可写时
  // 拿到要写的文本与 revision，落盘期间视图才可能被切走。
  it('不挂 assertWritable：处于「原始结构」视图时 markSaved 仍然生效', async () => {
    const s = new Session(root); await s.open()
    s.annotate({ path: 'src', isDir: true, annotation: 'x' })
    const { revision } = s.rawForSave()
    s.setViewMode('disk')

    expect(() => s.markSaved(revision)).not.toThrow()
    expect(s.isDirty()).toBe(false)
  })
})
