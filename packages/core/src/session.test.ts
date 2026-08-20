import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { Session, SPEC_FILENAME } from './session.js'
import { specError } from './errors.test-support.js'
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
    expect(() => s.annotate({ path: 'src', isDir: true, annotation: 'x' })).toThrow(specError('readonly.parseFailed'))
    await expect(s.save()).rejects.toThrow(specError('readonly.parseFailed'))
  })

  it('契约文件解析失败时 raw() 也抛错，绝不能返回空契约掩盖用户原文件', async () => {
    await fs.writeFile(nodePath.join(root, SPEC_FILENAME), '不是合法的契约文件\n')
    const s = new Session(root)
    await s.open()
    expect(() => s.raw()).toThrow(specError('readonly.parseFailed'))
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

      await expect(s.save()).rejects.toThrow(specError('readonly.parseFailed'))
      expect(() => s.annotate({ path: 'src', isDir: true, annotation: 'x' })).toThrow(specError('readonly.parseFailed'))
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

// OpenResult.sep 回归：UI 靠这个字段把 ViewNode.path（恒用 '/'）拼回一条平台原生的
// 绝对路径（右键菜单的「复制路径」）。UI 零 node 依赖，拿不到 nodePath.sep，只能由这里
// 如实告知——UI 侧任何"从 root 里含不含 '\\' 反推"的启发式都会在 POSIX 下遇到名字里
// 真的带反斜杠的目录时给出错误分隔符，而错误的绝对路径是**静默**的：粘出来才发现。
describe('OpenResult.sep', () => {
  it('如实给出本平台的路径分隔符', async () => {
    const r = await new Session(root).open()
    expect(r.sep).toBe(nodePath.sep)
    // 上面那条在 POSIX 上等价于 '/'，单独写死一个字面量才能让"把 sep 错写成
    // nodePath.posix.sep / '/' 硬编码"这类变异在本平台上也现形——两条一起才既
    // 跨平台正确、又在本平台有区分力。
    expect(r.sep).toBe(process.platform === 'win32' ? '\\' : '/')
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
    expect(() => s.annotate({ path: 'src', isDir: true, role: 'a]b' }))
      .toThrow(specError('identifier.forbiddenChar', { field: 'role' }))
  })

  it('role 中含反引号时也被拒绝', async () => {
    const s = new Session(root)
    await s.open()
    expect(() => s.annotate({ path: 'src', isDir: true, role: 'a`b' }))
      .toThrow(specError('identifier.forbiddenChar', { field: 'role' }))
  })

  it('template 中含空白字符时被拒绝，报错信息点名字段', async () => {
    const s = new Session(root)
    await s.open()
    expect(() => s.annotate({ path: 'src', isDir: true, template: 'a b' }))
      .toThrow(specError('identifier.forbiddenChar', { field: 'template' }))
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
    expect(() => s.raw()).toThrow(specError('serialize.selfCheckFailed'))
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

    await expect(s.save()).rejects.toThrow(specError('serialize.selfCheckFailed'))
    expect(await fs.readFile(specPath, 'utf8')).toBe(original)
  })

  it('handle("spec/raw") 也走同一道闸门——VSCode 宿主的 WorkspaceEdit 取的就是它', async () => {
    const s = new Session(root)
    await s.open()
    injectBadNode(s)
    await expect(s.handle('spec/raw', {})).rejects.toThrow(specError('serialize.selfCheckFailed'))
  })
})

describe('节点名可表示性（当前格式无法转义反引号与换行）', () => {
  it('annotate 的路径含反引号时抛错，且报错点名这条路径', async () => {
    const s = new Session(root)
    await s.open()
    expect(() => s.annotate({ path: 'src/we`ird', isDir: true, annotation: 'x' }))
      .toThrow(specError('path.unrepresentable', { path: '"src/we`ird"' }))
  })

  it('annotate 的路径含换行时同样被拒绝', async () => {
    const s = new Session(root)
    await s.open()
    expect(() => s.annotate({ path: 'src/a\nb', isDir: true, annotation: 'x' }))
      .toThrow(specError('path.unrepresentable', { path: JSON.stringify('src/a\nb') }))
  })

  it('move 的源路径与目标父路径都要过这道校验', async () => {
    const s = new Session(root)
    await s.open()
    expect(() => s.move({ from: 'we`ird', toParent: 'src', isDir: true }))
      .toThrow(specError('path.unrepresentable', { path: '"we`ird"' }))
    // toParent 逐段过 assertValidNodeName，所以这半边报的是 name.* 而不是 path.*
    expect(() => s.move({ from: 'README.md', toParent: 'ba`d', isDir: false }))
      .toThrow(specError('name.unrepresentable', { name: '"ba`d"' }))
  })

  it('拒绝之后 spec 保持干净：save() 仍然正常写盘', async () => {
    const s = new Session(root)
    await s.open()
    expect(() => s.annotate({ path: 'we`ird', isDir: true, annotation: 'x' }))
      .toThrow(specError('path.unrepresentable', { path: '"we`ird"' }))
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

  // 参照 removeNode 那条同名修订（本文件下方）：id 在当前分组里找不到是真正的
  // 空操作，不该置脏、不该吃一格撤销栈——与 setLang 传入相同语言时的既有行为
  // 保持一致（254cdaf），而不是像旧版本那样把这个怪癖当成 removeNode 该效仿的
  // "既有行为"。
  it('deleteGroup 传入不存在的 id：不置脏、不进撤销栈（真正的空操作）', async () => {
    const s = new Session(root); await s.open()
    expect(s.isDirty()).toBe(false)
    const r = s.deleteGroup('does-not-exist')
    expect(r.dirty).toBe(false)
    expect(r.canUndo).toBe(false)
  })

  it('只读模式下 setGroup 抛错', async () => {
    await fs.writeFile(nodePath.join(root, SPEC_FILENAME), '不是合法的契约文件\n')
    const s = new Session(root); await s.open()
    expect(() => s.setGroup({ id: null, members: ['src'], text: 't' })).toThrow(specError('readonly.parseFailed'))
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
    await expect(s.readFile('../../../etc/passwd'))
      .rejects.toThrow(specError('path.parentSegment', { path: '"../../../etc/passwd"' }))
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
    expect(() => s.createNode({ parentPath: '', name: '', isDir: true })).toThrow(specError('name.empty'))
  })

  it('拒绝含 "/" 的名字——这个参数位是单个路径段，不是路径', async () => {
    const s = new Session(root); await s.open()
    expect(() => s.createNode({ parentPath: '', name: 'a/b', isDir: true }))
      .toThrow(specError('name.hasSlash', { name: '"a/b"' }))
  })

  it('拒绝含反引号的名字', async () => {
    const s = new Session(root); await s.open()
    expect(() => s.createNode({ parentPath: '', name: 'we`ird', isDir: true }))
      .toThrow(specError('name.unrepresentable', { name: '"we`ird"' }))
  })

  it('拒绝含换行的名字', async () => {
    const s = new Session(root); await s.open()
    expect(() => s.createNode({ parentPath: '', name: 'a\nb', isDir: true }))
      .toThrow(specError('name.unrepresentable', { name: JSON.stringify('a\nb') }))
  })

  it('拒绝 "." 与 ".."：在文件系统里有特殊含义', async () => {
    const s = new Session(root); await s.open()
    expect(() => s.createNode({ parentPath: '', name: '.', isDir: true })).toThrow(specError('name.reserved', { name: '.' }))
    expect(() => s.createNode({ parentPath: '', name: '..', isDir: true })).toThrow(specError('name.reserved', { name: '..' }))
  })

  it('parentPath 含反引号时同样被拒绝', async () => {
    const s = new Session(root); await s.open()
    expect(() => s.createNode({ parentPath: 'we`ird', name: 'x', isDir: true }))
      .toThrow(specError('name.unrepresentable', { name: '"we`ird"' }))
  })

  // Important #2 回归：parentPath 是多段路径，assertRepresentablePath 只挡反引号/
  // 换行，挡不住 ".." 这种能把声明写出仓库之外的段。契约的消费者是真的会 mkdir
  // 的 Agent——写进一行 `- \`../\`\n  - \`etc/\`` 就是亲手给它下了一条越界指令，
  // 即便本工具自己从不写盘。逐段跑 assertValidNodeName，与 name 参数共用同一套
  // 校验规则（含 "." / ".." 的检查）。
  it('parentPath 中间任意一段是 ".." 时被拒绝——不能借这个参数位把声明写到仓库之外', async () => {
    const s = new Session(root); await s.open()
    expect(() => s.createNode({ parentPath: '../etc', name: 'passwd', isDir: false })).toThrow(specError('name.reserved', { name: '..' }))
    expect(() => s.createNode({ parentPath: 'a/../b', name: 'x', isDir: true })).toThrow(specError('name.reserved', { name: '..' }))
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
      .toThrow(specError('parent.fileOnDisk', { path: 'README.md' }))
  })

  // parentPath 是 spec 里已经声明为文件的叶子（不是磁盘上的文件）时同样拒绝：
  // 不能因为一次"新建子项"的副作用，就悄悄把用户之前"这是个文件"的声明改写成目录。
  it('parentPath 在契约里被声明为文件叶子时同样被拒绝', async () => {
    const s = new Session(root); await s.open()
    s.createNode({ parentPath: '', name: 'notes.txt', isDir: false })
    expect(() => s.createNode({ parentPath: 'notes.txt', name: 'child.md', isDir: false }))
      .toThrow(specError('parent.fileInSpec', { path: 'notes.txt' }))
  })

  it('校验失败不产生副作用：不置脏、不写进树里、不进撤销栈', async () => {
    const s = new Session(root); await s.open()
    const before = s.tree()
    expect(() => s.createNode({ parentPath: '', name: '', isDir: true })).toThrow(specError('name.empty'))
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
    expect(() => s.createNode({ parentPath: '', name: 'docs', isDir: true }))
      .toThrow(specError('name.duplicateSiblingAtRoot', { name: 'docs' }))
  })

  it('重名被拒绝后不产生副作用：只需一次撤销就能回到创建前的状态', async () => {
    const s = new Session(root); await s.open()
    s.createNode({ parentPath: '', name: 'docs', isDir: true })
    expect(() => s.createNode({ parentPath: '', name: 'docs', isDir: true }))
      .toThrow(specError('name.duplicateSiblingAtRoot', { name: 'docs' }))
    const r = s.undo()
    expect(find(r.tree, 'docs')).toBeNull()
    // 只有一次真正的编辑进了栈；如果被拒绝的那次也 commit 了，这里撤销一次之后
    // canUndo 仍会是 true（栈里还有一条本不该存在的记录）
    expect(r.canUndo).toBe(false)
  })

  it('只读模式（disk 视图）下 createNode 抛错', async () => {
    const s = new Session(root); await s.open()
    s.setViewMode('disk')
    expect(() => s.createNode({ parentPath: '', name: 'docs', isDir: true })).toThrow(specError('readonly.diskView'))
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
      .toThrow(specError('parent.unscanned', { path: 'src/deep/leaf.txt' }))
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
    expect(() => s.createNode({ parentPath: 'src/deep/leaf.txt', name: 'child.md', isDir: false }))
      .toThrow(specError('parent.unscanned', { path: 'src/deep/leaf.txt' }))
    // 被拒绝的调用不该产生任何副作用
    expect(s.isDirty()).toBe(false)
    expect(s.raw()).not.toContain('child.md')
  })
})

// 旁路 3：assertCreatableParent 不查 hidden。move() 之后旧位置被记进 hidden、
// merge 会在 spec 视图下把它整个跳过（无论磁盘/契约有没有内容）；在这个路径下
// createNode，写盘会成功、raw() 里确实有这条声明，但树上永远看不见。
// "把 lib 拖走之后再声明 lib 下面应该有什么"是相当自然的用户动作，这条不是边角情形。
describe('Session.createNode 与 hidden（旁路 3）', () => {
  it('parentPath 是本次会话刚拖走的旧位置时拒绝', async () => {
    const s = new Session(root); await s.open()
    // 先真的 move 一次，让 hidden 非空——否则"查不查 hidden"这条判断没有区分力。
    s.move({ from: 'src/core', toParent: '', isDir: true })
    expect(find(s.tree(), 'src/core')).toBeNull() // 确认 hidden 真的生效了
    expect(() => s.createNode({ parentPath: 'src/core', name: 'x.ts', isDir: false }))
      .toThrow(specError('hidden.oldLocation', { path: 'src/core' }))
  })

  it('对照：拖走之前，同一路径下 createNode 不受影响', async () => {
    const s = new Session(root); await s.open()
    expect(() => s.createNode({ parentPath: 'src/core', name: 'x.ts', isDir: false })).not.toThrow()
  })
})

// 旁路 4（最该修的一条）：move() 的 toParent 缺同款检查。createNode 已经在
// assertCreatableParent 里拒绝"父级在磁盘上是文件"，但 move() 一直没走这道闸门——
// 同一个不变量两条写路径给出相反答案，就是界面在说谎。复现上一轮复审的原始场景：
// 把带注释的节点拖到磁盘上真实存在的文件下面，move 成功、落盘写进一行 UI 选不中
// 的声明，原节点自己的注释也从树上消失（内容还在文件里，只是永久够不着）。
describe('Session.move 的 toParent 磁盘冲突检查（旁路 4）', () => {
  // 关键夹具：toParent 必须是磁盘上真实存在的文件（README.md，beforeEach 建的），
  // 不能用虚构路径——否则"toParent 是文件"这条判断没有区分力（上一轮复审点过的坑）。
  it('toParent 是磁盘上真实存在的文件时拒绝，与 createNode 走同一条判据', async () => {
    const s = new Session(root); await s.open()
    s.annotate({ path: 'src', isDir: true, annotation: '入口，别丢' })
    const beforeRaw = s.raw()
    expect(() => s.move({ from: 'src', toParent: 'README.md', isDir: true }))
      .toThrow(specError('parent.fileOnDisk', { path: 'README.md' }))
    // 被拒绝的调用不该产生任何副作用：原节点的注释仍在原地，raw() 一个字节都没变
    expect(find(s.tree(), 'src')?.annotation).toBe('入口，别丢')
    expect(s.raw()).toBe(beforeRaw)
  })

  it('对照：toParent 是磁盘上真实存在的目录时不受影响', async () => {
    const s = new Session(root); await s.open()
    expect(() => s.move({ from: 'README.md', toParent: 'src', isDir: false })).not.toThrow()
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

  // 这条用例的期望值本身经过一次修订：旧版本认为"路径不存在时仍置脏、仍进撤销栈"
  // 是与 deleteGroup 保持一致的正确行为，复审裁定这个参照对象选错了——setLang
  // 早就为同一个毛病改过（传入相同语言不再置脏、不再吃一格撤销栈，见 254cdaf），
  // 项目已经裁定过"一次什么都没改变的调用不该置脏"，deleteGroup 带着这个怪癖是
  // 遗留缺陷，不是该被沿用的标准。空操作置脏 = 界面告诉用户"有未保存的改动"，
  // 而其实一个字节都没变；用户按撤销，看起来什么也没发生（因为那一格撤销栈
  // 本来就是空的）——这与本轮另外三条旁路是同一族"界面在说谎"问题。
  it('路径不存在时是真正的空操作：树的形状不变，且不置脏、不进撤销栈', async () => {
    const s = new Session(root); await s.open()
    expect(s.isDirty()).toBe(false)
    const before = s.tree()
    const r = s.removeNode('does/not/exist')
    expect(r.tree).toEqual(before)
    expect(r.dirty).toBe(false)
    expect(r.canUndo).toBe(false)
    // 连带验证：既然没进撤销栈，undo() 也该是空操作，不会把树改成别的东西
    expect(s.undo().canUndo).toBe(false)
    expect(s.tree()).toEqual(before)
  })

  // 红线：子树里有用户内容时拒绝，且 Session 的内存状态（spec 与撤销栈）必须
  // 一个字节都不被这次失败的调用碰过——不能只看"抛没抛错"，还要看抛错之后
  // 契约本身真的原封不动。
  it('红线：子树里有用户内容时拒绝，raw() 与撤销栈都不受影响', async () => {
    const s = new Session(root); await s.open()
    s.annotate({ path: 'src/core', isDir: true, annotation: '重要的核心模块说明' })
    const beforeRaw = s.raw()

    expect(() => s.removeNode('src')).toThrow(specError('remove.subtreeHasContent', { path: 'src' }))

    expect(s.raw()).toBe(beforeRaw)
    expect(find(s.tree(), 'src/core')?.annotation).toBe('重要的核心模块说明')
    // 失败的调用不该往撤销栈里塞一条什么都没变的记录
    expect(s.undo().canUndo).toBe(false)
  })

  it('只读模式（disk 视图）下 removeNode 抛错', async () => {
    const s = new Session(root); await s.open()
    s.annotate({ path: 'src', isDir: true, annotation: 'x' })
    s.setViewMode('disk')
    expect(() => s.removeNode('src')).toThrow(specError('readonly.diskView'))
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
    expect(() => s.setLang('en')).toThrow(specError('readonly.parseFailed'))
  })

  it('disk 视图下 setLang 抛错', async () => {
    const s = new Session(root); await s.open()
    s.setViewMode('disk')
    expect(() => s.setLang('en')).toThrow(specError('readonly.diskView'))
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

    expect(() => s.annotate({ path: 'src', isDir: true, annotation: 'x' })).toThrow(specError('readonly.diskView'))
    expect(() => s.move({ from: 'README.md', toParent: 'src', isDir: false })).toThrow(specError('readonly.diskView'))
    expect(() => s.setGroup({ id: null, members: ['src'], text: 't' })).toThrow(specError('readonly.diskView'))
    expect(() => s.deleteGroup('whatever')).toThrow(specError('readonly.diskView'))
    expect(() => s.createNode({ parentPath: '', name: 'docs', isDir: true })).toThrow(specError('readonly.diskView'))
    expect(() => s.removeNode('src')).toThrow(specError('readonly.diskView'))
    expect(() => s.raw()).toThrow(specError('readonly.diskView'))
    await expect(s.save()).rejects.toThrow(specError('readonly.diskView'))
  })

  it('规则4：错误信息里带上如何退出只读状态的提示', async () => {
    const s = new Session(root)
    await s.open()
    s.setViewMode('disk')
    // 这一条断的**就是文案本身**——"报错必须告诉用户怎么退出只读态"是它要钉的
    // 全部内容，换成断 code 等于把这条用例删掉。所以它继续断文案，只是跟着改成英文。
    expect(() => s.annotate({ path: 'src', isDir: true, annotation: 'x' }))
      .toThrow(/Switch back to the "My Structure" view/)
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
      .rejects.toThrow(specError('readonly.diskView'))
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
    expect(() => s.annotate({ path: 'src', isDir: true, annotation: 'x' })).toThrow(specError('readonly.diskView'))
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
    expect(() => s.undo()).toThrow(specError('readonly.parseFailed'))
    expect(() => s.redo()).toThrow(specError('readonly.parseFailed'))
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

    expect(() => s.undo()).toThrow(specError('readonly.diskView'))
    expect(() => s.redo()).toThrow(specError('readonly.diskView'))
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


// ============================================================================
// 终审红线修复轮（甲 / 乙 / 丙）。三条收敛到同一句话：一次点击不该让人写下的内容
// 消失，"文件里还在、界面上够不着"与"真的被删掉"在用户那边是同一件事。
// ============================================================================

// 甲：moveNode 的 mergeInto 用源节点的字段无声覆盖目标同名节点。完整推导见
// spec-edit.ts 的 assertNoMergeConflict；这里从 Session 这一层端到端钉一次——
// 纯函数那几条用例证明"判据对不对"，这条证明"这条判据真的长在用户点得到的那条
// 写路径上"，且失败的调用不留任何残迹。
describe('Session.move 红线：合并到同名节点时不覆盖目标已有的注释（甲）', () => {
  it('把带注释的同名文件拖进已有同名注释的目录时拒绝，raw() 一个字节都不变', async () => {
    await fs.mkdir(nodePath.join(root, 'old'), { recursive: true })
    await fs.writeFile(nodePath.join(root, 'old/utils.ts'), '')
    await fs.writeFile(nodePath.join(root, 'src/utils.ts'), '')
    const s = new Session(root); await s.open()
    s.annotate({ path: 'src/utils.ts', isDir: false, annotation: '共享工具函数，勿删' })
    s.annotate({ path: 'old/utils.ts', isDir: false, annotation: '旧的' })
    const beforeRaw = s.raw()

    expect(() => s.move({ from: 'old/utils.ts', toParent: 'src', isDir: false }))
      .toThrow(specError('move.mergeConflict', { conflicts: expect.stringContaining('共享工具函数，勿删') as unknown as string }))

    // 只看"抛没抛错"不够：抛错之后契约、树、hidden 都必须原封不动。
    expect(s.raw()).toBe(beforeRaw)
    expect(find(s.tree(), 'src/utils.ts')?.annotation).toBe('共享工具函数，勿删')
    expect(find(s.tree(), 'old/utils.ts')?.annotation).toBe('旧的')

    // 失败的调用不该往撤销栈里塞一条什么都没变的记录：撤销一次应当退回到"第二次
    // annotate 之前"，而不是退回到"那次失败的 move 之前"（后者看起来什么也没发生）。
    const u = s.undo()
    expect(find(u.tree, 'old/utils.ts')?.annotation).toBeUndefined()
    expect(find(u.tree, 'src/utils.ts')?.annotation).toBe('共享工具函数，勿删')
  })
})

// 乙：hidden 只记旧位置、不记去向，它的有效性完全依赖"被拖走的那个 spec 节点还
// 活着"这个隐含前提。removeNode 能把那个节点删掉，却一直没有对称地回收 hidden——
// 于是磁盘上货真价实、装着文件的目录在本次会话里从树上彻底消失。
// 方向上是甲那条红线的镜像：不是契约里有而树上没有，是磁盘上有而树上没有。
describe('Session.removeNode 回收 move 遗留的 hidden（乙）', () => {
  it('红线：拖走后再对新位置「取消声明」，磁盘上真实存在的旧位置连同子树必须回到树上', async () => {
    // 夹具必须是"磁盘上真实存在、里面还装着文件"的目录——用一个虚构路径的话，
    // "旧位置有没有回到树上"这条断言对实现完全没有区分力。
    await fs.writeFile(nodePath.join(root, 'src/core/keep.ts'), '')
    const s = new Session(root); await s.open()
    s.annotate({ path: 'src/core', isDir: true, annotation: '核心模块' })
    s.move({ from: 'src/core', toParent: '', isDir: true })

    // 先确认这次拖拽真的把旧位置记进了 hidden，否则下面全部断言没有区分力
    expect(find(s.tree(), 'src/core')).toBeNull()
    expect(find(s.tree(), 'core')?.origin).toBe('spec-only')

    const r = s.removeNode('core')

    const back = find(r.tree, 'src/core')
    expect(back).not.toBeNull()
    expect(back?.origin).toBe('actual-only')
    // 整棵子树都要能重新够着：终审实测里连 tree/expand 都拉不回来。
    const expanded = await s.expand('src/core')
    expect(find(expanded, 'src/core/keep.ts')).not.toBeNull()
    // 磁盘上本来就一个字节都没被动过（只写 .folderspec.md 这条铁律）
    expect((await fs.stat(nodePath.join(root, 'src/core'))).isDirectory()).toBe(true)
  })

  it('被移除的是祖先、hidden 里的旧位置属于它的后代时同样回收', async () => {
    const s = new Session(root); await s.open()
    s.createNode({ parentPath: '', name: 'holder', isDir: true })
    s.move({ from: 'src/core', toParent: 'holder', isDir: true })
    expect(find(s.tree(), 'src/core')).toBeNull()
    expect(find(s.tree(), 'holder/core')).not.toBeNull()

    // holder/core 是纯脚手架（没有任何一层携带内容），removeNode 允许连同收走——
    // 于是 hidden 里那条 'src/core' 的落点跟着 holder 一起没了。
    const r = s.removeNode('holder')
    expect(find(r.tree, 'holder')).toBeNull()
    expect(find(r.tree, 'src/core')).not.toBeNull()
  })

  it('撤销之后 hidden 必须恢复原状——声明回到新位置，旧位置重新隐藏', async () => {
    const s = new Session(root); await s.open()
    s.move({ from: 'src/core', toParent: '', isDir: true })
    expect(find(s.tree(), 'src/core')).toBeNull()
    s.removeNode('core')
    expect(find(s.tree(), 'src/core')).not.toBeNull()

    const u = s.undo()
    // 撤销把 core 这条声明放了回去；旧位置若不跟着重新隐藏，同一个节点会在新旧
    // 两处同时出现——正是 Snapshot 注释里"hidden 必须和 spec 一起进快照"守的那条。
    expect(find(u.tree, 'core')).not.toBeNull()
    expect(find(u.tree, 'src/core')).toBeNull()
  })

  it('对照：移除一条与 hidden 无关的声明，不该顺手把旧位置解除隐藏', async () => {
    const s = new Session(root); await s.open()
    s.move({ from: 'src/core', toParent: '', isDir: true })
    s.annotate({ path: 'README.md', isDir: false, annotation: '与那次拖拽无关' })

    s.removeNode('README.md')
    // 这条钉的是"别图省事一把清空 hidden"：core 的声明还在根下活着，旧位置理应
    // 继续隐藏，否则同一个节点会在两处同时出现。
    expect(find(s.tree(), 'src/core')).toBeNull()
    expect(find(s.tree(), 'core')).not.toBeNull()
  })

  it('对照：路径不存在的真空操作不该动 hidden', async () => {
    const s = new Session(root); await s.open()
    s.move({ from: 'src/core', toParent: '', isDir: true })
    const r = s.removeNode('does/not/exist')
    expect(find(r.tree, 'src/core')).toBeNull()
  })
})

// 丙：assertCreatableParent 只审 parentPath、判据还过窄。五条发现同一个根因，
// 四个缺口一次补齐，并且让 createNode 与 move 走同一套判据（e7a723f 已经确立的
// 原则：同一条不变量必须只有一个实现，否则界面在说谎）。
describe('Session 新增声明的闸门：结果路径与祖先链（丙）', () => {
  it('结果路径正好是本次会话刚被拖走的旧位置时拒绝——闸门不能只管父级', async () => {
    const s = new Session(root); await s.open()
    s.move({ from: 'src/core', toParent: '', isDir: true })
    expect(find(s.tree(), 'src/core')).toBeNull() // 确认 hidden 真的生效了
    const beforeRaw = s.raw()

    expect(() => s.createNode({ parentPath: 'src', name: 'core', isDir: true }))
      .toThrow(specError('hidden.resultPath', { path: 'src/core' }))
    expect(s.raw()).toBe(beforeRaw)
    expect(s.isDirty()).toBe(true) // 上面那次 move 造成的，不是这次被拒的调用
  })

  it('parentPath 落在被拖走节点的子树里（祖先命中 hidden）时拒绝——判据不能是精确匹配', async () => {
    const s = new Session(root); await s.open()
    s.move({ from: 'src/core', toParent: '', isDir: true })
    expect(() => s.createNode({ parentPath: 'src/core/sub', name: 'x.md', isDir: false }))
      .toThrow(specError('hidden.oldLocation', { path: 'src/core' }))
  })

  it('move 的 toParent 落在被拖走节点的子树里时同样拒绝——两条写路径同一套判据', async () => {
    const s = new Session(root); await s.open()
    s.annotate({ path: 'README.md', isDir: false, annotation: '别把我搬到看不见的地方' })
    s.move({ from: 'src/core', toParent: '', isDir: true })

    expect(() => s.move({ from: 'README.md', toParent: 'src/core/sub', isDir: false }))
      .toThrow(specError('hidden.oldLocation', { path: 'src/core' }))
    // 被拒绝之后注释仍在原地、树上仍看得见——这条失效的形状正是"内容还在文件里，
    // 界面上再也找不回来"，只断言抛错是不够的。
    expect(find(s.tree(), 'README.md')?.annotation).toBe('别把我搬到看不见的地方')
  })

  it('对照：move 的结果路径落在 hidden 上是合法的——那是把节点拖回原位', async () => {
    const s = new Session(root); await s.open()
    s.move({ from: 'src/core', toParent: '', isDir: true })
    expect(() => s.move({ from: 'core', toParent: 'src', isDir: true })).not.toThrow()
    expect(find(s.tree(), 'src/core')).not.toBeNull()
  })

  it('「新建目录」用磁盘上真实文件的名字时拒绝——契约不能写下一条 Agent 会照做的谎话', async () => {
    const s = new Session(root); await s.open()
    expect(() => s.createNode({ parentPath: '', name: 'README.md', isDir: true }))
      .toThrow(specError('declare.typeConflictDiskFile', { path: 'README.md' }))
    // 树上零异常（merge 对 origin=both 只信磁盘），所以必须断言契约本身没被写脏
    expect(s.raw()).not.toContain('`README.md/`')
    expect(s.isDirty()).toBe(false)
  })

  it('「新建文件」用磁盘上真实目录的名字时同样拒绝（反方向）', async () => {
    const s = new Session(root); await s.open()
    expect(() => s.createNode({ parentPath: '', name: 'src', isDir: false }))
      .toThrow(specError('declare.typeConflictDiskDir', { path: 'src' }))
  })

  it('对照：类型一致时照常放行——把磁盘上已有的目录声明进契约是正常用法', async () => {
    const s = new Session(root); await s.open()
    expect(() => s.createNode({ parentPath: 'src', name: 'deep', isDir: true })).not.toThrow()
  })

  it('move 的结果路径与磁盘类型冲突时拒绝——与 createNode 同一套判据', async () => {
    // 根下真实存在一个名叫 core 的**文件**，把目录 src/core 拖到根 = 契约要声明
    // "根下的 core 是个目录"，而 merge 只信磁盘，这一行永远显示成文件。
    await fs.writeFile(nodePath.join(root, 'core'), '')
    const s = new Session(root); await s.open()
    s.annotate({ path: 'src/core', isDir: true, annotation: '核心模块' })
    const beforeRaw = s.raw()

    expect(() => s.move({ from: 'src/core', toParent: '', isDir: true }))
      .toThrow(specError('declare.typeConflictDiskFile', { path: 'core' }))
    expect(s.raw()).toBe(beforeRaw)
    // 被拒绝的 move 绝不能顺手把旧位置记进 hidden
    expect(find(s.tree(), 'src/core')?.annotation).toBe('核心模块')
  })

  // 闸门必须拿"这次移动落定之后目标路径的最终 isDir"去和磁盘比，而不是调用方传来的
  // params.isDir——moveNode 内部是"契约里已有的源节点优先于调用者的声明"，两者不一致
  // 时若按后者判，闸门放行的是一个值、写进契约的是另一个值，正是这一族缺陷本身的形状。
  it('结果类型按契约里源节点的 isDir 判定，不被调用方声明的 isDir 带偏', async () => {
    await fs.writeFile(nodePath.join(root, 'thing'), '') // 根下真实存在的**文件**
    const s = new Session(root); await s.open()
    s.createNode({ parentPath: 'old', name: 'thing', isDir: true }) // 契约里声明成**目录**

    expect(() => s.move({ from: 'old/thing', toParent: '', isDir: false }))
      .toThrow(specError('declare.typeConflictDiskFile', { path: 'thing' }))
  })

  it('parentPath 的中间祖先在契约里被声明为文件时拒绝——ensure() 会把它悄悄改写成目录', async () => {
    const s = new Session(root); await s.open()
    s.createNode({ parentPath: '', name: 'notes.txt', isDir: false })
    s.annotate({ path: 'notes.txt', isDir: false, annotation: '这是一个文件，我明确这么声明的' })

    expect(() => s.createNode({ parentPath: 'notes.txt/inner', name: 'x.ts', isDir: false }))
      .toThrow(specError('parent.fileInSpec', { path: 'notes.txt' }))
    // 用户写下的 isDir=false 必须原样活着：结构区里 notes.txt 不带尾斜杠
    expect(s.raw()).toContain('`notes.txt`')
    expect(s.raw()).not.toContain('`notes.txt/`')
  })

  it('move 的 toParent 中间祖先在契约里被声明为文件时同样拒绝', async () => {
    const s = new Session(root); await s.open()
    s.createNode({ parentPath: '', name: 'notes.txt', isDir: false })
    expect(() => s.move({ from: 'README.md', toParent: 'notes.txt/inner', isDir: false }))
      .toThrow(specError('parent.fileInSpec', { path: 'notes.txt' }))
  })

  it('parentPath 的中间祖先在磁盘上是文件时，报的是「是一个文件」而不是「尚未扫描」', async () => {
    const s = new Session(root); await s.open()
    // 旧实现走到 'README.md/inner' 时只发现"README.md 的 children 是 undefined"，
    // 于是报"尚未扫描"——一条让用户去展开一个文件的、无从执行的提示。
    expect(() => s.createNode({ parentPath: 'README.md/inner', name: 'x.ts', isDir: false }))
      .toThrow(specError('parent.fileOnDisk', { path: 'README.md' }))
    expect(() => s.createNode({ parentPath: 'README.md/inner', name: 'x.ts', isDir: false }))
      .not.toThrow(specError('parent.unscanned'))
  })

  // annotate 是第三条会往契约里写路径的写路径，此前完全没接这道闸门：终审实测
  // 在拖走的旧位置上 annotate 会"写成功"，raw() 里多出一行用户在树上够不着的
  // 声明——与甲/乙是同一条红线的第三次现形。
  it('annotate 落在被拖走的旧位置上时拒绝——写得进契约却在树上够不着，等同弄丢', async () => {
    const s = new Session(root); await s.open()
    s.move({ from: 'src/core', toParent: '', isDir: true })
    expect(() => s.annotate({ path: 'src/core', isDir: true, annotation: '够不着的注释' }))
      .toThrow(specError('hidden.oldLocation', { path: 'src/core' }))
    expect(s.raw()).not.toContain('够不着的注释')
  })

  it('对照：annotate 一个祖先链上没有任何 hidden 的普通路径不受影响', async () => {
    const s = new Session(root); await s.open()
    s.move({ from: 'src/core', toParent: '', isDir: true })
    // 'src' 是被拖走节点的**父**，它自己在树上好好的，绝不能被连坐
    expect(() => s.annotate({ path: 'src', isDir: true, annotation: '照常可写' })).not.toThrow()
    expect(find(s.tree(), 'src')?.annotation).toBe('照常可写')
  })
})

// 控制器点名的反向护栏：新增闸门绝不能误伤"给 Agent 布置一棵纯 spec-only 的目录
// 模板"——那正是「新建目录（仅契约）」这个功能存在的理由。
describe('纯 spec-only 模板树必须继续放行（丙 的反向护栏）', () => {
  it('templates/cases/fixtures/demo.json 四级逐层建得出来，树上可见、raw() 里有', async () => {
    const s = new Session(root); await s.open()
    expect(() => s.createNode({ parentPath: '', name: 'templates', isDir: true })).not.toThrow()
    expect(() => s.createNode({ parentPath: 'templates', name: 'cases', isDir: true })).not.toThrow()
    expect(() => s.createNode({ parentPath: 'templates/cases', name: 'fixtures', isDir: true })).not.toThrow()
    const r = s.createNode({ parentPath: 'templates/cases/fixtures', name: 'demo.json', isDir: false })

    expect(r.path).toBe('templates/cases/fixtures/demo.json')
    expect(find(r.tree, 'templates/cases/fixtures/demo.json')?.origin).toBe('spec-only')
    expect(s.raw()).toContain('demo.json')
    // 落盘 + 重开也要活着（结构区四级嵌套必须能被自己解析回来）
    await s.save()
    const s2 = new Session(root)
    const r2 = await s2.open()
    expect(find(r2.tree, 'templates/cases/fixtures/demo.json')).not.toBeNull()
  })

  it('一次性声明一条全新的深层路径（父级链条按需补齐）同样放行', async () => {
    const s = new Session(root); await s.open()
    expect(() => s.createNode({ parentPath: 'templates/cases/fixtures', name: 'demo.json', isDir: false }))
      .not.toThrow()
    expect(find(s.tree(), 'templates/cases/fixtures/demo.json')?.origin).toBe('spec-only')
  })
})

/**
 * 重命名与 move 是结构完全同构的两条写路径：都要改 spec 里的节点、都要往 hidden 里
 * 记一笔旧位置、都要重写分组成员路径、都要让快照盖住 hidden。下面按"七条配套动作"
 * 逐条钉住，其中三条是 move 已经用真实缺陷换来的（改成同名照样隐藏 / 改回原名不解除
 * 隐藏 / 快照只盖 spec），rename 会一模一样地踩到，所以各有一条独立用例。
 */
describe('Session.rename（在契约里给节点改名——不碰磁盘上的文件）', () => {
  it('配套动作 1：改 spec 里的节点——新名字带着注释出现在树上，返回新的完整路径', async () => {
    const s = new Session(root); await s.open()
    s.annotate({ path: 'src/core', isDir: true, annotation: '核心模块' })
    const r = s.rename({ path: 'src/core', newName: 'kernel' })
    expect(r.path).toBe('src/kernel')
    expect(find(r.tree, 'src/kernel')?.annotation).toBe('核心模块')
    expect(r.dirty).toBe(true)
  })

  it('配套动作 2：旧路径进 hidden——否则磁盘上那一行实体与新名字的虚线行会同时出现', async () => {
    const s = new Session(root); await s.open()
    // 夹具确认：改名之前 src/core 是磁盘上真实存在的一行，这条断言才有区分力
    expect(find(s.tree(), 'src/core')?.origin).toBe('actual-only')
    const r = s.rename({ path: 'src/core', newName: 'kernel' })
    expect(find(r.tree, 'src/core')).toBeNull()
    expect(find(r.tree, 'src/kernel')?.origin).toBe('spec-only')
  })

  it('配套动作 3（踩坑）：改成它现在的名字时不隐藏——照样隐藏会让 merge 把磁盘侧与 spec 侧双双跳过，节点凭空消失', async () => {
    const s = new Session(root); await s.open()
    // 必须拿一个 actual-only 节点来测：对它改成同名会真的改变契约（多出一条声明），
    // 不会被"什么都没变"那条空操作提前返回吃掉，`to !== path` 那道闸才是唯一挡在
    // "节点凭空消失"前面的东西。换成已声明的节点，这条用例对那道闸没有区分力。
    expect(find(s.tree(), 'src/core')?.origin).toBe('actual-only')
    const r = s.rename({ path: 'src/core', newName: 'core' })
    expect(find(r.tree, 'src/core')).not.toBeNull()
    expect(find(r.tree, 'src/core')?.origin).toBe('both')
  })

  it('配套动作 4（踩坑）：改回原名时先解除隐藏——不解除的话节点第二次凭空消失', async () => {
    const s = new Session(root); await s.open()
    s.rename({ path: 'src/core', newName: 'kernel' })
    expect(find(s.tree(), 'src/core')).toBeNull() // 第一次改名后旧位置确实藏起来了
    const r = s.rename({ path: 'src/kernel', newName: 'core' })
    expect(find(r.tree, 'src/core')).not.toBeNull()
    expect(find(r.tree, 'src/kernel')).toBeNull()
  })

  it('配套动作 5：分组成员路径连同子孙一并重写，否则成员悬空', async () => {
    await fs.writeFile(nodePath.join(root, 'src/core/walk.ts'), '')
    const s = new Session(root); await s.open()
    // 孙节点：src/core/walk.ts 是被改名的 src 的孙子，且带注释、且在一个分组里——
    // 少了任何一样，"成员路径有没有被重写"这条断言都会退化成恒真。
    s.annotate({ path: 'src/core/walk.ts', isDir: false, annotation: '遍历入口' })
    const g = s.setGroup({ id: null, members: ['src/core/walk.ts'], text: '遍历相关' })
    const r = s.rename({ path: 'src', newName: 'lib' })
    expect(r.groups[0].members).toEqual(['lib/core/walk.ts'])
    const moved = find(r.tree, 'lib/core/walk.ts')
    expect(moved?.annotation).toBe('遍历入口')
    expect(moved?.groups).toEqual([g.id])
  })

  it('配套动作 6（踩坑）：快照盖住 hidden——撤销之后旧位置必须真的回到树上且可见', async () => {
    const s = new Session(root); await s.open()
    s.rename({ path: 'src/core', newName: 'kernel' })
    expect(find(s.tree(), 'src/core')).toBeNull()
    const u = s.undo()
    // 只还原 spec 的话：kernel 这条声明没了，而 src/core 仍被 hidden 挡着，
    // 节点在新旧两个位置都不显示——正是 Snapshot 注释里守的那条。
    expect(find(u.tree, 'src/core')?.origin).toBe('actual-only')
    expect(find(u.tree, 'src/kernel')).toBeNull()
    expect(u.dirty).toBe(false)
  })

  it('配套动作 7：走 assertWritable + commitEdit——置脏、进撤销栈、重做回得来', async () => {
    const s = new Session(root); await s.open()
    const r = s.rename({ path: 'src/core', newName: 'kernel' })
    expect(r.dirty).toBe(true)
    expect(r.canUndo).toBe(true)
    expect(r.canRedo).toBe(false)
    const u = s.undo()
    expect(u.canRedo).toBe(true)
    const re = s.redo()
    expect(find(re.tree, 'src/kernel')).not.toBeNull()
    expect(find(re.tree, 'src/core')).toBeNull()
  })

  it('改成它现在的名字、且契约里本来就声明过它时是真正的空操作：不置脏、不进撤销栈', async () => {
    const s = new Session(root); await s.open()
    s.annotate({ path: 'src/core', isDir: true, annotation: '核心模块' })
    await s.save()
    const r = s.rename({ path: 'src/core', newName: 'core' })
    expect(r.dirty).toBe(false)
    expect(r.path).toBe('src/core')
    // 那一次空操作若偷偷吃了一格撤销栈，这次 undo 退回的就是"改名前"，注释还在
    const u = s.undo()
    expect(find(u.tree, 'src/core')?.annotation).toBeUndefined()
  })

  it('子树连同注释跟着走：改父节点的名字，孙节点的注释出现在新路径下', async () => {
    const s = new Session(root); await s.open()
    s.annotate({ path: 'src/core/walk.ts', isDir: false, annotation: '遍历入口' })
    const r = s.rename({ path: 'src', newName: 'lib' })
    expect(find(r.tree, 'lib/core/walk.ts')?.annotation).toBe('遍历入口')
    expect(find(r.tree, 'src')).toBeNull()
  })

  it('对 actual-only 节点改名是有意义的声明（"我声明这东西应该叫 X"），不要求先声明过', async () => {
    const s = new Session(root); await s.open()
    expect(find(s.tree(), 'src/core')?.origin).toBe('actual-only')
    const r = s.rename({ path: 'src/core', newName: 'kernel' })
    expect(find(r.tree, 'src/kernel')?.origin).toBe('spec-only')
  })

  it('只读模式（disk 视图）下 rename 抛错', async () => {
    const s = new Session(root); await s.open()
    s.setViewMode('disk')
    expect(() => s.rename({ path: 'src/core', newName: 'kernel' })).toThrow(specError('readonly.diskView'))
  })

  it('只读模式（契约解析失败）下 rename 抛错', async () => {
    await fs.writeFile(nodePath.join(root, SPEC_FILENAME), '# x\n\n## 结构\n\n   - `a/`\n')
    const s = new Session(root); await s.open()
    expect(() => s.rename({ path: 'src/core', newName: 'kernel' })).toThrow(specError('readonly.parseFailed'))
  })

  it('handle("spec/rename") 分发正确', async () => {
    const s = new Session(root); await s.open()
    const r = await s.handle('spec/rename', { path: 'src/core', newName: 'kernel' })
    expect((r as { path: string }).path).toBe('src/kernel')
    expect(find((r as { tree: ViewNode }).tree, 'src/kernel')).not.toBeNull()
  })

  it('改名之后 raw() 能成功序列化并自校验，落盘重开仍是新名字', async () => {
    const s = new Session(root); await s.open()
    s.annotate({ path: 'src/core', isDir: true, annotation: '核心模块' })
    s.rename({ path: 'src/core', newName: 'kernel' })
    expect(s.raw()).toContain('- `kernel/` — 核心模块')
    expect(parseSpec(s.raw()).ok).toBe(true)
    await s.save()

    const s2 = new Session(root)
    const o = await s2.open()
    expect(find(o.tree, 'src/kernel')?.annotation).toBe('核心模块')
  })

  it('只写 .folderspec.md：磁盘上的目录名一个字都没被改', async () => {
    const s = new Session(root); await s.open()
    s.rename({ path: 'src/core', newName: 'kernel' })
    await s.save()
    expect((await fs.stat(nodePath.join(root, 'src/core'))).isDirectory()).toBe(true)
    await expect(fs.stat(nodePath.join(root, 'src/kernel'))).rejects.toThrow()
  })
})

describe('Session.rename 的名字校验与撞名（悄悄合并两个不同的东西 = 不可逆的丢失）', () => {
  it('名字校验与 createNode 完全一致：空名 / "/" / 反引号 / 换行 / "." / ".." 全部拒绝', async () => {
    const s = new Session(root); await s.open()
    expect(() => s.rename({ path: 'src/core', newName: '' })).toThrow(specError('name.empty'))
    expect(() => s.rename({ path: 'src/core', newName: 'a/b' })).toThrow(specError('name.hasSlash', { name: '"a/b"' }))
    expect(() => s.rename({ path: 'src/core', newName: 'we`ird' })).toThrow(specError('name.unrepresentable', { name: '"we`ird"' }))
    expect(() => s.rename({ path: 'src/core', newName: 'a\nb' })).toThrow(specError('name.unrepresentable', { name: JSON.stringify('a\nb') }))
    expect(() => s.rename({ path: 'src/core', newName: '.' })).toThrow(specError('name.reserved', { name: '.' }))
    expect(() => s.rename({ path: 'src/core', newName: '..' })).toThrow(specError('name.reserved', { name: '..' }))
  })

  it('不能重命名根节点', async () => {
    const s = new Session(root); await s.open()
    expect(() => s.rename({ path: '', newName: 'x' })).toThrow(specError('rename.rootNode'))
  })

  it('契约里同层已经有同名声明时拒绝（磁盘上并没有这个名字）', async () => {
    const s = new Session(root); await s.open()
    s.createNode({ parentPath: 'src', name: 'kernel', isDir: true })
    expect(() => s.rename({ path: 'src/core', newName: 'kernel' }))
      .toThrow(specError('name.duplicateSibling', { parent: 'src', name: 'kernel' }))
  })

  it('磁盘上同层已经有同名条目时拒绝——契约不能把两个不同的东西说成同一个', async () => {
    await fs.mkdir(nodePath.join(root, 'src/kernel'))
    const s = new Session(root); await s.open()
    expect(() => s.rename({ path: 'src/core', newName: 'kernel' }))
      .toThrow(specError('rename.targetOccupiedOnDisk', { path: 'src/kernel' }))
  })

  it('新名字所在那一层尚未扫描时拒绝——分不清磁盘上有没有同名的东西，宁可让用户先展开', async () => {
    const s = new Session(root); await s.open()
    s.annotate({ path: 'src/deep/x', isDir: true, annotation: '声明' })
    expect(find(s.tree(), 'src/deep/x')?.origin).toBe('unscanned') // 夹具确认落在懒加载边界之下
    expect(() => s.rename({ path: 'src/deep/x', newName: 'y' }))
      .toThrow(specError('rename.targetUnscanned', { path: 'src/deep/y' }))
  })

  it('对照：展开那一层之后，同一次改名照常放行', async () => {
    const s = new Session(root); await s.open()
    s.annotate({ path: 'src/deep/x', isDir: true, annotation: '声明' })
    await s.expand('src/deep')
    const r = s.rename({ path: 'src/deep/x', newName: 'y' })
    expect(find(r.tree, 'src/deep/y')?.annotation).toBe('声明')
  })

  it('契约里和磁盘上都没有这条路径时拒绝——没有可以重命名的节点', async () => {
    const s = new Session(root); await s.open()
    expect(() => s.rename({ path: 'src/ghost', newName: 'x' }))
      .toThrow(specError('rename.sourceMissing', { path: 'src/ghost' }))
  })

  it('源节点落在懒加载边界之下、契约里也没有它时拒绝，而不是猜它是文件还是目录', async () => {
    const s = new Session(root); await s.open()
    expect(() => s.rename({ path: 'src/deep/deeper', newName: 'x' }))
      .toThrow(specError('node.unscannedKind', { path: 'src/deep/deeper' }))
  })

  it('拒绝之后不产生任何副作用：不置脏、不进撤销栈、契约一个字节都不变', async () => {
    const s = new Session(root); await s.open()
    s.annotate({ path: 'README.md', isDir: false, annotation: '说明' })
    const before = s.raw()
    expect(() => s.rename({ path: 'src/core', newName: 'a/b' })).toThrow(specError('name.hasSlash', { name: '"a/b"' }))
    expect(s.raw()).toBe(before)
    // 那一次失败若偷偷吃了一格撤销栈，这次 undo 退回的就是"改名前"而不是"写注释前"
    const u = s.undo()
    expect(find(u.tree, 'README.md')?.annotation).toBeUndefined()
    expect(u.dirty).toBe(false)
  })
})

/**
 * 闸门必须接进 createNode / move / annotate 已经共用的那一套（assertNotHidden /
 * assertCreatableParent / assertDeclarableResult），不新写一份——同一条不变量有两个
 * 实现，界面迟早在两条写路径上给出相反的答案。
 */
describe('Session.rename 接进既有的三道闸门', () => {
  it('源节点自己就是本次会话刚被拖走的旧位置时拒绝——那一行在树上根本不存在', async () => {
    const s = new Session(root); await s.open()
    s.move({ from: 'src/core', toParent: '', isDir: true })
    expect(() => s.rename({ path: 'src/core', newName: 'kernel' }))
      .toThrow(specError('hidden.oldLocation', { path: 'src/core' }))
  })

  it('祖先链上有被拖走的旧位置时同样拒绝——判据不是精确匹配', async () => {
    await fs.mkdir(nodePath.join(root, 'src/core/sub'), { recursive: true })
    const s = new Session(root); await s.open()
    s.move({ from: 'src/core', toParent: '', isDir: true })
    expect(() => s.rename({ path: 'src/core/sub', newName: 'x' }))
      .toThrow(specError('hidden.oldLocation', { path: 'src/core' }))
  })

  it('父级在磁盘上是文件时拒绝——与 createNode / move 共用 assertCreatableParent', async () => {
    const s = new Session(root); await s.open()
    // annotate 不过 assertCreatableParent（它只查 hidden），所以这条声明写得进去；
    // 正因为写得进去，才有机会在这里被 rename 的闸门挡下。
    s.annotate({ path: 'README.md/child', isDir: false, annotation: 'x' })
    expect(() => s.rename({ path: 'README.md/child', newName: 'y' }))
      .toThrow(specError('parent.fileOnDisk', { path: 'README.md' }))
  })

  it('结果路径与磁盘上的类型冲突时拒绝——与 createNode / move 共用 assertDeclarableResult', async () => {
    await fs.writeFile(nodePath.join(root, 'src/note.md'), '')
    const s = new Session(root); await s.open()
    // 先把 src/core 改走，src/core 落进 hidden：撞名检查因此放行（改回一个被藏起来的
    // 位置是合法动作），闸门这一格才轮得到 assertDeclarableResult 去审类型。
    s.rename({ path: 'src/core', newName: 'core-old' })
    expect(() => s.rename({ path: 'src/note.md', newName: 'core' }))
      .toThrow(specError('declare.typeConflictDiskDir', { path: 'src/core' }))
  })
})

/**
 * rename 会从另一扇门把 5eea9e1 修掉的那条红线放回来：releaseHiddenFor 按 basename
 * 回收 hidden，而它成立的前提是"移动不改名"——rename 恰好废掉这个前提。
 */
describe('Session.removeNode 回收 rename 遗留的 hidden', () => {
  it('红线：改名后再对新名字「取消声明」，磁盘上真实存在的旧位置连同子树必须回到树上', async () => {
    await fs.writeFile(nodePath.join(root, 'src/core/keep.ts'), '')
    const s = new Session(root); await s.open()
    s.rename({ path: 'src/core', newName: 'kernel' })
    expect(find(s.tree(), 'src/core')).toBeNull()

    const r = s.removeNode('src/kernel')
    const back = find(r.tree, 'src/core')
    expect(back).not.toBeNull()
    expect(back?.origin).toBe('actual-only')
    // 整棵子树都要能重新够着，不只是那一行
    const expanded = await s.expand('src/core')
    expect(find(expanded, 'src/core/keep.ts')).not.toBeNull()
  })

  it('撤销之后 hidden 恢复原状：声明回到新名字上，旧位置重新隐藏', async () => {
    const s = new Session(root); await s.open()
    s.rename({ path: 'src/core', newName: 'kernel' })
    s.removeNode('src/kernel')
    const u = s.undo()
    expect(find(u.tree, 'src/kernel')).not.toBeNull()
    expect(find(u.tree, 'src/core')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 本轮：spec/copyNode —— 右键「复制」/「粘贴」的 core 侧。语义是"把一个**契约子树**
// 在别处再声明一份"，磁盘一个字节不动（铁律 1）。剪贴板本身是 UI 的会话内状态，
// 不进 core：core 侧只有这一个无状态方法。
// ---------------------------------------------------------------------------

describe('Session.copyNode（把一个契约子树在别处再声明一份——磁盘一个字节不动）', () => {
  it('深子树连同注释、角色、模板、严重级别完整复制，源节点原样不动', async () => {
    const s = new Session(root); await s.open()
    s.annotate({ path: 'src/core', isDir: true, annotation: '内核', role: 'core-engine', severity: 'error' })
    s.annotate({ path: 'src/core/a.ts', isDir: false, annotation: '入口', template: 'case' })
    s.annotate({ path: 'src/core/deep/b.ts', isDir: false, annotation: '深处' })

    const r = s.copyNode({ from: 'src/core', toParent: '' })
    expect(r.path).toBe('core')

    const copy = find(r.tree, 'core')
    expect(copy?.annotation).toBe('内核')
    expect(copy?.role).toBe('core-engine')
    expect(copy?.severity).toBe('error')
    expect(find(r.tree, 'core/a.ts')?.annotation).toBe('入口')
    expect(find(r.tree, 'core/a.ts')?.template).toBe('case')
    // 深子树整棵跟着走，不只是第一层
    expect(find(r.tree, 'core/deep/b.ts')?.annotation).toBe('深处')

    // 源节点一个字都没被搬走
    expect(find(r.tree, 'src/core')?.annotation).toBe('内核')
    expect(find(r.tree, 'src/core/deep/b.ts')?.annotation).toBe('深处')
  })

  it('副本与源节点之间没有共享引用：给副本写注释，源节点纹丝不动', async () => {
    // structuredClone 漏掉的话两处会指向同一个对象，改一处改两处——而本工具唯一能
    // 造成的伤害正是弄丢人写的注释。
    const s = new Session(root); await s.open()
    s.annotate({ path: 'src/core/a.ts', isDir: false, annotation: '原' })
    s.copyNode({ from: 'src/core', toParent: '' })
    const r = s.annotate({ path: 'core/a.ts', isDir: false, annotation: '改过的' })
    expect(find(r.tree, 'core/a.ts')?.annotation).toBe('改过的')
    expect(find(r.tree, 'src/core/a.ts')?.annotation).toBe('原')
  })

  it('副本以 spec-only 呈现（磁盘上并不存在这个东西），且置脏、进撤销栈', async () => {
    const s = new Session(root); await s.open()
    s.annotate({ path: 'src/core', isDir: true, annotation: '内核' })
    const r = s.copyNode({ from: 'src/core', toParent: '' })
    expect(find(r.tree, 'core')?.origin).toBe('spec-only')
    expect(r.dirty).toBe(true)
    expect(r.canUndo).toBe(true)
  })

  it('红线（稀疏覆盖层）：源在契约里没有条目时，粘出来的是一条空声明，绝不把磁盘子结构灌进契约', async () => {
    const s = new Session(root); await s.open()
    // 前置：src 磁盘上真的有子项，而且**已经扫描到了**——否则下面的断言恒真，
    // 这条用例就只是在验证一个不可能发生的事。
    const t0 = s.tree()
    expect(find(t0, 'src')?.origin).toBe('actual-only')
    expect(find(t0, 'src/core')).not.toBeNull()
    expect(find(t0, 'src/deep')).not.toBeNull()

    const r = s.copyNode({ from: 'src', toParent: '' })
    expect(r.path).toBe('src-copy')
    expect(find(r.tree, 'src-copy')?.origin).toBe('spec-only')
    // 磁盘上的子结构一条都不许被物化进契约
    expect(find(r.tree, 'src-copy/core')).toBeNull()
    expect(find(r.tree, 'src-copy/deep')).toBeNull()

    const parsed = parseSpec(s.raw())
    expect(parsed.ok).toBe(true)
    const node = (parsed as { ok: true; value: Spec }).value.nodes.find(n => n.name === 'src-copy')
    expect(node).toBeDefined()
    expect(node!.children).toEqual([])
  })

  it('只复制契约里有的那部分：源的某个后代被标注过，其余磁盘子项照样不进契约', async () => {
    const s = new Session(root); await s.open()
    s.annotate({ path: 'src/core', isDir: true, annotation: '内核' })
    const r = s.copyNode({ from: 'src', toParent: '' })
    // 标注过的那一支跟着走
    expect(find(r.tree, 'src-copy/core')?.annotation).toBe('内核')
    // 没标注过的兄弟（磁盘上真实存在、也已经扫描到）不跟着走
    expect(find(s.tree(), 'src/deep')).not.toBeNull()
    expect(find(r.tree, 'src-copy/deep')).toBeNull()
  })

  it('自动后缀：连粘三次得到 demo-copy / demo-copy-2 / demo-copy-3', async () => {
    const s = new Session(root); await s.open()
    s.createNode({ parentPath: 'src', name: 'demo', isDir: true })
    expect(s.copyNode({ from: 'src/demo', toParent: 'src' }).path).toBe('src/demo-copy')
    expect(s.copyNode({ from: 'src/demo', toParent: 'src' }).path).toBe('src/demo-copy-2')
    expect(s.copyNode({ from: 'src/demo', toParent: 'src' }).path).toBe('src/demo-copy-3')
  })

  it('不冲突就不加后缀：粘到别的父级下时名字原样保留', async () => {
    const s = new Session(root); await s.open()
    s.createNode({ parentPath: 'src', name: 'demo', isDir: true })
    expect(s.copyNode({ from: 'src/demo', toParent: '' }).path).toBe('demo')
  })

  it('文件的后缀加在扩展名之前：a.ts → a-copy.ts', async () => {
    const s = new Session(root); await s.open()
    s.createNode({ parentPath: 'src', name: 'a.ts', isDir: false })
    expect(s.copyNode({ from: 'src/a.ts', toParent: 'src' }).path).toBe('src/a-copy.ts')
    expect(s.copyNode({ from: 'src/a.ts', toParent: 'src' }).path).toBe('src/a-copy-2.ts')
  })

  it('点文件（.gitignore）整体是名字，不当扩展名切', async () => {
    const s = new Session(root); await s.open()
    s.createNode({ parentPath: 'src', name: '.gitignore', isDir: false })
    expect(s.copyNode({ from: 'src/.gitignore', toParent: 'src' }).path).toBe('src/.gitignore-copy')
  })

  it('目录名里的点不是扩展名：my.dir → my.dir-copy', async () => {
    const s = new Session(root); await s.open()
    s.createNode({ parentPath: 'src', name: 'my.dir', isDir: true })
    expect(s.copyNode({ from: 'src/my.dir', toParent: 'src' }).path).toBe('src/my.dir-copy')
  })

  it('冲突检测同时看磁盘侧兄弟：磁盘上已经有 demo-copy 时让到 demo-copy-2', async () => {
    await fs.mkdir(nodePath.join(root, 'src/demo'))
    await fs.mkdir(nodePath.join(root, 'src/demo-copy'))
    const s = new Session(root); await s.open()
    // 前置：磁盘侧那两个目录确实已经被扫描到了，否则下面的断言恒真
    expect(find(s.tree(), 'src/demo-copy')?.origin).toBe('actual-only')
    expect(s.copyNode({ from: 'src/demo', toParent: 'src' }).path).toBe('src/demo-copy-2')
  })

  it('冲突检测也要让开本次会话里被拖走的旧位置——那条路径上的声明在树上根本不显示', async () => {
    const s = new Session(root); await s.open()
    // ghost 只存在于契约里，磁盘上没有；把它拖到根下之后，src/ghost 这个名字在
    // **契约侧与磁盘侧都是空的**，只有 hidden 占着它。这正是"只查契约 + 磁盘两侧"
    // 漏掉的那一格。
    s.createNode({ parentPath: 'src', name: 'ghost', isDir: true })
    s.move({ from: 'src/ghost', toParent: '', isDir: true })
    expect(find(s.tree(), 'src/ghost')).toBeNull()

    const r = s.copyNode({ from: 'ghost', toParent: 'src' })
    expect(r.path).toBe('src/ghost-copy')
    expect(find(r.tree, 'src/ghost-copy')).not.toBeNull()
  })

  it('生成出来的名字自己也要过 assertValidNodeName', async () => {
    const s = new Session(root); await s.open()
    // annotate 不做逐段名字校验（那是它自己的既有口径），因此契约里能长出一个叫 ".." 的节点
    s.annotate({ path: '..', isDir: true, annotation: 'x' })
    expect(() => s.copyNode({ from: '..', toParent: 'src' })).toThrow(specError('name.reserved', { name: '..' }))
  })

  it('副本不继承分组归属——分组是"这几条具体路径共享一条约束"，复制不该悄悄把范围扩一圈', async () => {
    const s = new Session(root); await s.open()
    s.annotate({ path: 'src/core/a.ts', isDir: false, annotation: '入口' })
    const g = s.setGroup({ id: null, members: ['src/core', 'src/core/a.ts'], text: '一体的两条' })
    // 前置：源节点与它的后代**真的**属于某个分组，否则断言恒真
    expect(find(s.tree(), 'src/core')?.groups).toEqual([g.id])
    expect(find(s.tree(), 'src/core/a.ts')?.groups).toEqual([g.id])

    const r = s.copyNode({ from: 'src/core', toParent: '' })
    expect(find(r.tree, 'core')?.groups).toBeUndefined()
    expect(find(r.tree, 'core/a.ts')?.groups).toBeUndefined()
    // 分组成员一个字都没变
    expect(r.groups.find(x => x.id === g.id)?.members).toEqual(['src/core', 'src/core/a.ts'])
    // 源节点照旧在组里
    expect(find(r.tree, 'src/core')?.groups).toEqual([g.id])
  })

  it('拒绝粘进它自己的子树下——与 moveNode 同一条判据', async () => {
    const s = new Session(root); await s.open()
    expect(() => s.copyNode({ from: 'src', toParent: 'src/core' })).toThrow(specError('copy.intoOwnSubtree'))
  })

  it('拒绝粘进它自己下面', async () => {
    const s = new Session(root); await s.open()
    expect(() => s.copyNode({ from: 'src', toParent: 'src' })).toThrow(specError('copy.intoOwnSubtree'))
  })

  it('不碰 hidden：复制不移走源节点，旧位置没有需要隐藏的东西', async () => {
    const s = new Session(root); await s.open()
    s.annotate({ path: 'src/core', isDir: true, annotation: '内核' })
    const r = s.copyNode({ from: 'src/core', toParent: '' })
    expect(find(r.tree, 'src/core')).not.toBeNull()
    expect(find(r.tree, 'src/core')?.annotation).toBe('内核')
  })

  it('走 commitEdit：撤销后副本消失、dirty 归零，重做后回来', async () => {
    const s = new Session(root); await s.open()
    s.annotate({ path: 'src/core', isDir: true, annotation: '内核' })
    await s.save()
    expect(s.isDirty()).toBe(false)

    s.copyNode({ from: 'src/core', toParent: '' })
    expect(s.isDirty()).toBe(true)

    const u = s.undo()
    expect(find(u.tree, 'core')).toBeNull()
    expect(u.dirty).toBe(false)
    expect(find(u.tree, 'src/core')?.annotation).toBe('内核')

    const re = s.redo()
    expect(find(re.tree, 'core')?.annotation).toBe('内核')
    expect(re.dirty).toBe(true)
  })

  it('只读模式（disk 视图）下 copyNode 抛错', async () => {
    const s = new Session(root); await s.open()
    s.setViewMode('disk')
    expect(() => s.copyNode({ from: 'src/core', toParent: '' })).toThrow(specError('readonly.diskView'))
  })

  it('只读模式（契约解析失败）下 copyNode 抛错', async () => {
    await fs.writeFile(nodePath.join(root, SPEC_FILENAME), '不是合法的契约文件\n')
    const s = new Session(root); await s.open()
    expect(() => s.copyNode({ from: 'src/core', toParent: '' })).toThrow(specError('readonly.parseFailed'))
  })

  it('handle("spec/copyNode") 分发正确', async () => {
    const s = new Session(root); await s.open()
    s.annotate({ path: 'src/core', isDir: true, annotation: '内核' })
    const r = await s.handle('spec/copyNode', { from: 'src/core', toParent: '' })
    expect(r.path).toBe('core')
    expect(find(r.tree, 'core')?.annotation).toBe('内核')
  })

  it('复制之后 raw() 能成功序列化并自校验，落盘重开副本还在', async () => {
    const s = new Session(root); await s.open()
    s.annotate({ path: 'src/core', isDir: true, annotation: '内核' })
    s.copyNode({ from: 'src/core', toParent: '' })
    expect(parseSpec(s.raw()).ok).toBe(true)
    await s.save()

    const s2 = new Session(root)
    const r2 = await s2.open()
    expect(find(r2.tree, 'core')?.annotation).toBe('内核')
    expect(find(r2.tree, 'core')?.origin).toBe('spec-only')
  })

  it('只写 .folderspec.md：磁盘上不会因为一次粘贴多出任何目录或文件', async () => {
    const s = new Session(root); await s.open()
    s.annotate({ path: 'src/core', isDir: true, annotation: '内核' })
    s.copyNode({ from: 'src/core', toParent: '' })
    await s.save()
    expect((await fs.readdir(root)).sort()).toEqual([SPEC_FILENAME, 'README.md', 'src'].sort())
    expect((await fs.readdir(nodePath.join(root, 'src'))).sort()).toEqual(['core', 'deep'].sort())
  })
})

describe('Session.copyNode 接进既有的三道闸门（不新写一份判据）', () => {
  it('toParent 在磁盘上是文件时拒绝——与 createNode / move / rename 共用 assertCreatableParent', async () => {
    const s = new Session(root); await s.open()
    expect(() => s.copyNode({ from: 'src/core', toParent: 'README.md' }))
      .toThrow(specError('parent.fileOnDisk', { path: 'README.md' }))
  })

  it('toParent 落在本次会话刚被拖走的旧位置里时拒绝', async () => {
    const s = new Session(root); await s.open()
    s.move({ from: 'src/deep', toParent: '', isDir: true })
    expect(() => s.copyNode({ from: 'src/core', toParent: 'src/deep' }))
      .toThrow(specError('hidden.oldLocation', { path: 'src/deep' }))
  })

  it('源节点自己就是刚被拖走的旧位置时拒绝——那一行在树上根本不存在', async () => {
    const s = new Session(root); await s.open()
    s.move({ from: 'src/core', toParent: '', isDir: true })
    expect(() => s.copyNode({ from: 'src/core', toParent: 'src' }))
      .toThrow(specError('hidden.oldLocation', { path: 'src/core' }))
  })

  it('toParent 含 ".." 段时拒绝——不能借这个参数位把声明写到仓库之外', async () => {
    const s = new Session(root); await s.open()
    expect(() => s.copyNode({ from: 'src/core', toParent: '../etc' })).toThrow(specError('name.reserved', { name: '..' }))
  })

  it('源路径含反引号时拒绝（当前契约格式无法表示）', async () => {
    const s = new Session(root); await s.open()
    expect(() => s.copyNode({ from: 'src/a`b', toParent: '' }))
      .toThrow(specError('path.unrepresentable', { path: '"src/a`b"' }))
  })

  it('不能复制根节点', async () => {
    const s = new Session(root); await s.open()
    expect(() => s.copyNode({ from: '', toParent: 'src' })).toThrow(specError('copy.rootNode'))
  })

  it('契约里和磁盘上都没有这条路径时拒绝——没有可以复制的节点', async () => {
    const s = new Session(root); await s.open()
    expect(() => s.copyNode({ from: 'src/nope', toParent: '' }))
      .toThrow(specError('copy.sourceMissing', { path: 'src/nope' }))
  })

  it('源节点落在懒加载边界之下、契约里也没有它时拒绝，而不是猜它是文件还是目录', async () => {
    const s = new Session(root); await s.open()
    expect(() => s.copyNode({ from: 'src/deep/deeper', toParent: '' }))
      .toThrow(specError('node.unscannedKind', { path: 'src/deep/deeper' }))
  })

  it('目标父级的子项尚未扫描时拒绝——磁盘侧撞名与否无从判断，绝不只查一半', async () => {
    const s = new Session(root); await s.open()
    // 前置：src/deep 确实处在懒加载边界上（children 尚未扫描）
    expect(find(s.tree(), 'src/deep')?.children).toBeUndefined()
    expect(() => s.copyNode({ from: 'src/core', toParent: 'src/deep' }))
      .toThrow(specError('copy.targetChildrenUnscanned', { path: 'src/deep' }))
  })

  it('对照：展开那一层之后，同一次粘贴照常放行', async () => {
    const s = new Session(root); await s.open()
    await s.expand('src/deep')
    const r = s.copyNode({ from: 'src/core', toParent: 'src/deep' })
    expect(r.path).toBe('src/deep/core')
    expect(find(r.tree, 'src/deep/core')?.origin).toBe('spec-only')
  })

  it('拒绝之后不产生任何副作用：不置脏、不进撤销栈、契约一个字节都不变', async () => {
    const s = new Session(root); await s.open()
    s.annotate({ path: 'src/core', isDir: true, annotation: '内核' })
    await s.save()
    const before = s.raw()

    expect(() => s.copyNode({ from: 'src', toParent: 'src/core' })).toThrow(specError('copy.intoOwnSubtree'))
    expect(() => s.copyNode({ from: 'src/core', toParent: 'README.md' })).toThrow(specError('parent.fileOnDisk', { path: 'README.md' }))
    expect(() => s.copyNode({ from: 'src/nope', toParent: '' })).toThrow(specError('copy.sourceMissing', { path: 'src/nope' }))

    expect(s.raw()).toBe(before)
    expect(s.isDirty()).toBe(false)
    // 三次失败一格撤销栈都没吃掉：唯一还能退的是那笔 annotate，退完就见底了
    const u = s.undo()
    expect(find(u.tree, 'src/core')?.annotation).toBeUndefined()
    expect(u.canUndo).toBe(false)
  })
})
